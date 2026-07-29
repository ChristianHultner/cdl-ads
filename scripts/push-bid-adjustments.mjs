// scripts/push-bid-adjustments.mjs
// Usage: node --env-file=.env.local scripts/push-bid-adjustments.mjs --profile <id> [--execute]
//
// API NOTE — SP v3 target bid update:
//   PUT /sp/targets
//   Content-Type / Accept: application/vnd.spTargetingClause.v3+json
//   Body: { targetingClauses: [ { targetId: <id>, bid: <bid> } ] }
//
// API NOTE — SP v3 keyword bid update:
//   PUT /sp/keywords
//   Content-Type / Accept: application/vnd.spKeyword.v3+json
//   Body: { keywords: [ { keywordId: <id>, bid: <bid> } ] }
//
// Keyword update shape confirmed by first contact; 4xx = finding, never improvised.
//
// v3 UPDATE resource/shape is to be CONFIRMED by dry-run + first live response.
// 4xx on shape = reported finding — NEVER improvised around.
//
// One PUT per rec (one entity per call) for clean per-item status tracking.

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

const TARGETS_ENDPOINT  = `${host}/sp/targets`;
const TARGETS_MEDIA     = 'application/vnd.spTargetingClause.v3+json';
const KEYWORDS_ENDPOINT = `${host}/sp/keywords`;
const KEYWORDS_MEDIA    = 'application/vnd.spKeyword.v3+json';

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
console.log(`API resources: PUT ${TARGETS_ENDPOINT} (TARGET/AUTO_STRATEGY)`);
console.log(`             : PUT ${KEYWORDS_ENDPOINT} (KEYWORD)`);
console.log('');

// ── Batch-fetch ad group names for dry-run display ────────────────────────────
const adGroupIds = [
  ...new Set(
    recs
      .flatMap(r => {
        const ev = typeof r.evidence === 'string' ? JSON.parse(r.evidence) : r.evidence;
        return [ev?.ad_group_id, ev?.chosen_target?.ad_group_id];
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
const planned = []; // { rec, entityKind, entityId, bidToSend, endpoint, mediaType, requestBody }
let skipped   = 0;

for (const rec of recs) {
  const evidence    = typeof rec.evidence === 'string'
    ? JSON.parse(rec.evidence)
    : rec.evidence;
  const entityKind  = evidence?.entity_kind ?? 'TARGET'; // default TARGET for v5-era recs

  // Bid to send: approved_bid (user-edited) takes precedence over proposed_bid (engine)
  const bidToSend = evidence?.approved_bid != null
    ? Number(evidence.approved_bid)
    : evidence?.proposed_bid != null
      ? Number(evidence.proposed_bid)
      : null;

  // ── REVIVE: one rec → all ENABLED targets+keywords in campaign ─────────────
  if (evidence?.kind === 'REVIVE') {
    const reviveCampId = String(evidence.campaign_id ?? rec.target_text);
    const proposedBid  = evidence?.approved_bid != null
      ? Number(evidence.approved_bid)
      : evidence?.proposed_bid != null
        ? Number(evidence.proposed_bid)
        : null;

    // Fetch campaign name.
    const { rows: campNameRows } = await pool.query(
      `SELECT name FROM amazon_campaigns
        WHERE profile_id = $1 AND campaign_id::text = $2`,
      [profileId, reviveCampId],
    );
    const campName = campNameRows[0]?.name ?? reviveCampId;

    console.log('─'.repeat(60));
    console.log(`Rec id        : ${rec.id}  [REVIVE]`);
    console.log(`Campaign      : "${campName}" (${reviveCampId})`);

    if (proposedBid == null) {
      console.log('  skipped [REVIVE] (no proposed_bid in evidence)');
      console.log('');
      skipped++;
      continue;
    }

    // Fetch ALL ENABLED targets + keywords in this campaign.
    const { rows: reviveTargetRows } = await pool.query(
      `SELECT target_id::text AS entity_id, bid::float AS current_bid
         FROM amazon_targets
        WHERE profile_id       = $1
          AND campaign_id::text = $2
          AND state            = 'ENABLED'
          AND bid              IS NOT NULL`,
      [profileId, reviveCampId],
    );
    const { rows: reviveKeywordRows } = await pool.query(
      `SELECT keyword_id::text AS entity_id, bid::float AS current_bid
         FROM amazon_keywords
        WHERE profile_id       = $1
          AND campaign_id::text = $2
          AND state            = 'ENABLED'
          AND bid              IS NOT NULL`,
      [profileId, reviveCampId],
    );

    const nTargets  = reviveTargetRows.length;
    const nKeywords = reviveKeywordRows.length;
    const nTotal    = nTargets + nKeywords;

    console.log(`Entities      : ${nTargets} target(s), ${nKeywords} keyword(s)`);

    if (nTotal === 0) {
      console.log('  skipped [REVIVE] (no ENABLED targets or keywords in campaign)');
      console.log('');
      skipped++;
      continue;
    }

    const allBids = [
      ...reviveTargetRows.map(r  => r.current_bid),
      ...reviveKeywordRows.map(r => r.current_bid),
    ].filter(b => b != null).map(Number);
    const bidMin = allBids.length ? Math.min(...allBids) : null;
    const bidMax = allBids.length ? Math.max(...allBids) : null;

    console.log(
      `Bid range     : ${bidMin != null ? bidMin.toFixed(2) : '—'}` +
      `–${bidMax != null ? bidMax.toFixed(2) : '—'} → ${proposedBid.toFixed(2)}`,
    );

    // First batch body only (keywords first if present, else targets).
    const firstBatchBody = nKeywords > 0
      ? { keywords: reviveKeywordRows.map(r => ({ keywordId: r.entity_id, bid: proposedBid })) }
      : { targetingClauses: reviveTargetRows.map(r => ({ targetId: r.entity_id, bid: proposedBid })) };
    console.log('First batch:');
    console.log(
      JSON.stringify(firstBatchBody, null, 2)
        .split('\n')
        .map(l => '  ' + l)
        .join('\n'),
    );
    console.log('');

    planned.push({
      isRevive: true,
      rec,
      reviveCampId,
      campName,
      proposedBid,
      targets:  reviveTargetRows,
      keywords: reviveKeywordRows,
      bidMin,
      bidMax,
    });
    continue;
  }

  console.log('─'.repeat(60));
  console.log(`Rec id      : ${rec.id}`);
  console.log(`Entity kind : ${entityKind}`);
  console.log(`Target text : "${rec.target_text}"`);

  // Entity ID: v6 uses evidence.entity_id; v5-era TARGET falls back to chosen_target.target_id.
  const chosenTarget = evidence?.chosen_target ?? null;
  const entityId     = entityKind === 'KEYWORD'
    ? (evidence?.entity_id ?? null)
    : (evidence?.entity_id ?? chosenTarget?.target_id ?? null);
  const agId         = evidence?.ad_group_id ?? chosenTarget?.ad_group_id ?? null;
  const agName       = (agId ? agNameMap.get(agId) : null) ?? agId ?? '—';
  const currentBid   = evidence?.current_bid ?? chosenTarget?.current_bid ?? null;
  const curBidFmt    = currentBid != null ? Number(currentBid).toFixed(2) : '—';

  if (!entityId) {
    console.log('  skipped (no entity id in evidence)');
    console.log('');
    skipped++;
    continue;
  }

  console.log(`Entity id   : ${entityId}`);
  console.log(`Ad group    : ${agName}`);

  if (bidToSend == null) {
    console.log(`Bid         : ${curBidFmt} → (none)`);
    console.log('  skipped (no bid — neither approved_bid nor proposed_bid in evidence)');
    console.log('');
    skipped++;
    continue;
  }

  console.log(`Bid         : ${curBidFmt} → ${bidToSend.toFixed(2)}`);

  // Route endpoint and build request body by entity kind.
  let endpoint, mediaType, requestBody;
  if (entityKind === 'KEYWORD') {
    endpoint    = KEYWORDS_ENDPOINT;
    mediaType   = KEYWORDS_MEDIA;
    requestBody = { keywords: [{ keywordId: entityId, bid: bidToSend }] };
  } else {
    // TARGET or AUTO_STRATEGY
    endpoint    = TARGETS_ENDPOINT;
    mediaType   = TARGETS_MEDIA;
    requestBody = { targetingClauses: [{ targetId: entityId, bid: bidToSend }] };
  }

  console.log('');
  console.log(`→ PUT ${endpoint}`);
  console.log('  Headers:');
  console.log(`    Amazon-Advertising-API-ClientId : <LWA_CLIENT_ID>`);
  console.log(`    Amazon-Advertising-API-Scope    : ${profileIdStr}`);
  console.log(`    Authorization                   : Bearer <access_token>`);
  console.log(`    Content-Type                    : ${mediaType}`);
  console.log(`    Accept                          : ${mediaType}`);
  console.log('  Body:');
  console.log(
    JSON.stringify(requestBody, null, 2)
      .split('\n')
      .map(l => '    ' + l)
      .join('\n'),
  );
  console.log('');

  planned.push({ rec, entityKind, entityId, bidToSend, endpoint, mediaType, requestBody });
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

// Helper: PUT one REVIVE batch; aborts on non-2xx (same pattern as the main execute loop).
const putReviveBatch = async (batchEndpoint, batchMedia, body, label) => {
  const res = await fetchWithTimeout(
    batchEndpoint,
    {
      method:  'PUT',
      headers: {
        'Authorization':                    `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId':   LWA_CLIENT_ID,
        'Amazon-Advertising-API-Scope':      profileIdStr,
        'Content-Type':                      batchMedia,
        'Accept':                            batchMedia,
      },
      body: JSON.stringify(body),
    },
    label,
  );
  const responseText = await res.text();
  console.log(`Response HTTP ${res.status} (${label}):`);
  console.log(responseText);
  console.log('');
  if (!res.ok) {
    console.error(`ERROR ${res.status} on ${label} — stopping run. Remaining recs stay APPROVED.`);
    await pool.end();
    process.exit(1);
  }
  let responseData;
  try { responseData = JSON.parse(responseText); } catch {
    console.error('ERROR: could not parse response JSON — stopping.');
    await pool.end();
    process.exit(1);
  }
  const responseKey = label.startsWith('KEYWORD') ? 'keywords' : 'targetingClauses';
  const tc          = responseData?.[responseKey];
  let successItems  = [];
  let errorItems    = [];
  if (tc && !Array.isArray(tc) && typeof tc === 'object') {
    successItems = Array.isArray(tc.success) ? tc.success : [];
    errorItems   = Array.isArray(tc.error)   ? tc.error   : [];
  } else if (Array.isArray(tc)) {
    for (const itm of tc) {
      const code = String(itm.code ?? '').toUpperCase();
      if (code === 'SUCCESS' || code === '200' || code === '') successItems.push(itm);
      else errorItems.push(itm);
    }
  } else {
    console.error(`ERROR: unrecognised response shape (expected ${responseKey}) — stopping.`);
    console.error('Full response:', responseText);
    await pool.end();
    process.exit(1);
  }
  if (errorItems.length > 0) {
    console.log(
      `PARTIAL on ${label} — ${successItems.length}/` +
      `${successItems.length + errorItems.length} succeeded.`,
    );
    console.log('Failing items:', JSON.stringify(errorItems, null, 2));
  }
  return { successItems, errorItems, ok: errorItems.length === 0 };
};

for (const item of planned) {
  // ── REVIVE execute path ────────────────────────────────────────────────────
  if (item.isRevive) {
    const { rec, reviveCampId, campName, proposedBid, targets, keywords } = item;
    console.log('─'.repeat(60));
    console.log(
      `Executing [REVIVE] rec id=${rec.id}  campaign="${campName}"` +
      `  targets=${targets.length}  keywords=${keywords.length}  bid→${proposedBid.toFixed(2)}…`,
    );

    let reviveKeywordsPushed = 0;
    let reviveTargetsPushed  = 0;
    let revivePartial        = false;

    // Batch keywords first.
    if (keywords.length > 0) {
      const body   = { keywords: keywords.map(r => ({ keywordId: r.entity_id, bid: proposedBid })) };
      const result = await putReviveBatch(
        KEYWORDS_ENDPOINT, KEYWORDS_MEDIA, body, `KEYWORD batch rec ${rec.id}`,
      );
      if (result.ok) reviveKeywordsPushed = keywords.length;
      else           revivePartial        = true;
    }

    // Batch targets (short inter-batch delay when both kinds present).
    if (targets.length > 0) {
      if (keywords.length > 0) await new Promise(r => setTimeout(r, 1_000));
      const body   = { targetingClauses: targets.map(r => ({ targetId: r.entity_id, bid: proposedBid })) };
      const result = await putReviveBatch(
        TARGETS_ENDPOINT, TARGETS_MEDIA, body, `TARGET batch rec ${rec.id}`,
      );
      if (result.ok) reviveTargetsPushed = targets.length;
      else           revivePartial       = true;
    }

    if (revivePartial) {
      console.log(
        `PARTIAL [REVIVE] rec id=${rec.id} — left APPROVED ` +
        `(keywords: ${reviveKeywordsPushed}/${keywords.length}, targets: ${reviveTargetsPushed}/${targets.length}).`,
      );
      partials++;
    } else {
      await pool.query(
        `UPDATE recommendations
            SET status    = 'PUSHED',
                pushed_at = now(),
                evidence  = evidence || $1::jsonb
          WHERE id        = $2
            AND status    = 'APPROVED'`,
        [
          JSON.stringify({
            pushed_at:        new Date().toISOString(),
            entities_updated: { keywords: reviveKeywordsPushed, targets: reviveTargetsPushed },
          }),
          rec.id,
        ],
      );
      console.log(
        `PUSHED [REVIVE] rec id=${rec.id} — entities_updated: ` +
        `keywords=${reviveKeywordsPushed}, targets=${reviveTargetsPushed}`,
      );
      pushed++;
    }
    console.log('');
    continue;
  }

  // ── Normal single-entity path ───────────────────────────────────────────────
  const { rec, entityKind, entityId, bidToSend, endpoint, mediaType, requestBody } = item;
  console.log('─'.repeat(60));
  console.log(
    `Executing rec id=${rec.id}  term="${rec.target_text}"` +
    `  entity_kind=${entityKind}  entity_id=${entityId}  bid=${bidToSend.toFixed(2)}…`,
  );

  // ── PUT to Amazon ─────────────────────────────────────────────────────────
  const res = await fetchWithTimeout(
    endpoint,
    {
      method:  'PUT',
      headers: {
        'Authorization':                    `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId':   LWA_CLIENT_ID,
        'Amazon-Advertising-API-Scope':      profileIdStr,
        'Content-Type':                      mediaType,
        'Accept':                            mediaType,
      },
      body: JSON.stringify(requestBody),
    },
    `${entityKind.toLowerCase()} update rec ${rec.id}`,
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

  // Response container key: 'keywords' for KEYWORD, 'targetingClauses' for TARGET/AUTO_STRATEGY.
  const responseKey = entityKind === 'KEYWORD' ? 'keywords' : 'targetingClauses';
  const tc = responseData?.[responseKey];
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
      `ERROR: unrecognised response shape (expected ${responseKey} object or array) — stopping.`,
    );
    console.error('Full response:', responseText);
    await pool.end();
    process.exit(1);
  }

  // ── Partial or full error: leave APPROVED ──────────────────────────────────
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
        push_response: responseData,
        pushed_bid:    bidToSend,
      }),
      rec.id,
    ],
  );

  console.log(
    `PUSHED — rec id=${rec.id}, pushed_bid=${bidToSend.toFixed(2)}, ` +
    `entity_kind=${entityKind}  entity_id=${entityId}`,
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
