// scripts/push-bid-adjustments.mjs
// Usage: node --env-file=.env.local scripts/push-bid-adjustments.mjs --profile <id> [--execute]
//
// API NOTE — SP v3 target bid update:
//   PUT /sp/targets
//   Content-Type / Accept: application/vnd.spTargetingClause.v3+json
//   Body: { targetingClauses: [ { targetId: <id>, bid: <bid> } ] }
//
// v3 UPDATE resource/shape is to be CONFIRMED by dry-run + first live response.
// 4xx on shape = reported finding — NEVER improvised around.
//
// One PUT per rec (one targetId per call) for clean per-item status tracking.

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

const ENDPOINT   = `${host}/sp/targets`;
const MEDIA_TYPE = 'application/vnd.spTargetingClause.v3+json';

// ── 2. SELECT APPROVED BID_ADJUST recs ───────────────────────────────────────
const limit = Math.floor(params.push_max_per_run ?? 20);

const { rows: recs } = await pool.query(
  `SELECT id, target_text, evidence
     FROM recommendations
    WHERE profile_id = $1
      AND status     = 'APPROVED'
      AND rec_type   = 'BID_ADJUST'
    ORDER BY id
    LIMIT $2`,
  [profileId, limit],
);

if (recs.length === 0) {
  await pool.end();
  console.log('Nothing approved to push.');
  process.exit(0);
}

console.log(
  `Found ${recs.length} approved BID_ADJUST recommendation(s)` +
  ` (limit: ${limit}, region: ${region})`,
);
console.log('');
console.log(`API resource : PUT ${ENDPOINT}`);
console.log(`Content-Type : ${MEDIA_TYPE}`);
console.log('');

// ── Batch-fetch ad group names for dry-run display ────────────────────────────
const adGroupIds = [
  ...new Set(
    recs
      .map(r => {
        const ev = typeof r.evidence === 'string' ? JSON.parse(r.evidence) : r.evidence;
        return ev?.chosen_target?.ad_group_id;
      })
      .filter(Boolean),
  ),
];

const agNameMap = new Map(); // ad_group_id → name
if (adGroupIds.length > 0) {
  const { rows: agRows } = await pool.query(
    `SELECT ad_group_id, name
       FROM amazon_ad_groups
      WHERE profile_id  = $1
        AND ad_group_id = ANY($2)`,
    [profileId, adGroupIds],
  );
  for (const ag of agRows) agNameMap.set(ag.ad_group_id, ag.name);
}

// ── PLAN ──────────────────────────────────────────────────────────────────────
const planned = []; // { rec, chosenTarget, bidToSend, requestBody }
let skipped   = 0;

for (const rec of recs) {
  const evidence     = typeof rec.evidence === 'string'
    ? JSON.parse(rec.evidence)
    : rec.evidence;
  const chosenTarget = evidence?.chosen_target ?? null;

  // Bid to send: approved_bid (user-edited) takes precedence over proposed_bid (engine)
  const bidToSend = evidence?.approved_bid != null
    ? Number(evidence.approved_bid)
    : evidence?.proposed_bid != null
      ? Number(evidence.proposed_bid)
      : null;

  console.log('─'.repeat(60));
  console.log(`Rec id      : ${rec.id}`);
  console.log(`Target text : "${rec.target_text}"`);

  if (!chosenTarget?.target_id) {
    console.log('  skipped (no chosen_target.target_id in evidence)');
    console.log('');
    skipped++;
    continue;
  }

  const agName = agNameMap.get(chosenTarget.ad_group_id) ?? chosenTarget.ad_group_id;
  const curBidFmt  = chosenTarget.current_bid != null
    ? Number(chosenTarget.current_bid).toFixed(2)
    : '—';

  console.log(`Target id   : ${chosenTarget.target_id}`);
  console.log(`Ad group    : ${agName}`);

  if (bidToSend == null) {
    console.log(`Bid         : ${curBidFmt} → (none)`);
    console.log('  skipped (no bid — neither approved_bid nor proposed_bid in evidence)');
    console.log('');
    skipped++;
    continue;
  }

  console.log(`Bid         : ${curBidFmt} → ${bidToSend.toFixed(2)}`);

  const requestBody = {
    targetingClauses: [
      {
        targetId: chosenTarget.target_id,
        bid:      bidToSend,
      },
    ],
  };

  console.log('');
  console.log(`→ PUT ${ENDPOINT}`);
  console.log('  Headers:');
  console.log(`    Amazon-Advertising-API-ClientId : <LWA_CLIENT_ID>`);
  console.log(`    Amazon-Advertising-API-Scope    : ${profileIdStr}`);
  console.log(`    Authorization                   : Bearer <access_token>`);
  console.log(`    Content-Type                    : ${MEDIA_TYPE}`);
  console.log(`    Accept                          : ${MEDIA_TYPE}`);
  console.log('  Body:');
  console.log(
    JSON.stringify(requestBody, null, 2)
      .split('\n')
      .map(l => '    ' + l)
      .join('\n'),
  );
  console.log('');

  planned.push({ rec, chosenTarget, bidToSend, requestBody });
}

// ── PLAN TOTALS ───────────────────────────────────────────────────────────────
console.log('─'.repeat(60));
console.log(
  `Totals: ${recs.length} fetched, ${skipped} skipped, ` +
  `${planned.length} planned API call(s)`,
);
console.log('');

// ── DRY-RUN EXIT ──────────────────────────────────────────────────────────────
if (!executeMode) {
  await pool.end();
  console.log('DRY RUN complete — nothing written to DB, nothing sent to Amazon.');
  process.exit(0);
}

// ── EXECUTE PATH ──────────────────────────────────────────────────────────────
if (planned.length === 0) {
  await pool.end();
  console.log('No planned recs — nothing to execute.');
  process.exit(0);
}

console.log('Waiting 5 s before first API call…');
await new Promise(r => setTimeout(r, 5_000));

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

for (const { rec, chosenTarget, bidToSend, requestBody } of planned) {
  console.log('─'.repeat(60));
  console.log(
    `Executing rec id=${rec.id}  term="${rec.target_text}"` +
    `  target_id=${chosenTarget.target_id}  bid=${bidToSend.toFixed(2)}…`,
  );

  // ── PUT to Amazon ─────────────────────────────────────────────────────────
  const res = await fetchWithTimeout(
    ENDPOINT,
    {
      method:  'PUT',
      headers: {
        'Authorization':                    `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId':   LWA_CLIENT_ID,
        'Amazon-Advertising-API-Scope':      profileIdStr,
        'Content-Type':                      MEDIA_TYPE,
        'Accept':                            MEDIA_TYPE,
      },
      body: JSON.stringify(requestBody),
    },
    `targets update rec ${rec.id}`,
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

  // ── Parse v3 multi-status response ────────────────────────────────────────
  // SP v3 batch update returns either:
  //   { targetingClauses: { success: [...], error: [...] } }
  // or a flat array variant:
  //   { targetingClauses: [ { ..., code: "SUCCESS"|<error> }, ... ] }
  // Exact shape to be confirmed from first live response.
  let responseData;
  try {
    responseData = JSON.parse(responseText);
  } catch {
    console.error('ERROR: could not parse response JSON — stopping.');
    await pool.end();
    process.exit(1);
  }

  const tc = responseData?.targetingClauses;
  let successItems = [];
  let errorItems   = [];

  if (tc && !Array.isArray(tc) && typeof tc === 'object') {
    // Object shape: { success: [...], error: [...] }
    successItems = Array.isArray(tc.success) ? tc.success : [];
    errorItems   = Array.isArray(tc.error)   ? tc.error   : [];
  } else if (Array.isArray(tc)) {
    // Flat array: classify by code field
    for (const item of tc) {
      const code = String(item.code ?? '').toUpperCase();
      if (code === 'SUCCESS' || code === '200' || code === '') {
        successItems.push(item);
      } else {
        errorItems.push(item);
      }
    }
  } else {
    // Unrecognised shape — stop and report
    console.error(
      'ERROR: unrecognised response shape (expected targetingClauses object or array) — stopping.',
    );
    console.error('Full response:', responseText);
    await pool.end();
    process.exit(1);
  }

  // ── Partial or full error: leave APPROVED ──────────────────────────────────
  if (errorItems.length > 0) {
    console.log(
      `PARTIAL — left APPROVED ` +
      `(${successItems.length}/${requestBody.targetingClauses.length} succeeded)`,
    );
    console.log('Failing items:', JSON.stringify(errorItems, null, 2));
    console.log('');
    partials++;
    continue;
  }

  // ── All succeeded: UPDATE DB ──────────────────────────────────────────────
  await pool.query(
    `UPDATE recommendations
        SET status    = 'PUSHED',
            pushed_at = now(),
            evidence  = evidence || $1::jsonb
      WHERE id        = $2
        AND status    = 'APPROVED'`,
    [
      JSON.stringify({
        push_response: responseData,
        pushed_bid:    bidToSend,
      }),
      rec.id,
    ],
  );

  console.log(
    `PUSHED — rec id=${rec.id}, pushed_bid=${bidToSend.toFixed(2)}, ` +
    `target_id=${chosenTarget.target_id}`,
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
