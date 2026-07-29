// scripts/fetch-bid-recommendations.mjs
// Usage: node --env-file=.env.local scripts/fetch-bid-recommendations.mjs \
//          --profile <id> [--campaign <id>]
//
// Fetches Amazon's per-entity theme-based bid + range (CONVERSION_OPPORTUNITIES theme)
// and upserts into amazon_bid_recommendations.
//
// VERIFIED CONTRACT:
//   POST {host}/sp/targets/bid/recommendations
//   Content-Type AND Accept: application/vnd.spthemebasedbidrecommendation.v4+json
//   Request (per ad group):
//     { campaignId: <str>, adGroupId: <str>,
//       recommendationType: 'BIDS_FOR_EXISTING_AD_GROUP',
//       targetingExpressions: [...] }   max 100 expressions/request
//   AUTO levers:  { type: 'CLOSE_MATCH'|'LOOSE_MATCH'|'SUBSTITUTES'|'COMPLEMENTS' }
//   Keywords:     { type: 'KEYWORD_EXACT_MATCH'|'KEYWORD_BROAD_MATCH'|
//                          'KEYWORD_PHRASE_MATCH', value: '<text>' }
//   Response theme to use: CONVERSION_OPPORTUNITIES.
//   If response shape differs from expectation, paste raw verbatim and adapt
//   parsing only — NEVER change the media type or endpoint.
//   4xx = finding pasted verbatim; never improvise around it.

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

const BID_REC_ENDPOINT = `${host}/sp/targets/bid/recommendations`;
const BID_REC_MEDIA    = 'application/vnd.spthemebasedbidrecommendation.v4+json';
const BATCH_SIZE       = 100;

// ── Expression type maps ──────────────────────────────────────────────────────
// DB AUTO target expression type → API targetingExpression type
const AUTO_THEME_MAP = {
  QUERY_HIGH_REL_MATCHES:  'CLOSE_MATCH',
  QUERY_BROAD_REL_MATCHES: 'LOOSE_MATCH',
  ASIN_SUBSTITUTE_RELATED: 'SUBSTITUTES',
  ASIN_ACCESSORY_RELATED:  'COMPLEMENTS',
};
// DB keyword match_type → API targetingExpression type
const KW_MATCH_MAP = {
  EXACT:  'KEYWORD_EXACT_MATCH',
  BROAD:  'KEYWORD_BROAD_MATCH',
  PHRASE: 'KEYWORD_PHRASE_MATCH',
};

// ── Entities to look up ───────────────────────────────────────────────────────
const campFilter = campaignId ? 'AND campaign_id::text = $2' : '';
const campParams = campaignId ? [profileId, campaignId] : [profileId];

// AUTO targets only (theme-based contract covers AUTO + keywords)
const { rows: autoTargetRows } = await pool.query(
  `SELECT target_id::text   AS entity_id,
          ad_group_id::text  AS ad_group_id,
          campaign_id::text  AS campaign_id,
          bid::float,
          expression
     FROM amazon_targets
    WHERE profile_id      = $1
      AND state           = 'ENABLED'
      AND bid             IS NOT NULL
      AND expression_type = 'AUTO'
      ${campFilter}`,
  campParams,
);

// Keywords
const { rows: keywordRows } = await pool.query(
  `SELECT keyword_id::text  AS entity_id,
          ad_group_id::text  AS ad_group_id,
          campaign_id::text  AS campaign_id,
          bid::float,
          keyword_text,
          match_type
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
console.log(`  AUTO targets : ${autoTargetRows.length}`);
console.log(`  Keywords     : ${keywordRows.length}`);
console.log('');

if (autoTargetRows.length === 0 && keywordRows.length === 0) {
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

// Extract AUTO expression type from JSONB array, object, or string.
function getAutoExprType(expression) {
  if (!expression) return null;
  if (Array.isArray(expression)) return expression[0]?.type ?? null;
  if (typeof expression === 'object') return expression.type ?? null;
  const s = String(expression).trim();
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      const p = JSON.parse(s);
      return Array.isArray(p) ? (p[0]?.type ?? null) : (p.type ?? null);
    } catch { return null; }
  }
  return s || null;
}

// POST one bid-rec request. isFirstBatch=true → always print raw response.
// 4xx → paste verbatim and stop (first-contact rule: never improvise).
async function postBidRec(body, label, isFirstBatch) {
  const res = await fetchWithTimeout(
    BID_REC_ENDPOINT,
    {
      method:  'POST',
      headers: {
        'Authorization':                    `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId':   LWA_CLIENT_ID,
        'Amazon-Advertising-API-Scope':      profileIdStr,
        'Content-Type':                      BID_REC_MEDIA,
        'Accept':                            BID_REC_MEDIA,
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
    if (!isFirstBatch) {
      console.error(`ERROR HTTP ${res.status} on ${label}:`);
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

// Extract CONVERSION_OPPORTUNITIES bid from a response expression item.
// Tries multiple field-name variants; returns null if not found.
function extractConvOppBid(item) {
  const themes =
    item.bidRecommendationsForThemes ??
    item.themes ??
    item.themeBasedBidRecommendations ??
    null;
  if (!Array.isArray(themes)) return null;
  const convOpp = themes.find(
    t => t.theme === 'CONVERSION_OPPORTUNITIES' || t.themeName === 'CONVERSION_OPPORTUNITIES',
  );
  if (!convOpp) return null;
  const bidObj = convOpp.bid ?? convOpp.suggestedBid ?? convOpp.bidRecommendation ?? null;
  if (!bidObj) return null;
  const suggested  = bidObj.suggested  != null ? Number(bidObj.suggested)  : null;
  const rangeStart = bidObj.rangeStart != null ? Number(bidObj.rangeStart) : null;
  const rangeEnd   = bidObj.rangeEnd   != null ? Number(bidObj.rangeEnd)   : null;
  return suggested != null ? { suggested, rangeStart, rangeEnd } : null;
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

// ── Group entities by (campaign_id, ad_group_id) ─────────────────────────────
const groups = new Map(); // key: `${campId}::${agId}`

function getGroup(cid, agid) {
  const key = `${cid}::${agid}`;
  if (!groups.has(key)) groups.set(key, { campaignId: cid, adGroupId: agid, autoTargets: [], keywords: [] });
  return groups.get(key);
}

for (const row of autoTargetRows) getGroup(row.campaign_id, row.ad_group_id).autoTargets.push(row);
for (const row of keywordRows)    getGroup(row.campaign_id, row.ad_group_id).keywords.push(row);

console.log(`Grouped into ${groups.size} ad-group request(s).`);
console.log('');

// ── Issue requests per ad group ───────────────────────────────────────────────
let totalUpserted = 0;
let reqCount      = 0;
let isFirstBatch  = true;

for (const { campaignId: campId, adGroupId, autoTargets, keywords } of groups.values()) {
  // Build targetingExpressions + reverse-lookup.
  // AUTO key: apiType string  (e.g. 'CLOSE_MATCH').
  // KW key  : `${apiType}::${text.toLowerCase()}`.
  const targetingExpressions = [];
  const exprKeyToEntity      = new Map(); // key → { entityId, kind }

  for (const row of autoTargets) {
    const dbType  = getAutoExprType(row.expression);
    const apiType = dbType ? AUTO_THEME_MAP[dbType] : null;
    if (!apiType) {
      console.log(`  skip AUTO target ${row.entity_id}: unmapped expression '${dbType}'`);
      continue;
    }
    targetingExpressions.push({ type: apiType });
    exprKeyToEntity.set(apiType, { entityId: row.entity_id, kind: 'AUTO_STRATEGY', adGroupId });
  }

  for (const row of keywords) {
    const apiType = KW_MATCH_MAP[(row.match_type ?? '').toUpperCase()] ?? null;
    if (!apiType) {
      console.log(`  skip keyword ${row.entity_id}: unmapped match_type '${row.match_type}'`);
      continue;
    }
    const text    = (row.keyword_text ?? '').toLowerCase();
    const exprKey = `${apiType}::${text}`;
    targetingExpressions.push({ type: apiType, value: text });
    exprKeyToEntity.set(exprKey, { entityId: row.entity_id, kind: 'KEYWORD', adGroupId });
  }

  if (targetingExpressions.length === 0) {
    console.log(`  skip ad group ${adGroupId}: no mappable expressions`);
    continue;
  }

  // Batch into chunks of BATCH_SIZE expressions.
  for (const batch of chunk(targetingExpressions, BATCH_SIZE)) {
    reqCount++;
    const body = {
      campaignId:           campId,
      adGroupId,
      recommendationType:   'BIDS_FOR_EXISTING_AD_GROUP',
      targetingExpressions: batch,
    };
    const label = `ad-group ${adGroupId} req ${reqCount}`;
    console.log(`  → POST ${BID_REC_ENDPOINT}`);
    console.log(`    campaignId=${campId}  adGroupId=${adGroupId}  exprs=${batch.length}`);
    const data = await postBidRec(body, label, isFirstBatch);
    isFirstBatch = false;

    // Parse response. Expected shape:
    //   { targetingExpressions: [ { expression: {type[,value]}, <themes-field>: [...] }, ... ] }
    // Both flat-type and expression-object variants handled.
    const items = Array.isArray(data?.targetingExpressions) ? data.targetingExpressions : [];
    console.log(`    response items: ${items.length}`);

    for (const item of items) {
      // Resolve expression type from item.
      const exprObj  = item.expression ?? item;
      const apiType  = exprObj.type  ?? '';
      const apiValue = (exprObj.value ?? '').toLowerCase();

      const bidInfo = extractConvOppBid(item);
      if (!bidInfo) continue;

      const match =
        exprKeyToEntity.get(apiType) ??
        exprKeyToEntity.get(`${apiType}::${apiValue}`) ??
        null;

      if (!match) {
        console.log(`    no entity match for type='${apiType}' value='${apiValue}'`);
        continue;
      }

      await upsertBidRec(
        match.kind, match.entityId, match.adGroupId,
        bidInfo.suggested, bidInfo.rangeStart, bidInfo.rangeEnd,
      );
      console.log(`    upserted ${match.kind} ${match.entityId}: suggested=${bidInfo.suggested}`);
      totalUpserted++;
    }

    if (batch.length < targetingExpressions.length) await new Promise(r => setTimeout(r, 500));
  }

  if (groups.size > 1) await new Promise(r => setTimeout(r, 500));
}

await pool.end();
console.log(`\nDone. ${reqCount} request(s), ${totalUpserted} bid recommendation(s) upserted.`);
process.exit(0);
