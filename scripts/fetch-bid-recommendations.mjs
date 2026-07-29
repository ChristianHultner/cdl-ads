// scripts/fetch-bid-recommendations.mjs
// Usage: node --env-file=.env.local scripts/fetch-bid-recommendations.mjs \
//          --profile <id> [--campaign <id>]
//
// Fetches Amazon's per-entity suggested bid + range from the SP v3 bid-recommendation
// endpoints and upserts results into amazon_bid_recommendations.
//
// API NOTE — SP v3 target bid recommendations:
//   POST /sp/targets/bid/recommendations
//   Content-Type / Accept: application/vnd.spTargetBidRecommendations.v3+json
//   Body: { "targetingClauses": [ { "targetId": "<id>" } ] }   batch ≤ 100
//   AUTO targets (expression_type='AUTO') use the same endpoint with their target_id.
//   If the API returns 4xx for AUTO targets, that is a finding — paste verbatim, STOP.
//
// API NOTE — SP v3 keyword bid recommendations:
//   POST /sp/keywords/bid/recommendations
//   Content-Type / Accept: application/vnd.spKeywordBidRecommendations.v3+json
//   Body: { "keywords": [ { "keywordId": "<id>" } ] }           batch ≤ 100
//
// 4xx on any shape = reported finding — NEVER improvised around.

import { parseArgs } from 'node:util';
import { Pool, neonConfig } from '@neondatabase/serverless';

neonConfig.webSocketConstructor = WebSocket;

// ── Args ─────────────────────────────────────────────────────────────────────
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    profile:  { type: 'string' },
    campaign: { type: 'string' },
  },
});
if (!values.profile) throw new Error('--profile <id> required');
const profileId    = BigInt(values.profile);
const profileIdStr = String(profileId);
const campaignId   = values.campaign ?? null;

// ── DB ────────────────────────────────────────────────────────────────────────
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
const pool = new Pool({ connectionString: DATABASE_URL });

// ── Profile → region + credentials ───────────────────────────────────────────
const { rows: profileRows } = await pool.query(
  `SELECT p.region, c.env_var_name
     FROM amazon_profiles p
     JOIN amazon_credentials c ON c.id = p.credential_id
    WHERE p.profile_id = $1`,
  [profileId],
);
if (!profileRows.length) {
  await pool.end();
  throw new Error(`Profile ${profileIdStr} not found`);
}
const { region, env_var_name: envVarName } = profileRows[0];

const REGION_HOST = {
  NA: 'https://advertising-api.amazon.com',
  EU: 'https://advertising-api-eu.amazon.com',
  FE: 'https://advertising-api-fe.amazon.com',
};
const host = REGION_HOST[region];
if (!host) throw new Error(`Unknown region: ${region}`);

const TARGETS_BID_REC_ENDPOINT  = `${host}/sp/targets/bid/recommendations`;
const TARGETS_BID_REC_MEDIA     = 'application/vnd.spTargetBidRecommendations.v3+json';
const KEYWORDS_BID_REC_ENDPOINT = `${host}/sp/keywords/bid/recommendations`;
const KEYWORDS_BID_REC_MEDIA    = 'application/vnd.spKeywordBidRecommendations.v3+json';

const BATCH_SIZE = 100;

// ── Entities to look up ───────────────────────────────────────────────────────
const campFilter = campaignId ? 'AND campaign_id::text = $2' : '';
const campParams = campaignId ? [profileId, campaignId] : [profileId];

const { rows: targetRows } = await pool.query(
  `SELECT target_id::text AS entity_id, ad_group_id::text, expression_type
     FROM amazon_targets
    WHERE profile_id = $1
      AND state      = 'ENABLED'
      AND bid        IS NOT NULL
      ${campFilter}`,
  campParams,
);

const { rows: keywordRows } = await pool.query(
  `SELECT keyword_id::text AS entity_id, ad_group_id::text
     FROM amazon_keywords
    WHERE profile_id = $1
      AND state      = 'ENABLED'
      AND bid        IS NOT NULL
      ${campFilter}`,
  campParams,
);

console.log(
  `Profile ${profileIdStr}  region=${region}` +
  (campaignId ? `  campaign=${campaignId}` : ''),
);
console.log(`  Targets  to look up: ${targetRows.length}`);
console.log(`  Keywords to look up: ${keywordRows.length}`);
console.log('');

if (targetRows.length === 0 && keywordRows.length === 0) {
  await pool.end();
  console.log('Nothing to fetch.');
  process.exit(0);
}

// ── LWA token ─────────────────────────────────────────────────────────────────
const refreshToken = process.env[envVarName];
if (!refreshToken) {
  await pool.end();
  throw new Error(`Env var ${envVarName} not set`);
}
const { LWA_CLIENT_ID, LWA_CLIENT_SECRET } = process.env;
if (!LWA_CLIENT_ID || !LWA_CLIENT_SECRET) {
  await pool.end();
  throw new Error('LWA_CLIENT_ID / LWA_CLIENT_SECRET not set');
}

async function fetchWithTimeout(url, opts, label) {
  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      console.error(`ABORTED: ${label}`);
      await pool.end();
      process.exit(1);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

console.log('Minting LWA token…');
const tokenRes = await fetchWithTimeout(
  'https://api.amazon.com/auth/o2/token',
  {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     LWA_CLIENT_ID,
      client_secret: LWA_CLIENT_SECRET,
    }),
  },
  'LWA token mint',
);
if (!tokenRes.ok) {
  const errBody = await tokenRes.text();
  await pool.end();
  throw new Error(`LWA token error ${tokenRes.status}: ${errBody}`);
}
const { access_token: accessToken } = await tokenRes.json();
console.log(`Token ok (len ${accessToken.length})`);
console.log('');

// ── Helpers ───────────────────────────────────────────────────────────────────
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// POST one bid-rec batch.  isFirstBatch=true → print raw response verbatim.
// Non-2xx → print full response, STOP (first-contact rule: never improvise around 4xx).
async function fetchBidRecBatch(endpoint, mediaType, body, label, isFirstBatch) {
  const res = await fetchWithTimeout(
    endpoint,
    {
      method:  'POST',
      headers: {
        'Authorization':                    `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId':   LWA_CLIENT_ID,
        'Amazon-Advertising-API-Scope':      profileIdStr,
        'Content-Type':                      mediaType,
        'Accept':                            mediaType,
      },
      body: JSON.stringify(body),
    },
    label,
  );
  const responseText = await res.text();

  if (isFirstBatch) {
    console.log(`=== FIRST BATCH RAW RESPONSE (HTTP ${res.status}) ===`);
    console.log(responseText);
    console.log('=== END FIRST BATCH RAW RESPONSE ===');
    console.log('');
  }

  if (!res.ok) {
    // First-contact rule: paste verbatim and stop; never improvise around 4xx.
    if (!isFirstBatch) {
      console.error(`ERROR ${res.status} on ${label}:`);
      console.error(responseText);
    }
    console.error(`HTTP ${res.status} on ${label} — stopping. Shape becomes next frame's input.`);
    await pool.end();
    process.exit(1);
  }

  let responseData;
  try {
    responseData = JSON.parse(responseText);
  } catch {
    console.error('ERROR: could not parse response JSON — stopping.');
    console.error(responseText);
    await pool.end();
    process.exit(1);
  }
  return responseData;
}

// Upsert one entity's bid rec.
async function upsertBidRec(entityKind, entityId, adGroupId, suggested, rangeStart, rangeEnd) {
  await pool.query(
    `INSERT INTO amazon_bid_recommendations
       (profile_id, entity_kind, entity_id, ad_group_id, suggested, range_start, range_end, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (profile_id, entity_kind, entity_id)
     DO UPDATE SET
       ad_group_id = EXCLUDED.ad_group_id,
       suggested   = EXCLUDED.suggested,
       range_start = EXCLUDED.range_start,
       range_end   = EXCLUDED.range_end,
       fetched_at  = EXCLUDED.fetched_at`,
    [profileId, entityKind, entityId, adGroupId, suggested, rangeStart, rangeEnd],
  );
}

// ── TARGETS ───────────────────────────────────────────────────────────────────
let totalUpserted = 0;
let batchCount    = 0;
let isFirstBatch  = true;

if (targetRows.length > 0) {
  console.log(`Fetching bid recs for ${targetRows.length} target(s) (incl. AUTO)…`);
  for (const batch of chunk(targetRows, BATCH_SIZE)) {
    batchCount++;
    const body  = { targetingClauses: batch.map(r => ({ targetId: r.entity_id })) };
    const label = `target batch ${batchCount}`;
    const data  = await fetchBidRecBatch(
      TARGETS_BID_REC_ENDPOINT, TARGETS_BID_REC_MEDIA, body, label, isFirstBatch,
    );
    isFirstBatch = false;

    // Normalise response: SP v3 may return object-shape {success:[...],error:[...]}
    // or flat array; handle both.
    const tc = data?.targetingClauses;
    const items = Array.isArray(tc)
      ? tc
      : Array.isArray(tc?.success) ? tc.success : [];

    const batchMap = new Map(batch.map(r => [r.entity_id, r]));
    for (const item of items) {
      const entityId = String(item.targetId ?? '');
      if (!entityId) continue;
      const code = String(item.code ?? item.status ?? '').toUpperCase();
      if (code && code !== 'SUCCESS' && code !== '200' && code !== '') continue;
      const s   = item.suggestedBid ?? null;
      const sug = s?.suggested != null ? Number(s.suggested) : null;
      if (sug == null) continue;
      const rs  = s.rangeStart != null ? Number(s.rangeStart) : null;
      const re  = s.rangeEnd   != null ? Number(s.rangeEnd)   : null;
      const row  = batchMap.get(entityId);
      const kind = row?.expression_type === 'AUTO' ? 'AUTO_STRATEGY' : 'TARGET';
      await upsertBidRec(kind, entityId, row?.ad_group_id ?? null, sug, rs, re);
      totalUpserted++;
    }
    if (targetRows.length > BATCH_SIZE) await new Promise(r => setTimeout(r, 500));
  }
}

// ── KEYWORDS ──────────────────────────────────────────────────────────────────
if (keywordRows.length > 0) {
  console.log(`Fetching bid recs for ${keywordRows.length} keyword(s)…`);
  for (const batch of chunk(keywordRows, BATCH_SIZE)) {
    batchCount++;
    const body  = { keywords: batch.map(r => ({ keywordId: r.entity_id })) };
    const label = `keyword batch ${batchCount}`;
    const data  = await fetchBidRecBatch(
      KEYWORDS_BID_REC_ENDPOINT, KEYWORDS_BID_REC_MEDIA, body, label, isFirstBatch,
    );
    isFirstBatch = false;

    const kw = data?.keywords;
    const items = Array.isArray(kw)
      ? kw
      : Array.isArray(kw?.success) ? kw.success : [];

    const batchMap = new Map(batch.map(r => [r.entity_id, r]));
    for (const item of items) {
      const entityId = String(item.keywordId ?? '');
      if (!entityId) continue;
      const code = String(item.code ?? item.status ?? '').toUpperCase();
      if (code && code !== 'SUCCESS' && code !== '200' && code !== '') continue;
      const s   = item.suggestedBid ?? null;
      const sug = s?.suggested != null ? Number(s.suggested) : null;
      if (sug == null) continue;
      const rs  = s.rangeStart != null ? Number(s.rangeStart) : null;
      const re  = s.rangeEnd   != null ? Number(s.rangeEnd)   : null;
      const row  = batchMap.get(entityId);
      await upsertBidRec('KEYWORD', entityId, row?.ad_group_id ?? null, sug, rs, re);
      totalUpserted++;
    }
    if (keywordRows.length > BATCH_SIZE) await new Promise(r => setTimeout(r, 500));
  }
}

await pool.end();
console.log(`Done. ${totalUpserted} bid recommendation(s) upserted.`);
process.exit(0);
