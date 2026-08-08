// scripts/language-hygiene.mjs
// Usage: node scripts/language-hygiene.mjs --profile <id> [--execute] [--include-catchalls]
//
// ONE-SHOT: enforces the no-mixed-language-campaigns ruling (2026-08-08).
//
// Campaign language rule (ES profile):
//   name contains 'ENG' or '(EN)' (case-insensitive) → eng
//   else, in profile 2263723137827296 → spa
//
// For every ENABLED campaign in the profile:
//   For every ENABLED product ad:
//     book language via title_cache (status='found') → book_clusters
//     mismatch (book_lang ≠ campaign_lang) → pause candidate
//     unknown (no title_cache row status='found', or not in book_clusters) → FLAG, never acted on
//
// Catch-all campaigns (name ilike '%catch all%' but NOT ilike '%catch all eng%'):
//   output separately; EXCLUDED from execute set unless --include-catchalls passed.
//
// --execute            : PUT /sp/productAds state=PAUSED; persist receipts to
//                        artifacts/language-hygiene-<date>.json
// --include-catchalls  : also include catch-all mismatch candidates in the execute set
// Default              : DRY RUN (no API calls)

import { parseArgs }    from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path              from 'node:path';
import { Pool, neonConfig } from '@neondatabase/serverless';

// Node 22+ native WebSocket
neonConfig.webSocketConstructor = WebSocket;

// ── Args ─────────────────────────────────────────────────────────────────────
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    profile:             { type: 'string' },
    execute:             { type: 'boolean', default: false },
    'include-catchalls': { type: 'boolean', default: false },
  },
});
if (!values.profile) throw new Error('--profile <id> required');
const profileId        = BigInt(values.profile);
const profileIdStr     = String(profileId);
const executeMode      = values.execute === true;
const includeCatchalls = values['include-catchalls'] === true;

// ── DB ───────────────────────────────────────────────────────────────────────
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
const pool = new Pool({ connectionString: DATABASE_URL });

console.log('');
console.log('═'.repeat(72));
console.log('  language-hygiene.mjs — no-mixed-language-campaigns ruling 2026-08-08');
console.log('═'.repeat(72));
console.log(`  profile          : ${profileIdStr}`);
console.log(`  mode             : ${executeMode ? 'EXECUTE — real API calls' : 'DRY RUN — no API calls'}`);
console.log(`  include-catchalls: ${includeCatchalls}`);
console.log('═'.repeat(72));
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

// ── Campaign language classifier ─────────────────────────────────────────────
// Rule: name contains 'ENG' or '(EN)' → eng; else (in this profile) → spa
function campaignLanguage(name) {
  const u = name.toUpperCase();
  if (u.includes('ENG') || u.includes('(EN)')) return 'eng';
  return 'spa';
}

// Catch-all: name contains 'CATCH ALL' but NOT 'CATCH ALL ENG'
function isCatchAll(name) {
  const u = name.toUpperCase();
  return u.includes('CATCH ALL') && !u.includes('CATCH ALL ENG');
}

// ── 1. Fetch ENABLED campaigns ────────────────────────────────────────────────
const { rows: campaigns } = await pool.query(
  `SELECT campaign_id, name
     FROM amazon_campaigns
    WHERE profile_id = $1
      AND state = 'ENABLED'
    ORDER BY name`,
  [profileId],
);
console.log(`ENABLED campaigns in DB : ${campaigns.length}`);

// ── 2. Fetch ENABLED product ads with book language via title_cache + book_clusters ──
// title_cache.status='found' is required; anything else → language unknown (FLAG).
// The AND on tc.status in the LEFT JOIN means book_language is only populated
// when status='found' — any other status yields NULL book_language.
const { rows: adRows } = await pool.query(
  `SELECT
       pa.ad_id,
       pa.campaign_id,
       pa.asin,
       tc.isbn13    AS tc_isbn13,
       tc.status    AS tc_status,
       bc.language  AS book_language
     FROM amazon_product_ads pa
     LEFT JOIN title_cache tc
            ON tc.asin = pa.asin
     LEFT JOIN book_clusters bc
            ON bc.isbn13 = tc.isbn13
           AND tc.status = 'found'
    WHERE pa.profile_id = $1
      AND pa.state      = 'ENABLED'`,
  [profileId],
);
console.log(`ENABLED product ads in DB: ${adRows.length}`);
console.log('');

// Index ads by campaign_id
/** @type {Map<string, Array>} */
const adsByCampaign = new Map();
for (const ad of adRows) {
  if (!adsByCampaign.has(ad.campaign_id)) adsByCampaign.set(ad.campaign_id, []);
  adsByCampaign.get(ad.campaign_id).push(ad);
}

// ── 3. Classify each ad per campaign ─────────────────────────────────────────
const mainCandidates     = []; // non-catch-all mismatches
const catchallCandidates = []; // catch-all mismatches
const flagList           = []; // unknown language — never acted on
const reportByCampaign   = []; // for the full report

for (const campaign of campaigns) {
  const { campaign_id, name } = campaign;
  const campLang = campaignLanguage(name);
  const catchAll = isCatchAll(name);
  const ads      = adsByCampaign.get(campaign_id) ?? [];

  const mismatches = [];
  const flags      = [];

  for (const ad of ads) {
    const tcFound  = ad.tc_status === 'found';
    const bookLang = ad.book_language; // non-null only when tcFound + in book_clusters

    const knownLang = tcFound && bookLang != null;

    if (!knownLang) {
      // Unknown language → FLAG, never pause
      let reason;
      if (ad.asin == null) {
        reason = 'no ASIN on ad';
      } else if (ad.tc_status == null) {
        reason = 'ASIN not in title_cache';
      } else if (ad.tc_status !== 'found') {
        reason = `title_cache.status=${ad.tc_status}`;
      } else {
        reason = 'in title_cache(found) but not in book_clusters';
      }
      flags.push({
        ad_id:         ad.ad_id,
        asin:          ad.asin ?? '(null)',
        campaign_id,
        campaign_name: name,
        reason,
      });
    } else if (bookLang !== campLang) {
      // Mismatch → pause candidate
      mismatches.push({
        ad_id:         ad.ad_id,
        asin:          ad.asin,
        campaign_id,
        campaign_name: name,
        campaign_lang: campLang,
        book_language: bookLang,
      });
    }
    // correct language → nothing to do
  }

  flagList.push(...flags);

  if (mismatches.length > 0 || flags.length > 0) {
    reportByCampaign.push({
      campaign_id,
      name,
      campLang,
      catchAll,
      ad_count:       ads.length,
      mismatch_count: mismatches.length,
      flag_count:     flags.length,
      mismatches,
      flags,
    });
  }

  if (mismatches.length > 0) {
    if (catchAll) {
      catchallCandidates.push(...mismatches);
    } else {
      mainCandidates.push(...mismatches);
    }
  }
}

// ── Helper: count by book_language ───────────────────────────────────────────
function countByLang(mismatches) {
  const acc = {};
  for (const m of mismatches) acc[m.book_language] = (acc[m.book_language] ?? 0) + 1;
  return acc;
}

// ── 4. REPORT ────────────────────────────────────────────────────────────────

// 4a. Non-catch-all campaigns
console.log('═'.repeat(72));
console.log('  CAMPAIGN REPORT — mismatch candidates (non-catch-all)');
console.log('═'.repeat(72));
console.log('');

const nonCatchAll = reportByCampaign.filter(r => !r.catchAll && r.mismatch_count > 0);
if (nonCatchAll.length === 0) {
  console.log('  (no mismatches in non-catch-all campaigns)');
  console.log('');
} else {
  for (const r of nonCatchAll) {
    console.log(`  Campaign : ${r.name}`);
    console.log(`  ID       : ${r.campaign_id}`);
    console.log(`  Lang     : ${r.campLang}  |  ENABLED ads: ${r.ad_count}  |  flags: ${r.flag_count}`);
    console.log(`  Pause candidates: ${r.mismatch_count}`);
    const byLang = countByLang(r.mismatches);
    for (const [lang, cnt] of Object.entries(byLang)) {
      console.log(`    book_lang=${lang}: ${cnt} ad(s)`);
    }
    console.log('');
  }
}

// 4b. Catch-all section
console.log('═'.repeat(72));
console.log('  CATCH-ALL SECTION (excluded from execute unless --include-catchalls)');
console.log('═'.repeat(72));
console.log('');

const catchAllReport = reportByCampaign.filter(r => r.catchAll);
if (catchAllReport.length === 0) {
  console.log('  (no catch-all campaigns with anomalies)');
  console.log('');
} else {
  for (const r of catchAllReport) {
    console.log(`  Campaign : ${r.name}`);
    console.log(`  ID       : ${r.campaign_id}`);
    console.log(`  Lang     : ${r.campLang}  |  ENABLED ads: ${r.ad_count}  |  flags: ${r.flag_count}`);
    console.log(`  Catch-all mismatch candidates: ${r.mismatch_count}`);
    const byLang = countByLang(r.mismatches);
    for (const [lang, cnt] of Object.entries(byLang)) {
      console.log(`    book_lang=${lang}: ${cnt} ad(s)`);
    }
    console.log('');
  }
  if (!includeCatchalls) {
    console.log('  ⚠️  Catch-all candidates are EXCLUDED from the execute set.');
    console.log('     Pass --include-catchalls to include them.');
  } else {
    console.log('  ✅  --include-catchalls ON: catch-all candidates INCLUDED in execute set.');
  }
  console.log('');
}

// 4c. FLAG list
console.log('═'.repeat(72));
console.log('  FLAG LIST — unknown language, NEVER acted on');
console.log('═'.repeat(72));
console.log('');

if (flagList.length === 0) {
  console.log('  (no flags)');
  console.log('');
} else {
  for (const f of flagList) {
    console.log(`  ad_id=${f.ad_id}  asin=${f.asin}  campaign="${f.campaign_name}"  reason=${f.reason}`);
  }
  console.log('');
}

// 4d. Grand total
const executeSet = includeCatchalls
  ? [...mainCandidates, ...catchallCandidates]
  : mainCandidates;

console.log('═'.repeat(72));
console.log('  GRAND TOTAL');
console.log('═'.repeat(72));
console.log(`  Main (non-catch-all) pause candidates : ${mainCandidates.length}`);
console.log(`  Catch-all pause candidates            : ${catchallCandidates.length}`);
console.log(`  FLAG list (unknown lang, no action)   : ${flagList.length}`);
console.log(`  Execute set (would be paused now)     : ${executeSet.length}`);
console.log('');

if (!executeMode) {
  console.log('DRY RUN complete — no API calls made.');
  await pool.end();
  process.exit(0);
}

// ── 5. EXECUTE — mint token, then batch-PUT /sp/productAds ───────────────────
if (executeSet.length === 0) {
  console.log('Execute mode: nothing to pause.');
  await pool.end();
  process.exit(0);
}

const refreshToken = process.env[envVarName];
if (!refreshToken) throw new Error(`Env var ${envVarName} not set`);
const { LWA_CLIENT_ID, LWA_CLIENT_SECRET } = process.env;
if (!LWA_CLIENT_ID || !LWA_CLIENT_SECRET) {
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
      process.exit(1);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

console.log('minting token…');
const tokenRes = await fetchWithTimeout(
  'https://api.amazon.com/auth/o2/token',
  {
    method: 'POST',
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
  const body = await tokenRes.text();
  throw new Error(`LWA token error ${tokenRes.status}: ${body}`);
}
const { access_token: accessToken } = await tokenRes.json();
console.log(`token ok (len ${accessToken.length})`);
console.log('');

const CHUNK_SIZE = 100; // API max per PUT
const DELAY_MS   = 2_000;
const MEDIA_TYPE = 'application/vnd.spProductAd.v3+json';
const authHeaders = {
  'Authorization':                      `Bearer ${accessToken}`,
  'Amazon-Advertising-API-ClientId':    LWA_CLIENT_ID,
  'Amazon-Advertising-API-Scope':       profileIdStr,
};

const receipts = [];
let paused = 0;
let errors  = 0;

for (let i = 0; i < executeSet.length; i += CHUNK_SIZE) {
  const chunk    = executeSet.slice(i, i + CHUNK_SIZE);
  const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
  const body     = { productAds: chunk.map(c => ({ adId: c.ad_id, state: 'PAUSED' })) };

  console.log(`chunk ${chunkNum}: pausing ${chunk.length} ad(s)…`);

  const res = await fetchWithTimeout(
    `${host}/sp/productAds`,
    {
      method:  'PUT',
      headers: { ...authHeaders, 'Content-Type': MEDIA_TYPE, 'Accept': MEDIA_TYPE },
      body:    JSON.stringify(body),
    },
    `PUT /sp/productAds chunk ${chunkNum}`,
  );

  const responseText = await res.text();
  let responseJson;
  try { responseJson = JSON.parse(responseText); }
  catch { responseJson = { raw: responseText }; }

  for (const candidate of chunk) {
    receipts.push({
      ad_id:         candidate.ad_id,
      asin:          candidate.asin,
      campaign_id:   candidate.campaign_id,
      campaign_name: candidate.campaign_name,
      campaign_lang: candidate.campaign_lang,
      book_language: candidate.book_language,
      action:        'PAUSED',
      http_status:   res.status,
      response:      responseJson,
    });
  }

  if (!res.ok) {
    console.error(`  API error ${res.status}: ${responseText.slice(0, 300)}`);
    errors += chunk.length;
  } else {
    paused += chunk.length;
    console.log(`  chunk ${chunkNum} ok (${res.status})`);
  }

  if (i + CHUNK_SIZE < executeSet.length) {
    await new Promise(r => setTimeout(r, DELAY_MS));
  }
}

// ── 6. Write receipts ─────────────────────────────────────────────────────────
// File is reversible: each entry records asin + ad_id + campaign_id.
// To reverse: iterate receipts, PUT each ad_id back to state=ENABLED.
const dateStr      = new Date().toISOString().slice(0, 10);
const scriptDir    = path.dirname(fileURLToPath(import.meta.url));
const artifactsDir = path.resolve(scriptDir, '../artifacts');
mkdirSync(artifactsDir, { recursive: true });
const receiptPath  = path.join(artifactsDir, `language-hygiene-${dateStr}.json`);

writeFileSync(
  receiptPath,
  JSON.stringify(
    {
      paused_at:        new Date().toISOString(),
      profile_id:       profileIdStr,
      include_catchalls: includeCatchalls,
      paused_count:     paused,
      error_count:      errors,
      receipts,
    },
    null,
    2,
  ),
);

await pool.end();
console.log('');
console.log(`Receipts written to : ${receiptPath}`);
console.log(`Paused : ${paused}  Errors : ${errors}`);
console.log('Execute complete.');
