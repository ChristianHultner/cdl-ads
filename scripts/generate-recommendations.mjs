// scripts/generate-recommendations.mjs
// Usage: node --env-file=.env.local scripts/generate-recommendations.mjs --profile <id>
import { parseArgs }       from 'node:util';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath }    from 'node:url';
import { join, dirname }    from 'node:path';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { isbn13ToIsbn10 }   from './lib/isbn.mjs';

// Node 22+ native WebSocket
neonConfig.webSocketConstructor = WebSocket;

// ── Args ─────────────────────────────────────────────────────────────────────
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    profile:          { type: 'string' },
    'cluster-rooms':  { type: 'boolean', default: false },
    'cluster-lang':   { type: 'string',  default: 'spa'  },
    'cluster-names':  { type: 'string',  default: ''     }, // comma-separated; empty = all
  },
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

// ── Fetch profile (currency + target_acos) ──────────────────────────────────
const { rows: profileRows } = await pool.query(
  `SELECT currency_code, country_code, target_acos FROM amazon_profiles WHERE profile_id = $1`,
  [profileId],
);
if (!profileRows.length) {
  await pool.end();
  throw new Error(`Profile ${profileIdStr} not found`);
}
const currencyCode = profileRows[0].currency_code;
const countryCode  = profileRows[0].country_code ?? 'US';
// Override target_acos from the profile row (seeded at 0.30; editable by Christian in the DB).
params.target_acos = Number(profileRows[0].target_acos);
const CURRENCY_SYMBOL = { EUR: '€', USD: '$', GBP: '£', CAD: 'CA$', MXN: 'MX$' };
const currSym = CURRENCY_SYMBOL[currencyCode] ?? `${currencyCode}\u202f`;

// ── L3.2: Market rolling ACoS + band computation ────────────────────────────
const { rows: mktAcosRows } = await pool.query(
  `SELECT (SUM(cost) / NULLIF(SUM(sales_14d), 0))::float AS rolling_acos
     FROM amazon_campaign_daily
    WHERE profile_id = $1
      AND date >= CURRENT_DATE - INTERVAL '30 days'`,
  [profileId],
);
const marketRollingAcos = mktAcosRows[0]?.rolling_acos != null
  ? Number(mktAcosRows[0].rolling_acos) : null;
const bandLow  = params.target_acos - 0.05;
const bandHigh = params.target_acos + 0.05;
const marketZone = marketRollingAcos == null ? 'in'
  : marketRollingAcos < bandLow   ? 'below'
  : marketRollingAcos <= bandHigh ? 'in'
  : 'above';
console.log(
  `Market 30d ACoS: ${marketRollingAcos != null ? (marketRollingAcos * 100).toFixed(1) + '%' : 'unknown'}` +
  ` — zone: ${marketZone} (band ${(bandLow*100).toFixed(0)}–${(bandHigh*100).toFixed(0)}%)`,
);

// ── L3.2: Track-record from most-recent scorecard artifact ───────────────────
const __scriptDir = dirname(fileURLToPath(import.meta.url));
const __repoRoot  = join(__scriptDir, '..');
let _trackMap     = {};
try {
  const _artDir = join(__repoRoot, 'artifacts');
  const _files  = readdirSync(_artDir)
    .filter(f => f.startsWith('scorecard-') && f.endsWith('.json'))
    .sort().reverse();
  if (_files.length > 0) {
    const _data = JSON.parse(readFileSync(join(_artDir, _files[0]), 'utf8'));
    for (const r of (_data.per_rec ?? [])) {
      if (r.verdict === 'NO-DATA') continue;
      const dir = r.judgment?.direction ?? '';
      for (const mkt of [r.market, '']) {
        const key = r.rec_type + '|' + dir + '|' + mkt;
        if (!_trackMap[key]) _trackMap[key] = { wins: 0, n: 0, gpDs: [] };
        _trackMap[key].n++;
        if (r.verdict === 'WIN') _trackMap[key].wins++;
        if (r.gp_delta != null)  _trackMap[key].gpDs.push(r.gp_delta);
      }
    }
    console.log('Track-record artifact loaded: ' + _files[0]);
  }
} catch (_e) { /* artifact optional */ }

function getTrackRecord(recType, direction, mkt) {
  const dir    = direction ?? '';
  const mktKey = recType + '|' + dir + '|' + mkt;
  const estKey = recType + '|' + dir + '|';
  const compute = (b) => {
    if (!b || b.n === 0) return null;
    const sorted = [...b.gpDs].sort((a, c) => a - c);
    const mid = Math.floor(sorted.length / 2);
    const med = sorted.length === 0 ? null
      : sorted.length % 2 === 0 ? (sorted[mid-1] + sorted[mid]) / 2 : sorted[mid];
    return { win_rate: b.wins / b.n, n: b.n, median_gp_delta: med };
  };
  const mktB = _trackMap[mktKey];
  if (mktB && mktB.n >= 10) return { ...compute(mktB), scope: 'market' };
  const estB = _trackMap[estKey];
  const tr   = compute(estB);
  return tr ? { ...tr, scope: 'estate' } : null;
}

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

// ── v6: collectBidEntities — scaffold (Frame 2) ───────────────────────────────
// Returns one entry per ENABLED bidding entity with its performance data.
// Census print only — no draft changes this frame.
async function collectBidEntities(bidPool, bidProfileId, bTermMap) {
  // TARGET: ENABLED amazon_targets, resolved_asin NOT NULL, not AUTO
  const { rows: tRows } = await bidPool.query(
    `SELECT target_id::text   AS entity_id,
            ad_group_id::text,
            campaign_id::text,
            bid,
            resolved_asin
       FROM amazon_targets
      WHERE profile_id      = $1
        AND state           = 'ENABLED'
        AND resolved_asin   IS NOT NULL
        AND expression_type != 'AUTO'`,
    [bidProfileId],
  );

  // KEYWORD: ENABLED keywords of ALL match types (EXACT/PHRASE/BROAD) — v6.1
  // Safety: PHRASE/BROAD bid changes affect whole query families — the per-step
  // caps (raise_max_step / cut_max_step) are the guard; no additional mechanism needed.
  const { rows: kRows } = await bidPool.query(
    `SELECT keyword_id::text  AS entity_id,
            ad_group_id::text,
            campaign_id::text,
            bid,
            keyword_text,
            match_type
       FROM amazon_keywords
      WHERE profile_id  = $1
        AND state       = 'ENABLED'`,
    [bidProfileId],
  );

  // AUTO_STRATEGY: ENABLED amazon_targets expression_type='AUTO'
  const { rows: aRows } = await bidPool.query(
    `SELECT target_id::text   AS entity_id,
            ad_group_id::text,
            campaign_id::text,
            bid,
            expression
       FROM amazon_targets
      WHERE profile_id      = $1
        AND state           = 'ENABLED'
        AND expression_type = 'AUTO'`,
    [bidProfileId],
  );

  // Group-level performance index for AUTO_STRATEGY (all placements → ad_group_id).
  const groupPerf = new Map(); // ad_group_id (string) → { spend, clicks, orders, sales }
  for (const [, termEntry] of bTermMap) {
    for (const p of termEntry.placements) {
      const gKey = String(p.ad_group_id);
      if (!groupPerf.has(gKey)) groupPerf.set(gKey, { spend: 0, clicks: 0, orders: 0, sales: 0 });
      const g   = groupPerf.get(gKey);
      g.spend  += p.spend;
      g.clicks += p.clicks;
      g.orders += p.orders;
      g.sales  += p.sales;
    }
  }

  const entities = [];

  // TARGET — basis: term-in-group (search_term = lower(resolved_asin) + same ad_group_id)
  for (const row of tRows) {
    const lookupKey = row.resolved_asin.toLowerCase();
    const termEntry = bTermMap.get(lookupKey);
    const placement = termEntry?.placements.find((p) => String(p.ad_group_id) === row.ad_group_id);
    const spend     = placement?.spend  ?? 0;
    const clicks    = placement?.clicks ?? 0;
    const orders    = placement?.orders ?? 0;
    const sales     = placement?.sales  ?? 0;
    entities.push({
      entity_kind:       'TARGET',
      entity_id:         row.entity_id,
      ad_group_id:       row.ad_group_id,
      campaign_id:       row.campaign_id,
      current_bid:       row.bid != null ? Number(row.bid) : null,
      resolved_asin:     row.resolved_asin,
      spend, clicks, orders, sales,
      acos:              sales > 0 ? spend / sales : null,
      performance_basis: 'term-in-group',
    });
  }

  // KEYWORD — basis: term-in-group (search_term = lower(keyword_text) + same ad_group_id)
  for (const row of kRows) {
    const lookupKey = row.keyword_text.toLowerCase();
    const termEntry = bTermMap.get(lookupKey);
    const placement = termEntry?.placements.find((p) => String(p.ad_group_id) === row.ad_group_id);
    const spend     = placement?.spend  ?? 0;
    const clicks    = placement?.clicks ?? 0;
    const orders    = placement?.orders ?? 0;
    const sales     = placement?.sales  ?? 0;
    entities.push({
      entity_kind:       'KEYWORD',
      entity_id:         row.entity_id,
      ad_group_id:       row.ad_group_id,
      campaign_id:       row.campaign_id,
      current_bid:       row.bid != null ? Number(row.bid) : null,
      keyword_text:      row.keyword_text,
      match_type:        row.match_type,   // EXACT | PHRASE | BROAD
      spend, clicks, orders, sales,
      acos:              sales > 0 ? spend / sales : null,
      performance_basis: 'term-in-group',
    });
  }

  // AUTO_STRATEGY — basis: group-level (SUM all rollup rows for this ad_group_id)
  for (const row of aRows) {
    const perf = groupPerf.get(row.ad_group_id) ?? { spend: 0, clicks: 0, orders: 0, sales: 0 };
    entities.push({
      entity_kind:       'AUTO_STRATEGY',
      entity_id:         row.entity_id,
      ad_group_id:       row.ad_group_id,
      campaign_id:       row.campaign_id,
      current_bid:       row.bid != null ? Number(row.bid) : null,
      expression:        row.expression,
      spend:             perf.spend,
      clicks:            perf.clicks,
      orders:            perf.orders,
      sales:             perf.sales,
      acos:              perf.sales > 0 ? perf.spend / perf.sales : null,
      performance_basis: 'group-level',
    });
  }

  return entities;
}

const bidEntities  = await collectBidEntities(pool, profileId, termMap);
const v6Counts     = { TARGET: 0, KEYWORD: 0, AUTO_STRATEGY: 0 };
for (const e of bidEntities) v6Counts[e.entity_kind]++;
const v6WithVolume = bidEntities.filter(
  (e) => e.clicks >= (params.v6_min_clicks ?? 30) || e.orders >= (params.v6_min_orders ?? 3),
).length;
console.log(
  `v6 entities: TARGET ${v6Counts.TARGET} / KEYWORD ${v6Counts.KEYWORD} / AUTO_STRATEGY ${v6Counts.AUTO_STRATEGY} (with volume: ${v6WithVolume})`,
);

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

  let salesAtRisk = false;

  if (orders === 0 && spend >= negate_min_spend && clicks >= negate_min_clicks) {
    // Zero-order negations — clean negate, flow as today
    recType = ASIN_SHAPE.test(row.search_term) ? 'NEGATE_TARGET' : 'NEGATE_TERM';
  } else if (
    orders > 0 && spend >= negate_min_spend && clicks >= negate_min_clicks &&
    !((!ASIN_SHAPE.test(row.search_term) && orders >= harvest_min_orders && acos !== null && acos < target_acos) ||
      (ASIN_SHAPE.test(row.search_term)  && orders >= promote_asin_min_orders && acos !== null && acos < target_acos))
  ) {
    // L3.2 [REVIEW]: meets negate thresholds, has orders, but doesn't qualify for promote.
    // Christian sees the sales risk before ruling — status DRAFT, proposal prefixed '[REVIEW]'.
    recType    = ASIN_SHAPE.test(row.search_term) ? 'NEGATE_TARGET' : 'NEGATE_TERM';
    salesAtRisk = true;
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
      placements:  row.placements,
      salesAtRisk,
    });
  }
}

// ── 5. WRITE DRAFTS (idempotent) ─────────────────────────────────────────────
let written         = 0;
let skippedExisting = 0;
let skippedRejected = 0;
const countsByType  = { NEGATE_TERM: 0, NEGATE_TARGET: 0, PROMOTE_TERM: 0, PROMOTE_ASIN: 0, BID_ADJUST: 0, DEFUSE: 0, CREATE_STRUCTURE: 0, BUDGET_ADJUST: 0, PAUSE_CAMPAIGN: 0, REPLACE_PRODUCT_AD: 0 };

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

  // Build lookup sets keyed "recType|lower(target_text)"
  // v5: BID_ADJUST keyed same way — profile+type+target.
  // v6 fix: match on lower(target_text) and include HELD in terminal statuses
  //         so re-born terms (any case) are suppressed across all terminal states.
  const openSet     = new Set(); // DRAFT | APPROVED | PUSHED → skip
  const rejectedSet = new Set(); // REJECTED | HELD → skip (not placement-scoped)
  for (const row of existingRows) {
    const key = `${row.rec_type}|${row.target_text.toLowerCase()}`;
    if (['DRAFT', 'APPROVED', 'PUSHED'].includes(row.status)) openSet.add(key);
    else if (['REJECTED', 'HELD'].includes(row.status))        rejectedSet.add(key);
  }

  // Detect auto ad groups: any group whose ENABLED targets include expression_type='AUTO'.
  // Used to exclude auto destinations from PROMOTE_ASIN primary_placement selection.
  const allPromotePlacementAgIds = [
    ...new Set(
      candidates
        .filter((c) => c.recType === 'PROMOTE_ASIN')
        .flatMap((c) => c.placements.map((p) => p.ad_group_id))
        .filter(Boolean),
    ),
  ];
  const autoGroupSet = new Set(); // ad_group_id (string) — group has expression_type='AUTO' target
  if (allPromotePlacementAgIds.length > 0) {
    const { rows: autoRows } = await pool.query(
      `SELECT DISTINCT ad_group_id::text
         FROM amazon_targets
        WHERE profile_id      = $1
          AND ad_group_id     = ANY($2)
          AND state           = 'ENABLED'
          AND expression_type = 'AUTO'
       UNION
       SELECT ag.ad_group_id::text
         FROM amazon_ad_groups ag
         JOIN amazon_campaigns  c ON c.campaign_id = ag.campaign_id
                                 AND c.profile_id  = ag.profile_id
        WHERE ag.profile_id  = $1
          AND ag.ad_group_id = ANY($2)
          AND c.targeting_type = 'AUTO'`,
      [profileId, allPromotePlacementAgIds],
    );
    for (const row of autoRows) autoGroupSet.add(String(row.ad_group_id));
  }

  // ── Already-targeted ASIN check (v5 harvested-check restored in v6) ──────────
  // Batch-fetch ASINs already ENABLED as targets for this profile.
  // Candidates whose ASIN appears are skipped entirely — bid tuning for existing
  // targets is v6 entity territory; no card should be raised here.
  const promoteAsinTermsUpper = candidates
    .filter((c) => c.recType === 'PROMOTE_ASIN')
    .map((c) => c.searchTerm.toUpperCase());
  const alreadyTargetedAsinSet = new Set();
  if (promoteAsinTermsUpper.length > 0) {
    const { rows: harvestedRows } = await pool.query(
      `SELECT DISTINCT upper(resolved_asin) AS asin
         FROM amazon_targets
        WHERE profile_id    = $1
          AND state         = 'ENABLED'
          AND resolved_asin IS NOT NULL
          AND upper(resolved_asin) = ANY($2)`,
      [profileId, promoteAsinTermsUpper],
    );
    for (const row of harvestedRows) alreadyTargetedAsinSet.add(row.asin);
  }

  // ── PROMOTE_TERM destination resolution (generation-time tier prediction) ───
  // Replicates the push-keywords.mjs tier predicate exactly (b31952e + 94ce867
  // lineage): campaign targeting_type filter is authoritative for AUTO exclusion.
  // HONESTY NOTE: push-time resolution remains authoritative; if structure changed
  // between generation and push, the push script's choice wins — the panel is the
  // generation-time prediction.
  const ptCandidates = candidates.filter(c => c.recType === 'PROMOTE_TERM');
  const ptAgIds = [...new Set(
    ptCandidates.flatMap(c => c.placements.map(p => String(p.ad_group_id)).filter(Boolean)),
  )];

  const ptGroupKwMap       = new Map(); // ad_group_id → { exactKws, anyKws, hasAuto }
  const ptAutoCampGroupIds = new Set(); // ad_group_ids whose campaign.targeting_type = 'AUTO'

  if (ptAgIds.length > 0) {
    const { rows: ptKwRows } = await pool.query(
      `SELECT ad_group_id::text,
              count(*) FILTER (WHERE match_type = 'EXACT') AS exact_kws,
              count(*) AS any_kws
         FROM amazon_keywords
        WHERE profile_id  = $1
          AND ad_group_id = ANY($2)
          AND state       = 'ENABLED'
        GROUP BY ad_group_id`,
      [profileId, ptAgIds],
    );
    for (const row of ptKwRows) {
      ptGroupKwMap.set(row.ad_group_id, { exactKws: Number(row.exact_kws), anyKws: Number(row.any_kws), hasAuto: 0 });
    }
    const { rows: ptAutoTgtRows } = await pool.query(
      `SELECT ad_group_id::text,
              count(*) FILTER (WHERE expression_type = 'AUTO') AS has_auto
         FROM amazon_targets
        WHERE profile_id  = $1
          AND ad_group_id = ANY($2)
          AND state       = 'ENABLED'
        GROUP BY ad_group_id`,
      [profileId, ptAgIds],
    );
    for (const row of ptAutoTgtRows) {
      const entry = ptGroupKwMap.get(row.ad_group_id);
      if (entry) entry.hasAuto = Number(row.has_auto);
      else ptGroupKwMap.set(row.ad_group_id, { exactKws: 0, anyKws: 0, hasAuto: Number(row.has_auto) });
    }
    const { rows: ptAutoCampRows } = await pool.query(
      `SELECT ag.ad_group_id::text
         FROM amazon_ad_groups ag
         JOIN amazon_campaigns  c ON c.campaign_id = ag.campaign_id
                                  AND c.profile_id  = ag.profile_id
        WHERE ag.profile_id  = $1
          AND ag.ad_group_id = ANY($2)
          AND c.targeting_type = 'AUTO'`,
      [profileId, ptAgIds],
    );
    for (const row of ptAutoCampRows) ptAutoCampGroupIds.add(row.ad_group_id);
  }

  const ptAgNameMap = new Map(); // ad_group_id → name
  if (ptAgIds.length > 0) {
    const { rows: ptAgRows } = await pool.query(
      `SELECT ad_group_id::text, name
         FROM amazon_ad_groups
        WHERE profile_id  = $1
          AND ad_group_id = ANY($2)`,
      [profileId, ptAgIds],
    );
    for (const r of ptAgRows) ptAgNameMap.set(r.ad_group_id, r.name);
  }

  // ── Pre-compute resolved destinations for all PROMOTE_TERM candidates ────────
  // Needed for the batch already-exact check below; reused inside the write loop
  // so the tier logic runs only once per candidate.
  const ptResolvedDestMap = new Map(); // searchTerm → resolvedDestination | null
  for (const c of ptCandidates) {
    const tierA = c.placements
      .filter(p => (ptGroupKwMap.get(String(p.ad_group_id))?.exactKws ?? 0) >= 1
                && (ptGroupKwMap.get(String(p.ad_group_id))?.hasAuto  ?? 0) === 0
                && !ptAutoCampGroupIds.has(String(p.ad_group_id)))
      .sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0));
    const tierB = c.placements
      .filter(p => (ptGroupKwMap.get(String(p.ad_group_id))?.anyKws   ?? 0) >= 1
                && (ptGroupKwMap.get(String(p.ad_group_id))?.hasAuto  ?? 0) === 0
                && !ptAutoCampGroupIds.has(String(p.ad_group_id)))
      .sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0));
    let rd = null;
    if (tierA.length > 0) {
      const dest = tierA[0];
      const agId = String(dest.ad_group_id);
      rd = { ad_group_id: agId, ad_group_name: ptAgNameMap.get(agId) ?? agId, campaign_id: String(dest.campaign_id), tier: 'exact-kw' };
    } else if (tierB.length > 0) {
      const dest = tierB[0];
      const agId = String(dest.ad_group_id);
      rd = { ad_group_id: agId, ad_group_name: ptAgNameMap.get(agId) ?? agId, campaign_id: String(dest.campaign_id), tier: 'kw-holding' };
    }
    ptResolvedDestMap.set(c.searchTerm, rd);
  }

  // ── Batch already-exact-in-destination check (PROMOTE_TERM honesty pair, bite 1) ─
  // One query for all (lower(term), dest_ag_id) pairs — no N queries.
  // Candidates with a null destination (orphans) are excluded here; they pass
  // through to CREATE_STRUCTURE unchanged.
  const ptAlreadyExactSet = new Set(); // key: `${lower(term)}|${dest_ag_id}`
  {
    const ptCheckPairs = ptCandidates
      .map(c => ({ term: c.searchTerm, rd: ptResolvedDestMap.get(c.searchTerm) }))
      .filter(({ rd }) => rd != null);
    if (ptCheckPairs.length > 0) {
      const kwLowerList = ptCheckPairs.map(({ term }) => term.toLowerCase());
      const destAgList  = [...new Set(ptCheckPairs.map(({ rd }) => rd.ad_group_id))];
      const { rows: exactRows } = await pool.query(
        `SELECT lower(keyword_text) AS kw_lower, ad_group_id::text AS ag_id
           FROM amazon_keywords
          WHERE profile_id          = $1
            AND state               = 'ENABLED'
            AND match_type          = 'EXACT'
            AND lower(keyword_text) = ANY($2)
            AND ad_group_id::text   = ANY($3)`,
        [profileId, kwLowerList, destAgList],
      );
      for (const row of exactRows) {
        ptAlreadyExactSet.add(`${row.kw_lower}|${row.ag_id}`);
      }
    }
    console.log(`PROMOTE_TERM destination-exact check: ${ptCheckPairs.length} candidate(s) with destination, ${ptAlreadyExactSet.size} already exact.`);
  }

  for (const c of candidates) {
    const spendFmt = `${currSym}${c.spend.toFixed(2)}`;
    const win      = `${windowStart} – ${windowEnd}`;

    // ── Already-targeted ASIN skip (v5 harvested-check restored) ────────────────
    if (c.recType === 'PROMOTE_ASIN' && alreadyTargetedAsinSet.has(c.searchTerm.toUpperCase())) {
      console.log(`  skipped (already targeted): [PROMOTE_ASIN] ${c.searchTerm.toUpperCase()}`);
      continue;
    }

    // ── Already-exact-in-destination skip (PROMOTE_TERM honesty pair, bite 1) ───
    // The batch check ran above; skip any candidate whose term is already live as
    // an ENABLED EXACT keyword in its resolved destination group. Null-destination
    // orphans are not in ptAlreadyExactSet and are unaffected — they flow to
    // CREATE_STRUCTURE as before.
    if (c.recType === 'PROMOTE_TERM') {
      const _rd = ptResolvedDestMap.get(c.searchTerm);
      if (_rd != null && ptAlreadyExactSet.has(`${c.searchTerm.toLowerCase()}|${_rd.ad_group_id}`)) {
        console.log(`  skipped (already exact in destination): [PROMOTE_TERM] ${c.searchTerm} → ${_rd.ad_group_name}`);
        continue;
      }
    }

    // All PROMOTE_ASIN candidates are now UNHARVESTED — BID_ADJUST comes from bidEntities (v6).
    const finalRecType = c.recType;
    let observedCpc    = null;
    let proposedBid    = null;

    if (c.recType === 'PROMOTE_ASIN' && c.clicks > 0) {
      observedCpc = c.spend / c.clicks;
      proposedBid = Math.min(
        Math.round(observedCpc * params.promote_bid_cpc_multiplier * 100) / 100,
        params.promote_bid_max,
      );
    }

    // ── Idempotency check — uses finalRecType ─────────────────────────────────
    countsByType[finalRecType] = (countsByType[finalRecType] ?? 0) + 1;
    const key = `${finalRecType}|${c.searchTerm.toLowerCase()}`;

    if (openSet.has(key)) {
      skippedExisting++;
      continue;
    }
    if (rejectedSet.has(key)) {
      console.log(`  previously rejected, skipped: [${finalRecType}] "${c.searchTerm}"`);
      skippedRejected++;
      continue;
    }

    // ── Build proposal + evidence ─────────────────────────────────────────────
    let proposal;
    let evidence;

    if (finalRecType === 'NEGATE_TERM') {
      // L3.2: [REVIEW] prefix for salesAtRisk; zero-order path unchanged.
      const _negPrefix = c.salesAtRisk
        ? `[REVIEW] ` : '';
      const _negOrders = c.salesAtRisk
        ? `${c.orders} order(s) — saves ~${spendFmt} spend, risks ~${currSym}${c.sales.toFixed(2)} sales`
        : '0 orders';
      proposal = `${_negPrefix}Negate '${c.searchTerm}': ${spendFmt} spend, ${c.clicks} clicks, ${_negOrders} in ${win}.`;
      const primaryPlacement = c.placements.reduce(
        (max, p) => (p.spend > max.spend ? p : max),
        c.placements[0],
      );
      evidence = {
        window_start:       windowStart,
        window_end:         windowEnd,
        spend:              c.spend,
        clicks:             c.clicks,
        orders:             c.orders,
        sales:              c.sales,
        acos:               c.acos,
        placements:         c.placements,
        primary_placement:  primaryPlacement,
        params_used:        params,
        ...(c.salesAtRisk ? { sales_at_risk: c.sales } : {}),
        rule_track_record:  getTrackRecord('NEGATE_TERM', null, countryCode) ?? undefined,
      };
    } else if (finalRecType === 'NEGATE_TARGET') {
      // ASIN-shaped term: keyword negation cannot block product-targeting traffic.
      // L3.2: [REVIEW] prefix for salesAtRisk.
      const _ntPrefix  = c.salesAtRisk ? '[REVIEW] ' : '';
      const _ntRiskStr = c.salesAtRisk
        ? ` — saves ~${spendFmt} spend, risks ~${currSym}${c.sales.toFixed(2)} sales` : '';
      proposal = `${_ntPrefix}Negative product target for ${c.searchTerm.toUpperCase()}${_ntRiskStr} — keyword negation cannot block product-targeting traffic.`;
      const primaryPlacement = c.placements.reduce(
        (max, p) => (p.spend > max.spend ? p : max),
        c.placements[0],
      );
      evidence = {
        window_start:       windowStart,
        window_end:         windowEnd,
        spend:              c.spend,
        clicks:             c.clicks,
        orders:             c.orders,
        sales:              c.sales,
        acos:               c.acos,
        placements:         c.placements,
        primary_placement:  primaryPlacement,
        params_used:        params,
        ...(c.salesAtRisk ? { sales_at_risk: c.sales } : {}),
        rule_track_record:  getTrackRecord('NEGATE_TARGET', null, countryCode) ?? undefined,
      };
    } else if (finalRecType === 'PROMOTE_TERM') {
      // Unchanged from v4. v5.1: compute observed_cpc/proposed_bid and add to evidence when clicks > 0.
      if (c.clicks > 0) {
        observedCpc = c.spend / c.clicks;
        proposedBid = Math.min(
          Math.round(observedCpc * params.promote_bid_cpc_multiplier * 100) / 100,
          params.promote_bid_max,
        );
      }
      const acosPct = (c.acos * 100).toFixed(1);
      proposal =
        `Promote '${c.searchTerm}' to exact match: ${c.orders} orders at ` +
        `${acosPct}% ACoS (${spendFmt} spend) in ${win}.`;
      const primaryPlacement = c.placements.reduce(
        (max, p) => (p.spend > max.spend ? p : max),
        c.placements[0],
      );

      // ── Generation-time destination resolution (pre-computed above; mirrors push-keywords.mjs tier predicate) ──
      // HONESTY NOTE: push-time resolution remains authoritative; if structure changed
      // between generation and push, the push script's choice wins — the panel is the
      // generation-time prediction.
      const resolvedDestination = ptResolvedDestMap.get(c.searchTerm) ?? null;

      evidence = {
        window_start:         windowStart,
        window_end:           windowEnd,
        spend:                c.spend,
        clicks:               c.clicks,
        orders:               c.orders,
        sales:                c.sales,
        acos:                 c.acos,
        placements:           c.placements,
        primary_placement:    primaryPlacement,
        ...(observedCpc != null ? { observed_cpc: observedCpc } : {}),
        ...(proposedBid  != null ? { proposed_bid:  proposedBid  } : {}),
        resolved_destination: resolvedDestination,
        params_used:          params,
        rule_track_record:    getTrackRecord('PROMOTE_TERM', null, countryCode) ?? undefined,
      };
    } else {
      // PROMOTE_ASIN — UNHARVESTED (new target, destination = highest-spend placement).
      const eligiblePlacements = c.placements.filter((p) => !autoGroupSet.has(String(p.ad_group_id)));
      if (eligiblePlacements.length === 0) {
        console.log(`  skipped (no manual destination — all placements are auto groups): [PROMOTE_ASIN] "${c.searchTerm}"`);
        continue;
      }
      const acosPct = (c.acos * 100).toFixed(1);
      proposal =
        `Target ASIN for '${c.searchTerm}': ${c.orders} orders at ` +
        `${acosPct}% ACoS (${spendFmt} spend) in ${win}.`;
      const primaryPlacement = eligiblePlacements.reduce(
        (max, p) => (p.spend > max.spend ? p : max),
        eligiblePlacements[0],
      );
      evidence = {
        window_start:      windowStart,
        window_end:        windowEnd,
        spend:             c.spend,
        clicks:            c.clicks,
        orders:            c.orders,
        sales:             c.sales,
        acos:              c.acos,
        placements:        c.placements,
        primary_placement: primaryPlacement,
        existing_targets:  [],
        ...(observedCpc != null ? { observed_cpc: observedCpc } : {}),
        ...(proposedBid  != null ? { proposed_bid:  proposedBid  } : {}),
        params_used:       params,
        rule_track_record: getTrackRecord('PROMOTE_ASIN', null, countryCode) ?? undefined,
      };
    }

    await pool.query(
      `INSERT INTO recommendations
         (rec_type, profile_id, campaign_id, target_text, proposal, evidence)
       VALUES ($1, $2, NULL, $3, $4, $5)`,
      [finalRecType, profileId, c.searchTerm, proposal, JSON.stringify(evidence)],
    );
    written++;
  }
} else {
  console.log('No candidates found — nothing to write.');
}

// ── Retro sweep: PUSHED NEGATE_TERM with ASIN-shaped target (leak cohort) ────────
// Print only — no auto-action. Christian decides whether to remediate as NEGATE_TARGET.
{
  const { rows: leakedRecs } = await pool.query(
    `SELECT target_text
       FROM recommendations
      WHERE profile_id = $1
        AND rec_type   = 'NEGATE_TERM'
        AND status     = 'PUSHED'`,
    [profileId],
  );
  for (const row of leakedRecs) {
    if (ASIN_SHAPE.test(row.target_text)) {
      console.log(
        `info: consider NEGATE_TARGET for previously keyword-negated ASIN ${row.target_text}`,
      );
    }
  }
}


// ── 5.5 v6 BID_ADJUST — RAISE / CUT / DEFUSE from bidEntities ─────────────────
console.log('\n── v6 BID_ADJUST (RAISE/CUT/DEFUSE) ──────────────────────────────────');

// Map AUTO expression type to readable label for kind-phrase.
const AUTO_EXPR_LABEL = {
  'close-match':             'close match',
  'loose-match':             'loose match',
  'substitutes':             'substitutes',
  'complements':             'complements',
  // Amazon API raw expression types
  'QUERY_HIGH_REL_MATCHES':  'close match',
  'QUERY_BROAD_REL_MATCHES': 'loose match',
  'ASIN_SUBSTITUTE_RELATED': 'substitutes',
  'ASIN_ACCESSORY_RELATED':  'complements',
};

function bidKindPhrase(entity, agName) {
  const grp = agName ?? entity.ad_group_id;
  if (entity.entity_kind === 'TARGET') {
    return `target '${entity.resolved_asin}' in '${grp}'`;
  }
  if (entity.entity_kind === 'KEYWORD') {
    const mtTag = entity.match_type ? ` [${entity.match_type}]` : '';
    return `keyword '${entity.keyword_text}'${mtTag} in '${grp}'`;
  }
  // AUTO_STRATEGY — map from expression JSON
  const exprArr   = Array.isArray(entity.expression) ? entity.expression : [];
  const rawType   = (exprArr[0] ?? {}).type ?? null;
  const exprLabel = (rawType && AUTO_EXPR_LABEL[rawType]) ?? 'auto targeting';
  return `auto strategy ${exprLabel} in '${grp}'`;
}

// Batch-fetch ad group names for all bidEntities (::text cast on column — 42883 safety).
const bidAgIds     = [...new Set(bidEntities.map((e) => e.ad_group_id).filter(Boolean))];
const bidAgNameMap = new Map(); // ad_group_id (string) → name
if (bidAgIds.length > 0) {
  const { rows: bidAgRows } = await pool.query(
    `SELECT ad_group_id::text, name
       FROM amazon_ad_groups
      WHERE profile_id        = $1
        AND ad_group_id::text = ANY($2)`,
    [profileId, bidAgIds],
  );
  for (const r of bidAgRows) bidAgNameMap.set(r.ad_group_id, r.name);
}

// Idempotency: open BID_ADJUST recs keyed on target_text = entity_id.
const { rows: openBidRows } = await pool.query(
  `SELECT target_text
     FROM recommendations
    WHERE profile_id = $1
      AND rec_type   = 'BID_ADJUST'
      AND status     = ANY($2)`,
  [profileId, ['DRAFT', 'APPROVED', 'PUSHED']],
);
const openBidSet = new Set(openBidRows.map((r) => r.target_text));

// Volume filter: entity must meet v6_min_clicks OR v6_min_orders, and have a bid.
// L3.2: below-band markets use half the click floor for RAISE candidates.
const bidMinClicks = params.v6_min_clicks ?? 30;
const bidMinOrders = params.v6_min_orders ?? 3;
const effectiveBidMinClicks = marketZone === 'below' ? Math.floor(bidMinClicks / 2) : bidMinClicks;
const bidEligible  = bidEntities.filter(
  (e) => e.current_bid !== null &&
         (e.clicks >= effectiveBidMinClicks || e.orders >= bidMinOrders),
);
console.log(`  Eligible for bid review (volume filter): ${bidEligible.length}`);

// Batch-fetch Amazon bid recommendations (fresh ≤14 days) for all eligible entities.
// THE QUOTE IS CONTEXT ONLY — vpc, proposed bid, caps, and steps are unchanged.
const bidRecEligibleIds = bidEligible.map((e) => e.entity_id);
const bidRecMap = new Map(); // entity_id → { amazon_suggested, amazon_range_start, amazon_range_end, quote_age_days }
if (bidRecEligibleIds.length > 0) {
  const { rows: bidRecRows } = await pool.query(
    `SELECT entity_id,
            suggested::float                                              AS amazon_suggested,
            range_start::float                                            AS amazon_range_start,
            range_end::float                                              AS amazon_range_end,
            FLOOR(EXTRACT(epoch FROM (now() - fetched_at)) / 86400)::int AS quote_age_days
       FROM amazon_bid_recommendations
      WHERE profile_id = $1
        AND entity_id  = ANY($2)
        AND fetched_at >= now() - INTERVAL '14 days'`,
    [profileId, bidRecEligibleIds],
  );
  for (const row of bidRecRows) {
    bidRecMap.set(row.entity_id, {
      amazon_suggested:   row.amazon_suggested,
      amazon_range_start: row.amazon_range_start,
      amazon_range_end:   row.amazon_range_end,
      quote_age_days:     row.quote_age_days,
    });
  }
  console.log(`  Amazon bid-rec enrichment: ${bidRecMap.size} entity match(es) (≤14d fresh).`);
}

for (const entity of bidEligible) {
  const currentBid = entity.current_bid;
  const agName     = bidAgNameMap.get(entity.ad_group_id);
  const kindPhrase = bidKindPhrase(entity, agName);

  // Idempotency — skip when open BID_ADJUST for this entity_id already exists.
  if (openBidSet.has(entity.entity_id)) {
    console.log(`  skipped (open rec exists): [BID_ADJUST] ${entity.entity_kind} ${entity.entity_id}`);
    skippedExisting++;
    continue;
  }

  let direction   = null;
  let proposedBid = null;
  let vpc         = null;
  let boundBy     = 'none';
  let isDefuse    = false;

  if (entity.sales > 0) {
    // vpc = value per click at target ACoS; sales > 0 and clicks > 0 required.
    if (entity.clicks === 0) continue;
    vpc = Math.round((entity.sales / entity.clicks) * params.target_acos * 100) / 100;

    if (entity.acos < params.target_acos && vpc > currentBid) {
      // RAISE — L3.2 band-aware gates
      if (marketZone === 'above') {
        // Repair market: proven winners only — ACoS ≤ 30% AND orders ≥ 3
        if (entity.acos > 0.30 || entity.orders < 3) continue;
      }
      // Below-band: loosened step cap 1.75×; in-band: current gates
      const raiseStepCap = marketZone === 'below' ? 1.75 : (params.raise_max_step ?? 1.5);
      const step    = entity.entity_kind === 'AUTO_STRATEGY'
        ? (params.auto_strategy_raise_step ?? 1.3)
        : raiseStepCap;
      const stepBid = Math.round(currentBid * step * 100) / 100;
      const capBid  = params.raise_bid_max ?? 0.75;
      proposedBid   = Math.min(vpc, stepBid, capBid);
      direction     = 'Raise';
      if      (proposedBid === capBid  && capBid  <= vpc && capBid  <= stepBid) boundBy = 'cap';
      else if (proposedBid === stepBid && stepBid <= vpc)                        boundBy = 'step';
    } else if (entity.acos > params.target_acos && vpc < currentBid) {
      // CUT — L3.2 band-aware gate
      // Gate 1: entity ACoS must exceed band ceiling (market-zone adjusted)
      //   in/below-band markets: only extraordinary waste (ACoS > 2× ceiling = 70%)
      //   above-band (repair) markets: entity ACoS > ceiling (35%)
      const cutMinAcos = (marketZone === 'in' || marketZone === 'below')
        ? bandHigh * 2   // 70% extraordinary waste
        : bandHigh;      // 35% standard repair-zone cut
      if (entity.acos <= cutMinAcos) continue;
      // Gate 2: clicks >= 2× v6 click floor (high confidence required)
      if (entity.clicks < bidMinClicks * 2) continue;
      const step    = entity.entity_kind === 'AUTO_STRATEGY'
        ? (params.auto_strategy_cut_step ?? 0.7)
        : (params.cut_max_step           ?? 0.6);
      const stepBid = Math.round(currentBid * step * 100) / 100;
      proposedBid   = Math.max(vpc, stepBid, 0.05);
      direction     = 'Cut';
      if      (proposedBid === 0.05    && 0.05    >= vpc && 0.05    >= stepBid) boundBy = 'cap';
      else if (proposedBid === stepBid && stepBid >= vpc)                        boundBy = 'step';
    } else {
      continue; // neither condition met
    }

    // Skip negligible delta.
    if (Math.abs(proposedBid - currentBid) < 0.02) {
      console.log(`  skipped (delta < $0.02): [${direction.toUpperCase()}] ${entity.entity_kind} ${entity.entity_id}`);
      continue;
    }
  } else if (entity.spend > 0 && entity.entity_kind === 'TARGET') {
    // DEFUSE — zero-sales TARGET with spend (v5.1 DORMANT logic, proposal prefixed 'Defuse dormant target').
    isDefuse    = true;
    direction   = 'Cut';
    const step  = params.cut_max_step ?? 0.6;
    proposedBid = Math.max(Math.round(currentBid * step * 100) / 100, 0.05);
    if (Math.abs(proposedBid - currentBid) < 0.02) {
      console.log(`  skipped (delta < $0.02): [DEFUSE] ${entity.entity_id}`);
      continue;
    }
  } else {
    continue; // no actionable signal
  }

  // Build proposal sentence.
  const curFmt      = `${currSym}${currentBid.toFixed(2)}`;
  const propFmt     = `${currSym}${proposedBid.toFixed(2)}`;
  const boundSuffix = boundBy !== 'none' ? ` (bounded by ${boundBy})` : '';

  // Amazon bid-rec context (context only — vpc/proposed bid unchanged).
  const amzRec = bidRecMap.get(entity.entity_id) ?? null;
  const amzSuffix = amzRec
    ? ` Amazon suggests ${currSym}${amzRec.amazon_suggested.toFixed(2)}` +
      ` (${currSym}${amzRec.amazon_range_start.toFixed(2)}–${currSym}${amzRec.amazon_range_end.toFixed(2)}).`
    : '';

  let proposal;
  if (isDefuse) {
    proposal =
      `Defuse dormant target ${kindPhrase}: ` +
      `${currSym}${entity.spend.toFixed(2)} spend, ${entity.clicks} clicks, 0 sales in ` +
      `${windowStart} – ${windowEnd} — cut bid from ${curFmt} to ${propFmt}.${amzSuffix}`;
  } else {
    const acosPct = (entity.acos * 100).toFixed(1);
    const cpcFmt  = entity.clicks > 0
      ? `${currSym}${(entity.spend / entity.clicks).toFixed(2)}`
      : '—';
    const vpcFmt  = `${currSym}${vpc.toFixed(2)}`;
    const tgtPct  = (params.target_acos * 100).toFixed(0);
    proposal =
      direction === 'Cut'
      ? `${direction} bid on ${kindPhrase} ` +
        `from ${curFmt} to ${propFmt}: ` +
        `its clicks are worth ${vpcFmt} at your ${tgtPct}% target ` +
        `(60d: ${entity.orders} orders, ${acosPct}% ACoS, ${cpcFmt}/click) — ` +
        `saves ~${currSym}${(_estSavedSpend ?? 0).toFixed(2)} spend, risks ~${currSym}${entity.sales.toFixed(2)} sales.${boundSuffix}${amzSuffix}`
      : `${direction} bid on ${kindPhrase} ` +
        `from ${curFmt} to ${propFmt}: ` +
        `its clicks are worth ${vpcFmt} at your ${tgtPct}% target ` +
        `(60d: ${entity.orders} orders, ${acosPct}% ACoS, ${cpcFmt}/click).${boundSuffix}${amzSuffix}`;
  }

  // Build evidence.
  const _bidDir = direction?.toUpperCase() ?? null;   // 'CUT' | 'RAISE' | null
  const _estSavedSpend = direction === 'Cut' && entity.clicks > 0
    ? Math.round((currentBid - proposedBid) * entity.clicks * 100) / 100 : null;
  const bidEvidence = {
    entity_kind:       entity.entity_kind,
    entity_id:         entity.entity_id,
    ad_group_id:       entity.ad_group_id,
    campaign_id:       entity.campaign_id,
    current_bid:       currentBid,
    proposed_bid:      proposedBid,
    vpc,
    spend:             entity.spend,
    clicks:            entity.clicks,
    orders:            entity.orders,
    sales:             entity.sales,
    acos:              entity.acos,
    target_acos:       params.target_acos,
    performance_basis: entity.performance_basis,
    window_start:      windowStart,
    window_end:        windowEnd,
    params_used:       params,
    bound_by:          boundBy,
    market_zone:       marketZone,
    market_rolling_acos: marketRollingAcos,
    ...(direction === 'Cut' ? {
      est_saved_spend:    _estSavedSpend,
      est_at_risk_sales:  entity.sales,
    } : {}),
    ...(entity.match_type ? { match_type: entity.match_type } : {}),
    ...(amzRec ? {
      amazon_suggested:   amzRec.amazon_suggested,
      amazon_range_start: amzRec.amazon_range_start,
      amazon_range_end:   amzRec.amazon_range_end,
      quote_age_days:     amzRec.quote_age_days,
    } : {}),
    rule_track_record: getTrackRecord('BID_ADJUST', _bidDir, countryCode) ?? undefined,
  };

  await pool.query(
    `INSERT INTO recommendations
       (rec_type, profile_id, campaign_id, target_text, proposal, evidence)
     VALUES ($1, $2, NULL, $3, $4, $5)`,
    ['BID_ADJUST', profileId, entity.entity_id, proposal, JSON.stringify(bidEvidence)],
  );

  const tag = isDefuse ? 'DEFUSE' : direction.toUpperCase();
  countsByType['BID_ADJUST']++;
  if (isDefuse) countsByType['DEFUSE']++;
  written++;
  console.log(`  [${tag}] ${entity.entity_kind} ${entity.entity_id}: ${curFmt} → ${propFmt}${boundSuffix}`);
}
console.log('──────────────────────────────────────────────────────────────────────');
// ── 6. CREATE_STRUCTURE PHASE ─────────────────────────────────────────────────
// Collect orphaned PROMOTE_TERM + PROMOTE_ASIN recs (DRAFT/APPROVED, this profile)
// whose push-script destination resolution (b31952e tier logic: campaign
// targeting_type filter) yields no eligible manual group, split by language,
// and emit one CREATE_STRUCTURE draft per needed room (idempotent).
console.log('\n── Phase 6: CREATE_STRUCTURE ────────────────────────────────────');

// 6a. Fetch open PROMOTE_TERM + PROMOTE_ASIN recs for this profile.
const { rows: openPromoteRows } = await pool.query(
  `SELECT id, rec_type, target_text, evidence
     FROM recommendations
    WHERE profile_id = $1
      AND rec_type   = ANY($2)
      AND status     = ANY($3)`,
  [profileId, ['PROMOTE_TERM', 'PROMOTE_ASIN'], ['DRAFT', 'APPROVED']],
);
console.log(`  Fetched ${openPromoteRows.length} open PROMOTE_TERM/PROMOTE_ASIN rec(s).`);

// 6b. Collect all placement ad_group_ids from stored evidence to resolve targeting_type.
const promoteAdGroupIds = [];
for (const row of openPromoteRows) {
  const ev = (typeof row.evidence === 'string') ? JSON.parse(row.evidence) : (row.evidence ?? {});
  for (const p of (ev.placements ?? [])) {
    if (p.ad_group_id) promoteAdGroupIds.push(p.ad_group_id);
  }
}
const uniquePromoteAgIds = [...new Set(promoteAdGroupIds)];

// Same two-leg AUTO detection used by the push scripts (b31952e lineage):
// a group is AUTO if its campaign has targeting_type='AUTO' OR if it has an
// expression_type='AUTO' enabled target.
const promoteAutoGroupSet = new Set();
if (uniquePromoteAgIds.length > 0) {
  const { rows: autoAgRows } = await pool.query(
    `SELECT ag.ad_group_id::text
       FROM amazon_ad_groups ag
       JOIN amazon_campaigns c ON c.campaign_id  = ag.campaign_id
                               AND c.profile_id  = ag.profile_id
      WHERE ag.profile_id  = $1
        AND ag.ad_group_id = ANY($2)
        AND c.targeting_type = 'AUTO'
     UNION
     SELECT DISTINCT ad_group_id::text
       FROM amazon_targets
      WHERE profile_id      = $1
        AND ad_group_id     = ANY($2)
        AND state           = 'ENABLED'
        AND expression_type = 'AUTO'`,
    [profileId, uniquePromoteAgIds],
  );
  for (const r of autoAgRows) promoteAutoGroupSet.add(r.ad_group_id);
}

// Groups with >= 1 ENABLED keyword — HOME test for PROMOTE_TERM.
const hasKeywordGroupSet = new Set();
// Groups with >= 1 ENABLED target — HOME test for PROMOTE_ASIN.
const hasTargetGroupSet  = new Set();
if (uniquePromoteAgIds.length > 0) {
  const { rows: kwRows } = await pool.query(
    `SELECT DISTINCT ad_group_id::text
       FROM amazon_keywords
      WHERE profile_id  = $1
        AND ad_group_id = ANY($2)
        AND state       = 'ENABLED'`,
    [profileId, uniquePromoteAgIds],
  );
  for (const r of kwRows) hasKeywordGroupSet.add(r.ad_group_id);

  const { rows: tgtRows } = await pool.query(
    `SELECT DISTINCT ad_group_id::text
       FROM amazon_targets
      WHERE profile_id  = $1
        AND ad_group_id = ANY($2)
        AND state       = 'ENABLED'`,
    [profileId, uniquePromoteAgIds],
  );
  for (const r of tgtRows) hasTargetGroupSet.add(r.ad_group_id);
}

// 6c. Orphan detection: rec has no HOME group.
//     HOME for PROMOTE_TERM = not AUTO AND has >= 1 ENABLED keyword.
//     HOME for PROMOTE_ASIN = not AUTO AND has >= 1 ENABLED target.
//     A manual-but-keyword-less group is neither pushable nor a HOME — it would
//     create permanent limbo — so it must NOT satisfy the HOME test.
const orphans = [];
for (const row of openPromoteRows) {
  const ev = (typeof row.evidence === 'string') ? JSON.parse(row.evidence) : (row.evidence ?? {});
  const placements = ev.placements ?? [];
  const holdingSet = row.rec_type === 'PROMOTE_TERM' ? hasKeywordGroupSet : hasTargetGroupSet;
  const hasManual  = placements.some(
    (p) => p.ad_group_id &&
           !promoteAutoGroupSet.has(String(p.ad_group_id)) &&
           holdingSet.has(String(p.ad_group_id)),
  );
  if (!hasManual) {
    orphans.push({ id: row.id, rec_type: row.rec_type, target_text: row.target_text, placements, evidence: ev });
  }
}
console.log(`  Orphans (no HOME — auto, keyword-less, or target-less): ${orphans.length}`);

// 6d. Language split helper — shared by keyword-room and ASIN-room proposals.
const detectLang = (term) => {
  const s = (' ' + term + ' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return (
    s.includes(' en ')    ||
    s.includes(' para ')  ||
    s.includes('espanol') ||
    s.includes('libro')   ||
    s.includes('cuento')  ||
    s.includes('ninos')   ||
    s.includes('bebes')   ||
    s.includes('infantil')
  ) ? 'ES' : 'EN';
};

if (orphans.length === 0) {
  console.log('  No orphans — skipping CREATE_STRUCTURE drafts.');
} else {
  const orphansByLang = { ES: [], EN: [] };
  for (const o of orphans) orphansByLang[detectLang(o.target_text)].push(o);
  console.log(`  Language split → ES: ${orphansByLang.ES.length}  EN: ${orphansByLang.EN.length}`);

  // 6e. For each language bucket that has orphans: collect seed ASINs, check
  //     idempotency, and insert one CREATE_STRUCTURE draft.
  for (const [lang, langOrphans] of Object.entries(orphansByLang)) {
    if (langOrphans.length === 0) continue;

    const targetText = countryCode === 'US' ? 'CDL | US | SP | ORPHAN KWs | EXACT' : `Keywords - Exacta ${countryCode} (${lang})`;

    // Idempotency: skip if an open CREATE_STRUCTURE for this target_text already exists.
    const { rows: existOpen } = await pool.query(
      `SELECT id FROM recommendations
        WHERE profile_id  = $1
          AND rec_type    = 'CREATE_STRUCTURE'
          AND target_text = $2
          AND status      = ANY($3)`,
      [profileId, targetText, ['DRAFT', 'APPROVED', 'PUSHED']],
    );
    if (existOpen.length > 0) {
      console.log(`  [CREATE_STRUCTURE] '${targetText}' already open (id ${existOpen[0].id}) — skipping.`);
      continue;
    }

    // Seed ASINs: each orphan's top-spend placement ad_group_id → advertised ASINs
    // from amazon_product_ads; union per bucket, cap 20, order by orphan-count desc.
    const orphanTopAgMap = new Map(); // ad_group_id → how many orphans land here as top-spend
    for (const o of langOrphans) {
      if (o.placements.length === 0) continue;
      const top = o.placements.reduce((best, p) => (p.spend > best.spend ? p : best), o.placements[0]);
      if (!top.ad_group_id) continue;
      orphanTopAgMap.set(top.ad_group_id, (orphanTopAgMap.get(top.ad_group_id) ?? 0) + 1);
    }

    const asinOrphanCount = new Map(); // asin → accumulated orphan-count weight
    if (orphanTopAgMap.size > 0) {
      const { rows: asinRows } = await pool.query(
        `SELECT DISTINCT asin, ad_group_id
           FROM amazon_product_ads
          WHERE profile_id  = $1
            AND ad_group_id = ANY($2)
            AND state       = 'ENABLED'`,
        [profileId, [...orphanTopAgMap.keys()]],
      );
      for (const r of asinRows) {
        const weight = orphanTopAgMap.get(r.ad_group_id) ?? 0;
        asinOrphanCount.set(r.asin, (asinOrphanCount.get(r.asin) ?? 0) + weight);
      }
    }

    // Sort by weight desc, cap 20.
    const seedAsins = [...asinOrphanCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([asin, orphan_count]) => ({ asin, orphan_count }));

    const N = seedAsins.length;
    const M = langOrphans.length;
    const proposal =
      `Create manual campaign + ad group '${targetText}' seeded with ${N} advertised books ` +
      `(default bid $0.35) to house ${M} approved harvest keyword(s) with no eligible destination.`;
    const evidence = {
      orphan_rec_ids:       langOrphans.map((o) => o.id),
      orphan_terms:         langOrphans.map((o) => o.target_text),
      seed_asins:           seedAsins,
      proposed_default_bid: 0.35,
      language:             lang,
    };

    await pool.query(
      `INSERT INTO recommendations
         (rec_type, profile_id, campaign_id, target_text, proposal, evidence)
       VALUES ($1, $2, NULL, $3, $4, $5)`,
      ['CREATE_STRUCTURE', profileId, targetText, proposal, JSON.stringify(evidence)],
    );
    countsByType['CREATE_STRUCTURE']++;
    written++;
    console.log(`  [CREATE_STRUCTURE] '${targetText}' drafted — ${M} orphan(s), ${N} seed ASIN(s).`);
  }
}

// ── 6b. CREATIVE_TARGET orphan rooms ─────────────────────────────────────────
// Collect CREATIVE_TARGET (DRAFT/APPROVED) whose destination_ad_group_id is null
// OR whose destination fails the product-room test (non-AUTO campaign, ENABLED
// target with resolved_asin IS NOT NULL). Propose 'ASINs Competencia <CC> (<LANG>)'
// rooms; language split and seed-ASIN derivation mirror Phase 6a.
console.log('\n── Phase 6b: CREATIVE_TARGET orphan rooms ────────────────────────────────');

const { rows: openCtRows } = await pool.query(
  `SELECT id, rec_type, target_text, evidence
     FROM recommendations
    WHERE profile_id = $1
      AND rec_type   = 'CREATIVE_TARGET'
      AND status     = ANY($2)`,
  [profileId, ['DRAFT', 'APPROVED']],
);
console.log(`  Fetched ${openCtRows.length} open CREATIVE_TARGET rec(s).`);

if (openCtRows.length > 0) {
  // Collect non-null destination_ad_group_ids for product-room validation.
  const ctDestAgIds = [
    ...new Set(
      openCtRows
        .map(r => {
          const ev = typeof r.evidence === 'string' ? JSON.parse(r.evidence) : (r.evidence ?? {});
          return ev.destination_ad_group_id ?? null;
        })
        .filter(id => id !== null && id !== ''),
    ),
  ];

  // Product-room set: non-AUTO campaigns with >= 1 ENABLED target (resolved_asin IS NOT NULL).
  const ctProductRoomSet = new Set();
  if (ctDestAgIds.length > 0) {
    const { rows: ctPrRows } = await pool.query(
      `SELECT DISTINCT ag.ad_group_id::text
         FROM amazon_ad_groups ag
         JOIN amazon_campaigns c ON c.campaign_id = ag.campaign_id
                                 AND c.profile_id  = ag.profile_id
        WHERE ag.profile_id  = $1
          AND ag.ad_group_id = ANY($2)
          AND c.targeting_type != 'AUTO'
          AND EXISTS (
                SELECT 1
                  FROM amazon_targets t
                 WHERE t.profile_id    = $1
                   AND t.ad_group_id   = ag.ad_group_id
                   AND t.state         = 'ENABLED'
                   AND t.resolved_asin IS NOT NULL
              )`,
      [profileId, ctDestAgIds],
    );
    for (const r of ctPrRows) ctProductRoomSet.add(r.ad_group_id);
  }

  // Orphan: null destination OR destination not in product-room set.
  const ctOrphans = [];
  for (const row of openCtRows) {
    const ev       = typeof row.evidence === 'string' ? JSON.parse(row.evidence) : (row.evidence ?? {});
    const destAgId = ev.destination_ad_group_id ? String(ev.destination_ad_group_id) : null;
    if (destAgId === null || !ctProductRoomSet.has(destAgId)) {
      ctOrphans.push({ id: row.id, target_text: row.target_text, evidence: ev, destAgId });
    }
  }
  console.log(`  CREATIVE_TARGET orphans (null dest or not product-room): ${ctOrphans.length}`);

  if (ctOrphans.length > 0) {
    const ctOrphansByLang = { ES: [], EN: [] };
    for (const o of ctOrphans) ctOrphansByLang[detectLang(o.target_text)].push(o);
    console.log(`  Language split → ES: ${ctOrphansByLang.ES.length}  EN: ${ctOrphansByLang.EN.length}`);

    for (const [lang, langOrphans] of Object.entries(ctOrphansByLang)) {
      if (langOrphans.length === 0) continue;

      const targetText = `ASINs Competencia ${countryCode} (${lang})`;

      // Idempotency.
      const { rows: ctExistOpen } = await pool.query(
        `SELECT id FROM recommendations
          WHERE profile_id  = $1
            AND rec_type    = 'CREATE_STRUCTURE'
            AND target_text = $2
            AND status      = ANY($3)`,
        [profileId, targetText, ['DRAFT', 'APPROVED', 'PUSHED']],
      );
      if (ctExistOpen.length > 0) {
        console.log(`  [CREATE_STRUCTURE] '${targetText}' already open (id ${ctExistOpen[0].id}) — skipping.`);
        continue;
      }

      // Seed ASINs: use each orphan's destAgId (if not null) as the ad-group anchor.
      const ctTopAgMap = new Map();
      for (const o of langOrphans) {
        if (o.destAgId) ctTopAgMap.set(o.destAgId, (ctTopAgMap.get(o.destAgId) ?? 0) + 1);
      }

      const ctAsinCount = new Map();
      if (ctTopAgMap.size > 0) {
        const { rows: ctAsinRows } = await pool.query(
          `SELECT DISTINCT asin, ad_group_id
             FROM amazon_product_ads
            WHERE profile_id  = $1
              AND ad_group_id = ANY($2)
              AND state       = 'ENABLED'`,
          [profileId, [...ctTopAgMap.keys()]],
        );
        for (const r of ctAsinRows) {
          const w = ctTopAgMap.get(r.ad_group_id) ?? 0;
          ctAsinCount.set(r.asin, (ctAsinCount.get(r.asin) ?? 0) + w);
        }
      }

      const ctSeedAsins = [...ctAsinCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([asin, orphan_count]) => ({ asin, orphan_count }));

      const N = ctSeedAsins.length;
      const M = langOrphans.length;
      const proposal =
        `Create manual campaign + ad group '${targetText}' seeded with ${N} advertised books ` +
        `(default bid $0.35) to house ${M} CREATIVE_TARGET rec(s) with no eligible product-targeting destination.`;
      const ctEvidence = {
        orphan_rec_ids:       langOrphans.map(o => o.id),
        orphan_terms:         langOrphans.map(o => o.target_text),
        seed_asins:           ctSeedAsins,
        proposed_default_bid: 0.35,
        language:             lang,
      };

      await pool.query(
        `INSERT INTO recommendations
           (rec_type, profile_id, campaign_id, target_text, proposal, evidence)
         VALUES ($1, $2, NULL, $3, $4, $5)`,
        ['CREATE_STRUCTURE', profileId, targetText, proposal, JSON.stringify(ctEvidence)],
      );
      countsByType['CREATE_STRUCTURE']++;
      written++;
      console.log(`  [CREATE_STRUCTURE] '${targetText}' drafted — ${M} orphan(s), ${N} seed ASIN(s).`);
    }
  }
}

// ── 7. BUDGET_ADJUST + PAUSE_CAMPAIGN PHASE ─────────────────────────────────
// Sources: amazon_campaigns (budget_amount, state) + amazon_campaign_daily (30d).
// target_acos already resolved per-profile in params.
console.log('\n── Phase 7: BUDGET_ADJUST / PAUSE_CAMPAIGN ──────────────────────');

// Fetch ENABLED campaigns with a known budget + their 30d aggregates.
const { rows: budgetCampRows } = await pool.query(
  `SELECT
     c.campaign_id,
     c.name,
     c.budget_amount::float                        AS budget_amount,
     c.budget_type,
     coalesce(sum(d.cost),          0)::float      AS spend_30d,
     coalesce(sum(d.sales_14d),     0)::float      AS sales_30d,
     coalesce(sum(d.purchases_14d), 0)::float      AS orders_30d
   FROM amazon_campaigns c
   LEFT JOIN amazon_campaign_daily d
     ON  d.campaign_id = c.campaign_id
     AND d.profile_id  = c.profile_id
     AND d.date >= CURRENT_DATE - INTERVAL '30 days'
   WHERE c.profile_id    = $1
     AND c.state         = 'ENABLED'
     AND c.budget_amount IS NOT NULL
   GROUP BY c.campaign_id, c.name, c.budget_amount, c.budget_type`,
  [profileId],
);
console.log(`  ${budgetCampRows.length} ENABLED campaign(s) with a known budget.`);

// Idempotency: open BUDGET_ADJUST recs keyed on target_text = campaign_id.
const { rows: openBudgetRows } = await pool.query(
  `SELECT target_text
     FROM recommendations
    WHERE profile_id = $1
      AND rec_type   = 'BUDGET_ADJUST'
      AND status     = ANY($2)`,
  [profileId, ['DRAFT', 'APPROVED', 'PUSHED']],
);
const openBudgetSet = new Set(openBudgetRows.map(r => r.target_text));

for (const row of budgetCampRows) {
  const budgetAmount  = row.budget_amount;
  const avgDailySpend = row.spend_30d / 30.0;
  const pctOfBudget   = budgetAmount > 0 ? (avgDailySpend / budgetAmount) * 100 : 0;
  const acos30d       = row.sales_30d > 0 ? row.spend_30d / row.sales_30d : null;
  const orders30d     = Math.round(row.orders_30d);

  // BUDGET_ADJUST: state=ENABLED (filtered), avg_daily_spend >= budget*0.85,
  // acos_30d < target_acos, orders_30d >= 5.
  if (
    avgDailySpend   < budgetAmount * 0.85 ||
    acos30d === null                       ||
    acos30d         >= params.target_acos  ||
    orders30d       < 5
  ) continue;

  // proposed_budget = round(budget * 1.5, 2) capped at budget + 20.
  const proposed150    = Math.round(budgetAmount * 1.5 * 100) / 100;
  const proposedBudget = Math.min(proposed150, Math.round((budgetAmount + 20) * 100) / 100);
  if (proposedBudget <= budgetAmount) continue; // no meaningful raise

  // Idempotency.
  if (openBudgetSet.has(row.campaign_id)) {
    console.log(`  skipped (open rec exists): [BUDGET_ADJUST] ${row.campaign_id}`);
    skippedExisting++;
    continue;
  }

  const acosPct = (acos30d * 100).toFixed(1);
  const pctFmt  = pctOfBudget.toFixed(0);
  const curFmt  = `${currSym}${budgetAmount.toFixed(2)}`;
  const propFmt = `${currSym}${proposedBudget.toFixed(2)}`;

  const proposal =
    `Raise daily budget for '${row.name}' from ${curFmt} to ${propFmt}: ` +
    `spending ${pctFmt}% of its cap at ${acosPct}% ACoS (${orders30d} orders/30d) ` +
    `\u2014 the cap is starving a profitable campaign.`;

  const evidence = {
    campaign_id:     row.campaign_id,
    budget_amount:   budgetAmount,
    proposed_budget: proposedBudget,
    avg_daily_spend: avgDailySpend,
    pct_of_budget:   pctOfBudget,
    acos_30d:        acos30d,
    orders_30d:      orders30d,
    sales_30d:       row.sales_30d,
    target_acos:     params.target_acos,
  };

  await pool.query(
    `INSERT INTO recommendations
       (rec_type, profile_id, campaign_id, target_text, proposal, evidence)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    ['BUDGET_ADJUST', profileId, row.campaign_id, row.campaign_id, proposal, JSON.stringify(evidence)],
  );
  countsByType['BUDGET_ADJUST']++;
  written++;
  console.log(`  [BUDGET_ADJUST] '${row.name}': ${curFmt} \u2192 ${propFmt} (${pctFmt}% of cap, ${acosPct}% ACoS)`);
}

// ── PAUSE_CAMPAIGN ─────────────────────────────────────────────────────────
// Criteria: state='ENABLED', spend_30d >= 30, AND
//   (acos_30d >= 1.0 OR COALESCE(sales_30d,0) = 0).
// Separate query — does NOT require budget_amount IS NOT NULL.
console.log('\n── Phase 7b: PAUSE_CAMPAIGN ──────────────────────────────────────');

const { rows: pauseCandRows } = await pool.query(
  `SELECT
     c.campaign_id,
     c.name,
     c.budget_amount::float                        AS budget_amount,
     coalesce(sum(d.cost),          0)::float      AS spend_30d,
     coalesce(sum(d.sales_14d),     0)::float      AS sales_30d,
     coalesce(sum(d.purchases_14d), 0)::float      AS orders_30d
   FROM amazon_campaigns c
   LEFT JOIN amazon_campaign_daily d
     ON  d.campaign_id = c.campaign_id
     AND d.profile_id  = c.profile_id
     AND d.date >= CURRENT_DATE - INTERVAL '30 days'
   WHERE c.profile_id = $1
     AND c.state      = 'ENABLED'
   GROUP BY c.campaign_id, c.name, c.budget_amount
   HAVING coalesce(sum(d.cost), 0) >= 30`,
  [profileId],
);
console.log(`  ${pauseCandRows.length} ENABLED campaign(s) with spend_30d >= 30.`);

// Idempotency: open PAUSE_CAMPAIGN recs keyed on target_text = campaign_id.
const { rows: openPauseRows } = await pool.query(
  `SELECT target_text
     FROM recommendations
    WHERE profile_id = $1
      AND rec_type   = 'PAUSE_CAMPAIGN'
      AND status     = ANY($2)`,
  [profileId, ['DRAFT', 'APPROVED', 'PUSHED']],
);
const openPauseSet = new Set(openPauseRows.map(r => r.target_text));

for (const row of pauseCandRows) {
  const spend30d   = row.spend_30d;
  const sales30d   = row.sales_30d;

  // Criteria: (acos_30d >= 1.0) OR (sales_30d = 0). spend_30d >= 30 enforced by query HAVING.
  const isZeroSales = sales30d === 0;
  const acos30d     = sales30d > 0 ? spend30d / sales30d : null;
  if (!isZeroSales && (acos30d === null || acos30d < 1.0)) continue;

  // Idempotency.
  if (openPauseSet.has(row.campaign_id)) {
    console.log(`  skipped (open rec exists): [PAUSE_CAMPAIGN] ${row.campaign_id}`);
    skippedExisting++;
    continue;
  }

  const spendFmt = `${currSym}${spend30d.toFixed(2)}`;

  let proposal;
  if (isZeroSales) {
    proposal = `Pause '${row.name}': ${spendFmt} spend bought ZERO sales in 30d.`;
  } else {
    const acosPct  = (acos30d * 100).toFixed(1);
    const salesFmt = `${currSym}${sales30d.toFixed(2)}`;
    proposal =
      `Pause '${row.name}': ${spendFmt} spend bought ${salesFmt} sales in 30d ` +
      `(${acosPct}% ACoS) \u2014 losing money on every sale.`;
  }

  const evidence = {
    campaign_id:   row.campaign_id,
    spend_30d:     spend30d,
    sales_30d:     sales30d,
    acos_30d:      acos30d,
    budget_amount: row.budget_amount,
    target_acos:   params.target_acos,
  };

  await pool.query(
    `INSERT INTO recommendations
       (rec_type, profile_id, campaign_id, target_text, proposal, evidence)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    ['PAUSE_CAMPAIGN', profileId, row.campaign_id, row.campaign_id, proposal, JSON.stringify(evidence)],
  );
  countsByType['PAUSE_CAMPAIGN']++;
  written++;
  if (isZeroSales) {
    console.log(`  [PAUSE_CAMPAIGN] '${row.name}': ${spendFmt} spend, ZERO sales`);
  } else {
    const acosPct = (acos30d * 100).toFixed(1);
    console.log(`  [PAUSE_CAMPAIGN] '${row.name}': ${spendFmt} spend, ${acosPct}% ACoS`);
  }
}
console.log('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

// ── 7c. REVIVE ─────────────────────────────────────────────────────────────
// Criteria: state='ENABLED', spend_30d < 2, lifetime sales > 0 OR orders > 0,
//   >= 1 ENABLED target/keyword, max enabled bid < viability_floor.
// viability_floor = median bid of ENABLED targets+keywords belonging to
//   campaigns with spend_30d >= 10; fallback = params.target_acos.
// rec_type = 'BID_ADJUST', evidence.kind = 'REVIVE', target_text = campaign_id.
console.log('\n\u2500\u2500 Phase 7c: REVIVE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

// Step 1: viability_floor — median bid across ENABLED targets+keywords in
//         campaigns that spent >= 10 in the last 30 days.
const { rows: floorRows } = await pool.query(
  `WITH active_camps AS (
     SELECT campaign_id
       FROM amazon_campaign_daily
      WHERE profile_id = $1
        AND date >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY campaign_id
     HAVING COALESCE(SUM(cost), 0) >= 10
   ),
   all_bids AS (
     SELECT bid::float AS bid
       FROM amazon_targets
      WHERE profile_id = $1
        AND state      = 'ENABLED'
        AND bid        IS NOT NULL
        AND campaign_id = ANY(SELECT campaign_id FROM active_camps)
     UNION ALL
     SELECT bid::float AS bid
       FROM amazon_keywords
      WHERE profile_id = $1
        AND state      = 'ENABLED'
        AND bid        IS NOT NULL
        AND campaign_id = ANY(SELECT campaign_id FROM active_camps)
   )
   SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY bid) AS median_bid,
          COUNT(*) AS n_bids
     FROM all_bids`,
  [profileId],
);
const _floorRow      = floorRows[0];
const viabilityFloor = (_floorRow && Number(_floorRow.n_bids) > 0 && _floorRow.median_bid != null)
  ? Math.round(Number(_floorRow.median_bid) * 100) / 100
  : params.target_acos;
console.log(`  viability_floor: ${currSym}${viabilityFloor.toFixed(2)} (from ${_floorRow?.n_bids ?? 0} ENABLED bid(s) in active campaigns)`);

// Step 2: candidate campaigns.
const { rows: reviveCandRows } = await pool.query(
  `WITH spend30 AS (
     SELECT campaign_id,
            COALESCE(SUM(cost), 0)::float AS spend_30d
       FROM amazon_campaign_daily
      WHERE profile_id = $1
        AND date >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY campaign_id
   ),
   lifetime AS (
     SELECT campaign_id,
            COALESCE(SUM(sales_14d),     0)::float AS lifetime_sales,
            COALESCE(SUM(purchases_14d), 0)::float AS lifetime_orders
       FROM amazon_campaign_daily
      WHERE profile_id = $1
      GROUP BY campaign_id
   ),
   enabled_bids AS (
     SELECT campaign_id::text AS campaign_id,
            COUNT(*)          AS n_entities,
            MIN(bid::float)   AS min_bid,
            MAX(bid::float)   AS max_bid
       FROM (
         SELECT campaign_id, bid
           FROM amazon_targets
          WHERE profile_id = $1 AND state = 'ENABLED' AND bid IS NOT NULL
         UNION ALL
         SELECT campaign_id, bid
           FROM amazon_keywords
          WHERE profile_id = $1 AND state = 'ENABLED' AND bid IS NOT NULL
       ) eb
      GROUP BY campaign_id
     HAVING COUNT(*) >= 1
   )
   SELECT c.campaign_id::text AS campaign_id,
          c.name,
          COALESCE(s.spend_30d,        0)::float AS spend_30d,
          COALESCE(lt.lifetime_sales,  0)::float AS lifetime_sales,
          COALESCE(lt.lifetime_orders, 0)::float AS lifetime_orders,
          eb.n_entities::int,
          eb.min_bid::float,
          eb.max_bid::float
     FROM amazon_campaigns c
     JOIN enabled_bids eb ON eb.campaign_id = c.campaign_id::text
LEFT JOIN spend30 s       ON s.campaign_id  = c.campaign_id
LEFT JOIN lifetime lt      ON lt.campaign_id = c.campaign_id
    WHERE c.profile_id = $1
      AND c.state      = 'ENABLED'
      AND COALESCE(s.spend_30d, 0) < 2
      AND (COALESCE(lt.lifetime_sales, 0) > 0 OR COALESCE(lt.lifetime_orders, 0) > 0)
      AND eb.max_bid < $2`,
  [profileId, viabilityFloor],
);
console.log(`  ${reviveCandRows.length} candidate(s) (spend_30d < 2, lifetime activity, max bid < floor).`);

// Step 3: idempotency — skip campaign if ANY open BID_ADJUST exists
//         where target_text = campaign_id OR evidence.campaign_id = campaign_id.
const { rows: openReviveRows } = await pool.query(
  `SELECT target_text, evidence->>'campaign_id' AS ev_campaign_id
     FROM recommendations
    WHERE profile_id = $1
      AND rec_type   = 'BID_ADJUST'
      AND status     = ANY($2)`,
  [profileId, ['DRAFT', 'APPROVED', 'PUSHED']],
);
const openReviveCampSet = new Set();
for (const r of openReviveRows) {
  if (r.target_text)    openReviveCampSet.add(r.target_text);
  if (r.ev_campaign_id) openReviveCampSet.add(r.ev_campaign_id);
}

// Step 4: emit recs.
for (const row of reviveCandRows) {
  const campId     = row.campaign_id;
  const spend30d   = row.spend_30d;
  const lifeSales  = row.lifetime_sales;
  const lifeOrders = row.lifetime_orders;
  const nEntities  = row.n_entities;
  const currentMin = Math.round(Number(row.min_bid) * 100) / 100;
  const currentMax = Math.round(Number(row.max_bid) * 100) / 100;

  if (openReviveCampSet.has(campId)) {
    console.log(`  skipped (open rec exists): [REVIVE] ${campId}`);
    skippedExisting++;
    continue;
  }

  const floorFmt = `${currSym}${viabilityFloor.toFixed(2)}`;
  const minFmt   = `${currSym}${currentMin.toFixed(2)}`;
  const maxFmt   = `${currSym}${currentMax.toFixed(2)}`;
  const salesFmt = `${currSym}${lifeSales.toFixed(2)}`;

  const proposal =
    `Revive '${row.name}': raise all ${nEntities} enabled bids to ${floorFmt} \u2014 ` +
    `lifetime ${salesFmt} sales prove demand, but current bids (${minFmt}\u2013${maxFmt}) ` +
    `sit below the market floor (${floorFmt}).`;

  // v2: per-entity bids from amazon_bid_recommendations (fresh within 7 days).
  // Fall back to v1 uniform median-floor when no rows exist.
  const { rows: bidRecRows } = await pool.query(
    `SELECT br.entity_kind, br.entity_id,
            br.suggested::float, br.range_start::float, br.range_end::float
       FROM amazon_bid_recommendations br
      WHERE br.profile_id = $1
        AND br.fetched_at >= now() - INTERVAL '7 days'
        AND br.entity_id = ANY(
          SELECT target_id::text FROM amazon_targets
           WHERE profile_id = $1 AND campaign_id::text = $2 AND state = 'ENABLED'
          UNION ALL
          SELECT keyword_id::text FROM amazon_keywords
           WHERE profile_id = $1 AND campaign_id::text = $2 AND state = 'ENABLED'
        )`,
    [profileId, campId],
  );

  let perEntity = null;
  let bidSource = 'median_floor';

  if (bidRecRows.length > 0) {
    bidSource     = 'amazon_bid_rec';
    const promCap = params.raise_bid_max ?? 0.75;
    const clampLo = viabilityFloor * 0.5;
    const clampHi = promCap * 1.5;

    // Fetch current bids to build per_entity current field.
    const { rows: entityRows } = await pool.query(
      `SELECT target_id::text AS entity_id, expression_type, bid::float AS current_bid
         FROM amazon_targets
        WHERE profile_id = $1 AND campaign_id::text = $2 AND state = 'ENABLED' AND bid IS NOT NULL
       UNION ALL
       SELECT keyword_id::text AS entity_id, 'KEYWORD' AS expression_type, bid::float AS current_bid
         FROM amazon_keywords
        WHERE profile_id = $1 AND campaign_id::text = $2 AND state = 'ENABLED' AND bid IS NOT NULL`,
      [profileId, campId],
    );
    const entityBidMap = new Map(entityRows.map(r => [
      r.entity_id,
      { kind: r.expression_type === 'AUTO' ? 'AUTO_STRATEGY' : r.expression_type, currentBid: r.current_bid },
    ]));

    perEntity = bidRecRows.map(br => {
      const info     = entityBidMap.get(br.entity_id);
      const kind     = br.entity_kind;
      const sugg     = Number(br.suggested);
      const proposed = Math.round(Math.max(clampLo, Math.min(clampHi, sugg)) * 100) / 100;
      return {
        entity_id: br.entity_id,
        kind,
        current:   info ? Math.round(Number(info.currentBid) * 100) / 100 : null,
        suggested: Math.round(sugg * 100) / 100,
        proposed,
      };
    });
  }

  const evidence = {
    kind:            'REVIVE',
    campaign_id:     campId,
    n_entities:      nEntities,
    current_min:     currentMin,
    current_max:     currentMax,
    proposed_bid:    viabilityFloor,
    lifetime_sales:  lifeSales,
    lifetime_orders: lifeOrders,
    spend_30d:       spend30d,
    source:          bidSource,
    ...(perEntity ? { per_entity: perEntity } : {}),
  };

  await pool.query(
    `INSERT INTO recommendations
       (rec_type, profile_id, campaign_id, target_text, proposal, evidence)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    ['BID_ADJUST', profileId, campId, campId, proposal, JSON.stringify(evidence)],
  );
  countsByType['BID_ADJUST']++;
  written++;
  console.log(`  [REVIVE] '${row.name}': ${nEntities} bid(s), max ${currSym}${currentMax.toFixed(2)} \u2192 ${floorFmt}`);
}
console.log('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

// ── 7d. DORMANT-PAUSE ──────────────────────────────────────────────────────
// Criteria: state='ENABLED', spend_30d < 2, lifetime impressions < 500,
//   lifetime sales = 0 (full history).
// Age guard: amazon_campaigns.raw jsonb has no creationDate/createdDate
//   (confirmed: both fields return NULL) — age guard skipped; impressions
//   floor and HARD EXCLUDE below serve as the newborn guard.
// HARD EXCLUDE: campaigns whose name starts with 'CDL | SP |'.
// rec_type = PAUSE_CAMPAIGN, target_text = campaign_id.
console.log('\n\u2500\u2500 Phase 7d: DORMANT-PAUSE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

// Step 1: candidate campaigns.
const { rows: dormantCandRows } = await pool.query(
  `WITH lifetime AS (
     SELECT campaign_id,
            COALESCE(SUM(impressions), 0)::bigint AS lifetime_impressions,
            COALESCE(SUM(cost),        0)::float  AS lifetime_spend,
            COALESCE(SUM(sales_14d),   0)::float  AS lifetime_sales
       FROM amazon_campaign_daily
      WHERE profile_id = $1
      GROUP BY campaign_id
   ),
   spend30 AS (
     SELECT campaign_id,
            COALESCE(SUM(cost), 0)::float AS spend_30d
       FROM amazon_campaign_daily
      WHERE profile_id = $1
        AND date >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY campaign_id
   )
   SELECT c.campaign_id::text                          AS campaign_id,
          c.name,
          c.budget_amount::float                       AS budget_amount,
          COALESCE(s.spend_30d,            0)::float   AS spend_30d,
          COALESCE(lt.lifetime_impressions,0)::bigint  AS lifetime_impressions,
          COALESCE(lt.lifetime_spend,      0)::float   AS lifetime_spend,
          COALESCE(lt.lifetime_sales,      0)::float   AS lifetime_sales
     FROM amazon_campaigns c
LEFT JOIN spend30 s   ON s.campaign_id  = c.campaign_id
LEFT JOIN lifetime lt  ON lt.campaign_id = c.campaign_id
    WHERE c.profile_id = $1
      AND c.state      = 'ENABLED'
      AND c.name NOT LIKE 'CDL | SP |%'
      AND COALESCE(s.spend_30d,            0) < 2
      AND COALESCE(lt.lifetime_impressions, 0) < 500
      AND COALESCE(lt.lifetime_sales,       0) = 0`,
  [profileId],
);
console.log(`  ${dormantCandRows.length} DORMANT-PAUSE candidate(s).`);

// Step 2: idempotency — open PAUSE_CAMPAIGN recs for this profile.
const { rows: openDormantRows } = await pool.query(
  `SELECT target_text
     FROM recommendations
    WHERE profile_id = $1
      AND rec_type   = 'PAUSE_CAMPAIGN'
      AND status     = ANY($2)`,
  [profileId, ['DRAFT', 'APPROVED', 'PUSHED']],
);
const openDormantSet = new Set(openDormantRows.map((r) => r.target_text));

// Step 3: emit recs.
for (const row of dormantCandRows) {
  const campId  = row.campaign_id;
  const impr    = Number(row.lifetime_impressions);
  const spend3d = row.spend_30d;

  if (openDormantSet.has(campId)) {
    console.log(`  skipped (open rec exists): [DORMANT-PAUSE] ${campId}`);
    skippedExisting++;
    continue;
  }

  const proposal =
    `Pause '${row.name}': lifetime ${impr.toLocaleString('en')} impressions, ` +
    `zero sales \u2014 structure never reached the market.`;

  const evidence = {
    kind:                 'DORMANT',
    campaign_id:          campId,
    spend_30d:            spend3d,
    lifetime_impressions: impr,
    lifetime_spend:       row.lifetime_spend,
    lifetime_sales:       row.lifetime_sales,
    budget_amount:        row.budget_amount,
  };

  await pool.query(
    `INSERT INTO recommendations
       (rec_type, profile_id, campaign_id, target_text, proposal, evidence)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    ['PAUSE_CAMPAIGN', profileId, campId, campId, proposal, JSON.stringify(evidence)],
  );
  countsByType['PAUSE_CAMPAIGN']++;
  written++;
  console.log(`  [DORMANT-PAUSE] '${row.name}': ${impr.toLocaleString('en')} impr, ${currSym}${row.lifetime_spend.toFixed(2)} lifetime spend`);
}
console.log('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

// ── 8. REPLACE_PRODUCT_AD PHASE ─────────────────────────────────────────────
// For each ENABLED amazon_product_ads row whose asin has a CONFIRMED
// b0_hc_candidates pair: emit one REPLACE_PRODUCT_AD rec per ad row.
// target_text = the ad's adId (string).
// Idempotent: skip if an open REPLACE_PRODUCT_AD rec exists for the same ad_id.
console.log('\n── Phase 8: REPLACE_PRODUCT_AD ──────────────────────────────────────────');

const { rows: replaceAdRows } = await pool.query(
  `SELECT
       pa.ad_id,
       pa.asin                     AS b0_asin,
       pa.campaign_id,
       pa.ad_group_id,
       hc.amazon_title,
       hc.hc_isbn13,
       hc.hc_title,
       c.name                      AS campaign_name
     FROM amazon_product_ads pa
     JOIN b0_hc_candidates hc
       ON hc.b0_asin  = pa.asin
      AND hc.status   = 'CONFIRMED'
     LEFT JOIN amazon_campaigns c
       ON c.campaign_id = pa.campaign_id
      AND c.profile_id  = pa.profile_id
    WHERE pa.profile_id = $1
      AND pa.state      = 'ENABLED'`,
  [profileId],
);
console.log(`  ${replaceAdRows.length} ENABLED product ad(s) with CONFIRMED HC pair.`);

// Idempotency: fetch all open REPLACE_PRODUCT_AD recs for this profile once.
const { rows: openReplaceRows } = await pool.query(
  `SELECT target_text
     FROM recommendations
    WHERE profile_id = $1
      AND rec_type   = 'REPLACE_PRODUCT_AD'
      AND status     = ANY($2)`,
  [profileId, ['DRAFT', 'APPROVED', 'PUSHED']],
);
const openReplaceSet = new Set(openReplaceRows.map((r) => r.target_text));
console.log(`  Open REPLACE_PRODUCT_AD recs (idempotency): ${openReplaceSet.size}`);

for (const row of replaceAdRows) {
  const adId      = row.ad_id;
  const b0Asin    = row.b0_asin;
  const hcIsbn13  = row.hc_isbn13;
  const hcIsbn10  = isbn13ToIsbn10(hcIsbn13);
  const hcTitle   = row.hc_title;
  const campName  = row.campaign_name ?? row.campaign_id;
  const kindleTitle = row.amazon_title ?? b0Asin;

  if (!hcIsbn10) {
    console.log(`  skipped (isbn13ToIsbn10 null for ${hcIsbn13}): ad_id ${adId}`);
    continue;
  }

  // Idempotency: skip when open rec already exists for this ad_id.
  if (openReplaceSet.has(adId)) {
    console.log(`  skipped (open rec exists): [REPLACE_PRODUCT_AD] ad_id ${adId}`);
    skippedExisting++;
    continue;
  }

  const proposal =
    `Replace Kindle ad '${kindleTitle}' with HC '${hcTitle}' (${hcIsbn10}) in ${campName}.`;

  const evidence = {
    kind:        'REPLACE',
    b0_asin:     b0Asin,
    hc_isbn10:   hcIsbn10,
    hc_isbn13:   hcIsbn13,
    hc_title:    hcTitle,
    campaign_id: row.campaign_id,
    ad_group_id: row.ad_group_id,
    ad_id:       adId,
  };

  await pool.query(
    `INSERT INTO recommendations
       (rec_type, profile_id, campaign_id, target_text, proposal, evidence)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    ['REPLACE_PRODUCT_AD', profileId, row.campaign_id, adId, proposal, JSON.stringify(evidence)],
  );
  countsByType['REPLACE_PRODUCT_AD']++;
  written++;
  console.log(`  [REPLACE_PRODUCT_AD] Kindle ad ${adId} (${b0Asin}) → HC ${hcIsbn10} in '${campName}'`);
}
console.log('─'.repeat(70));

// ── CLUSTER_ROOM PHASE ──────────────────────────────────────────────────────
// Runs ONLY when --cluster-rooms flag is passed; never emits during normal
// generation. Scoped to --cluster-lang (default: 'spa') and --profile.
// Cold-start pattern: AUTO-only. KW siblings born later from the AUTO room's
// own harvest via the existing PROMOTE_TERM road once traffic accrues.
// Emits ONE CREATE_STRUCTURE rec per cluster lacking a dedicated AUTO room.
// Campaign: 'CDL | SP | CLUSTER | <NAME> | AUTO', budget €3.00/day,
// AUTO targeting, full cluster ASIN roster as product ads, born PAUSED.
// Evidence manifest: roster, bid, budget, targeting_type, works_count, spend_60d.
// Profile → language mapping (cluster_auto_room, cluster_kw_room, orphan_kw_room).
// Add new entries as profiles onboard; absent profiles are skipped with a log line.
const CLUSTER_LANG_MAP = {
  '2263723137827296': 'spa',  // ES profile (Spain)
  '139446882235960':  'eng',  // US profile
};

// ── cluster_auto_room entry guard ────────────────────────────────────────────
if (!values['cluster-rooms']) {
  console.log('cluster-room phases skipped (no --cluster-rooms flag)');
} else {
  console.log('\n── CLUSTER_ROOM phase ──────────────────────────────────────────────────────');
  const crLang = CLUSTER_LANG_MAP[profileIdStr];
  if (!crLang) { console.log(`  cluster-room phases skipped — no language mapping for profile ${profileIdStr}`); } else {
  console.log(`  --cluster-rooms active — language: ${crLang}`);

  // Slug helper (mirrors seed-cluster-terms.mjs)
  const crToSlug = (s) =>
    s.toLowerCase()
     .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
     .replace(/\s+/g, '-')
     .replace(/[^a-z0-9-]/g, '');

  // CR-1. Distinct cluster names for this language
  const { rows: crClusters } = await pool.query(
    `SELECT DISTINCT cluster_name
       FROM book_clusters
      WHERE language = $1
      ORDER BY cluster_name`,
    [crLang],
  );
  console.log(`  Clusters in '${crLang}': ${crClusters.length}`);

  // CR-1b. Optional cluster-names filter (comma-separated; empty = all)
  const crNameFilter = (values['cluster-names'] ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const crFiltered = crNameFilter.length > 0
    ? crClusters.filter(r => crNameFilter.includes(r.cluster_name))
    : crClusters;
  if (crNameFilter.length > 0) {
    console.log(`  --cluster-names filter: ${crNameFilter.length} name(s) → ${crFiltered.length} match(es)`);
  }

  // CR-2. ENABLED CLUSTER AUTO campaigns (room-exists check)
  const { rows: crEnabledCamps } = await pool.query(
    `SELECT name
       FROM amazon_campaigns
      WHERE profile_id = $1
        AND state      = 'ENABLED'
        AND name       ILIKE '%CDL | SP | CLUSTER |%| AUTO'`,
    [profileId],
  );
  const crEnabledNamesLower = crEnabledCamps.map(r => r.name.toLowerCase());
  console.log(`  Existing ENABLED CLUSTER AUTO campaigns: ${crEnabledNamesLower.length}`);

  // CR-3. Open CREATE_STRUCTURE CLUSTER recs (idempotency)
  const { rows: crOpenRows } = await pool.query(
    `SELECT target_text
       FROM recommendations
      WHERE profile_id  = $1
        AND rec_type    = 'CREATE_STRUCTURE'
        AND target_text LIKE 'CLUSTER |%'
        AND status      = ANY($2)`,
    [profileId, ['DRAFT', 'APPROVED', 'PUSHED']],
  );
  const crOpenSet = new Set(crOpenRows.map(r => r.target_text));
  console.log(`  Open CLUSTER CREATE_STRUCTURE recs: ${crOpenSet.size}`);

  // CR-4. AUTO_STRATEGY median bid (≤14d fresh), fallback 0.30
  const { rows: crBidRows } = await pool.query(
    `SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY suggested::float) AS median_bid
       FROM amazon_bid_recommendations
      WHERE profile_id  = $1
        AND entity_kind = 'AUTO_STRATEGY'
        AND fetched_at >= now() - INTERVAL '14 days'`,
    [profileId],
  );
  const crBid = crBidRows[0]?.median_bid != null
    ? Math.round(Number(crBidRows[0].median_bid) * 100) / 100
    : 0.30;
  console.log(`  AUTO_STRATEGY median bid: ${currSym}${crBid.toFixed(2)} (fallback 0.30)`);
  console.log('');

  let crWritten = 0;
  let crSkipped = 0;

  for (const { cluster_name } of crFiltered) {
    const crSlug     = crToSlug(cluster_name);
    const recKey     = `CLUSTER | ${cluster_name} | AUTO`;
    const crCampName = `CDL | SP | CLUSTER | ${cluster_name} | AUTO`;
    console.log(`  ── ${cluster_name}`);

    // Room-exists: ENABLED AUTO campaign for this cluster
    if (crEnabledNamesLower.some(n =>
      n.includes(`cdl | sp | cluster | ${cluster_name.toLowerCase()} | auto`)
    )) {
      console.log(`     skip: ENABLED room '${crCampName}' already present`);
      crSkipped++;
      continue;
    }

    // Idempotency
    if (crOpenSet.has(recKey)) {
      console.log(`     skip: open rec '${recKey}' already exists`);
      crSkipped++;
      continue;
    }

    // CR-5a. Full ASIN roster for this cluster
    const { rows: crAsinRows } = await pool.query(
      `SELECT bc.isbn13, bc.work_title, tc.asin
         FROM book_clusters bc
         JOIN title_cache   tc ON tc.isbn13 = bc.isbn13
        WHERE bc.cluster_name = $1
          AND bc.language     = $2
        ORDER BY bc.isbn13`,
      [cluster_name, crLang],
    );
    const crSeedAsins = crAsinRows
      .filter(r => r.asin)
      .map(r => ({ asin: r.asin, title: r.work_title, isbn13: r.isbn13 }));

    if (crSeedAsins.length === 0) {
      console.log(`     skip: no resolved ASINs`);
      crSkipped++;
      continue;
    }
    console.log(`     works: ${crSeedAsins.length}`);

    // CR-5b. spend_60d: cost from all campaigns containing cluster ASINs
    const { rows: crSpendRows } = await pool.query(
      `SELECT COALESCE(SUM(d.cost), 0)::float AS spend_60d
         FROM amazon_campaign_daily d
        WHERE d.profile_id  = $1
          AND d.date        >= CURRENT_DATE - INTERVAL '60 days'
          AND d.campaign_id IN (
                SELECT DISTINCT pa.campaign_id
                  FROM amazon_product_ads pa
                 WHERE pa.profile_id = $1
                   AND pa.state      = 'ENABLED'
                   AND pa.asin       = ANY($2)
              )`,
      [profileId, crSeedAsins.map(s => s.asin)],
    );
    const crSpend60d = Math.round(Number(crSpendRows[0]?.spend_60d ?? 0) * 100) / 100;
    console.log(`     spend_60d: ${currSym}${crSpend60d.toFixed(2)}`);

    // CR-5c. Evidence manifest
    const crEvidence = {
      kind:                 'cluster_auto_room',
      cluster_name,
      cluster_slug:         crSlug,
      language:             crLang,
      profile_id:           profileIdStr,
      seed_asins:           crSeedAsins,
      proposed_default_bid: crBid,
      targeting_type:       'AUTO',
      budget:               3.00,
      works_count:          crSeedAsins.length,
      spend_60d:            crSpend60d,
    };

    const crProposal =
      `Create AUTO cluster room for '${cluster_name}': ` +
      `'${crCampName}' — ${crSeedAsins.length} works, ` +
      `${currSym}3.00/day budget, AUTO targeting, ` +
      `default bid ${currSym}${crBid.toFixed(2)}, born PAUSED. ` +
      `Cluster 60d spend ${currSym}${crSpend60d.toFixed(2)} across all current rooms.`;

    await pool.query(
      `INSERT INTO recommendations
         (rec_type, profile_id, campaign_id, target_text, proposal, evidence)
       VALUES ($1, $2, NULL, $3, $4, $5)`,
      ['CREATE_STRUCTURE', profileId, recKey, crProposal, JSON.stringify(crEvidence)],
    );
    countsByType['CREATE_STRUCTURE']++;
    written++;
    crWritten++;
    console.log(`     ✓ Drafted '${recKey}'`);
    console.log('');
  }

  console.log(`  CLUSTER_ROOM: ${crWritten} drafted, ${crSkipped} skipped.`);
  console.log('──────────────────────────────────────────────────────────────────────');
  } // end crLang check
} // end cluster_auto_room guard

// ── cluster_kw_room entry guard ──────────────────────────────────────────────
if (!values['cluster-rooms']) {
  console.log('cluster-room phases skipped (no --cluster-rooms flag)');
} else {
  const ckLang = CLUSTER_LANG_MAP[profileIdStr];
  if (!ckLang) { console.log(`  cluster-room phases skipped — no language mapping for profile ${profileIdStr}`); } else {

  // ── CLUSTER_KW_ROOM: keyword sibling rooms born-PAUSED for clusters with ──────
  // an existing CDL AUTO room + ≥1 stranded APPROVED PROMOTE_TERM orphan.
  // 'CDL | SP | CLUSTER | <name> | KW' — MANUAL, budget 3.00, full ASIN
  // roster from AUTO room product ads, keywords = stranded terms EXACT at
  // evidence.approved_bid. Evidence: kind='cluster_kw_room', graduation_from.
  console.log('\n── CLUSTER_KW_ROOM phase ───────────────────────────────────────────────────');

  // CK-1. CDL CLUSTER AUTO rooms + their ASIN rosters (ENABLED)
  const { rows: ckAutoRows } = await pool.query(
    `SELECT c.campaign_id::text, c.name,
            array_agg(DISTINCT pa.asin) FILTER (WHERE pa.state = 'ENABLED') AS asins
       FROM amazon_campaigns   c
       JOIN amazon_ad_groups   ag ON ag.campaign_id = c.campaign_id
                                 AND ag.profile_id  = c.profile_id
       JOIN amazon_product_ads pa ON pa.ad_group_id = ag.ad_group_id
                                 AND pa.profile_id  = ag.profile_id
      WHERE c.profile_id = $1
        AND c.state      = 'ENABLED'
        AND c.name       ILIKE 'CDL | SP | CLUSTER |%| AUTO'
      GROUP BY c.campaign_id, c.name`,
    [profileId],
  );
  const ckAutoRooms = ckAutoRows.map(r => {
    const m = r.name.match(/CDL \| SP \| CLUSTER \| (.+) \| AUTO$/);
    return m ? { cluster_name: m[1], campaign_id: r.campaign_id, asins: r.asins ?? [] } : null;
  }).filter(Boolean);
  console.log(`  CDL CLUSTER AUTO rooms: ${ckAutoRooms.length}`);

  // CK-2. Idempotency — ENABLED KW rooms + open CREATE_STRUCTURE recs
  const { rows: ckLiveKwRows } = await pool.query(
    `SELECT name FROM amazon_campaigns
      WHERE profile_id = $1 AND state = 'ENABLED' AND name ILIKE 'CDL | SP | CLUSTER |%| KW'`,
    [profileId],
  );
  const ckLiveKwNamesLower = new Set(ckLiveKwRows.map(r => r.name.toLowerCase()));
  const { rows: ckOpenKwRows } = await pool.query(
    `SELECT target_text FROM recommendations
      WHERE profile_id = $1 AND rec_type = 'CREATE_STRUCTURE'
        AND target_text LIKE 'CLUSTER |%| KW'
        AND status = ANY($2)`,
    [profileId, ['DRAFT', 'APPROVED', 'PUSHED']],
  );
  const ckOpenKwSet = new Set(ckOpenKwRows.map(r => r.target_text));

  if (ckAutoRooms.length === 0) {
    console.log('  No CDL CLUSTER AUTO rooms — skipping CLUSTER_KW_ROOM phase.');
  } else {
    // CK-3. Stranded APPROVED PROMOTE_TERM orphans (resolved_destination = null)
    const { rows: ckStrandedRows } = await pool.query(
      `SELECT id, target_text, evidence
         FROM recommendations
        WHERE profile_id = $1
          AND rec_type   = 'PROMOTE_TERM'
          AND status     = 'APPROVED'
          AND (evidence->>'resolved_destination') IS NULL`,
      [profileId],
    );
    console.log(`  Stranded APPROVED PROMOTE_TERM recs: ${ckStrandedRows.length}`);

    if (ckStrandedRows.length === 0) {
      console.log('  No stranded recs — skipping CLUSTER_KW_ROOM phase.');
    } else {
      // CK-4. Map each orphan to a cluster via ASIN overlap with AUTO room rosters
      const ckClusterAsinSets = new Map(); // cluster_name → Set<asin>
      for (const room of ckAutoRooms) ckClusterAsinSets.set(room.cluster_name, new Set(room.asins));

      const ckAllAgIds = [];
      const ckRecEvMap = new Map(); // rec_id → { target_text, ev, convAgIds }
      for (const row of ckStrandedRows) {
        const ev = typeof row.evidence === 'string' ? JSON.parse(row.evidence) : row.evidence;
        const pls = Array.isArray(ev.placements) ? ev.placements : [];
        const convAgs = pls.filter(p => Number(p.orders) > 0).map(p => String(p.ad_group_id)).filter(Boolean);
        const allAgs  = pls.map(p => String(p.ad_group_id)).filter(Boolean);
        const targetAgs = convAgs.length > 0 ? convAgs : allAgs;
        ckAllAgIds.push(...targetAgs);
        ckRecEvMap.set(Number(row.id), { target_text: row.target_text, ev, convAgIds: targetAgs });
      }

      // Batch-fetch product ads for all relevant ag ids
      const ckAgAsinMap = new Map(); // ag_id → Set<asin>
      const ckUniqueAgIds = [...new Set(ckAllAgIds)];
      if (ckUniqueAgIds.length > 0) {
        const { rows: ckPaRows } = await pool.query(
          `SELECT ad_group_id::text AS ag_id, asin FROM amazon_product_ads
            WHERE profile_id = $1 AND ad_group_id = ANY($2) AND state = 'ENABLED'`,
          [profileId, ckUniqueAgIds],
        );
        for (const r of ckPaRows) {
          if (!ckAgAsinMap.has(r.ag_id)) ckAgAsinMap.set(r.ag_id, new Set());
          ckAgAsinMap.get(r.ag_id).add(r.asin);
        }
      }

      // Map rec → best-overlap cluster
      const ckOrphansByCluster = new Map(); // cluster_name → [rec_info]
      for (const [recId, recInfo] of ckRecEvMap) {
        const recAsins = new Set(recInfo.convAgIds.flatMap(ag => [...(ckAgAsinMap.get(ag) ?? [])]));
        let bestCluster = null, bestOverlap = 0;
        for (const [cn, cnAsins] of ckClusterAsinSets) {
          let overlap = 0;
          for (const a of recAsins) if (cnAsins.has(a)) overlap++;
          if (overlap > bestOverlap) { bestOverlap = overlap; bestCluster = cn; }
        }
        console.log(
          bestCluster
            ? `  rec ${recId} '${recInfo.target_text}' → '${bestCluster}' (${bestOverlap} ASIN overlap)`
            : `  rec ${recId} '${recInfo.target_text}' → no cluster match`,
        );
        if (!bestCluster) continue;
        if (!ckOrphansByCluster.has(bestCluster)) ckOrphansByCluster.set(bestCluster, []);
        ckOrphansByCluster.get(bestCluster).push({ id: recId, ...recInfo });
      }

      // CK-5. Emit ONE CREATE_STRUCTURE per qualifying cluster
      let ckKwWritten = 0, ckKwSkipped = 0;
      for (const [clusterName, clusterOrphans] of ckOrphansByCluster) {
        const recKey   = `CLUSTER | ${clusterName} | KW`;
        const campName = `CDL | SP | CLUSTER | ${clusterName} | KW`;

        if (ckLiveKwNamesLower.has(campName.toLowerCase())) {
          console.log(`  skip: ENABLED KW room '${campName}' already present`); ckKwSkipped++; continue;
        }
        if (ckOpenKwSet.has(recKey)) {
          console.log(`  skip: open rec '${recKey}' already exists`); ckKwSkipped++; continue;
        }
        const autoRoom = ckAutoRooms.find(r => r.cluster_name === clusterName);
        if (!autoRoom) { console.log(`  skip: AUTO room not found for '${clusterName}'`); ckKwSkipped++; continue; }

        const ckSeedAsins    = autoRoom.asins.map(asin => ({ asin }));
        const ckKeywords     = clusterOrphans.map(o => ({
          keyword: o.target_text, match_type: 'EXACT',
          bid: Number(o.ev.approved_bid ?? o.ev.proposed_bid ?? 0.35),
        }));
        const graduationFrom = clusterOrphans.map(o => o.id);

        const ckProposal =
          `Create MANUAL cluster KW room '${campName}' — ${ckSeedAsins.length} ASIN(s), ` +
          `${currSym}3.00/day budget, MANUAL targeting, ${ckKeywords.length} exact keyword(s), born PAUSED. ` +
          `Graduates stranded PROMOTE_TERM rec(s): ${graduationFrom.join(', ')}.`;
        const ckEvidence = {
          kind:                 'cluster_kw_room',
          cluster_name:         clusterName,
          profile_id:           profileIdStr,
          seed_asins:           ckSeedAsins,
          keywords:             ckKeywords,
          proposed_default_bid: Math.max(...ckKeywords.map(k => k.bid)),
          targeting_type:       'MANUAL',
          budget:               3.00,
          graduation_from:      graduationFrom,
          orphan_rec_ids:       graduationFrom,
        };

        await pool.query(
          `INSERT INTO recommendations (rec_type, profile_id, campaign_id, target_text, proposal, evidence)
           VALUES ($1, $2, NULL, $3, $4, $5)`,
          ['CREATE_STRUCTURE', profileId, recKey, ckProposal, JSON.stringify(ckEvidence)],
        );
        countsByType['CREATE_STRUCTURE']++;
        written++;
        ckKwWritten++;
        console.log(`  ✓ Drafted '${recKey}' — ${ckKeywords.length} keyword(s), ${ckSeedAsins.length} ASIN(s)`);
      }
      console.log(`  CLUSTER_KW_ROOM: ${ckKwWritten} drafted, ${ckKwSkipped} skipped.`);
    }
  }
  console.log('──────────────────────────────────────────────────────────────────────');
  } // end ckLang check
} // end cluster_kw_room guard

// ── orphan_kw_room entry guard ───────────────────────────────────────────────
if (!values['cluster-rooms']) {
  console.log('cluster-room phases skipped (no --cluster-rooms flag)');
} else {
  const orpLang = CLUSTER_LANG_MAP[profileIdStr];
  if (!orpLang) { console.log(`  cluster-room phases skipped — no language mapping for profile ${profileIdStr}`); }
  else if (countryCode !== 'ES') {
    console.log('\n── ORPHAN KW ROOM phase ─────────────────────────────────────────────────────');
    const orphanKwCampName = `CDL | ${countryCode} | SP | ORPHAN KWs | EXACT`;
    const orphanKwRecKey   = orphanKwCampName; // target_text = full room name

    const { rows: orphanKwExist } = await pool.query(
      `SELECT id FROM recommendations
        WHERE profile_id = $1 AND rec_type = 'CREATE_STRUCTURE'
          AND target_text = $2 AND status = ANY($3)`,
      [profileId, orphanKwRecKey, ['DRAFT', 'APPROVED', 'PUSHED']],
    );
    if (orphanKwExist.length > 0) {
      console.log(`  [ORPHAN KW ROOM] '${orphanKwCampName}' already open (id ${orphanKwExist[0].id}) — skipping.`);
    } else {
      const { rows: orphanKwStrandedRows } = await pool.query(
        `SELECT id, target_text, evidence
           FROM recommendations
          WHERE profile_id = $1
            AND rec_type   = 'PROMOTE_TERM'
            AND status     = 'APPROVED'
            AND (evidence->>'resolved_destination') IS NULL`,
        [profileId],
      );
      console.log(`  Stranded APPROVED PROMOTE_TERM recs: ${orphanKwStrandedRows.length}`);

      if (orphanKwStrandedRows.length === 0) {
        console.log('  No stranded recs — skipping ORPHAN KW ROOM.');
      } else {
        // Seed ASINs: converting placement ag product ads, sorted by order weight
        const orphanKwAgMap = new Map(); // ag_id → total_orders
        for (const row of orphanKwStrandedRows) {
          const ev = typeof row.evidence === 'string' ? JSON.parse(row.evidence) : row.evidence;
          const pls  = Array.isArray(ev.placements) ? ev.placements : [];
          const conv = pls.filter(p => Number(p.orders) > 0);
          for (const p of (conv.length > 0 ? conv : pls)) {
            if (p.ad_group_id) {
              const ag = String(p.ad_group_id);
              orphanKwAgMap.set(ag, (orphanKwAgMap.get(ag) ?? 0) + Number(p.orders));
            }
          }
        }
        const orphanKwAsinMap = new Map();
        if (orphanKwAgMap.size > 0) {
          const { rows: orphanKwPaRows } = await pool.query(
            `SELECT DISTINCT asin, ad_group_id::text AS ag_id FROM amazon_product_ads
              WHERE profile_id = $1 AND ad_group_id = ANY($2) AND state = 'ENABLED'`,
            [profileId, [...orphanKwAgMap.keys()]],
          );
          for (const r of orphanKwPaRows) {
            orphanKwAsinMap.set(r.asin, (orphanKwAsinMap.get(r.asin) ?? 0) + (orphanKwAgMap.get(r.ag_id) ?? 0));
          }
        }
        const orphanKwSeedAsins = [...orphanKwAsinMap.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([asin, orders]) => ({ asin, orders }));

        // Keywords from stranded recs
        const orphanKwKeywords = orphanKwStrandedRows.map(row => {
          const ev = typeof row.evidence === 'string' ? JSON.parse(row.evidence) : row.evidence;
          return {
            keyword: row.target_text, match_type: 'EXACT',
            bid: Number(ev.approved_bid ?? ev.proposed_bid ?? 0.35),
          };
        });
        const orphanRecIds = orphanKwStrandedRows.map(r => Number(r.id));

        const orphanKwProposal =
          `Create MANUAL orphan KW room '${orphanKwCampName}' — ${orphanKwSeedAsins.length} ASIN(s), ` +
          `${currSym}3.00/day budget, MANUAL targeting, ${orphanKwKeywords.length} exact keyword(s), born PAUSED. ` +
          `US orphan-router destination for stranded PROMOTE_TERM rec(s): ${orphanRecIds.join(', ')}.`;
        const orphanKwEvidence = {
          kind:           'us_orphan_kw_room',
          profile_id:     profileIdStr,
          campaign_name:  orphanKwCampName,
          seed_asins:     orphanKwSeedAsins,
          keywords:       orphanKwKeywords,
          targeting_type: 'MANUAL',
          budget:         3.00,
          orphan_rec_ids: orphanRecIds,
          orphan_router:  true,
        };

        await pool.query(
          `INSERT INTO recommendations (rec_type, profile_id, campaign_id, target_text, proposal, evidence)
           VALUES ($1, $2, NULL, $3, $4, $5)`,
          ['CREATE_STRUCTURE', profileId, orphanKwRecKey, orphanKwProposal, JSON.stringify(orphanKwEvidence)],
        );
        countsByType['CREATE_STRUCTURE']++;
        written++;
        console.log(`  ✓ Drafted '${orphanKwCampName}' — ${orphanKwKeywords.length} keyword(s), ${orphanKwSeedAsins.length} ASIN(s)`);
      }
    }
    console.log('──────────────────────────────────────────────────────────────────────');
  }
} // end orphan_kw_room guard

await pool.end();

// ── 8. SUMMARY ───────────────────────────────────────────────────────────────
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
