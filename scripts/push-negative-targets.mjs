// scripts/push-negative-targets.mjs
// Usage: node --env-file=.env.local scripts/push-negative-targets.mjs --profile <id> [--execute]
//
// API NOTE — campaign-level negative product targeting in SP v3:
//   Resource  : POST /sp/campaignNegativeTargets
//   Media type: application/vnd.spCampaignNegativeTargetingClause.v3+json
//   Expression: { type: 'ASIN_SAME_AS', value: <ASIN uppercased> }
//
// ⚠ RESOURCE/EXPRESSION TO CONFIRM:
//   The resource name (campaignNegativeTargets) and expression type
//   (ASIN_SAME_AS) must be verified against the live API's first response.
//   If Amazon returns 404 (unknown resource) or 400 (bad expression shape),
//   that is a FINDING to report back to Christian — do NOT improvise
//   a workaround; stop the run and surface the raw response.
//
// ELIGIBILITY: ISBN-10 shape (/^[0-9]{9}[0-9xX]$/) or B0-ASIN shape (/^b0[a-z0-9]{8}$/i).
//   Matches the ASIN_SHAPE classification in generate-recommendations.mjs.
//   All NEGATE_TARGET recs should already be ASIN-shaped; the filter here is a safety guard.
//   ASINs are uppercased in the expression value (e.g. b0abc12345 → B0ABC12345).

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

// Campaign-level negative product targeting resource.
// ⚠ Resource name and expression type to be confirmed against first response.
const ENDPOINT   = `${host}/sp/campaignNegativeTargets`;
const MEDIA_TYPE = 'application/vnd.spCampaignNegativeTargetingClause.v3+json';

// ── 2. SELECT APPROVED NEGATE_TERM recs ──────────────────────────────────────
const limit = Math.floor(params.push_max_per_run ?? 20);

const { rows: recs } = await pool.query(
  `SELECT id, target_text, evidence
     FROM recommendations
    WHERE profile_id = $1
      AND status     = 'APPROVED'
      AND rec_type   = 'NEGATE_TARGET'
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
  `Found ${recs.length} approved NEGATE_TARGET recommendation(s)` +
  ` (limit: ${limit}, region: ${region})`,
);
console.log('');
console.log('API resource : POST ' + ENDPOINT);
console.log('Content-Type : ' + MEDIA_TYPE);
console.log('Note         : campaign-level negative product targeting.');
console.log('               expression type ASIN_SAME_AS — to be confirmed by live response.');
console.log('               target_text uppercased for ASIN expression value.');
console.log('');

// ── ELIGIBILITY FILTER + PLAN ─────────────────────────────────────────────────
// Eligible: ISBN-10 or B0-ASIN shape — matches generate-recommendations.mjs ASIN_SHAPE.
// NEGATE_TARGET recs are always ASIN-shaped by classification; this is a safety guard.
const ASIN_SHAPE = /^([0-9]{9}[0-9xX]|b0[a-z0-9]{8})$/i;

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

  // Safety guard: all NEGATE_TARGET recs should be ASIN-shaped by classification.
  if (!ASIN_SHAPE.test(rec.target_text)) {
    console.log('  skipped (unexpected non-ASIN shape in NEGATE_TARGET — classification error)');
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

  // ASINs are uppercased in the expression value
  const asinValue = rec.target_text.toUpperCase();
  console.log(`ASIN value : ${asinValue}  (uppercased for expression)`);
  console.log(`Campaigns  : ${campaignIds.join(', ')}`);
  console.log('');

  // One body batching all campaign_ids for this ASIN, one clause each
  const requestBody = {
    campaignNegativeTargetingClauses: campaignIds.map((campaignId) => ({
      campaignId,
      expression: [{ type: 'ASIN_SAME_AS', value: asinValue }],
      state: 'ENABLED',
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
  `Totals: ${recs.length} fetched, ${skipped} skipped (unexpected non-ASIN shape),` +
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

let pushed             = 0;
let partials           = 0;
let totalCreated       = 0;
let totalAlreadyExisted = 0;

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
    `campaignNegativeTargets create rec ${rec.id}`,
  );

  // Print full response verbatim — including 404/400 shape-validation findings
  const responseText = await res.text();
  console.log(`Response HTTP ${res.status}:`);
  console.log(responseText);
  console.log('');

  // Stop-on-first-failure for non-2xx
  // ⚠ If 404 or 400: resource name or expression shape incorrect — report finding.
  if (!res.ok) {
    console.error(
      `ERROR ${res.status} — stopping run. Remaining recs stay APPROVED.` +
      (res.status === 404
        ? ' (404 may indicate wrong resource path — confirm /sp/campaignNegativeTargets)'
        : res.status === 400
        ? ' (400 may indicate wrong expression type — confirm ASIN_SAME_AS shape)'
        : ''),
    );
    await pool.end();
    process.exit(1);
  }

  // ── Parse v3 multi-status response ─────────────────────────────────────────
  // SP v3 batch create returns either:
  //   { campaignNegativeTargetingClauses: { success: [...], error: [...] } }
  // or a flat array variant:
  //   { campaignNegativeTargetingClauses: [ { ..., code: "SUCCESS"|<error> }, ... ] }
  let responseData;
  try {
    responseData = JSON.parse(responseText);
  } catch {
    console.error('ERROR: could not parse response JSON — stopping.');
    await pool.end();
    process.exit(1);
  }

  const cntc = responseData?.campaignNegativeTargetingClauses;
  let successItems = [];
  let errorItems   = [];

  if (cntc && !Array.isArray(cntc) && typeof cntc === 'object') {
    // Object shape: { success: [...], error: [...] }
    successItems = Array.isArray(cntc.success) ? cntc.success : [];
    errorItems   = Array.isArray(cntc.error)   ? cntc.error   : [];
  } else if (Array.isArray(cntc)) {
    // Flat array shape: inspect each item's code
    for (const item of cntc) {
      const code = String(item.code ?? '').toUpperCase();
      if (code === 'SUCCESS' || code === '200' || item.campaignNegativeTargetingClauseId) {
        successItems.push(item);
      } else {
        errorItems.push(item);
      }
    }
  } else {
    // Unexpected shape — report finding, stop
    console.error(
      'ERROR: unrecognised response shape (campaignNegativeTargetingClauses missing' +
      ' or unexpected) — stopping. Report raw response as finding.',
    );
    await pool.end();
    process.exit(1);
  }

  // ── Duplicate-is-satisfied doctrine ────────────────────────────────────────
  // DUPLICATE_VALUE errors mean the clause already exists — desired state reached.
  const duplicateItems   = errorItems.filter((item) => JSON.stringify(item).includes('DUPLICATE_VALUE'));
  const genuineFailItems = errorItems.filter((item) => !JSON.stringify(item).includes('DUPLICATE_VALUE'));

  const createdCampaignIds        = successItems.map((item) => String(item.campaignId ?? '')).filter(Boolean);
  const alreadyExistedCampaignIds = duplicateItems.map((item) => String(item.campaignId ?? '')).filter(Boolean);
  const failedCampaignIds         = genuineFailItems.map((item) => String(item.campaignId ?? '')).filter(Boolean);

  const pushResult = {
    created:         createdCampaignIds,
    already_existed: alreadyExistedCampaignIds,
    failed:          failedCampaignIds,
  };

  // ── Genuine failures → partial (leave APPROVED) ────────────────────────────
  if (genuineFailItems.length > 0) {
    const expected = requestBody.campaignNegativeTargetingClauses.length;
    console.log(
      `PARTIAL — left APPROVED` +
      ` (${successItems.length} created, ${duplicateItems.length} already_existed,` +
      ` ${genuineFailItems.length} genuine fail / ${expected} total)`,
    );
    console.log('Genuine failing items:', JSON.stringify(genuineFailItems, null, 2));
    if (duplicateItems.length > 0) {
      console.log(`Satisfied via duplicate (already_existed): ${duplicateItems.length}`);
    }
    console.log('');
    partials++;
    continue;
  }

  // ── All created OR already_existed → PUSHED ─────────────────────────────────
  const pushedTargetIds = successItems
    .map((item) => item.campaignNegativeTargetingClauseId)
    .filter(Boolean);

  await pool.query(
    `UPDATE recommendations
        SET status    = 'PUSHED',
            pushed_at = now(),
            evidence  = evidence || $1::jsonb
      WHERE id        = $2
        AND status    = 'APPROVED'`,
    [
      JSON.stringify({
        push_response:     responseData,
        pushed_target_ids: pushedTargetIds,
        push_result:       pushResult,
      }),
      rec.id,
    ],
  );

  totalCreated        += createdCampaignIds.length;
  totalAlreadyExisted += alreadyExistedCampaignIds.length;

  console.log(
    `PUSHED — rec id=${rec.id}` +
    ` (${createdCampaignIds.length} created, ${alreadyExistedCampaignIds.length} already_existed)` +
    (pushedTargetIds.length ? `  target ids: ${pushedTargetIds.join(', ')}` : ''),
  );
  console.log('');
  pushed++;
}

await pool.end();

console.log('─'.repeat(60));
console.log(
  `${pushed} pushed (${totalCreated} clauses created, ${totalAlreadyExisted} already existed), ${partials} partial.`,
);
process.exit(0);
