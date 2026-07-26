// scripts/generate-recommendations.mjs
// Usage: node --env-file=.env.local scripts/generate-recommendations.mjs --profile <id>
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
const profileIdStr = String(profileId); // for text-typed columns (scope, ANY arrays)

// ── DB ───────────────────────────────────────────────────────────────────────
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
const pool = new Pool({ connectionString: DATABASE_URL });

// ── 1. PARAMETER RESOLUTION ──────────────────────────────────────────────────
// For each key: use scope = <profile_id> when present, else scope = 'GLOBAL'.
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
// include any profile-only keys absent from GLOBAL
for (const [key, val] of profileMap) {
  if (!(key in params)) params[key] = val;
}

console.log(JSON.stringify(params));

// ── 2. EVALUATION WINDOW ─────────────────────────────────────────────────────
const MS_PER_DAY = 86_400_000;

const todayMs = Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
);
const windowEndMs   = todayMs  - params.negate_attribution_buffer_days * MS_PER_DAY;
const windowStartMs = windowEndMs - params.negate_window_days          * MS_PER_DAY;

const toISO = (ms) => new Date(ms).toISOString().slice(0, 10);
const windowStart = toISO(windowStartMs);
const windowEnd   = toISO(windowEndMs);

console.log(JSON.stringify({ window_start: windowStart, window_end: windowEnd }));

// ── Fetch profile (currency) ──────────────────────────────────────────────────
const { rows: profileRows } = await pool.query(
  `SELECT currency_code FROM amazon_profiles WHERE profile_id = $1`,
  [profileId],
);
if (!profileRows.length) {
  await pool.end();
  throw new Error(`Profile ${profileIdStr} not found`);
}
const currencyCode = profileRows[0].currency_code;
const CURRENCY_SYMBOL = { EUR: '€', USD: '$', GBP: '£', CAD: 'CA$', MXN: 'MX$' };
const currSym = CURRENCY_SYMBOL[currencyCode] ?? `${currencyCode}\u202f`;

// ── 3. AGGREGATE ─────────────────────────────────────────────────────────────
// One pass over amazon_search_term_daily for this profile + window,
// grouped by search_term.
const { rows: aggRows } = await pool.query(
  `SELECT
       search_term,
       campaign_id,
       ad_group_id,
       SUM(cost)                                     AS spend,
       SUM(clicks)                                   AS clicks,
       SUM(purchases_14d)                            AS orders,
       SUM(sales_14d)                                AS sales,
       BOOL_OR(match_type = 'TARGETING_EXPRESSION')  AS is_targeting
     FROM amazon_search_term_daily
    WHERE profile_id = $1
      AND date >= $2
      AND date <= $3
    GROUP BY search_term, campaign_id, ad_group_id`,
  [profileId, windowStart, windowEnd],
);

console.log(
  `Aggregated ${aggRows.length} row(s) (term×campaign×adgroup) in window ${windowStart} → ${windowEnd}.`,
);

// ── Roll up to term-level totals + build placements list ─────────────────────
const termMap = new Map(); // search_term → { spend, clicks, orders, sales, isTargeting, placements }
for (const row of aggRows) {
  const spend  = Number(row.spend);
  const clicks = Number(row.clicks);
  const orders = Number(row.orders);
  const sales  = Number(row.sales);

  if (!termMap.has(row.search_term)) {
    termMap.set(row.search_term, {
      search_term: row.search_term,
      spend:       0,
      clicks:      0,
      orders:      0,
      sales:       0,
      isTargeting: false,
      placements:  [],
    });
  }
  const entry = termMap.get(row.search_term);
  entry.spend       += spend;
  entry.clicks      += clicks;
  entry.orders      += orders;
  entry.sales       += sales;
  entry.isTargeting  = entry.isTargeting || Boolean(row.is_targeting);
  entry.placements.push({ campaign_id: row.campaign_id, ad_group_id: row.ad_group_id, spend, clicks, orders, sales });
}
const termRows = [...termMap.values()];
console.log(`Rolled up to ${termRows.length} unique search term(s).`);

// ── 4. CANDIDATES ─────────────────────────────────────────────────────────────
// Priority order: NEGATE_TERM → PROMOTE_TERM → PROMOTE_ASIN.
// Classification is based on term shape, not is_targeting:
// is_targeting describes how the ad matched (auto/category campaigns report
// genuine queries under TARGETING_EXPRESSION), not what the term is.
// is_targeting is kept in evidence as a signal but does not decide rec_type.
const ASIN_SHAPE = /^([0-9]{9}[0-9xX]|b0[a-z0-9]{8})$/i;
// A term matching multiple types takes the first match.
const {
  negate_min_spend,
  negate_min_clicks,
  harvest_min_orders,
  promote_asin_min_orders,
  target_acos,
} = params;

const candidates = [];

for (const row of termRows) {
  const spend       = row.spend;
  const clicks      = row.clicks;
  const orders      = row.orders;
  const sales       = row.sales;
  const isTargeting = row.isTargeting;
  // acos = null when sales = 0 (avoid ÷0; don't promote what we can't measure)
  const acos        = sales > 0 ? spend / sales : null;

  let recType = null;

  if (orders === 0 && spend >= negate_min_spend && clicks >= negate_min_clicks) {
    recType = 'NEGATE_TERM';
  } else if (
    !ASIN_SHAPE.test(row.search_term) &&
    orders >= harvest_min_orders &&
    acos !== null &&
    acos < target_acos
  ) {
    recType = 'PROMOTE_TERM';
  } else if (
    ASIN_SHAPE.test(row.search_term) &&
    orders >= promote_asin_min_orders &&
    acos !== null &&
    acos < target_acos
  ) {
    recType = 'PROMOTE_ASIN';
  }

  if (recType !== null) {
    candidates.push({
      recType,
      searchTerm: row.search_term,
      spend,
      clicks,
      orders,
      sales,
      acos,
      placements: row.placements,
    });
  }
}

// ── 5. WRITE DRAFTS (idempotent) ─────────────────────────────────────────────
let written         = 0;
let skippedExisting = 0;
let skippedRejected = 0;
const countsByType  = { NEGATE_TERM: 0, PROMOTE_TERM: 0, PROMOTE_ASIN: 0 };

if (candidates.length > 0) {
  // Fetch any existing rows for these terms in a single query.
  const termList = candidates.map((c) => c.searchTerm);
  const { rows: existingRows } = await pool.query(
    `SELECT rec_type, target_text, status
       FROM recommendations
      WHERE profile_id = $1
        AND target_text = ANY($2)`,
    [profileId, termList],
  );

  // Build lookup sets keyed "recType|target_text"
  const openSet     = new Set(); // DRAFT | APPROVED | PUSHED → skip
  const rejectedSet = new Set(); // REJECTED → skip in v1
  for (const row of existingRows) {
    const key = `${row.rec_type}|${row.target_text}`;
    if (['DRAFT', 'APPROVED', 'PUSHED'].includes(row.status)) openSet.add(key);
    else if (row.status === 'REJECTED')                        rejectedSet.add(key);
  }

  // ── v4: Batch existing-targets lookup for PROMOTE_ASIN ───────────────────
  const promoteAsinTerms = candidates
    .filter((c) => c.recType === 'PROMOTE_ASIN')
    .map((c) => c.searchTerm.toUpperCase());
  const existingTargetsMap = new Map(); // UPPER(asin) → [{ad_group_id, campaign_id, bid}]
  if (promoteAsinTerms.length > 0) {
    const { rows: existingTargetRows } = await pool.query(
      `SELECT ad_group_id, campaign_id, bid, resolved_asin
         FROM amazon_targets
        WHERE profile_id = $1
          AND resolved_asin = ANY($2)
          AND state = 'ENABLED'`,
      [profileId, promoteAsinTerms],
    );
    for (const row of existingTargetRows) {
      const key = row.resolved_asin.toUpperCase();
      if (!existingTargetsMap.has(key)) existingTargetsMap.set(key, []);
      existingTargetsMap.get(key).push({
        ad_group_id: row.ad_group_id,
        campaign_id: row.campaign_id,
        bid:         row.bid != null ? Number(row.bid) : null,
      });
    }
  }

  for (const c of candidates) {
    countsByType[c.recType] = (countsByType[c.recType] ?? 0) + 1;
    const key = `${c.recType}|${c.searchTerm}`;

    if (openSet.has(key)) {
      skippedExisting++;
      continue;
    }
    if (rejectedSet.has(key)) {
      console.log(`  previously rejected, skipped: [${c.recType}] "${c.searchTerm}"`);
      skippedRejected++;
      continue;
    }

    // ── Build human proposal sentence ─────────────────────────────────────────
    const spendFmt = `${currSym}${c.spend.toFixed(2)}`;
    const win      = `${windowStart} – ${windowEnd}`;
    let proposal;

    // v4: PROMOTE_ASIN — existing-targets destination rule
    let existingTargets     = [];
    let effectivePlacements = c.placements;
    if (c.recType === 'PROMOTE_ASIN') {
      const asinKey          = c.searchTerm.toUpperCase();
      existingTargets        = existingTargetsMap.get(asinKey) ?? [];
      const targetedAdGroups = new Set(existingTargets.map((t) => t.ad_group_id));
      effectivePlacements    = c.placements.filter((p) => !targetedAdGroups.has(p.ad_group_id));
      if (effectivePlacements.length === 0) {
        console.log(`suppressed (already targeted everywhere it converts): ${c.searchTerm}`);
        continue;
      }
    }

    if (c.recType === 'NEGATE_TERM') {
      proposal =
        `Negate '${c.searchTerm}': ${spendFmt} spend, ${c.clicks} clicks, ` +
        `0 orders in ${win}.`;
    } else if (c.recType === 'PROMOTE_TERM') {
      const acosPct = (c.acos * 100).toFixed(1);
      proposal =
        `Promote '${c.searchTerm}' to exact match: ${c.orders} orders at ` +
        `${acosPct}% ACoS (${spendFmt} spend) in ${win}.`;
    } else {
      const acosPct = (c.acos * 100).toFixed(1);
      proposal =
        `Target ASIN for '${c.searchTerm}': ${c.orders} orders at ` +
        `${acosPct}% ACoS (${spendFmt} spend) in ${win}.`;
      if (existingTargets.length > 0) {
        const nGroups = new Set(existingTargets.map((t) => t.ad_group_id)).size;
        proposal += ` Already explicitly targeted in ${nGroups} other ad group(s).`;
      }
    }

    const primaryPlacement = effectivePlacements.reduce(
      (max, p) => (p.spend > max.spend ? p : max),
      effectivePlacements[0],
    );
    const evidence = {
      window_start:      windowStart,
      window_end:        windowEnd,
      spend:             c.spend,
      clicks:            c.clicks,
      orders:            c.orders,
      sales:             c.sales,
      acos:              c.acos,
      placements:        c.placements,
      primary_placement: primaryPlacement,
      ...(c.recType === 'PROMOTE_ASIN' ? { existing_targets: existingTargets } : {}),
      params_used:       params,
    };

    await pool.query(
      `INSERT INTO recommendations
         (rec_type, profile_id, campaign_id, target_text, proposal, evidence)
       VALUES ($1, $2, NULL, $3, $4, $5)`,
      [c.recType, profileId, c.searchTerm, proposal, JSON.stringify(evidence)],
    );
    written++;
  }
} else {
  console.log('No candidates found — nothing to write.');
}

await pool.end();

// ── 6. SUMMARY ───────────────────────────────────────────────────────────────
console.log('\n── Summary ──────────────────────────────────────────────────────');
for (const [type, count] of Object.entries(countsByType)) {
  if (count > 0) console.log(`  ${type}: ${count} candidate(s)`);
}
if (Object.values(countsByType).every((n) => n === 0)) {
  console.log('  (no candidates matched any rule)');
}
console.log(`  Written:            ${written}`);
console.log(`  Skipped (exists):   ${skippedExisting}`);
console.log(`  Skipped (rejected): ${skippedRejected}`);
console.log('─────────────────────────────────────────────────────────────────');

process.exit(0);
