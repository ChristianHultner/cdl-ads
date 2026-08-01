// scripts/push-replace-ads.mjs
// Usage: node --env-file=.env.local scripts/push-replace-ads.mjs --profile <id> [--execute]
//
// CAPABILITY — REPLACE_PRODUCT_AD executor.
// Reads APPROVED REPLACE_PRODUCT_AD recs and, per rec:
//   (a) CREATE the HC product ad  POST /sp/productAds  state ENABLED,
//       same campaign_id + ad_group_id, asin = hc_isbn10 (from evidence).
//   (b) PAUSE  the Kindle ad      PUT  /sp/productAds  state PAUSED,
//       adId = rec.target_text (= the Kindle ad's adId).
//
// ORDER MATTERS: create first; pause only after create is accepted.
// Never leave an ad group emptier than found.
//
// Partial result (create ok / pause fail or vice versa):
//   status stays APPROVED; evidence.push_result records the honest partial.
//
// RecCard: REPLACE_PRODUCT_AD renders via the generic card path — no bespoke
// UI needed this frame.

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
const REPLACE_MAX_PER_RUN = 10;   // safety cap per run; raise only with explicit approval
const DELAY_MS            = 3_000;
const TIMEOUT_MS          = 30_000;

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

// ── 1. SELECT APPROVED REPLACE_PRODUCT_AD recs ───────────────────────────────
const { rows: recs } = await pool.query(
  `SELECT id, target_text, evidence
     FROM recommendations
    WHERE profile_id = $1
      AND rec_type   = 'REPLACE_PRODUCT_AD'
      AND status     = 'APPROVED'
    ORDER BY id
    LIMIT $2`,
  [profileId, REPLACE_MAX_PER_RUN],
);

console.log(
  `Found ${recs.length} APPROVED REPLACE_PRODUCT_AD rec(s)` +
  ` (cap ${REPLACE_MAX_PER_RUN}, region ${region})`,
);
console.log('');

if (recs.length === 0) {
  await pool.end();
  console.log('Nothing to push.');
  console.log(`Execute complete: 0 pushed, 0 partial`);
  process.exit(0);
}

// ── 2. DRY-RUN — print both API bodies per rec verbatim, then exit ─────────────
if (!executeMode) {
  for (const rec of recs) {
    const ev = typeof rec.evidence === 'string' ? JSON.parse(rec.evidence) : rec.evidence;
    const kindleAdId = rec.target_text;
    const hcIsbn10   = ev.hc_isbn10;
    const campaignId = ev.campaign_id;
    const adGroupId  = ev.ad_group_id;

    console.log('─'.repeat(60));
    console.log(`Rec id       : ${rec.id}`);
    console.log(`Kindle ad_id : ${kindleAdId}  (→ PAUSED)`);
    console.log(`HC ISBN-10   : ${hcIsbn10}     (→ CREATE ENABLED)`);
    console.log(`Campaign     : ${campaignId}`);
    console.log(`Ad group     : ${adGroupId}`);
    console.log('');

    const createBody = {
      productAds: [
        {
          campaignId: campaignId,
          adGroupId:  adGroupId,
          asin:       hcIsbn10.toUpperCase(),
          state:      'ENABLED',
        },
      ],
    };
    console.log(`[DRY-RUN] POST ${host}/sp/productAds`);
    console.log('  Content-Type: application/vnd.spProductAd.v3+json');
    console.log(JSON.stringify(createBody, null, 2));
    console.log('');

    const pauseBody = {
      productAds: [
        {
          adId:  kindleAdId,
          state: 'PAUSED',
        },
      ],
    };
    console.log(`[DRY-RUN] PUT ${host}/sp/productAds`);
    console.log('  Content-Type: application/vnd.spProductAd.v3+json');
    console.log(JSON.stringify(pauseBody, null, 2));
    console.log('');
  }

  await pool.end();
  console.log(`Totals: ${recs.length} fetched, 0 skipped`);
  console.log(`Execute complete: 0 pushed, 0 partial`);
  process.exit(0);
}

// ── 3. EXECUTE MODE ──────────────────────────────────────────────────────────

// Resolve LWA credentials
const LWA_CLIENT_ID     = process.env.LWA_CLIENT_ID;
const LWA_CLIENT_SECRET = process.env.LWA_CLIENT_SECRET;
const refreshToken      = process.env[envVarName];

if (!LWA_CLIENT_ID || !LWA_CLIENT_SECRET || !refreshToken) {
  await pool.end();
  throw new Error(`Missing credentials: LWA_CLIENT_ID=${!!LWA_CLIENT_ID}, LWA_CLIENT_SECRET=${!!LWA_CLIENT_SECRET}, ${envVarName}=${!!refreshToken}`);
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────
function fetchWithTimeout(url, options, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), TIMEOUT_MS);
    fetch(url, options).then(
      (res) => { clearTimeout(timer); resolve(res); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// Multi-status parser: handles { success: [...], error: [...] } and flat shapes.
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

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Mint LWA token ────────────────────────────────────────────────────────────
console.log('Waiting 3 s before first API call…');
await delay(DELAY_MS);

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

let pushed             = 0;
let partial            = 0;
let viaExistingHcCount = 0;

for (const rec of recs) {
  const ev = typeof rec.evidence === 'string' ? JSON.parse(rec.evidence) : rec.evidence;
  const kindleAdId = rec.target_text;          // the Kindle ad's adId
  const hcIsbn10   = ev.hc_isbn10;
  const campaignId = ev.campaign_id;
  const adGroupId  = ev.ad_group_id;

  console.log('─'.repeat(60));
  console.log(`Rec id       : ${rec.id}`);
  console.log(`Kindle ad_id : ${kindleAdId}  (→ PAUSED)`);
  console.log(`HC ISBN-10   : ${hcIsbn10}     (→ CREATE ENABLED)`);
  console.log(`Campaign     : ${campaignId}`);
  console.log(`Ad group     : ${adGroupId}`);
  console.log('');

  const pushResult = {
    create_attempted: true,
    pause_attempted:  false,
    create_http:      null,
    create_adId:      null,
    create_errors:    [],
    pause_http:       null,
    pause_errors:     [],
    outcome:          null,
  };

  // ── (a) CREATE HC product ad ─────────────────────────────────────────────────
  const createBody = {
    productAds: [
      {
        campaignId: campaignId,
        adGroupId:  adGroupId,
        asin:       hcIsbn10.toUpperCase(),
        state:      'ENABLED',
      },
    ],
  };

  console.log(`POST ${host}/sp/productAds…`);
  const createRes  = await fetchWithTimeout(
    `${host}/sp/productAds`,
    {
      method:  'POST',
      headers: authHeaders('application/vnd.spProductAd.v3+json'),
      body:    JSON.stringify(createBody),
    },
    `productAds create rec ${rec.id}`,
  );
  const createText = await createRes.text();
  pushResult.create_http = createRes.status;
  console.log(`Response HTTP ${createRes.status}:`);
  console.log(createText);
  console.log('');

  let createData;
  try { createData = JSON.parse(createText); } catch { createData = null; }

  const { ids: createdIds, errors: createErrors } = parseMultiStatus(createData?.productAds, 'adId');
  pushResult.create_adId   = createdIds[0] ?? null;
  pushResult.create_errors = createErrors;

  // Detect duplicate: any DUPLICATE_VALUE error on our single-item request = create-satisfied.
  const iconst isDuplicatePath = !createdIds.length &&
    JSON.stringify(createData?.productAds?.error ?? []).includes('DUPLICATE_VALUE');

  if (isDuplicatePath) {
    console.log(`  DUPLICATE_VALUE for ASIN ${hcIsbn10.toUpperCase()} — treating as create-satisfied.`);
    pushResult.create = 'duplicate_existing';

    // Look up the existing HC ad in our table (::text discipline).
    const { rows: existingRows } = await pool.query(
      `SELECT ad_id, state
         FROM amazon_product_ads
        WHERE campaign_id = $1::text
          AND ad_group_id = $2::text
          AND asin        = $3::text
        LIMIT 1`,
      [campaignId, adGroupId, hcIsbn10.toUpperCase()],
    );

    if (existingRows.length) {
      const existingAd = existingRows[0];
      if (existingAd.state === 'PAUSED') {
        console.log(`  Existing HC ad ${existingAd.ad_id} is PAUSED — enabling…`);
        await delay(DELAY_MS);
        const enableBody = { productAds: [{ adId: existingAd.ad_id, state: 'ENABLED' }] };
        const enableRes  = await fetchWithTimeout(
          `${host}/sp/productAds`,
          {
            method:  'PUT',
            headers: authHeaders('application/vnd.spProductAd.v3+json'),
            body:    JSON.stringify(enableBody),
          },
          `productAds enable existing HC rec ${rec.id}`,
        );
        const enableText = await enableRes.text();
        console.log(`Enable response HTTP ${enableRes.status}:`);
        console.log(enableText);
        console.log('');
        pushResult.hc_enable = { adId: existingAd.ad_id, http: enableRes.status, raw: enableText };
      } else {
        // Already ENABLED — no action needed.
        console.log(`  Existing HC ad ${existingAd.ad_id} already ENABLED — no-op.`);
        pushResult.hc_enable = 'noop';
      }
    } else {
      // Not in our table (sync lag); duplicate error proves it exists on Amazon.
      console.log(`  HC ad not found in amazon_product_ads (sync lag) — hc_state_unverified.`);
      pushResult.hc_enable           = 'unverified';
      pushResult.hc_state_unverified = true;
    }
  } else if (!createdIds.length) {
    // Create failed (non-duplicate) — do NOT pause; leave rec APPROVED with partial summary.
    pushResult.pause_attempted = false;
    pushResult.outcome         = 'CREATE_FAILED';
    await pool.query(
      `UPDATE recommendations
          SET evidence = evidence || jsonb_build_object('push_result', $2::jsonb)
        WHERE id = $1`,
      [rec.id, JSON.stringify(pushResult)],
    );
    console.log(`  CREATE failed for rec ${rec.id} — leaving APPROVED (partial). Not pausing Kindle ad.`);
    partial++;
    await delay(DELAY_MS);
    continue;
  } else {
    console.log(`HC product ad created: adId ${createdIds[0]}`);
    console.log('');
  }

  // ── (b) PAUSE Kindle ad ───────────────────────────────────────────────────
  // Only reached when create was accepted.
  pushResult.pause_attempted = true;
  await delay(DELAY_MS);

  const pauseBody = {
    productAds: [
      {
        adId:  kindleAdId,
        state: 'PAUSED',
      },
    ],
  };

  console.log(`PUT ${host}/sp/productAds (pause Kindle ad ${kindleAdId})…`);
  const pauseRes  = await fetchWithTimeout(
    `${host}/sp/productAds`,
    {
      method:  'PUT',
      headers: authHeaders('application/vnd.spProductAd.v3+json'),
      body:    JSON.stringify(pauseBody),
    },
    `productAds pause rec ${rec.id}`,
  );
  const pauseText = await pauseRes.text();
  pushResult.pause_http = pauseRes.status;
  console.log(`Response HTTP ${pauseRes.status}:`);
  console.log(pauseText);
  console.log('');

  let pauseData;
  try { pauseData = JSON.parse(pauseText); } catch { pauseData = null; }

  const { ids: pausedIds, errors: pauseErrors } = parseMultiStatus(pauseData?.productAds, 'adId');
  pushResult.pause_errors = pauseErrors;

  if (!pausedIds.length) {
    // Pause failed after create satisfied — honest partial.
    pushResult.outcome = isDuplicatePath ? 'DUPLICATE_EXISTING_PAUSE_FAILED' : 'CREATE_OK_PAUSE_FAILED';
    await pool.query(
      `UPDATE recommendations
          SET evidence = evidence || jsonb_build_object('push_result', $2::jsonb)
        WHERE id = $1`,
      [rec.id, JSON.stringify(pushResult)],
    );
    console.log(`  PAUSE failed for rec ${rec.id} — HC ad ${isDuplicatePath ? 'existing' : 'created'} but Kindle ad still ENABLED. Leaving APPROVED (partial).`);
    partial++;
  } else {
    // Both legs satisfied.
    pushResult.outcome = 'SUCCESS';
    if (isDuplicatePath) pushResult.pause = { adId: kindleAdId, http: pauseRes.status };
    await pool.query(
      `UPDATE recommendations
          SET status   = 'PUSHED',
              evidence = evidence || jsonb_build_object('push_result', $2::jsonb)
        WHERE id = $1`,
      [rec.id, JSON.stringify(pushResult)],
    );
    if (isDuplicatePath) {
      console.log(`  Rec ${rec.id} → PUSHED via existing HC (hc_enable: ${JSON.stringify(pushResult.hc_enable)}, Kindle paused: ${kindleAdId})`);
      viaExistingHcCount++;
    } else {
      console.log(`  Rec ${rec.id} → PUSHED (HC created: ${createdIds[0]}, Kindle paused: ${kindleAdId})`);
    }
    pushed++;
  }

  await delay(DELAY_MS);
}

await pool.end();

console.log('');
console.log(`Totals: ${recs.length} fetched, 0 skipped`);
console.log(
  viaExistingHcCount > 0
    ? `Execute complete: ${pushed} pushed (${viaExistingHcCount} via existing HC), ${partial} partial`
    : `Execute complete: ${pushed} pushed, ${partial} partial`
);
process.exit(0);
