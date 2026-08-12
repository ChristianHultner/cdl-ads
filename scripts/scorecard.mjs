// scripts/scorecard.mjs
// Layer 3.1: GP-derived judgment, ACoS band 25-35, REVIEW state.
// Usage: node --env-file=.env.local scripts/scorecard.mjs [--horizon t7|t14|all]
// READ-ONLY analysis of rec_outcomes.

import { parseArgs }      from 'node:util';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname }   from 'node:path';
import { fileURLToPath }   from 'node:url';

neonConfig.webSocketConstructor = WebSocket;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = join(__dirname, '..');

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: { horizon: { type: 'string', default: 'all' } },
});
const horizonFilter = args.horizon;
if (!['t7', 't14', 'all'].includes(horizonFilter))
  throw new Error(`--horizon must be t7|t14|all, got: ${horizonFilter}`);

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL not set');
const pool = new Pool({ connectionString: DATABASE_URL });

// ── Fetch stamps ─────────────────────────────────────────────────────────────
const hClause = horizonFilter === 'all' ? '' : `AND o.horizon = '${horizonFilter}'`;
const { rows: rawRows } = await pool.query(`
  SELECT r.id, r.rec_type, r.target_text, r.campaign_id, r.evidence,
         p.country_code, p.currency_code,
         o.horizon, o.metrics, o.captured_at
  FROM recommendations   r
  JOIN rec_outcomes      o ON o.rec_id     = r.id
  JOIN amazon_profiles   p ON p.profile_id = r.profile_id
  WHERE r.status = 'PUSHED'
  ${hClause}
  ORDER BY r.rec_type, o.horizon, p.country_code, r.id
`);

// ── Market rolling ACoS (last 30 days from campaign_daily) ───────────────────
const { rows: acosRows } = await pool.query(`
  SELECT p.country_code,
         SUM(acd.cost)::float                                  AS cost_30d,
         NULLIF(SUM(acd.sales_14d), 0)::float                  AS sales_30d
  FROM amazon_campaign_daily acd
  JOIN amazon_profiles       p ON p.profile_id = acd.profile_id
  WHERE acd.date >= CURRENT_DATE - INTERVAL '30 days'
  GROUP BY p.country_code
`);
const marketRollingAcos = {};
for (const r of acosRows) {
  if (r.sales_30d != null && r.sales_30d > 0)
    marketRollingAcos[r.country_code] = r.cost_30d / r.sales_30d;
}

// Per-profile target_acos → per-market band (#4 fix — 2026-08-12: replaces hardcoded 25/35).
const { rows: profileAcosRows } = await pool.query(`
  SELECT country_code, target_acos::float AS target_acos
  FROM amazon_profiles
  WHERE target_acos IS NOT NULL
`);
const profileTargetAcos = {};
for (const r of profileAcosRows) {
  if (r.target_acos != null) profileTargetAcos[r.country_code] = Number(r.target_acos);
}

await pool.end();

// Per-market band helper: derives from amazon_profiles.target_acos, fallback 0.30.
function marketBand(mkt) {
  const ta = profileTargetAcos[mkt] ?? 0.30;
  return { bandLow: ta - 0.05, bandHigh: ta + 0.05 };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function safeN(x) { return (x == null) ? NaN : Number(x); }
function pct(n, total) {
  if (total === 0 || isNaN(total)) return '—';
  return (n / total * 100).toFixed(1) + '%';
}
function median(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// ── Judgment functions ────────────────────────────────────────────────────────

function judgeNegateTerm(ev, m) {
  if (m.rows_found === 0) return { verdict: 'NO-DATA' };
  const cost     = safeN(m.cost);
  const refSpend = safeN(ev.spend);
  const hasBefore = m.before_rows_found != null;

  if (!hasBefore) {
    // Legacy stamp: old definition + pre_gp_grading tag
    const stopped = (!isNaN(refSpend) && !isNaN(cost)) ? refSpend - cost : null;
    if (!isNaN(refSpend) && refSpend > 0) {
      const ratio = cost / refSpend;
      if (ratio <= 0.05) return { verdict: 'WIN',     euros_stopped: stopped, pct_of_ref: ratio, pre_gp_grading: true };
      if (ratio <= 0.50) return { verdict: 'PARTIAL', euros_stopped: stopped, pct_of_ref: ratio, pct_reduced: 1 - ratio, pre_gp_grading: true };
      return               { verdict: 'LEAK',          euros_stopped: stopped, pct_of_ref: ratio, pre_gp_grading: true };
    }
    if (cost < 0.10) return { verdict: 'WIN',    euros_stopped: stopped, note: 'refSpend unknown; absolute fallback', pre_gp_grading: true };
    return                  { verdict: 'PARTIAL', euros_stopped: stopped, note: 'refSpend unknown; absolute fallback', pre_gp_grading: true };
  }

  // GP grading (L3.1)
  const salesAfter  = safeN(m.sales_14d      ?? 0);
  const beforeCost  = safeN(m.before_cost    ?? 0);
  const beforeSales = safeN(m.before_sales_14d ?? 0);
  const gp_delta    = (salesAfter - cost) - (beforeSales - beforeCost);
  const stopped     = (!isNaN(refSpend) && !isNaN(cost)) ? refSpend - cost : null;

  const spendStopped = !isNaN(refSpend) && refSpend > 0
    ? (cost / refSpend) <= 0.05
    : cost < 0.10;

  if (spendStopped) {
    if (gp_delta >= 0)
      return { verdict: 'WIN',    euros_stopped: stopped, gp_delta,
               pct_of_ref: !isNaN(refSpend) && refSpend > 0 ? cost / refSpend : undefined };
    return   { verdict: 'REVIEW', euros_stopped: stopped, gp_delta,
               note: 'spend stopped but GP Δ<0: negation may have killed converting traffic' };
  }

  if (!isNaN(refSpend) && refSpend > 0) {
    const ratio = cost / refSpend;
    if (ratio <= 0.50) return { verdict: 'PARTIAL', euros_stopped: stopped, pct_of_ref: ratio, pct_reduced: 1 - ratio, gp_delta };
    return               { verdict: 'LEAK',          euros_stopped: stopped, pct_of_ref: ratio, gp_delta };
  }
  return { verdict: 'PARTIAL', euros_stopped: stopped, note: 'refSpend unknown; absolute fallback', gp_delta };
}

function judgeNegateTarget(ev, m) {
  if (m.rows_found === 0) return { verdict: 'NO-DATA' };
  const cost     = safeN(m.cost);
  const refSpend = safeN(ev.spend);
  const hasBefore = m.before_rows_found != null;

  if (!hasBefore) {
    const stopped = (!isNaN(refSpend) && !isNaN(cost)) ? refSpend - cost : null;
    if (!isNaN(refSpend) && refSpend > 0) {
      const ratio = cost / refSpend;
      if (ratio <= 0.05) return { verdict: 'WIN',     euros_stopped: stopped, pct_of_ref: ratio, pre_gp_grading: true };
      if (ratio <= 0.50) return { verdict: 'PARTIAL', euros_stopped: stopped, pct_of_ref: ratio, pct_reduced: 1 - ratio, pre_gp_grading: true };
      return               { verdict: 'LEAK',          euros_stopped: stopped, pct_of_ref: ratio, pre_gp_grading: true };
    }
    if (cost < 0.10) return { verdict: 'WIN',    euros_stopped: stopped, note: 'refSpend unknown; absolute fallback', pre_gp_grading: true };
    return                  { verdict: 'PARTIAL', euros_stopped: stopped, note: 'refSpend unknown; absolute fallback', pre_gp_grading: true };
  }

  const salesAfter  = safeN(m.sales_14d      ?? 0);
  const beforeCost  = safeN(m.before_cost    ?? 0);
  const beforeSales = safeN(m.before_sales_14d ?? 0);
  const gp_delta    = (salesAfter - cost) - (beforeSales - beforeCost);
  const stopped     = (!isNaN(refSpend) && !isNaN(cost)) ? refSpend - cost : null;

  const spendStopped = !isNaN(refSpend) && refSpend > 0
    ? (cost / refSpend) <= 0.05
    : cost < 0.10;

  if (spendStopped) {
    if (gp_delta >= 0)
      return { verdict: 'WIN',    euros_stopped: stopped, gp_delta,
               pct_of_ref: !isNaN(refSpend) && refSpend > 0 ? cost / refSpend : undefined };
    return   { verdict: 'REVIEW', euros_stopped: stopped, gp_delta,
               note: 'spend stopped but GP Δ<0: negation may have killed converting traffic' };
  }

  if (!isNaN(refSpend) && refSpend > 0) {
    const ratio = cost / refSpend;
    if (ratio <= 0.50) return { verdict: 'PARTIAL', euros_stopped: stopped, pct_of_ref: ratio, pct_reduced: 1 - ratio, gp_delta };
    return               { verdict: 'LEAK',          euros_stopped: stopped, pct_of_ref: ratio, gp_delta };
  }
  return { verdict: 'PARTIAL', euros_stopped: stopped, note: 'refSpend unknown; absolute fallback', gp_delta };
}

function judgeBidAdjust(ev, m, countryCode) {
  const pushed  = safeN(ev.pushed_bid ?? ev.proposed_bid);
  let   current = safeN(ev.current_bid);
  if (isNaN(current) && Array.isArray(ev.existing_targets) && ev.existing_targets.length > 0)
    current = safeN(ev.existing_targets[0].bid);
  // REVIVE: current_bid not top-level; resolve from evidence.current_max (#8 fix — 2026-08-12).
  if (isNaN(current) && ev.kind === 'REVIVE' && ev.current_max != null)
    current = safeN(ev.current_max);

  const targetAcos = safeN(ev.params_used?.target_acos ?? 0.30);
  const bandHigh   = targetAcos + 0.05;

  let direction;
  if (!isNaN(current) && !isNaN(pushed)) {
    direction = pushed < current * 0.99 ? 'CUT'
              : pushed > current * 1.01 ? 'RAISE'
              : 'FLAT';
  } else {
    direction = 'UNKNOWN';
  }

  if (m.rows_found === 0) return { verdict: 'NO-DATA', direction };

  const afterCost   = safeN(m.cost);
  const afterSales  = safeN(m.sales_14d);
  const afterClicks = safeN(m.clicks);
  const beforeCost  = safeN(m.before_cost);
  const beforeSales = safeN(m.before_sales_14d);
  const beforeClks  = safeN(m.before_clicks);

  const afterAcos  = afterSales  > 0 ? afterCost  / afterSales  : null;
  const beforeAcos = beforeSales > 0 ? beforeCost / beforeSales : null;
  const acosDelta  = (afterAcos !== null && beforeAcos !== null) ? afterAcos - beforeAcos : null;

  const gp_delta = (!isNaN(afterCost) && !isNaN(beforeCost))
    ? (afterSales - afterCost) - (beforeSales - beforeCost)
    : null;

  if (direction === 'CUT') {
    if (gp_delta !== null && gp_delta > 0)
      return { verdict: 'WIN',     direction, acos_delta: acosDelta, gp_delta };
    const acosBetter = afterAcos !== null && beforeAcos !== null && afterAcos < beforeAcos;
    if (acosBetter)
      return { verdict: 'PARTIAL', direction, acos_delta: acosDelta, gp_delta,
               note: 'ACoS improved but GP Δ≤0' };
    const spendFell = afterCost < beforeCost * 0.90;
    if (spendFell)
      return { verdict: 'PARTIAL', direction, acos_delta: acosDelta, gp_delta,
               note: 'spend fell but GP Δ≤0 (sales fell more)' };
    return { verdict: 'LEAK', direction, acos_delta: acosDelta, gp_delta };
  }

  if (direction === 'RAISE') {
    if (gp_delta !== null && gp_delta > 0) {
      const marketAcos  = marketRollingAcos[countryCode];
      const marketAbove = marketAcos != null && marketAcos > bandHigh;
      if (!marketAbove) {
        const note = marketAcos != null
          ? `market ${(marketAcos * 100).toFixed(1)}% in/below band`
          : undefined;
        return { verdict: 'WIN', direction, acos_delta: acosDelta, gp_delta, note };
      }
      if (afterAcos == null || afterAcos <= bandHigh)
        return { verdict: 'WIN',     direction, acos_delta: acosDelta, gp_delta,
                 note: `market ${(marketAcos * 100).toFixed(1)}% above band; entity ACoS within ceiling` };
      return   { verdict: 'PARTIAL', direction, acos_delta: acosDelta, gp_delta,
                 note: `GP Δ>0 but market ${(marketAcos * 100).toFixed(1)}% above band; entity ACoS ${(afterAcos * 100).toFixed(1)}%>ceiling` };
    }
    const clicksRose = afterClicks > beforeClks;
    if (clicksRose)
      return { verdict: 'PARTIAL', direction, acos_delta: acosDelta, gp_delta,
               note: 'clicks rose but GP Δ≤0' };
    return { verdict: 'LEAK', direction, acos_delta: acosDelta, gp_delta,
             note: 'clicks did not rise and GP Δ≤0' };
  }

  return {
    verdict: 'NO-DATA', direction,
    note: direction === 'FLAT'
      ? 'pushed_bid ≈ current_bid; no directional change'
      : 'current_bid unavailable in evidence',
  };
}

function judgeReplaceProductAd(ev, m) {
  if (m.rows_found === 0) return { verdict: 'NO-DATA', note: 'no daily rows for B0 or HC in window' };
  const b0Impr   = safeN(m.b0_impressions ?? 0);
  const hcImpr   = safeN(m.hc_impressions ?? 0);
  const hcClicks = safeN(m.hc_clicks      ?? 0);
  const b0Spend  = safeN(m.b0_spend);
  const hcOrders = safeN(m.hc_orders      ?? 0);
  const b0Dark   = b0Impr === 0;
  const hcServe  = hcImpr > 0 || hcClicks > 0;

  let gp_delta = null;
  if (m.before_b0_spend != null && m.before_hc_spend != null) {
    const afterGP  = safeN(m.hc_sales  ?? 0) + safeN(m.b0_sales  ?? 0)
                   - safeN(m.hc_spend  ?? 0) - safeN(m.b0_spend  ?? 0);
    const beforeGP = safeN(m.before_hc_sales ?? 0) + safeN(m.before_b0_sales ?? 0)
                   - safeN(m.before_hc_spend ?? 0) - safeN(m.before_b0_spend ?? 0);
    gp_delta = afterGP - beforeGP;
  }

  if (b0Dark && hcServe) return { verdict: 'WIN',     note: 'B0 dark, HC serving', b0_spend: b0Spend, hc_orders: hcOrders, gp_delta };
  if (b0Dark)             return { verdict: 'PARTIAL', note: 'B0 dark but HC not yet serving', b0_spend: b0Spend, gp_delta };
  if (hcServe)            return { verdict: 'PARTIAL', note: 'HC serving but B0 still active', b0_spend: b0Spend, gp_delta };
  return                         { verdict: 'LEAK',    note: 'B0 still active, HC not serving', b0_spend: b0Spend, gp_delta };
}

function judgePromoteTerm(ev, m, horizon) {
  if (m.rows_found === 0) return { verdict: 'NO-DATA' };
  const clicks    = safeN(m.clicks);
  const purchases = safeN(m.purchases_14d ?? 0);
  if (isNaN(clicks)) return { verdict: 'NO-DATA', note: 'no clicks field in metrics' };

  let gp_delta = null;
  if (m.before_rows_found != null) {
    const afterSales  = safeN(m.sales_14d  ?? 0);
    const afterCost   = safeN(m.cost       ?? 0);
    const beforeSales = safeN(m.before_sales_14d ?? 0);
    const beforeCost  = safeN(m.before_cost ?? 0);
    gp_delta = (afterSales - afterCost) - (beforeSales - beforeCost);
  }

  if (clicks > 0) {
    if (gp_delta != null && gp_delta > 0)
      return { verdict: 'WIN', note: 'STRONG: gp_delta>0',
               clicks, purchases: purchases > 0 ? purchases : undefined, gp_delta };
    if (horizon === 't14' && purchases > 0)
      return { verdict: 'WIN', note: 'STRONG: orders>0 at t14', clicks, purchases, gp_delta };
    return { verdict: 'WIN', note: 'serving at ' + horizon + ' (clicks>0; impression proxy)', clicks, gp_delta };
  }
  return { verdict: 'LEAK', note: 'rows found but zero clicks — keyword dark', clicks: 0, gp_delta };
}

function judgeCreativeKeyword(ev, m, horizon) { return judgePromoteTerm(ev, m, horizon); }

function judgePromoteAsin(ev, m, horizon) {
  if (m.rows_found === 0) return { verdict: 'NO-DATA' };
  const clicks    = safeN(m.clicks);
  const purchases = safeN(m.purchases ?? m.purchases_14d ?? 0);

  let gp_delta = null;
  if (m.before_rows_found != null) {
    const afterSales  = safeN(m.sales  ?? m.sales_14d  ?? 0);
    const afterCost   = safeN(m.cost   ?? 0);
    const beforeSales = safeN(m.before_sales ?? m.before_sales_14d ?? 0);
    const beforeCost  = safeN(m.before_cost ?? 0);
    gp_delta = (afterSales - afterCost) - (beforeSales - beforeCost);
  }

  if (clicks > 0) {
    if (gp_delta != null && gp_delta > 0)
      return { verdict: 'WIN', note: 'STRONG: gp_delta>0', clicks,
               purchases: purchases > 0 ? purchases : undefined, gp_delta };
    if (horizon === 't14' && purchases > 0)
      return { verdict: 'WIN', note: 'STRONG: orders>0 at t14', clicks, purchases, gp_delta };
    return { verdict: 'WIN', note: 'serving (clicks>0)', clicks, gp_delta };
  }
  return { verdict: 'LEAK', note: 'target dark (rows found, zero clicks)', clicks: 0, gp_delta };
}

function judgeCreativeTarget(ev, m, horizon) { return judgePromoteAsin(ev, m, horizon); }

function judgePauseCampaign(ev, m) {
  if (m.rows_found === 0 && (!m.before_rows_found || m.before_rows_found === 0)) return { verdict: 'NO-DATA' };
  const afterCost  = safeN(m.cost);
  const beforeCost = safeN(m.before_cost);
  if (afterCost < 0.10) return { verdict: 'WIN',     before_cost: beforeCost, after_cost: afterCost };
  if (!isNaN(beforeCost) && beforeCost > 0 && afterCost < beforeCost * 0.50)
    return { verdict: 'PARTIAL', before_cost: beforeCost, after_cost: afterCost };
  return { verdict: 'LEAK', before_cost: beforeCost, after_cost: afterCost };
}

function judgeBudgetAdjust(ev, m) {
  if (m.rows_found === 0) return { verdict: 'NO-DATA' };
  const spendChg = (safeN(m.before_cost) > 0)
    ? (safeN(m.cost) - safeN(m.before_cost)) / safeN(m.before_cost)
    : null;
  const salesChg = (safeN(m.before_sales_14d) > 0)
    ? (safeN(m.sales_14d) - safeN(m.before_sales_14d)) / safeN(m.before_sales_14d)
    : null;
  // GP delta (L3.1-parity; campaign_daily before/after always present for BUDGET_ADJUST).
  const gp_delta = (!isNaN(safeN(m.cost)) && !isNaN(safeN(m.before_cost)))
    ? (safeN(m.sales_14d) - safeN(m.cost)) - (safeN(m.before_sales_14d) - safeN(m.before_cost))
    : null;
  // WIN  = spend rose (raise took) AND gp_delta ≥ 0.
  // LEAK = spend rose but GP fell (volume gained at a loss).
  // PARTIAL = spend flat/fell (raise did not take; no directional signal).
  // BUDGET_ADJUST is raise-only by generation — no direction inversion needed (#3 fix — 2026-08-12).
  let verdict;
  if (spendChg === null) {
    verdict = 'PARTIAL'; // no baseline — cannot judge
  } else if (spendChg > 0) {
    verdict = (gp_delta !== null && gp_delta >= 0) ? 'WIN' : 'LEAK';
  } else {
    verdict = 'PARTIAL'; // raise did not take
  }
  return {
    verdict,
    note: `spend_chg=${spendChg !== null ? (spendChg*100).toFixed(0)+'%' : '?'} sales_chg=${salesChg !== null ? (salesChg*100).toFixed(0)+'%' : '?'}`,
    spend_change_pct: spendChg, sales_change_pct: salesChg, gp_delta,
  };
}

function judgeCreateStructure(ev, m) {
  if (m.rows_found === 0) return { verdict: 'NO-DATA' };
  const impr = safeN(m.impressions);
  if (impr > 0) return { verdict: 'WIN',     note: `campaign serving (impr=${impr})` };
  return       { verdict: 'PARTIAL', note: 'campaign exists but impressions=0' };
}

function judge(row) {
  const ev = typeof row.evidence === 'string' ? JSON.parse(row.evidence) : row.evidence;
  const m  = typeof row.metrics  === 'string' ? JSON.parse(row.metrics)  : row.metrics;
  let j;
  switch (row.rec_type) {
    case 'NEGATE_TERM':        j = judgeNegateTerm(ev, m);                       break;
    case 'NEGATE_TARGET':      j = judgeNegateTarget(ev, m);                     break;
    case 'BID_ADJUST':         j = judgeBidAdjust(ev, m, row.country_code);      break;
    case 'REPLACE_PRODUCT_AD': j = judgeReplaceProductAd(ev, m);                 break;
    case 'PROMOTE_TERM':       j = judgePromoteTerm(ev, m, row.horizon);         break;
    case 'CREATIVE_KEYWORD':   j = judgeCreativeKeyword(ev, m, row.horizon);     break;
    case 'PROMOTE_ASIN':       j = judgePromoteAsin(ev, m, row.horizon);         break;
    case 'CREATIVE_TARGET':    j = judgeCreativeTarget(ev, m, row.horizon);      break;
    case 'PAUSE_CAMPAIGN':     j = judgePauseCampaign(ev, m);                    break;
    case 'BUDGET_ADJUST':      j = judgeBudgetAdjust(ev, m);                     break;
    case 'CREATE_STRUCTURE':   j = judgeCreateStructure(ev, m);                  break;
    default:                   j = { verdict: 'NO-DATA', note: `unhandled type: ${row.rec_type}` };
  }
  return { ...row, ev, m, judgment: j };
}

const judged = rawRows.map(judge);

// ── Aggregation ───────────────────────────────────────────────────────────────
function aggRows(rows) {
  const counts = { WIN: 0, PARTIAL: 0, LEAK: 0, 'NO-DATA': 0, REVIEW: 0 };
  for (const r of rows) counts[r.judgment.verdict] = (counts[r.judgment.verdict] ?? 0) + 1;
  const n  = rows.length;
  const dn = n - (counts['NO-DATA'] ?? 0);   // REVIEW counts in dn
  return { n, dn, counts };
}

// ── Formatting ────────────────────────────────────────────────────────────────
const SEP1 = '═'.repeat(82);
const SEP2 = '─'.repeat(82);

function rateStr(counts, dn) {
  if (dn === 0) return '(all NO-DATA)';
  const parts = [];
  if (counts.WIN    > 0) parts.push(`WIN=${pct(counts.WIN, dn)}`);
  if (counts.REVIEW > 0) parts.push(`REVIEW=${counts.REVIEW} (${pct(counts.REVIEW, dn)}) ⚠`);
  if (counts.PARTIAL > 0) parts.push(`PARTIAL=${pct(counts.PARTIAL, dn)}`);
  if (counts.LEAK    > 0) parts.push(`LEAK=${pct(counts.LEAK, dn)}`);
  const nd = counts['NO-DATA'] ?? 0;
  return parts.join('  ') + (nd > 0 ? `  NO-DATA=${nd}` : '');
}

// ── Market ACoS band summary ──────────────────────────────────────────────────
console.log(SEP1);
console.log('  CdL Ads SCORECARD — Layer 3.1 GP-Derived Outcomes');
console.log(`  Horizon: ${horizonFilter}   Stamps loaded: ${judged.length}   Generated: ${new Date().toISOString()}`);
console.log(SEP1);

console.log('\n  Market rolling ACoS (30d) vs per-profile band (target_acos ± 5pp):');
const mktAcosKeys = Object.keys(marketRollingAcos).sort();
for (const mkt of mktAcosKeys) {
  const ra = marketRollingAcos[mkt];
  const { bandLow, bandHigh } = marketBand(mkt);
  const zone = ra < bandLow ? 'push zone' : ra <= bandHigh ? 'in band' : 'repair zone';
  console.log(`    ${mkt.padEnd(4)} ${(ra * 100).toFixed(1).padStart(6)}%  ·  ${zone}  (band ${(bandLow*100).toFixed(0)}–${(bandHigh*100).toFixed(0)}%)`);
}
if (mktAcosKeys.length === 0) console.log('    (no data)');

console.log(`\n⚠  ADAPTATIONS (L3.1 vs spec):
  1. NEGATE_TERM/TARGET (new stamps): WIN = spend stopped (≤5% ev.spend) AND gp_delta≥0.
     Spend stopped + gp_delta<0 → REVIEW. Legacy stamps tagged pre_gp_grading.
  2. BID_ADJUST CUT: WIN = gp_delta>0. ACoS improvement alone = PARTIAL.
  3. BID_ADJUST RAISE: WIN = gp_delta>0 + market ACoS in/below band (target_acos±5pp);
     above-band market: also requires entity ACoS ≤ ceiling.
  4. REPLACE: execution bar unchanged; gp_delta informational (pair-level).
  5. PROMOTE_TERM/ASIN: WIN=serving unchanged; STRONG = gp_delta>0; gp_delta informational.
  6. BID_ADJUST always had before/after → GP grading applies to all existing stamps.
  7. NEGATE/PROMOTE before-window only on NEW stamps; old stamps → pre_gp_grading.
`);

// ── Per rec_type sections ─────────────────────────────────────────────────────
const TYPE_ORDER = [
  'NEGATE_TERM', 'NEGATE_TARGET',
  'BID_ADJUST',
  'REPLACE_PRODUCT_AD',
  'PROMOTE_TERM', 'CREATIVE_KEYWORD',
  'PROMOTE_ASIN', 'CREATIVE_TARGET',
  'PAUSE_CAMPAIGN', 'BUDGET_ADJUST', 'CREATE_STRUCTURE',
];
const SMALL_TYPES = new Set(['PAUSE_CAMPAIGN', 'BUDGET_ADJUST', 'PROMOTE_ASIN',
                              'CREATIVE_TARGET', 'CREATE_STRUCTURE']);

const jsonSummary = {};

for (const recType of TYPE_ORDER) {
  const typeRows = judged.filter(r => r.rec_type === recType);
  if (typeRows.length === 0) continue;

  const horizons = [...new Set(typeRows.map(r => r.horizon))].sort();
  const markets  = [...new Set(typeRows.map(r => r.country_code))].sort();

  console.log(SEP1);
  console.log(`  ▶  ${recType}`);
  console.log(SEP1);

  jsonSummary[recType] = {};

  // Count pre_gp_grading stamps
  const preGp = typeRows.filter(r => r.judgment.pre_gp_grading).length;
  if (preGp > 0) console.log(`  ⚠ ${preGp} stamp(s) on legacy definition (pre_gp_grading; no before-window)`);

  for (const h of horizons) {
    const hRows = typeRows.filter(r => r.horizon === h);
    const { n, dn, counts } = aggRows(hRows);

    console.log(`\n  ${h.toUpperCase()}  (n=${n})`);

    if (n < 5 || SMALL_TYPES.has(recType)) {
      console.log(`  ↳ n<5 or small-cohort — per-rec:`);
      for (const row of hRows) {
        const j = row.judgment;
        const dir  = j.direction ? ` [${j.direction}]` : '';
        const gpStr = j.gp_delta != null ? `  GP Δ=${j.gp_delta >= 0 ? '+' : ''}${j.gp_delta.toFixed(2)}` : '';
        const note = j.note ? ` | ${j.note}` : '';
        const pre  = j.pre_gp_grading ? ' [pre_gp]' : '';
        console.log(`    rec ${String(row.id).padStart(6)} [${row.country_code}]${dir}  ${j.verdict}${pre}${gpStr}${note}`);
      }
      jsonSummary[recType][h] = { n, counts, perRec: true };
      continue;
    }

    if (recType === 'BID_ADJUST') {
      const cuts   = hRows.filter(r => r.judgment.direction === 'CUT');
      const raises = hRows.filter(r => r.judgment.direction === 'RAISE');
      const other  = hRows.filter(r => !['CUT','RAISE'].includes(r.judgment.direction));

      console.log(`  Direction split: CUTs=${cuts.length}  RAISEs=${raises.length}  FLAT/UNKNOWN=${other.length}`);

      for (const [label, subset] of [['CUTs', cuts], ['RAISEs', raises]]) {
        const { n: sn, dn: sdn, counts: sc } = aggRows(subset);
        if (sn === 0) { console.log(`\n  ${label}: none`); continue; }
        console.log(`\n  ${label} (n=${sn})`);
        console.log(`  Rates (graded n=${sdn}): ${rateStr(sc, sdn)}`);

        const deltas = subset.filter(r => r.judgment.acos_delta != null).map(r => r.judgment.acos_delta);
        if (deltas.length > 0) {
          const med = median(deltas);
          console.log(`  Median ACoS Δ: ${(med * 100).toFixed(1)}pp  (n=${deltas.length}; neg=improvement)`);
        }
        const gpDs = subset.filter(r => r.judgment.gp_delta != null).map(r => r.judgment.gp_delta);
        if (gpDs.length > 0) {
          const medGP = median(gpDs);
          console.log(`  Median GP Δ:   ${medGP >= 0 ? '+' : ''}${medGP.toFixed(2)} (local ccy, n=${gpDs.length})`);
        }

        console.log(`  By market:`);
        console.log(`  ${'Mkt'.padEnd(5)} ${'n'.padStart(4)}  ${'graded'.padStart(7)}  rates`);
        console.log(`  ${'─'.repeat(60)}`);
        for (const mkt of markets) {
          const mr = subset.filter(r => r.country_code === mkt);
          if (mr.length === 0) continue;
          const { n: mn, dn: mdn, counts: mc } = aggRows(mr);
          console.log(`  ${mkt.padEnd(5)} ${String(mn).padStart(4)}  ${String(mdn).padStart(7)}  ${rateStr(mc, mdn)}`);
        }
      }

      if (other.length > 0) console.log(`\n  FLAT/UNKNOWN (n=${other.length}) — all NO-DATA`);
      jsonSummary[recType][h] = {
        n,
        cuts:   { n: cuts.length,   counts: aggRows(cuts).counts },
        raises: { n: raises.length, counts: aggRows(raises).counts },
        other:  { n: other.length },
      };
      continue;
    }

    console.log(`  Rates (graded n=${dn}): ${rateStr(counts, dn)}`);

    if (recType === 'NEGATE_TERM' || recType === 'NEGATE_TARGET') {
      const stops = hRows.filter(r => r.judgment.euros_stopped != null && !isNaN(r.judgment.euros_stopped))
                        .map(r => r.judgment.euros_stopped);
      if (stops.length > 0) console.log(`  Median spend stopped: ${median(stops).toFixed(2)} (n=${stops.length})`);

      const gpDs = hRows.filter(r => r.judgment.gp_delta != null).map(r => r.judgment.gp_delta);
      if (gpDs.length > 0) {
        const medGP = median(gpDs);
        console.log(`  Median GP Δ:          ${medGP >= 0 ? '+' : ''}${medGP.toFixed(2)} (local ccy, n=${gpDs.length})`);
      }
      const reviewN = counts['REVIEW'] ?? 0;
      if (reviewN > 0) console.log(`  ⚠ REVIEW count: ${reviewN} (spend stopped but GP Δ<0 — check converting terms)`);
    }

    console.log(`  By market:`);
    console.log(`  ${'Mkt'.padEnd(5)} ${'n'.padStart(4)}  ${'graded'.padStart(7)}  rates`);
    console.log(`  ${'─'.repeat(60)}`);
    const byMkt = {};
    for (const mkt of markets) {
      const mr = hRows.filter(r => r.country_code === mkt);
      if (mr.length === 0) continue;
      const { n: mn, dn: mdn, counts: mc } = aggRows(mr);
      // Band position annotation for market
      const ra = marketRollingAcos[mkt];
      const { bandLow: _bl, bandHigh: _bh } = marketBand(mkt);
      const bandStr = ra != null
        ? `  [${(ra*100).toFixed(1)}% ${ra < _bl ? 'push' : ra <= _bh ? 'in band' : 'repair'}]`
        : '';
      console.log(`  ${mkt.padEnd(5)} ${String(mn).padStart(4)}  ${String(mdn).padStart(7)}  ${rateStr(mc, mdn)}${bandStr}`);
      byMkt[mkt] = { n: mn, dn: mdn, counts: mc };
    }

    jsonSummary[recType][h] = { n, dn, counts, byMarket: byMkt };
  }

  console.log('');
}

// ── Estate summary ────────────────────────────────────────────────────────────
console.log(SEP1);
console.log('  ESTATE SUMMARY');
console.log(SEP1);

const estateVerdicts = { WIN: 0, PARTIAL: 0, LEAK: 0, 'NO-DATA': 0, REVIEW: 0 };
const estateByType   = {};
for (const row of judged) {
  estateVerdicts[row.judgment.verdict] = (estateVerdicts[row.judgment.verdict] ?? 0) + 1;
  if (!estateByType[row.rec_type]) estateByType[row.rec_type] = { n: 0, WIN: 0, PARTIAL: 0, LEAK: 0, 'NO-DATA': 0, REVIEW: 0 };
  estateByType[row.rec_type].n++;
  estateByType[row.rec_type][row.judgment.verdict]++;
}

const total     = judged.length;
const totalND   = estateVerdicts['NO-DATA'];
const totalData = total - totalND;
const totalRev  = estateVerdicts['REVIEW'];

console.log(`\nTotal stamps:  ${total}`);
console.log(`Graded:        ${totalData}  (${pct(totalData, total)} of total)`);
console.log(`NO-DATA:       ${totalND}  (${pct(totalND, total)})`);
if (totalRev > 0) console.log(`⚠ REVIEW:      ${totalRev}  (${pct(totalRev, totalData)} of graded)`);
console.log(`\nOverall (graded only):  WIN=${pct(estateVerdicts.WIN, totalData)}  REVIEW=${totalRev}  PARTIAL=${pct(estateVerdicts.PARTIAL, totalData)}  LEAK=${pct(estateVerdicts.LEAK, totalData)}`);
console.log('');
console.log(`${'Type'.padEnd(22)} ${'n'.padStart(5)}  ${'graded'.padStart(7)}  ${'WIN%'.padStart(6)}  ${'REV'.padStart(5)}  ${'PART%'.padStart(6)}  ${'LEAK%'.padStart(6)}  ${'NO-DATA'.padStart(8)}`);
console.log(SEP2);
for (const rt of TYPE_ORDER) {
  const s = estateByType[rt];
  if (!s) continue;
  const dn  = s.n - s['NO-DATA'];
  const wp  = pct(s.WIN,     dn);
  const pp  = pct(s.PARTIAL, dn);
  const lp  = pct(s.LEAK,    dn);
  const rev = String(s.REVIEW ?? 0);
  console.log(`${rt.padEnd(22)} ${String(s.n).padStart(5)}  ${String(dn).padStart(7)}  ${wp.padStart(6)}  ${rev.padStart(5)}  ${pp.padStart(6)}  ${lp.padStart(6)}  ${String(s['NO-DATA']).padStart(8)}`);
}
console.log(SEP2);
console.log('');

// ── Write artifact ────────────────────────────────────────────────────────────
const today        = new Date().toISOString().slice(0, 10);
const artifactsDir = join(REPO_ROOT, 'artifacts');
await mkdir(artifactsDir, { recursive: true });
const artifactPath = join(artifactsDir, `scorecard-${today}.json`);

const artifact = {
  generated_at:   new Date().toISOString(),
  horizon_filter: horizonFilter,
  total_stamps:   total,
  verdict_totals: estateVerdicts,
  market_rolling_acos: marketRollingAcos,
  adaptations: [
    'L3.1 NEGATE WIN: spend stopped (≤5% ev.spend) AND gp_delta≥0; spend stopped + gp_delta<0 → REVIEW',
    'L3.1 BID_ADJUST CUT WIN: gp_delta>0; ACoS improvement alone = PARTIAL',
    'L3.1 BID_ADJUST RAISE WIN: gp_delta>0 + market ACoS in/below band (target±5pp); above-band: entity ACoS ≤ ceiling',
    'REPLACE/PROMOTE: gp_delta informational; execution bars unchanged',
    'Legacy stamps (no before-window for NEGATE/PROMOTE): pre_gp_grading tag, old definition applies',
  ],
  summary:  jsonSummary,
  per_rec: judged.map(r => ({
    id:             Number(r.id),
    rec_type:       r.rec_type,
    horizon:        r.horizon,
    market:         r.country_code,
    currency:       r.currency_code,
    target_text:    r.target_text,
    verdict:        r.judgment.verdict,
    gp_delta:       r.judgment.gp_delta ?? null,
    pre_gp_grading: r.judgment.pre_gp_grading ?? false,
    judgment:       r.judgment,
    captured_at:    r.captured_at,
  })),
};

await writeFile(artifactPath, JSON.stringify(artifact, null, 2));
console.log(`Artifact written → ${artifactPath}`);
console.log(SEP1);
