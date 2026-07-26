// scripts/push-keywords.mjs
// Usage: node --env-file=.env.local scripts/push-keywords.mjs --profile <id> [--execute]
//
// API NOTE — SP v3 positive keyword creation (exact-match):
//   POST /sp/keywords
//   Content-Type / Accept: application/vnd.spKeyword.v3+json
//   Body: { keywords: [ { campaignId, adGroupId, keywordText, matchType: 'EXACT',
//                          state: 'ENABLED', bid } ] }
//
// shape confirmed by dry-run + first response; 4xx = finding.
// One POST per rec (one keyword per call) for clean per-item status tracking.

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

const ENDPOINT   = `${host}/sp/keywords`;
const MEDIA_TYPE = 'application/vnd.spKeyword.v3+json';

// ── 2. SELECT APPROVED PROMOTE_TERM recs ─────────────────────────────────────
const limit = Math.floor(params.push_max_per_run ?? 20);

const { rows: recs } = await pool.query(
  `SELECT id, target_text, evidence
     FROM recommendations
    WHERE profile_id = $1
      AND status     = 'APPROVED'
      AND rec_type   = 'PROMOTE_TERM'
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
  `Found ${recs.length} approved PROMOTE_TERM recommendation(s)` +
  ` (limit: ${limit}, region: ${region})`,
);
console.log('');
console.log(`API resource : POST ${ENDPOINT}`);
console.log(`Content-Type : ${MEDIA_TYPE}`);
console.log('');

// ── Pre-parse evidences ───────────────────────────────────────────────────────
const parsedEvidence = recs.map(r =>
  typeof r.evidence === 'string' ? JSON.parse(r.evidence) : r.evidence,
);

// ── 3a. Collect ALL ad_group_ids across ALL candidates' evidence.placements ───
const adGroupIds = [
  ...new Set(
    parsedEvidence.flatMap(ev =>
      Array.isArray(ev?.placements)
        ? ev.placements.map(p => String(p.ad_group_id)).filter(Boolean)
        : [],
    ),
  ),
];

// ── 3b. GROUP CLASSIFICATION — ONE batch query over all placement ad groups ───
// Returns ENABLED keyword counts per group; groups absent from result = zero.
const groupKwMap = new Map(); // ad_group_id (string) → { exactKws, anyKws, hasAuto }
const autoCampaignGroupIds = new Set(); // ad_group_ids whose campaign.targeting_type = 'AUTO'

if (adGroupIds.length > 0) {
  const { rows: groupRows } = await pool.query(
    `SELECT ad_group_id::text,
            count(*) FILTER (WHERE match_type = 'EXACT') AS exact_kws,
            count(*) AS any_kws
       FROM amazon_keywords
      WHERE profile_id  = $1
        AND ad_group_id = ANY($2)
        AND state       = 'ENABLED'
      GROUP BY ad_group_id`,
    [profileId, adGroupIds],
  );
  for (const row of groupRows) {
    groupKwMap.set(row.ad_group_id, {
      exactKws: Number(row.exact_kws),
      anyKws:   Number(row.any_kws),
      hasAuto:  0,
    });
  }
  // has_auto: count FILTER WHERE expression_type='AUTO' > 0 — excludes auto groups from tier selection.
  const { rows: autoRows } = await pool.query(
    `SELECT ad_group_id::text,
            count(*) FILTER (WHERE expression_type = 'AUTO') AS has_auto
       FROM amazon_targets
      WHERE profile_id  = $1
        AND ad_group_id = ANY($2)
        AND state       = 'ENABLED'
      GROUP BY ad_group_id`,
    [profileId, adGroupIds],
  );
  for (const row of autoRows) {
    const entry = groupKwMap.get(row.ad_group_id);
    if (entry) entry.hasAuto = Number(row.has_auto);
    else groupKwMap.set(row.ad_group_id, { exactKws: 0, anyKws: 0, hasAuto: Number(row.has_auto) });
  }
  // Campaign-level AUTO exclusion — targeting_type is the authority; ad-group-level
  // expression checks can be fooled by agency-era manual keywords inside auto campaigns.
  const { rows: autoCampRows } = await pool.query(
    `SELECT ag.ad_group_id::text
       FROM amazon_ad_groups ag
       JOIN amazon_campaigns  c ON c.campaign_id = ag.campaign_id
                                AND c.profile_id  = ag.profile_id
      WHERE ag.profile_id  = $1
        AND ag.ad_group_id = ANY($2)
        AND c.targeting_type = 'AUTO'`,
    [profileId, adGroupIds],
  );
  for (const row of autoCampRows) autoCampaignGroupIds.add(row.ad_group_id);
}

// ── 3c. DUPLICATE CHECK — ONE batch query for all candidates ──────────────────
// Fetch all EXACT ENABLED keywords across the full placement ad-group set,
// then match against (ad_group_id, lower(target_text)) in JS.
const duplicateKeys = new Set(); // 'ad_group_id::lower_text'

if (adGroupIds.length > 0) {
  const { rows: kwRows } = await pool.query(
    `SELECT ad_group_id::text, lower(keyword_text) AS kw_lower
       FROM amazon_keywords
      WHERE profile_id  = $1
        AND match_type  = 'EXACT'
        AND state       = 'ENABLED'
        AND ad_group_id = ANY($2)`,
    [profileId, adGroupIds],
  );
  for (const row of kwRows) {
    duplicateKeys.add(`${row.ad_group_id}::${row.kw_lower}`);
  }
}

// ── 4. Batch-fetch ad group names for display ─────────────────────────────────
const agNameMap = new Map(); // ad_group_id (string) → name
if (adGroupIds.length > 0) {
  const { rows: agRows } = await pool.query(
    `SELECT ad_group_id::text, name
       FROM amazon_ad_groups
      WHERE profile_id  = $1
        AND ad_group_id = ANY($2)`,
    [profileId, adGroupIds],
  );
  for (const ag of agRows) agNameMap.set(ag.ad_group_id, ag.name);
}

// ── 5. PLAN ───────────────────────────────────────────────────────────────────
const planned = []; // { rec, placement, bidToSend, requestBody }
let skipped   = 0;

for (let i = 0; i < recs.length; i++) {
  const rec      = recs[i];
  const evidence = parsedEvidence[i];

  // Bid: approved_bid (user-edited) takes precedence over proposed_bid (engine)
  const rawBid = evidence?.approved_bid != null
    ? Number(evidence.approved_bid)
    : evidence?.proposed_bid != null
      ? Number(evidence.proposed_bid)
      : null;

  console.log('─'.repeat(60));
  console.log(`Rec id      : ${rec.id}`);
  console.log(`Target text : "${rec.target_text}"`);

  // ── Destination resolution (priority: exact-kw group → any-kw group → skip) ─
  const placements = Array.isArray(evidence?.placements) ? evidence.placements : [];

  const tierA = placements
    .filter(p => (groupKwMap.get(String(p.ad_group_id))?.exactKws ?? 0) >= 1
              && (groupKwMap.get(String(p.ad_group_id))?.hasAuto  ?? 0) === 0
              && !autoCampaignGroupIds.has(String(p.ad_group_id)))
    .sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0));
  const tierB = placements
    .filter(p => (groupKwMap.get(String(p.ad_group_id))?.anyKws   ?? 0) >= 1
              && (groupKwMap.get(String(p.ad_group_id))?.hasAuto  ?? 0) === 0
              && !autoCampaignGroupIds.has(String(p.ad_group_id)))
    .sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0));

  let placement = null;
  let destTier  = null;

  if (tierA.length > 0) {
    placement = tierA[0];
    destTier  = 'exact-kw group';
  } else if (tierB.length > 0) {
    placement = tierB[0];
    destTier  = 'any-kw group';
  }

  if (!placement?.ad_group_id || !placement?.campaign_id) {
    console.log('  skipped (no keyword-holding ad group among placements — needs manual destination)');
    console.log('');
    skipped++;
    continue;
  }

  const agKey  = String(placement.ad_group_id);
  const agName = agNameMap.get(agKey) ?? agKey;
  const dupKey = `${agKey}::${rec.target_text.toLowerCase()}`;

  if (duplicateKeys.has(dupKey)) {
    console.log(`Ad group    : ${agName}`);
    console.log(`Dest. tier  : destination tier: ${destTier}`);
    console.log('  skipped (exact keyword already exists in destination ad group)');
    console.log('');
    skipped++;
    continue;
  }

  if (rawBid == null || rawBid < 0.02) {
    console.log(`Ad group    : ${agName}`);
    console.log(`Dest. tier  : destination tier: ${destTier}`);
    console.log(`Bid         : ${rawBid == null ? '(none)' : rawBid}`);
    console.log('  skipped (no valid bid)');
    console.log('');
    skipped++;
    continue;
  }

  const bidToSend = Math.round(rawBid * 100) / 100;

  const requestBody = {
    keywords: [
      {
        campaignId:  String(placement.campaign_id),
        adGroupId:   String(placement.ad_group_id),
        keywordText: rec.target_text,
        matchType:   'EXACT',
        state:       'ENABLED',
        bid:         bidToSend,
      },
    ],
  };

  console.log(`Ad group    : ${agName}`);
  console.log(`Dest. tier  : destination tier: ${destTier}`);
  console.log(`Campaign id : ${placement.campaign_id}`);
  console.log(`Bid         : ${bidToSend.toFixed(2)}`);
  console.log('');
  console.log(`→ POST ${ENDPOINT}`);
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

  planned.push({ rec, placement, bidToSend, requestBody });
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

for (const { rec, placement, bidToSend, requestBody } of planned) {
  console.log('─'.repeat(60));
  console.log(
    `Executing rec id=${rec.id}  term="${rec.target_text}"` +
    `  ad_group=${placement.ad_group_id}  bid=${bidToSend.toFixed(2)}…`,
  );

  // ── POST to Amazon ────────────────────────────────────────────────────────
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
    `keywords create rec ${rec.id}`,
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
  // SP v3 batch create returns either:
  //   { keywords: { success: [ { keywordId, index } ], error: [...] } }
  // or a flat array variant:
  //   { keywords: [ { ..., code: "SUCCESS"|<error> }, ... ] }
  // Exact shape to be confirmed from first live response.
  let responseData;
  try {
    responseData = JSON.parse(responseText);
  } catch {
    console.error('ERROR: could not parse response JSON — stopping.');
    await pool.end();
    process.exit(1);
  }

  const kws = responseData?.keywords;
  let successItems    = [];
  let errorItems      = [];
  let pushedKeywordId = null;

  if (kws && !Array.isArray(kws) && typeof kws === 'object') {
    // Object shape: { success: [...], error: [...] }
    successItems    = Array.isArray(kws.success) ? kws.success : [];
    errorItems      = Array.isArray(kws.error)   ? kws.error   : [];
    pushedKeywordId = successItems[0]?.keywordId ?? null;
  } else if (Array.isArray(kws)) {
    // Flat array: classify by code field
    for (const item of kws) {
      const code = String(item.code ?? '').toUpperCase();
      if (code === 'SUCCESS' || code === '200' || code === '') {
        successItems.push(item);
      } else {
        errorItems.push(item);
      }
    }
    pushedKeywordId = successItems[0]?.keywordId ?? null;
  } else {
    // Unrecognised shape — stop and report
    console.error(
      'ERROR: unrecognised response shape (expected keywords object or array) — stopping.',
    );
    console.error('Full response:', responseText);
    await pool.end();
    process.exit(1);
  }

  // ── Partial or full error: leave APPROVED ─────────────────────────────────
  if (errorItems.length > 0) {
    console.log(
      `PARTIAL — left APPROVED ` +
      `(${successItems.length}/${requestBody.keywords.length} succeeded)`,
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
        push_response:     responseData,
        pushed_keyword_id: pushedKeywordId,
        pushed_bid:        bidToSend,
      }),
      rec.id,
    ],
  );

  console.log(
    `PUSHED — rec id=${rec.id}, pushed_keyword_id=${pushedKeywordId}, ` +
    `pushed_bid=${bidToSend.toFixed(2)}, ad_group=${placement.ad_group_id}`,
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
