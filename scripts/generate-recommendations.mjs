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
  `SELECT currency_code, country_code FROM amazon_profiles WHERE profile_id = $1`,
  [profileId],
);
if (!profileRows.length) {
  await pool.end();
  throw new Error(`Profile ${profileIdStr} not found`);
}
const currencyCode = profileRows[0].currency_code;
const countryCode  = profileRows[0].country_code ?? 'US';
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

  // KEYWORD: ENABLED EXACT amazon_keywords
  const { rows: kRows } = await bidPool.query(
    `SELECT keyword_id::text  AS entity_id,
            ad_group_id::text,
            campaign_id::text,
            bid,
            keyword_text
       FROM amazon_keywords
      WHERE profile_id  = $1
        AND state       = 'ENABLED'
        AND match_type  = 'EXACT'`,
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
const countsByType  = { NEGATE_TERM: 0, PROMOTE_TERM: 0, PROMOTE_ASIN: 0, BID_ADJUST: 0, DEFUSE: 0, CREATE_STRUCTURE: 0, BUDGET_ADJUST: 0, PAUSE_CAMPAIGN: 0 };

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
  // v5: BID_ADJUST keyed same way — profile+type+target.
  const openSet     = new Set(); // DRAFT | APPROVED | PUSHED → skip
  const rejectedSet = new Set(); // REJECTED → skip
  for (const row of existingRows) {
    const key = `${row.rec_type}|${row.target_text}`;
    if (['DRAFT', 'APPROVED', 'PUSHED'].includes(row.status)) openSet.add(key);
    else if (row.status === 'REJECTED')                        rejectedSet.add(key);
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
    const key = `${finalRecType}|${c.searchTerm}`;

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
      // Unchanged from v4.
      proposal =
        `Negate '${c.searchTerm}': ${spendFmt} spend, ${c.clicks} clicks, ` +
        `0 orders in ${win}.`;
      const primaryPlacement = c.placements.reduce(
        (max, p) => (p.spend > max.spend ? p : max),
        c.placements[0],
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
        params_used:       params,
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
    return `keyword '${entity.keyword_text}' in '${grp}'`;
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
const bidMinClicks = params.v6_min_clicks ?? 30;
const bidMinOrders = params.v6_min_orders ?? 3;
const bidEligible  = bidEntities.filter(
  (e) => e.current_bid !== null &&
         (e.clicks >= bidMinClicks || e.orders >= bidMinOrders),
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
      // RAISE
      const step    = entity.entity_kind === 'AUTO_STRATEGY'
        ? (params.auto_strategy_raise_step ?? 1.3)
        : (params.raise_max_step           ?? 1.5);
      const stepBid = Math.round(currentBid * step * 100) / 100;
      const capBid  = params.raise_bid_max ?? 0.75;
      proposedBid   = Math.min(vpc, stepBid, capBid);
      direction     = 'Raise';
      if      (proposedBid === capBid  && capBid  <= vpc && capBid  <= stepBid) boundBy = 'cap';
      else if (proposedBid === stepBid && stepBid <= vpc)                        boundBy = 'step';
    } else if (entity.acos > params.target_acos && vpc < currentBid) {
      // CUT
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
      `${direction} bid on ${kindPhrase} ` +
      `from ${curFmt} to ${propFmt}: ` +
      `its clicks are worth ${vpcFmt} at your ${tgtPct}% target ` +
      `(60d: ${entity.orders} orders, ${acosPct}% ACoS, ${cpcFmt}/click).${boundSuffix}${amzSuffix}`;
  }

  // Build evidence.
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
    performance_basis: entity.performance_basis,
    params_used:       params,
    bound_by:          boundBy,
    ...(amzRec ? {
      amazon_suggested:   amzRec.amazon_suggested,
      amazon_range_start: amzRec.amazon_range_start,
      amazon_range_end:   amzRec.amazon_range_end,
      quote_age_days:     amzRec.quote_age_days,
    } : {}),
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

    const targetText = `Keywords - Exacta ${countryCode} (${lang})`;

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
//   campaigns with spend_30d >= 10; fallback 0.30.
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
  : 0.30;
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
