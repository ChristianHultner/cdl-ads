// scripts/push-negatives.mjs
// Usage: node --env-file=.env.local scripts/push-negatives.mjs --profile <id> [--execute]
//
// API NOTE — campaign-level vs ad-group-level negative keywords in SP v3:
//   POST /sp/negativeKeywords          → ad-group-level  (requires adGroupId)
//   POST /sp/campaignNegativeKeywords  → campaign-level  (campaignId only)
//
// Because evidence.campaign_ids contains campaign IDs with no adGroupId,
// this script plans against campaignNegativeKeywords exclusively.
// Media type: application/vnd.spCampaignNegativeKeyword.v3+json
//
// ELIGIBILITY: query-term negates only.
//   Skipped (needs negative product targeting, not keyword negation):
//     • evidence.is_targeting === true
//     • target_text matches ISBN-10 pattern /^[0-9]{9}[0-9xX]$/ (belt-and-braces)

import { parseArgs } from 'node:util';
import { Pool, neonConfig } from '@neondatabase/serverless';

// Node 22+ native WebSocket
neonConfig.webSocketConstructor = WebSocket;

// ── Args ─────────────────────────────────────────────────────────────────────
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    profile: { type: 'string' },
    execute: { type: 'boolean', default: false },
  },
});
if (!values.profile) throw new Error('--profile <id> required');
const profileId    = BigInt(values.profile);
const profileIdStr = String(profileId);
const executeMode  = values.execute === true;

// ── DB ───────────────────────────────────────────────────────────────────────
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
const pool = new Pool({ connectionString: DATABASE_URL });

// First line always reflects mode
console.log(
  executeMode
    ? 'EXECUTE MODE — real API calls follow'
    : 'DRY RUN — no API calls will be made',
);
console.log('');

// ── 1. PARAMETER RESOLUTION ──────────────────────────────────────────────────
const { rows: paramRows } = await pool.query(
  `SELECT key, scope, value
     FROM engine_parameters
    WHERE scope = 'GLOBAL' OR scope = $1`,
  [profileIdStr],
);

const globalMap  = new Map();
const profileMap = new Map();
for (const row of paramRows) {
  if (row.scope === 'GLOBAL') globalMap.set(row.key,  Number(row.value));
  else                        profileMap.set(row.key, Number(row.value));
}
const params = {};
for (const key of globalMap.keys()) {
  params[key] = profileMap.has(key) ? profileMap.get(key) : globalMap.get(key);
}
for (const [key, val] of profileMap) {
  if (!(key in params)) params[key] = val;
}

console.log('Resolved params:', JSON.stringify(params));
console.log('');

// ── Profile → region + credential env_var ────────────────────────────────────
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

const ENDPOINT   = `${host}/sp/campaignNegativeKeywords`;
const MEDIA_TYPE = 'application/vnd.spCampaignNegativeKeyword.v3+json';

// ── 2. SELECT APPROVED NEGATE_TERM recs ──────────────────────────────────────
const limit = Math.floor(params.push_max_per_run ?? 20);

const { rows: recs } = await pool.query(
  `SELECT id, target_text, evidence
     FROM recommendations
    WHERE profile_id = $1
      AND status     = 'APPROVED'
      AND rec_type   = 'NEGATE_TERM'
    ORDER BY id
    LIMIT $2`,
  [profileId, limit],
);

if (recs.length === 0) {
  await pool.end();
  console.log('nothing approved to push');
  process.exit(0);
}

console.log(
  `Found ${recs.length} approved NEGATE_TERM recommendation(s)` +
  ` (limit: ${limit}, region: ${region})`,
);
console.log('');
console.log('API resource : POST ' + ENDPOINT);
console.log('Content-Type : ' + MEDIA_TYPE);
console.log('Note         : campaign-level negatives — adGroupId is NOT sent.');
console.log('               (campaignNegativeKeywords, not negativeKeywords)');
console.log('');

// ── ELIGIBILITY FILTER + PLAN ─────────────────────────────────────────────────
// Keyword-eligible: NOT is_targeting AND NOT ISBN-10 shape.
// Applied in BOTH modes; skipped recs printed with the reason.
const ISBN10_RE = /^[0-9]{9}[0-9xX]$/;

const eligible = [];  // { rec, requestBody }
let skipped    = 0;

for (const rec of recs) {
  const evidence    = typeof rec.evidence === 'string'
    ? JSON.parse(rec.evidence)
    : rec.evidence;
  const campaignIds = Array.isArray(evidence?.campaign_ids) && evidence.campaign_ids.length > 0
    ? evidence.campaign_ids
    : Array.isArray(evidence?.placements)
      ? [...new Set(evidence.placements.map((p) => p.campaign_id).filter(Boolean))]
      : [];

  console.log('─'.repeat(60));
  console.log(`Rec id     : ${rec.id}`);
  console.log(`Term       : "${rec.target_text}"`);

  // Primary check: is_targeting in evidence
  if (evidence?.is_targeting === true) {
    console.log(
      '  skipped (product-targeting term — needs negative targeting clause)' +
      ' [evidence.is_targeting=true]',
    );
    console.log('');
    skipped++;
    continue;
  }

  // Belt-and-braces: ISBN-10 regex
  if (ISBN10_RE.test(rec.target_text)) {
    console.log(
      '  skipped (product-targeting term — needs negative targeting clause)' +
      ' [ISBN-10 pattern match]',
    );
    console.log('');
    skipped++;
    continue;
  }

  if (campaignIds.length === 0) {
    console.log('Campaigns  : (none in evidence)');
    console.log('  skipped (no campaigns in evidence)');
    console.log('');
    skipped++;
    continue;
  }

  console.log(`Campaigns  : ${campaignIds.join(', ')}`);
  console.log('');

  // One body batching all campaign_ids for this term
  const requestBody = {
    campaignNegativeKeywords: campaignIds.map((campaignId) => ({
      campaignId,
      keywordText: rec.target_text,
      matchType:   'NEGATIVE_EXACT',
      state:       'ENABLED',
    })),
  };

  console.log(`→ POST ${ENDPOINT}`);
  console.log(`  Headers:`);
  console.log(`    Amazon-Advertising-API-ClientId : <LWA_CLIENT_ID>`);
  console.log(`    Amazon-Advertising-API-Scope    : ${profileIdStr}`);
  console.log(`    Authorization                   : Bearer <access_token>`);
  console.log(`    Content-Type                    : ${MEDIA_TYPE}`);
  console.log(`    Accept                          : ${MEDIA_TYPE}`);
  console.log(`  Body:`);
  console.log(
    JSON.stringify(requestBody, null, 2)
      .split('\n')
      .map((l) => '    ' + l)
      .join('\n'),
  );
  console.log('');

  eligible.push({ rec, requestBody });
}

// ── PLAN TOTALS ───────────────────────────────────────────────────────────────
console.log('─'.repeat(60));
console.log(
  `Totals: ${recs.length} fetched, ${skipped} skipped (product-targeting),` +
  ` ${eligible.length} eligible → ${eligible.length} planned API call(s)`,
);
console.log('');

// ── DRY-RUN EXIT ──────────────────────────────────────────────────────────────
if (!executeMode) {
  await pool.end();
  console.log('DRY RUN complete — nothing written to DB, nothing sent to Amazon.');
  process.exit(0);
}

// ── EXECUTE PATH ──────────────────────────────────────────────────────────────
if (eligible.length === 0) {
  await pool.end();
  console.log('No eligible recs — nothing to execute.');
  process.exit(0);
}

console.log('Waiting 5 s before first API call…');
await new Promise((r) => setTimeout(r, 5_000));

// ── Mint LWA token (once per run; never printed) ──────────────────────────────
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

// Helper: fetch with 30 s AbortController timeout
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
    body: new URLSearchParams({
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

let pushed   = 0;
let partials = 0;

for (const { rec, requestBody } of eligible) {
  console.log('─'.repeat(60));
  console.log(`Executing rec id=${rec.id}  term="${rec.target_text}"…`);

  // ── POST to Amazon ──────────────────────────────────────────────────────────
  const res = await fetchWithTimeout(
    ENDPOINT,
    {
      method:  'POST',
      headers: {
        'Authorization':                    `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId':   LWA_CLIENT_ID,
        'Amazon-Advertising-API-Scope':      profileIdStr,
        'Content-Type':                      MEDIA_TYPE,
        'Accept':                            MEDIA_TYPE,
      },
      body: JSON.stringify(requestBody),
    },
    `campaignNegativeKeywords create rec ${rec.id}`,
  );

  // Print full response verbatim
  const responseText = await res.text();
  console.log(`Response HTTP ${res.status}:`);
  console.log(responseText);
  console.log('');

  // Stop-on-first-failure for non-2xx
  if (!res.ok) {
    console.error(`ERROR ${res.status} — stopping run. Remaining recs stay APPROVED.`);
    await pool.end();
    process.exit(1);
  }

  // ── Parse v3 multi-status response ─────────────────────────────────────────
  // SP v3 batch create returns either:
  //   { campaignNegativeKeywords: { success: [...], error: [...] } }
  // or a flat array variant:
  //   { campaignNegativeKeywords: [ { ..., code: "SUCCESS"|<error> }, ... ] }
  let responseData;
  try {
    responseData = JSON.parse(responseText);
  } catch {
    console.error('ERROR: could not parse response JSON — stopping.');
    await pool.end();
    process.exit(1);
  }

  const cnk = responseData?.campaignNegativeKeywords;
  let successItems = [];
  let errorItems   = [];

  if (cnk && !Array.isArray(cnk) && typeof cnk === 'object') {
    // Object shape: { success: [...], error: [...] }
    successItems = Array.isArray(cnk.success) ? cnk.success : [];
    errorItems   = Array.isArray(cnk.error)   ? cnk.error   : [];
  } else if (Array.isArray(cnk)) {
    // Flat array shape: inspect each item's code
    for (const item of cnk) {
      const code = String(item.code ?? '').toUpperCase();
      if (code === 'SUCCESS' || code === '200' || item.campaignNegativeKeywordId) {
        successItems.push(item);
      } else {
        errorItems.push(item);
      }
    }
  } else {
    // Unexpected shape — treat as failure
    console.error('ERROR: unrecognised response shape — stopping.');
    await pool.end();
    process.exit(1);
  }

  // ── Partial or full error: leave APPROVED ──────────────────────────────────
  if (errorItems.length > 0) {
    const expected = requestBody.campaignNegativeKeywords.length;
    console.log(
      `PARTIAL — left APPROVED (${successItems.length}/${expected} succeeded)`,
    );
    console.log('Failing items:', JSON.stringify(errorItems, null, 2));
    console.log('');
    partials++;
    continue;
  }

  // ── All succeeded: UPDATE DB ────────────────────────────────────────────────
  const pushedKeywordIds = successItems
    .map((item) => item.campaignNegativeKeywordId)
    .filter(Boolean);

  await pool.query(
    `UPDATE recommendations
        SET status    = 'PUSHED',
            pushed_at = now(),
            evidence  = evidence || $1::jsonb
      WHERE id        = $2
        AND status    = 'APPROVED'`,
    [
      JSON.stringify({ push_response: responseData, pushed_keyword_ids: pushedKeywordIds }),
      rec.id,
    ],
  );

  console.log(
    `PUSHED — rec id=${rec.id}, keyword ids: ` +
    (pushedKeywordIds.length ? pushedKeywordIds.join(', ') : '(none returned)'),
  );
  console.log('');
  pushed++;
}

await pool.end();

console.log('─'.repeat(60));
console.log(
  `Execute complete: ${pushed} pushed, ${partials} partial (left APPROVED).`,
);
process.exit(0);
