// scripts/push-structure.mjs
// Usage: node --env-file=.env.local scripts/push-structure.mjs --profile <id> [--execute]
//
// CAPABILITY 6 — CREATE_STRUCTURE executor.
// Reads APPROVED CREATE_STRUCTURE recs and creates three resources per rec:
//   (a) Sponsored Products campaign   POST /sp/campaigns
//   (b) Ad group                      POST /sp/adGroups
//   (c) Product ads (seed ASINs)      POST /sp/productAds
//
// ⚠  CAMPAIGNS ARE CREATED PAUSED DELIBERATELY.
//    Christian enables in console after inspection, or a later frame
//    flips state after verification. Never change state: 'PAUSED' here.
//
// NOTE (startDate): SP v3 campaigns require ISO "YYYY-MM-DD" (confirmed via 400 regex).

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

// ── Config ───────────────────────────────────────────────────────────────────
const STRUCTURE_MAX_PER_RUN = 2;     // v1 hard cap; never increase without Christian's ruling
const DELAY_MS              = 5_000;
const TIMEOUT_MS            = 30_000;
const DEFAULT_BID           = 0.75;  // platform fallback when evidence carries no bid info

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
if (!host) {
  await pool.end();
  throw new Error(`Unknown region: ${region}`);
}

// ── Date helper ───────────────────────────────────────────────────────────────
// SP v3 campaigns startDate: confirmed shape is ISO "YYYY-MM-DD" (e.g. "2026-07-27").
const todayISODate = () => new Date().toISOString().slice(0, 10);

// Bid resolver: proposed_default_bid → max per-keyword bid → DEFAULT_BID. Never null.
// Covers cluster_kw_room evidence that carries per-keyword bids but no top-level bid.
const resolveDefaultBid = (ev) =>
  ev.proposed_default_bid
  ?? (ev.keywords?.length ? Math.max(...ev.keywords.map(k => k.bid ?? 0)) : undefined)
  ?? DEFAULT_BID;

// ── 1. SELECT APPROVED CREATE_STRUCTURE recs (PUSHED guard via status filter) ─
const { rows: recs } = await pool.query(
  `SELECT id, target_text, evidence
     FROM recommendations
    WHERE profile_id = $1
      AND rec_type   = 'CREATE_STRUCTURE'
      AND status     = 'APPROVED'
    ORDER BY id
    LIMIT $2`,
  [profileId, STRUCTURE_MAX_PER_RUN],
);

console.log(
  `Found ${recs.length} APPROVED CREATE_STRUCTURE rec(s)` +
  ` (cap ${STRUCTURE_MAX_PER_RUN}, region ${region})`,
);
console.log('');

if (recs.length === 0) {
  await pool.end();
  console.log('Nothing to push.');
  process.exit(0);
}

// ── 2. DRY-RUN — print all three bodies per rec verbatim, then exit ───────────
if (!executeMode) {
  for (const rec of recs) {
    const ev           = typeof rec.evidence === 'string' ? JSON.parse(rec.evidence) : rec.evidence;
    const targetText   = rec.target_text;
    const campaignName = ev.campaign_name ?? (targetText.startsWith('CDL | ') ? targetText : `CDL | SP | ${targetText}`);
    const seedAsins    = ev.seed_asins ?? [];

    console.log('─'.repeat(60));
    console.log(`Rec id      : ${rec.id}`);
    console.log(`Target text : ${targetText}`);
    console.log(`Orphan recs : ${ev.orphan_rec_ids?.length ?? 0}`);
    console.log(`Seed ASINs  : ${seedAsins.length}`);
    console.log(`Default bid : $${ev.proposed_default_bid}`);
    console.log('');

    // 2a. CAMPAIGN
    // Evidence overrides: targeting_type (AUTO → API auto; absent → MANUAL) and budget.
    // Manual creative arc paths are bit-identical (evTargetingType defaults to 'MANUAL').
    const evTargetingType = ev.targeting_type?.toUpperCase() === 'AUTO' ? 'AUTO' : 'MANUAL';
    const evDailyBudget   = (typeof ev.budget === 'number' && ev.budget > 0) ? ev.budget : 3.00;

    const campaignBody = {
      campaigns: [
        {
          name:           campaignName,
          targetingType:  evTargetingType,
          state:          'PAUSED',
          ...(evTargetingType === 'MANUAL' ? { dynamicBidding: { strategy: 'LEGACY_FOR_SALES' } } : {}),
          budget:         { budgetType: 'DAILY', budget: evDailyBudget },
          startDate:      todayISODate(),
        },
      ],
    };
    console.log(`[DRY-RUN] POST ${host}/sp/campaigns`);
    console.log('  Content-Type: application/vnd.spCampaign.v3+json');
    console.log(JSON.stringify(campaignBody, null, 2));
    console.log('');

    // 2b. AD GROUP
    const adGroupBody = {
      adGroups: [
        {
          campaignId:  '<created_campaign_id>',
          name:        targetText,
          state:       'ENABLED',
          defaultBid:  resolveDefaultBid(ev),
        },
      ],
    };
    console.log(`[DRY-RUN] POST ${host}/sp/adGroups`);
    console.log('  Content-Type: application/vnd.spAdGroup.v3+json');
    console.log(JSON.stringify(adGroupBody, null, 2));
    console.log('');

    // 2c. PRODUCT ADS
    const productAdsBody = {
      productAds: seedAsins.map((s) => ({
        campaignId: '<created_campaign_id>',
        adGroupId:  '<created_ad_group_id>',
        asin:       s.asin.toUpperCase(),
        state:      'ENABLED',
      })),
    };
    console.log(`[DRY-RUN] POST ${host}/sp/productAds  (${seedAsins.length} items)`);
    console.log('  Content-Type: application/vnd.spProductAd.v3+json');
    console.log(JSON.stringify(productAdsBody, null, 2));
    console.log('');
  }

  await pool.end();
  console.log('DRY RUN complete — nothing written to DB, nothing sent to Amazon.');
  process.exit(0);
}

// ── EXECUTE PATH ──────────────────────────────────────────────────────────────
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

// fetchWithTimeout: 30 s AbortController; abort = exit(1)
async function fetchWithTimeout(url, opts, label) {
  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      console.error(`ABORTED (30 s timeout): ${label}`);
      await pool.end();
      process.exit(1);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Multi-status parser: handles { success: [...], error: [...] } and flat-array shapes.
// idField = the id property to extract from success items.
function parseMultiStatus(container, idField) {
  if (!container) return { ids: [], errors: [] };
  if (!Array.isArray(container) && typeof container === 'object') {
    const success = Array.isArray(container.success) ? container.success : [];
    const error   = Array.isArray(container.error)   ? container.error
                  : Array.isArray(container.errors)  ? container.errors : [];
    return { ids: success.map((i) => i[idField]).filter(Boolean), errors: error };
  }
  if (Array.isArray(container)) {
    const ids = []; const errors = [];
    for (const item of container) {
      const code = String(item.code ?? '').toUpperCase();
      if (!code || code === 'SUCCESS' || code === '200') ids.push(item[idField]);
      else errors.push(item);
    }
    return { ids: ids.filter(Boolean), errors };
  }
  return { ids: [], errors: [] };
}

console.log('Waiting 5 s before first API call…');
await delay(DELAY_MS);

// Mint LWA token once per run — never printed
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
  const errText = await tokenRes.text();
  await pool.end();
  throw new Error(`LWA token error ${tokenRes.status}: ${errText}`);
}
const { access_token: accessToken } = await tokenRes.json();
console.log(`Token ok (len ${accessToken.length})`);
console.log('');

const authHeaders = (contentType) => ({
  'Authorization':                   `Bearer ${accessToken}`,
  'Amazon-Advertising-API-ClientId':  LWA_CLIENT_ID,
  'Amazon-Advertising-API-Scope':     profileIdStr,
  'Content-Type':                     contentType,
  'Accept':                           contentType,
});

let pushed = 0;

for (const rec of recs) {
  const ev           = typeof rec.evidence === 'string' ? JSON.parse(rec.evidence) : rec.evidence;
  const targetText   = rec.target_text;
  const campaignName = ev.campaign_name ?? (targetText.startsWith('CDL | ') ? targetText : `CDL | SP | ${targetText}`);
  const seedAsins    = ev.seed_asins ?? [];

  console.log('─'.repeat(60));
  console.log(`Rec id      : ${rec.id}`);
  console.log(`Target text : ${targetText}`);
  console.log(`Orphan recs : ${ev.orphan_rec_ids?.length ?? 0}`);
  console.log(`Seed ASINs  : ${seedAsins.length}`);
  console.log('');

  // ── RESUME CHECK ─────────────────────────────────────────────────────────────
  const sp = ev.structure_progress ?? {};
  let createdCampaignId = sp.created_campaign_id ?? null;
  let createdAdGroupId  = sp.created_ad_group_id ?? null;

  if (createdCampaignId) {
    console.log(`campaign REUSED ${createdCampaignId}`);
    console.log('');
  }

  // ── 2a. CAMPAIGN ────────────────────────────────────────────────────────────
  if (!createdCampaignId) {
  // Evidence overrides: targeting_type (AUTO → API auto; absent → MANUAL) and budget.
  // Manual creative arc paths are bit-identical (evTargetingType defaults to 'MANUAL').
  const evTargetingType = ev.targeting_type?.toUpperCase() === 'AUTO' ? 'AUTO' : 'MANUAL';
  const evDailyBudget   = (typeof ev.budget === 'number' && ev.budget > 0) ? ev.budget : 3.00;

  const campaignBody = {
    campaigns: [
      {
        name:           campaignName,
        targetingType:  evTargetingType,
        state:          'PAUSED',
        ...(evTargetingType === 'MANUAL' ? { dynamicBidding: { strategy: 'LEGACY_FOR_SALES' } } : {}),
        budget:         { budgetType: 'DAILY', budget: evDailyBudget },
        startDate:      todayISODate(),
      },
    ],
  };

  console.log(`POST ${host}/sp/campaigns…`);
  const campRes  = await fetchWithTimeout(
    `${host}/sp/campaigns`,
    {
      method:  'POST',
      headers: authHeaders('application/vnd.spCampaign.v3+json'),
      body:    JSON.stringify(campaignBody),
    },
    `campaigns create rec ${rec.id}`,
  );
  const campText = await campRes.text();
  console.log(`Response HTTP ${campRes.status}:`);
  console.log(campText);
  console.log('');

  if (!campRes.ok) {
    console.error(`CAMPAIGN non-2xx — leaving rec ${rec.id} APPROVED. Stopping run.`);
    await pool.end();
    process.exit(1);
  }

  let campData;
  try { campData = JSON.parse(campText); } catch {
    console.error('CAMPAIGN response JSON parse error — stopping.');
    await pool.end();
    process.exit(1);
  }

  const { ids: campIds, errors: campErrors } = parseMultiStatus(campData?.campaigns, 'campaignId');
  if (!campIds.length) {
    console.error(`CAMPAIGN per-item error — leaving rec ${rec.id} APPROVED. Stopping run.`);
    if (campErrors.length) console.error(JSON.stringify(campErrors, null, 2));
    await pool.end();
    process.exit(1);
  }
  if (campErrors.length) console.warn('CAMPAIGN warnings:', JSON.stringify(campErrors));
  createdCampaignId = campIds[0];
  console.log(`Created campaignId: ${createdCampaignId}`);
  console.log('');

  // ── Incremental evidence write: campaign created ───────────────────────────
  await pool.query(
    `UPDATE recommendations
        SET evidence = evidence || jsonb_build_object('structure_progress', jsonb_build_object('created_campaign_id', $2::text))
      WHERE id = $1 AND status = 'APPROVED'`,
    [rec.id, createdCampaignId],
  );
  console.log(`Rec ${rec.id} — campaign id saved to evidence.`);
  console.log('');

  await delay(DELAY_MS);
  } // end if (!createdCampaignId)

  // ── 2b. AD GROUP ────────────────────────────────────────────────────────────
  if (!createdAdGroupId) {
  const adGroupBody = {
    adGroups: [
      {
        campaignId:  createdCampaignId,
        name:        targetText,
        state:       'ENABLED',
        defaultBid:  resolveDefaultBid(ev),
      },
    ],
  };

  console.log(`POST ${host}/sp/adGroups…`);
  const agRes  = await fetchWithTimeout(
    `${host}/sp/adGroups`,
    {
      method:  'POST',
      headers: authHeaders('application/vnd.spAdGroup.v3+json'),
      body:    JSON.stringify(adGroupBody),
    },
    `adGroups create rec ${rec.id}`,
  );
  const agText = await agRes.text();
  console.log(`Response HTTP ${agRes.status}:`);
  console.log(agText);
  console.log('');

  if (!agRes.ok) {
    console.error(`AD GROUP non-2xx — leaving rec ${rec.id} APPROVED. Stopping run.`);
    await pool.end();
    process.exit(1);
  }

  let agData;
  try { agData = JSON.parse(agText); } catch {
    console.error('AD GROUP response JSON parse error — stopping.');
    await pool.end();
    process.exit(1);
  }

  const { ids: agIds, errors: agErrors } = parseMultiStatus(agData?.adGroups, 'adGroupId');
  if (!agIds.length) {
    console.error(`AD GROUP per-item error — leaving rec ${rec.id} APPROVED. Stopping run.`);
    if (agErrors.length) console.error(JSON.stringify(agErrors, null, 2));
    await pool.end();
    process.exit(1);
  }
  if (agErrors.length) console.warn('AD GROUP warnings:', JSON.stringify(agErrors));
  createdAdGroupId = agIds[0];
  console.log(`Created adGroupId: ${createdAdGroupId}`);
  console.log('');

  // ── Incremental evidence write: ad group created ───────────────────────────
  await pool.query(
    `UPDATE recommendations
        SET evidence = jsonb_set(evidence, '{structure_progress}',
              COALESCE(evidence->'structure_progress', '{}'::jsonb) ||
              jsonb_build_object('created_ad_group_id', $2::text))
      WHERE id = $1 AND status = 'APPROVED'`,
    [rec.id, createdAdGroupId],
  );
  console.log(`Rec ${rec.id} — ad group id saved to evidence.`);
  console.log('');

  await delay(DELAY_MS);
  } // end if (!createdAdGroupId)

  // ── 2c. PRODUCT ADS ─────────────────────────────────────────────────────────
  // Partial failures OK: >= 1 success still counts the room as built.
  // All failures: room still built (campaign + ad group exist); mark PUSHED with seed_failures.
  const productAdsBody = {
    productAds: seedAsins.map((s) => ({
      campaignId: createdCampaignId,
      adGroupId:  createdAdGroupId,
      asin:       s.asin.toUpperCase(),
      state:      'ENABLED',
    })),
  };

  console.log(`POST ${host}/sp/productAds  (${seedAsins.length} items)…`);
  const paRes  = await fetchWithTimeout(
    `${host}/sp/productAds`,
    {
      method:  'POST',
      headers: authHeaders('application/vnd.spProductAd.v3+json'),
      body:    JSON.stringify(productAdsBody),
    },
    `productAds create rec ${rec.id}`,
  );
  const paText = await paRes.text();
  console.log(`Response HTTP ${paRes.status}:`);
  console.log(paText);
  console.log('');

  if (!paRes.ok) {
    console.warn(
      `PRODUCT ADS non-2xx — room is built (campaign + ad group created).` +
      ` Marking PUSHED with failures.`,
    );
  }

  let paData;
  try { paData = JSON.parse(paText); } catch { paData = null; }

  const { ids: createdAdIds, errors: paFailures } = parseMultiStatus(paData?.productAds, 'adId');
  if (paFailures.length) {
    console.warn(`PRODUCT ADS failures (${paFailures.length}):`);
    console.warn(JSON.stringify(paFailures, null, 2));
  }
  console.log(`Product ads created: ${createdAdIds.length}, failed: ${paFailures.length}`);
  console.log('');

  // ── Mark PUSHED: evidence || { created_campaign_id, created_ad_group_id,
  //                               created_ad_ids, seed_failures, pushed_at,
  //                               push_result }
  const updatedEvidence = {
    ...ev,
    created_campaign_id: createdCampaignId,
    created_ad_group_id: createdAdGroupId,
    created_ad_ids:      createdAdIds,
    seed_failures:       paFailures,
    pushed_at:           new Date().toISOString(),
    push_result: {
      campaign_id:    createdCampaignId,
      ad_group_id:    createdAdGroupId,
      ad_ids:         createdAdIds,
      ad_success_cnt: createdAdIds.length,
      ad_failure_cnt: paFailures.length,
    },
  };
  await pool.query(
    `UPDATE recommendations
        SET status    = 'PUSHED',
            pushed_at = now(),
            evidence  = $2
      WHERE id     = $1
        AND status = 'APPROVED'`,
    [rec.id, JSON.stringify(updatedEvidence)],
  );
  console.log(`Rec ${rec.id} → PUSHED`);
  console.log('');
  pushed++;

  // 5 s between recs (skip after the last)
  if (pushed < recs.length) await delay(DELAY_MS);
}

await pool.end();

console.log('─'.repeat(60));
console.log(`Execute complete: ${pushed} rec(s) PUSHED.`);
process.exit(0);
