// scripts/push-negatives.mjs
// Usage: node --env-file=.env.local scripts/push-negatives.mjs --profile <id>
//
// API NOTE — campaign-level vs ad-group-level negative keywords in SP v3:
//   POST /sp/negativeKeywords          → ad-group-level  (requires adGroupId)
//   POST /sp/campaignNegativeKeywords  → campaign-level  (campaignId only)
//
// Because evidence.campaign_ids contains campaign IDs with no adGroupId,
// this script plans against campaignNegativeKeywords exclusively.
// Media type: application/vnd.spCampaignNegativeKeyword.v3+json

import { parseArgs } from 'node:util';
import { Pool, neonConfig } from '@neondatabase/serverless';

// Node 22+ native WebSocket
neonConfig.webSocketConstructor = WebSocket;

// ── Args ─────────────────────────────────────────────────────────────────────
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { profile: { type: 'string' } },
});
if (!values.profile) throw new Error('--profile <id> required');
const profileId    = BigInt(values.profile);
const profileIdStr = String(profileId);

// ── DB ───────────────────────────────────────────────────────────────────────
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
const pool = new Pool({ connectionString: DATABASE_URL });

// First line — always
console.log('DRY RUN — no API calls will be made');
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

// ── Profile → region ─────────────────────────────────────────────────────────
const { rows: profileRows } = await pool.query(
  `SELECT region FROM amazon_profiles WHERE profile_id = $1`,
  [profileId],
);
if (!profileRows.length) {
  await pool.end();
  throw new Error(`Profile ${profileIdStr} not found`);
}
const { region } = profileRows[0];

const REGION_HOST = {
  NA: 'https://advertising-api.amazon.com',
  EU: 'https://advertising-api-eu.amazon.com',
  FE: 'https://advertising-api-fe.amazon.com',
};
const host = REGION_HOST[region];
if (!host) throw new Error(`Unknown region: ${region}`);

// Campaign-level negative keywords → campaignNegativeKeywords resource.
// (Ad-group-level negativeKeywords is a separate resource requiring adGroupId.)
const ENDPOINT    = `${host}/sp/campaignNegativeKeywords`;
const MEDIA_TYPE  = 'application/vnd.spCampaignNegativeKeyword.v3+json';

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

await pool.end();

if (recs.length === 0) {
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

// ── 3–4. BUILD AND PRINT PLAN ─────────────────────────────────────────────────
// One POST per recommendation; each body batches all campaign_ids for that term.
let totalApiCalls = 0;

for (const rec of recs) {
  const evidence    = typeof rec.evidence === 'string'
    ? JSON.parse(rec.evidence)
    : rec.evidence;
  const campaignIds = Array.isArray(evidence?.campaign_ids)
    ? evidence.campaign_ids
    : [];

  const bar = '─'.repeat(60);
  console.log(bar);
  console.log(`Rec id     : ${rec.id}`);
  console.log(`Term       : "${rec.target_text}"`);

  if (campaignIds.length === 0) {
    console.log('Campaigns  : (none in evidence — no API call planned)');
    console.log('');
    continue;
  }

  console.log(`Campaigns  : ${campaignIds.join(', ')}`);
  console.log('');

  // One body batching all campaign entries for this term.
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
  totalApiCalls++;
}

// ── 5. TOTALS ────────────────────────────────────────────────────────────────
console.log('─'.repeat(60));
console.log(
  `Totals: ${recs.length} recommendation(s) → ${totalApiCalls} planned API call(s)`,
);
console.log('');
console.log('DRY RUN complete — nothing written to DB, nothing sent to Amazon.');

// ── 5. NO DB WRITES. NO AMAZON CALLS. ────────────────────────────────────────
process.exit(0);
