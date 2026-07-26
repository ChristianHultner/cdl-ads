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
// v5: BID_ADJUST is a new rec_type for harvested PROMOTE_ASIN candidates
const countsByType  = { NEGATE_TERM: 0, PROMOTE_TERM: 0, PROMOTE_ASIN: 0, BID_ADJUST: 0 };

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

  // ── v5: Batch existing-targets lookup for PROMOTE_ASIN candidates ─────────
  // target_id included — the push path will need it for BID_ADJUST.
  const promoteAsinTerms = candidates
    .filter((c) => c.recType === 'PROMOTE_ASIN')
    .map((c) => c.searchTerm.toUpperCase());

  const existingTargetsMap = new Map(); // UPPER(asin) → [{target_id, ad_group_id, campaign_id, bid}]
  const adGroupNameMap     = new Map(); // ad_group_id → name (for BID_ADJUST proposal sentences)

  if (promoteAsinTerms.length > 0) {
    const { rows: existingTargetRows } = await pool.query(
      `SELECT target_id, ad_group_id, campaign_id, bid, resolved_asin
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
        target_id:   row.target_id,
        ad_group_id: row.ad_group_id,
        campaign_id: row.campaign_id,
        bid:         row.bid != null ? Number(row.bid) : null,
      });
    }

    // Batch-fetch ad group names for BID_ADJUST proposal sentences.
    const agIds = [...new Set(existingTargetRows.map((r) => r.ad_group_id))];
    if (agIds.length > 0) {
      const { rows: agRows } = await pool.query(
        `SELECT ad_group_id, name
           FROM amazon_ad_groups
          WHERE profile_id = $1
            AND ad_group_id = ANY($2)`,
        [profileId, agIds],
      );
      for (const ag of agRows) adGroupNameMap.set(ag.ad_group_id, ag.name);
    }
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
      `SELECT DISTINCT ad_group_id
         FROM amazon_targets
        WHERE profile_id      = $1
          AND ad_group_id     = ANY($2)
          AND state           = 'ENABLED'
          AND expression_type = 'AUTO'`,
      [profileId, allPromotePlacementAgIds],
    );
    for (const row of autoRows) autoGroupSet.add(String(row.ad_group_id));
  }

  for (const c of candidates) {
    const spendFmt = `${currSym}${c.spend.toFixed(2)}`;
    const win      = `${windowStart} – ${windowEnd}`;

    // ── v5: Determine final rec_type and PROMOTE_ASIN routing ────────────────
    // Must be resolved before idempotency so the guard uses the written type.
    let finalRecType        = c.recType;
    let existingTargets     = [];
    let chosenTarget        = null;
    let observedCpc         = null;
    let proposedBid         = null;
    let chosen_target_share = null;

    if (c.recType === 'PROMOTE_ASIN') {
      const asinKey   = c.searchTerm.toUpperCase();
      existingTargets = existingTargetsMap.get(asinKey) ?? [];

      if (existingTargets.length >= 1) {
        // ── HARVESTED → BID_ADJUST ──────────────────────────────────────────
        finalRecType = 'BID_ADJUST';

        if (c.clicks === 0) {
          console.log(`  skipped (cannot price — 0 clicks): [BID_ADJUST] "${c.searchTerm}"`);
          continue;
        }

        // Chosen target: existing target whose ad group appears in placements
        // with the highest spend; fallback = existing target with highest bid.
        const placementSpendByAg = new Map(c.placements.map((p) => [p.ad_group_id, p.spend]));
        const targetsInPlacements = existingTargets.filter((t) => placementSpendByAg.has(t.ad_group_id));

        if (targetsInPlacements.length > 0) {
          chosenTarget = targetsInPlacements.reduce((best, t) =>
            (placementSpendByAg.get(t.ad_group_id) ?? 0) > (placementSpendByAg.get(best.ad_group_id) ?? 0)
              ? t : best,
            targetsInPlacements[0],
          );
        } else {
          chosenTarget = existingTargets.reduce((best, t) =>
            (t.bid ?? 0) > (best.bid ?? 0) ? t : best,
            existingTargets[0],
          );
        }

        observedCpc = c.spend / c.clicks;
        proposedBid = Math.min(
          Math.round(observedCpc * params.promote_bid_cpc_multiplier * 100) / 100,
          params.promote_bid_max,
        );

        // search-term rows are group-level; the share is the target's GROUP's performance for this term.
        const matchedPlacement = c.placements.find((p) => p.ad_group_id === chosenTarget.ad_group_id);
        chosen_target_share = matchedPlacement
          ? { spend: matchedPlacement.spend, clicks: matchedPlacement.clicks,
              orders: matchedPlacement.orders, sales: matchedPlacement.sales }
          : { spend: 0, clicks: 0, orders: 0, sales: 0 };

        // Skip when proposed bid equals current bid — nothing to change.
        if (chosenTarget.bid != null && proposedBid === chosenTarget.bid) {
          console.log(`  skipped (bid already at proposal): [BID_ADJUST] "${c.searchTerm}"`);
          continue;
        }
      } else {
        // ── UNHARVESTED → PROMOTE_ASIN (new target, v4 rule unchanged) ───────
        if (c.clicks > 0) {
          observedCpc = c.spend / c.clicks;
          proposedBid = Math.min(
            Math.round(observedCpc * params.promote_bid_cpc_multiplier * 100) / 100,
            params.promote_bid_max,
          );
        }
      }
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
        ...(observedCpc != null ? { observed_cpc: observedCpc } : {}),
        ...(proposedBid  != null ? { proposed_bid:  proposedBid  } : {}),
        params_used:       params,
      };
    } else if (finalRecType === 'BID_ADJUST') {
      // v5.1: honest BID_ADJUST — EARNING or DORMANT based on chosen target's group share.
      const adGroupName    = adGroupNameMap.get(chosenTarget.ad_group_id) ?? chosenTarget.ad_group_id;
      const currentBidFmt  = chosenTarget.bid != null
        ? `${currSym}${chosenTarget.bid.toFixed(2)}`
        : '—';
      const proposedBidFmt = `${currSym}${proposedBid.toFixed(2)}`;
      const direction      = proposedBid > (chosenTarget.bid ?? 0) ? 'Raise' : 'Cut';
      const asin           = c.searchTerm.toUpperCase();
      const share          = chosen_target_share ?? { spend: 0, clicks: 0, orders: 0, sales: 0 };

      if (share.orders >= 1) {
        // EARNING: chosen target's group contributed at least one order for this term.
        const shareAcosPct = share.sales > 0
          ? (share.spend / share.sales * 100).toFixed(1)
          : '—';
        proposal =
          `${direction} bid on target for '${asin}' in '${adGroupName}' ` +
          `from ${currentBidFmt} to ${proposedBidFmt}: this placement won ` +
          `${share.orders} of ${c.orders} orders (${shareAcosPct}% ACoS) in ${win}.`;
      } else {
        // DORMANT: chosen target's group earned no orders for this term.
        const topPlacement  = c.placements.reduce(
          (best, p) => ((p.sales ?? 0) > (best.sales ?? 0) ? p : best),
          c.placements[0],
        );
        const topGroupName  = adGroupNameMap.get(topPlacement.ad_group_id) ?? topPlacement.ad_group_id;
        const termAcosPct   = (c.acos * 100).toFixed(1);
        const termCpc       = (c.spend / c.clicks).toFixed(2);
        const shareSpendFmt = `${currSym}${share.spend.toFixed(2)}`;
        proposal =
          `Reprice dormant target for '${asin}' in '${adGroupName}' ` +
          `from ${currentBidFmt} to ${proposedBidFmt}: it spent ${shareSpendFmt} with no sales in ${win}, ` +
          `while the term converted at ${termAcosPct}% ACoS elsewhere (${topGroupName}, ${currSym}${termCpc}/click).`;
      }

      evidence = {
        window_start:        windowStart,
        window_end:          windowEnd,
        spend:               c.spend,
        clicks:              c.clicks,
        orders:              c.orders,
        sales:               c.sales,
        acos:                c.acos,
        observed_cpc:        observedCpc,
        proposed_bid:        proposedBid,
        chosen_target: {
          target_id:   chosenTarget.target_id,
          ad_group_id: chosenTarget.ad_group_id,
          campaign_id: chosenTarget.campaign_id,
          current_bid: chosenTarget.bid,
        },
        chosen_target_share: share,
        existing_targets:    existingTargets,
        placements:          c.placements,
        params_used:         params,
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
