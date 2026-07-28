// scripts/push-budget-adjustments.mjs
// Usage: node --env-file=.env.local scripts/push-budget-adjustments.mjs --profile <id> [--execute]
//
// API NOTE — SP v3 campaign update:
//   PUT /sp/campaigns
//   Content-Type / Accept: application/vnd.spCampaign.v3+json
//   Body (BUDGET_ADJUST):  { campaigns: [ { campaignId: <id>, budget: { budget: <amount>, budgetType: 'DAILY' } } ] }
//   Body (PAUSE_CAMPAIGN): { campaigns: [ { campaignId: <id>, state: 'PAUSED' } ] }
//
// Update shapes confirmed by first contact; a 4xx is a finding — paste it
// verbatim, never improvise around it.
//
// One PUT per rec (one campaign per call) for clean per-item status tracking.

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

console.log(
  executeMode
    ? 'EXECUTE MODE — real API calls follow'
    : 'DRY RUN — no API calls will be made',
);
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

const CAMPAIGNS_ENDPOINT = `${host}/sp/campaigns`;
const CAMPAIGNS_MEDIA    = 'application/vnd.spCampaign.v3+json';

// ── SELECT APPROVED BUDGET_ADJUST + PAUSE_CAMPAIGN recs ──────────────────────
const { rows: recs } = await pool.query(
  `SELECT id, rec_type, target_text, evidence
     FROM recommendations
    WHERE profile_id = $1
      AND status     = 'APPROVED'
      AND rec_type   = ANY($2)
    ORDER BY id`,
  [profileId, ['BUDGET_ADJUST', 'PAUSE_CAMPAIGN']],
);

if (recs.length === 0) {
  await pool.end();
  console.log('Nothing approved to push.');
  process.exit(0);
}

console.log(
  `Found ${recs.length} approved recommendation(s)` +
  ` (BUDGET_ADJUST + PAUSE_CAMPAIGN, region: ${region})`,
);
console.log('');
console.log(`API resource: PUT ${CAMPAIGNS_ENDPOINT}`);
console.log(`Media type  : ${CAMPAIGNS_MEDIA}`);
console.log('');

// ── PLAN ──────────────────────────────────────────────────────────────────────
const planned = []; // { rec, campaignId, recType, requestBody, displaySummary }
let skipped   = 0;

for (const rec of recs) {
  const evidence   = typeof rec.evidence === 'string'
    ? JSON.parse(rec.evidence)
    : rec.evidence;
  const campaignId = evidence?.campaign_id ?? rec.target_text;
  const recType    = rec.rec_type;

  console.log('─'.repeat(60));
  console.log(`Rec id      : ${rec.id}`);
  console.log(`Rec type    : ${recType}`);
  console.log(`Campaign id : ${campaignId}`);
  console.log(`Target text : "${rec.target_text}"`);

  if (!campaignId) {
    console.log('  skipped (no campaign_id in evidence or target_text)');
    console.log('');
    skipped++;
    continue;
  }

  let requestBody;
  let displaySummary;

  if (recType === 'BUDGET_ADJUST') {
    const proposedBudget = evidence?.proposed_budget != null
      ? Number(evidence.proposed_budget)
      : null;
    if (proposedBudget == null) {
      console.log('  skipped (no proposed_budget in evidence)');
      console.log('');
      skipped++;
      continue;
    }
    requestBody    = { campaigns: [{ campaignId, budget: { budget: proposedBudget, budgetType: 'DAILY' } }] };
    displaySummary = `budget → ${proposedBudget.toFixed(2)} DAILY`;
    console.log(`Action      : raise budget to ${proposedBudget.toFixed(2)}`);
  } else {
    // PAUSE_CAMPAIGN
    requestBody    = { campaigns: [{ campaignId, state: 'PAUSED' }] };
    displaySummary = `state → PAUSED`;
    console.log(`Action      : pause campaign`);
  }

  console.log('');
  console.log(`→ PUT ${CAMPAIGNS_ENDPOINT}`);
  console.log('  Headers:');
  console.log(`    Amazon-Advertising-API-ClientId : <LWA_CLIENT_ID>`);
  console.log(`    Amazon-Advertising-API-Scope    : ${profileIdStr}`);
  console.log(`    Authorization                   : Bearer <access_token>`);
  console.log(`    Content-Type                    : ${CAMPAIGNS_MEDIA}`);
  console.log(`    Accept                          : ${CAMPAIGNS_MEDIA}`);
  console.log('  Body:');
  console.log(
    JSON.stringify(requestBody, null, 2)
      .split('\n')
      .map(l => '    ' + l)
      .join('\n'),
  );
  console.log('');

  planned.push({ rec, campaignId, recType, requestBody, displaySummary });
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

for (const { rec, campaignId, recType, requestBody, displaySummary } of planned) {
  console.log('─'.repeat(60));
  console.log(
    `Executing rec id=${rec.id}  type=${recType}  campaign=${campaignId}  action: ${displaySummary}…`,
  );

  // ── PUT to Amazon ─────────────────────────────────────────────────────────
  const res = await fetchWithTimeout(
    CAMPAIGNS_ENDPOINT,
    {
      method:  'PUT',
      headers: {
        'Authorization':                   `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId':  LWA_CLIENT_ID,
        'Amazon-Advertising-API-Scope':     profileIdStr,
        'Content-Type':                     CAMPAIGNS_MEDIA,
        'Accept':                           CAMPAIGNS_MEDIA,
      },
      body: JSON.stringify(requestBody),
    },
    `${recType} campaign ${campaignId}`,
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
  // SP v3 campaign update returns { campaigns: { success: [...], error: [...] } }
  // or flat array variant. Update shapes confirmed by first contact; a 4xx is a
  // finding — paste it verbatim, never improvise around it.
  let responseData;
  try {
    responseData = JSON.parse(responseText);
  } catch {
    console.error('ERROR: could not parse response JSON — stopping.');
    await pool.end();
    process.exit(1);
  }

  const tc = responseData?.campaigns;
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
      'ERROR: unrecognised response shape (expected campaigns object or array) — stopping.',
    );
    console.error('Full response:', responseText);
    await pool.end();
    process.exit(1);
  }

  // ── Partial or full error: leave APPROVED ─────────────────────────────────
  if (errorItems.length > 0) {
    console.log(
      `PARTIAL — left APPROVED ` +
      `(${successItems.length}/1 succeeded)`,
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
        push_result: responseData,
        pushed_at:   new Date().toISOString(),
      }),
      rec.id,
    ],
  );

  console.log(
    `PUSHED — rec id=${rec.id}  type=${recType}  campaign=${campaignId}  action: ${displaySummary}`,
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
