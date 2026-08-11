// scripts/scorecard.mjs
// Usage: node --env-file=.env.local scripts/scorecard.mjs [--horizon t7|t14|all]
//
// READ-ONLY analysis of rec_outcomes.
// Judges every PUSHED rec with stamps per the Layer 2 spec.
// Writes artifacts/scorecard-<date>.json with full per-rec judgments.
// All DB access is SELECT only.

import { parseArgs }      from 'node:util';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname }   from 'node:path';
import { fileURLToPath }   from 'node:url';

neonConfig.webSocketConstructor = WebSocket;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = join(__dirname, '..');

// ── Args ──────────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: { horizon: { type: 'string', default: 'all' } },
});
const horizonFilter = args.horizon;
if (!['t7', 't14', 'all'].includes(horizonFilter)) {
  throw new Error(`--horizon must be t7|t14|all, got: ${horizonFilter}`);
}

// ── DB ────────────────────────────────────────────────────────────────────────
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL not set');
const pool = new Pool({ connectionString: DATABASE_URL });

// ── Fetch all PUSHED recs with stamps ─────────────────────────────────────────
const hClause = horizonFilter === 'all' ? '' : `AND o.horizon = '${horizonFilter}'`;
const { rows: rawRows } = await pool.query(`
  SELECT
    r.id,
    r.rec_type,
    r.target_text,
    r.campaign_id,
    r.evidence,
    p.country_code,
    p.currency_code,
    o.horizon,
    o.metrics,
    o.captured_at
  FROM recommendations   r
  JOIN rec_outcomes      o ON o.rec_id     = r.id
  JOIN amazon_profiles   p ON p.profile_id = r.profile_id
  WHERE r.status = 'PUSHED'
  ${hClause}
  ORDER BY r.rec_type, o.horizon, p.country_code, r.id
`);
await pool.end();

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
//
// Four-state: WIN / PARTIAL / LEAK / NO-DATA
// Spec rule: rows_found === 0  →  NO-DATA (never LOSS/LEAK)

function judgeNegateTerm(ev, m) {
  // Adaptation: reference spend = ev.spend (window spend that triggered rec)
  // WIN  : stamp cost ≈ 0 (< 0.10)
  // PARTIAL: cost < 50% of ev.spend
  // LEAK : else
  if (m.rows_found === 0) return { verdict: 'NO-DATA' };
  const cost     = safeN(m.cost);
  const refSpend = safeN(ev.spend);
  const stopped  = (!isNaN(refSpend) && !isNaN(cost)) ? refSpend - cost : null;
  if (cost < 0.10) return { verdict: 'WIN', euros_stopped: stopped };
  if (!isNaN(refSpend) && refSpend > 0 && cost < refSpend * 0.50)
    return { verdict: 'PARTIAL', euros_stopped: stopped, pct_reduced: 1 - cost / refSpend };
  return { verdict: 'LEAK', euros_stopped: stopped };
}

function judgeNegateTarget(ev, m) {
  // stamp-outcomes.mjs has NO handler for NEGATE_TARGET.
  // All stamps carry only { rows_found: 0, window_days }.
  // No spend or cost data is captured → cannot grade.
  return { verdict: 'NO-DATA', note: 'stamp handler absent; metrics={rows_found:0,window_days} only' };
}

function judgeBidAdjust(ev, m) {
  // Direction: pushed_bid vs current_bid (evidence field, added in v2 push).
  // Fallback: existing_targets[0].bid for older recs.
  // Adaptation: proposed_bid == approved_bid == pushed_bid for all 227 stamps;
  //   direction cannot be read from proposed vs approved.
  const pushed     = safeN(ev.pushed_bid ?? ev.proposed_bid);
  let   current    = safeN(ev.current_bid);
  if (isNaN(current) && Array.isArray(ev.existing_targets) && ev.existing_targets.length > 0)
    current = safeN(ev.existing_targets[0].bid);

  const targetAcos = safeN(ev.params_used?.target_acos ?? 0.30);

  let direction;
  if (!isNaN(current) && !isNaN(pushed)) {
    direction = pushed < current * 0.99  ? 'CUT'
              : pushed > current * 1.01  ? 'RAISE'
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

  if (direction === 'CUT') {
    const acosBetter = afterAcos !== null && beforeAcos !== null && afterAcos < beforeAcos;
    const spendFell  = afterCost < beforeCost * 0.90;
    const ordersHeld = afterSales >= beforeSales * 0.80;
    if (acosBetter || (spendFell && ordersHeld))
      return { verdict: 'WIN',     direction, acos_delta: acosDelta };
    if (spendFell)
      return { verdict: 'PARTIAL', direction, acos_delta: acosDelta,
               note: 'spend fell but sales also fell' };
    return { verdict: 'LEAK',    direction, acos_delta: acosDelta };
  }

  if (direction === 'RAISE') {
    const clicksRose = afterClicks > beforeClks;
    const acosOk     = afterAcos === null || afterAcos <= targetAcos * 1.20;
    if (clicksRose && acosOk)  return { verdict: 'WIN',     direction, acos_delta: acosDelta };
    if (clicksRose && !acosOk) return { verdict: 'PARTIAL', direction, acos_delta: acosDelta,
                                         note: 'clicks rose but ACoS > target+20%' };
    return { verdict: 'LEAK',    direction, acos_delta: acosDelta, note: 'clicks did not rise' };
  }

  // FLAT or UNKNOWN
  return {
    verdict: 'NO-DATA', direction,
    note: direction === 'FLAT'
      ? 'pushed_bid ≈ current_bid; no directional change'
      : 'current_bid unavailable in evidence',
  };
}

function judgeReplaceProductAd(ev, m) {
  // stamp-outcomes.mjs has NO handler for REPLACE_PRODUCT_AD.
  // All 3,563 stamps carry only { rows_found: 0, window_days }.
  // Evidence carries: b0_asin, hc_isbn10/13, ad_id, campaign_id.
  // No cost/impression data for either B0 or HC ad captured.
  return {
    verdict: 'NO-DATA',
    note: 'stamp handler absent; no B0/HC ad-pair metrics captured',
    b0_asin:   ev.b0_asin,
    hc_isbn13: ev.hc_isbn13,
  };
}

function judgePromoteTerm(ev, m, horizon) {
  // Adaptation: stamp metrics lack impressions.
  //   Using clicks > 0 as serving proxy (clicks ≥ 1 implies impressions ≥ 1).
  if (m.rows_found === 0) return { verdict: 'NO-DATA' };
  const clicks    = safeN(m.clicks);
  const purchases = safeN(m.purchases_14d ?? 0);
  if (isNaN(clicks)) return { verdict: 'NO-DATA', note: 'no clicks field in metrics' };
  if (horizon === 't14' && purchases > 0)
    return { verdict: 'WIN', note: 'STRONG: orders>0 at t14', clicks, purchases };
  if (clicks > 0)
    return { verdict: 'WIN', note: 'serving at ' + horizon + ' (clicks>0; impression proxy)', clicks };
  return { verdict: 'LEAK', note: 'rows found but zero clicks — keyword dark', clicks: 0 };
}

function judgeCreativeKeyword(ev, m, horizon) {
  // Same shape as PROMOTE_TERM
  return judgePromoteTerm(ev, m, horizon);
}

function judgePromoteAsin(ev, m, horizon) {
  if (m.rows_found === 0) return { verdict: 'NO-DATA' };
  const clicks    = safeN(m.clicks);
  const purchases = safeN(m.purchases ?? m.purchases_14d ?? 0);
  if (horizon === 't14' && purchases > 0)
    return { verdict: 'WIN', note: 'STRONG: orders>0 at t14', clicks, purchases };
  if (clicks > 0) return { verdict: 'WIN', note: 'serving (clicks>0)', clicks };
  return { verdict: 'LEAK', note: 'target dark (rows found, zero clicks)', clicks: 0 };
}

function judgeCreativeTarget(ev, m, horizon) {
  // Metrics shape: { cost, sales, clicks, purchases, rows_found }
  return judgePromoteAsin(ev, m, horizon);
}

function judgePauseCampaign(ev, m) {
  if (m.rows_found === 0 && (!m.before_rows_found || m.before_rows_found === 0))
    return { verdict: 'NO-DATA' };
  const afterCost  = safeN(m.cost);
  const beforeCost = safeN(m.before_cost);
  if (afterCost < 0.10) return { verdict: 'WIN', before_cost: beforeCost, after_cost: afterCost };
  if (!isNaN(beforeCost) && beforeCost > 0 && afterCost < beforeCost * 0.50)
    return { verdict: 'PARTIAL', before_cost: beforeCost, after_cost: afterCost };
  return { verdict: 'LEAK', before_cost: beforeCost, after_cost: afterCost };
}

function judgeBudgetAdjust(ev, m) {
  // Small cohort (n=2 t7 only) — per-rec one-liner; no rate computation
  if (m.rows_found === 0) return { verdict: 'NO-DATA' };
  const spendChg = (safeN(m.before_cost) > 0)
    ? (safeN(m.cost) - safeN(m.before_cost)) / safeN(m.before_cost)
    : null;
  const salesChg = (safeN(m.before_sales_14d) > 0)
    ? (safeN(m.sales_14d) - safeN(m.before_sales_14d)) / safeN(m.before_sales_14d)
    : null;
  return {
    verdict: spendChg !== null ? (spendChg > 0 ? 'PARTIAL' : 'WIN') : 'PARTIAL',
    note: `spend_chg=${spendChg !== null ? (spendChg*100).toFixed(0)+'%' : '?'} sales_chg=${salesChg !== null ? (salesChg*100).toFixed(0)+'%' : '?'}`,
    spend_change_pct: spendChg,
    sales_change_pct: salesChg,
  };
}

function judgeCreateStructure(ev, m) {
  // Small cohort — per-rec one-liner
  if (m.rows_found === 0) return { verdict: 'NO-DATA' };
  const impr = safeN(m.impressions);
  if (impr > 0) return { verdict: 'WIN',     note: `campaign serving (impr=${impr})` };
  return       { verdict: 'PARTIAL', note: 'campaign exists but impressions=0' };
}

// ── Dispatch ──────────────────────────────────────────────────────────────────
function judge(row) {
  const ev = typeof row.evidence === 'string' ? JSON.parse(row.evidence) : row.evidence;
  const m  = typeof row.metrics  === 'string' ? JSON.parse(row.metrics)  : row.metrics;
  let j;
  switch (row.rec_type) {
    case 'NEGATE_TERM':        j = judgeNegateTerm(ev, m);                  break;
    case 'NEGATE_TARGET':      j = judgeNegateTarget(ev, m);                break;
    case 'BID_ADJUST':         j = judgeBidAdjust(ev, m);                   break;
    case 'REPLACE_PRODUCT_AD': j = judgeReplaceProductAd(ev, m);            break;
    case 'PROMOTE_TERM':       j = judgePromoteTerm(ev, m, row.horizon);    break;
    case 'CREATIVE_KEYWORD':   j = judgeCreativeKeyword(ev, m, row.horizon);break;
    case 'PROMOTE_ASIN':       j = judgePromoteAsin(ev, m, row.horizon);    break;
    case 'CREATIVE_TARGET':    j = judgeCreativeTarget(ev, m, row.horizon); break;
    case 'PAUSE_CAMPAIGN':     j = judgePauseCampaign(ev, m);               break;
    case 'BUDGET_ADJUST':      j = judgeBudgetAdjust(ev, m);                break;
    case 'CREATE_STRUCTURE':   j = judgeCreateStructure(ev, m);             break;
    default:                   j = { verdict: 'NO-DATA', note: `unhandled type: ${row.rec_type}` };
  }
  return { ...row, ev, m, judgment: j };
}

const judged = rawRows.map(judge);

// ── Aggregation helper ────────────────────────────────────────────────────────
function aggRows(rows) {
  const counts = { WIN: 0, PARTIAL: 0, LEAK: 0, 'NO-DATA': 0 };
  for (const r of rows) counts[r.judgment.verdict] = (counts[r.judgment.verdict] ?? 0) + 1;
  const n  = rows.length;
  const dn = n - (counts['NO-DATA'] ?? 0);
  return { n, dn, counts };
}

// ── Formatting ────────────────────────────────────────────────────────────────
const SEP1 = '═'.repeat(82);
const SEP2 = '─'.repeat(82);

function rateStr(counts, dn) {
  if (dn === 0) return '(all NO-DATA)';
  const parts = [];
  if (counts.WIN    > 0) parts.push(`WIN=${pct(counts.WIN, dn)}`);
  if (counts.PARTIAL > 0) parts.push(`PARTIAL=${pct(counts.PARTIAL, dn)}`);
  if (counts.LEAK    > 0) parts.push(`LEAK=${pct(counts.LEAK, dn)}`);
  const nd = counts['NO-DATA'] ?? 0;
  return parts.join('  ') + (nd > 0 ? `  NO-DATA=${nd}` : '');
}

// ── Header ────────────────────────────────────────────────────────────────────
console.log(SEP1);
console.log('  CdL Ads SCORECARD — Layer 2 Outcomes Analysis');
console.log(`  Horizon: ${horizonFilter}   Stamps loaded: ${judged.length}   Generated: ${new Date().toISOString()}`);
console.log(SEP1);

console.log(`
⚠  ADAPTATIONS (stamp reality vs spec):
  1. NEGATE_TARGET  — stamp-outcomes.mjs has no NEGATE_TARGET handler.
     All 37 stamps: {rows_found:0, window_days}.  No spend captured.
     All 37 → NO-DATA.  Cannot grade until stamp handler is added.

  2. REPLACE_PRODUCT_AD — stamp-outcomes.mjs has no handler.
     All 3,563 stamps: {rows_found:0, window_days}.
     Evidence carries b0_asin, hc_isbn10/13, ad_id, campaign_id —
     but metrics lack the B0/HC ad-pair split entirely.
     All 3,563 → NO-DATA.  Grading requires a dedicated stamp handler.

  3. PROMOTE_TERM / CREATIVE_KEYWORD — stamp metrics lack impressions.
     Using clicks>0 as serving proxy (clicks ≥ 1 ⟹ impressions ≥ 1).

  4. BID_ADJUST direction — proposed_bid == approved_bid == pushed_bid
     for all 227 stamps; cannot use proposed-vs-approved delta.
     Direction resolved from evidence.current_bid vs pushed_bid
     (fallback: existing_targets[0].bid for 56 older recs).
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

// Small-cohort types: list per-rec instead of rates
const SMALL_TYPES = new Set(['PAUSE_CAMPAIGN', 'BUDGET_ADJUST', 'PROMOTE_ASIN',
                              'CREATIVE_TARGET', 'CREATE_STRUCTURE']);

const jsonPerRec = [];
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

  for (const h of horizons) {
    const hRows = typeRows.filter(r => r.horizon === h);
    const { n, dn, counts } = aggRows(hRows);

    console.log(`\n  ${h.toUpperCase()}  (n=${n})`);

    // ── Small-cohort or n<5 ────────────────────────────────────────────────
    if (n < 5 || SMALL_TYPES.has(recType)) {
      console.log(`  ↳ n<5 or small-cohort type — insufficient for rates; per-rec listing:`);
      for (const row of hRows) {
        const j = row.judgment;
        const dir  = j.direction ? ` [${j.direction}]` : '';
        const note = j.note      ? ` | ${j.note}`      : '';
        console.log(`    rec ${String(row.id).padStart(6)} [${row.country_code}]${dir}  ${j.verdict}${note}`);
      }
      jsonSummary[recType][h] = { n, counts, perRec: true };
      continue;
    }

    // ── BID_ADJUST: split CUTs vs RAISEs ──────────────────────────────────
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

        // Median ACoS delta for graded rows
        const deltas = subset
          .filter(r => r.judgment.acos_delta != null)
          .map(r => r.judgment.acos_delta);
        if (deltas.length > 0) {
          const med = median(deltas);
          console.log(`  Median ACoS delta: ${(med * 100).toFixed(1)}pp  (n=${deltas.length}; neg=improvement)`);
        }

        // Per-market
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

      if (other.length > 0) {
        console.log(`\n  FLAT/UNKNOWN (n=${other.length}) — all NO-DATA (no directional change recorded)`);
      }

      jsonSummary[recType][h] = {
        n,
        cuts:   { n: cuts.length,   counts: aggRows(cuts).counts },
        raises: { n: raises.length, counts: aggRows(raises).counts },
        other:  { n: other.length },
      };
      continue;
    }

    // ── Standard table ─────────────────────────────────────────────────────
    console.log(`  Rates (graded n=${dn}): ${rateStr(counts, dn)}`);

    // Median effect sizes
    if (recType === 'NEGATE_TERM') {
      const stops = hRows
        .filter(r => r.judgment.euros_stopped != null && !isNaN(r.judgment.euros_stopped))
        .map(r => r.judgment.euros_stopped);
      if (stops.length > 0) {
        const med = median(stops);
        console.log(`  Median spend stopped vs ev.spend: ${med.toFixed(2)} (n=${stops.length})`);
      }
    }

    // Per-market breakdown
    console.log(`  By market:`);
    console.log(`  ${'Mkt'.padEnd(5)} ${'n'.padStart(4)}  ${'graded'.padStart(7)}  rates`);
    console.log(`  ${'─'.repeat(60)}`);
    const byMkt = {};
    for (const mkt of markets) {
      const mr = hRows.filter(r => r.country_code === mkt);
      if (mr.length === 0) continue;
      const { n: mn, dn: mdn, counts: mc } = aggRows(mr);
      console.log(`  ${mkt.padEnd(5)} ${String(mn).padStart(4)}  ${String(mdn).padStart(7)}  ${rateStr(mc, mdn)}`);
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

const estateVerdicts = { WIN: 0, PARTIAL: 0, LEAK: 0, 'NO-DATA': 0 };
const estateByType   = {};
for (const row of judged) {
  estateVerdicts[row.judgment.verdict] = (estateVerdicts[row.judgment.verdict] ?? 0) + 1;
  if (!estateByType[row.rec_type]) estateByType[row.rec_type] = { n: 0, WIN: 0, PARTIAL: 0, LEAK: 0, 'NO-DATA': 0 };
  estateByType[row.rec_type].n++;
  estateByType[row.rec_type][row.judgment.verdict]++;
}

const total     = judged.length;
const totalND   = estateVerdicts['NO-DATA'];
const totalData = total - totalND;

console.log(`\nTotal stamps:  ${total}`);
console.log(`Graded:        ${totalData}  (${pct(totalData, total)} of total)`);
console.log(`NO-DATA:       ${totalND}  (${pct(totalND, total)} — REPLACE_PRODUCT_AD + NEGATE_TARGET have no stamp handler)`);
console.log(`\nOverall (graded only):  WIN=${pct(estateVerdicts.WIN, totalData)}  PARTIAL=${pct(estateVerdicts.PARTIAL, totalData)}  LEAK=${pct(estateVerdicts.LEAK, totalData)}`);
console.log('');
console.log(`${'Type'.padEnd(22)} ${'n'.padStart(5)}  ${'graded'.padStart(7)}  ${'WIN%'.padStart(6)}  ${'PART%'.padStart(6)}  ${'LEAK%'.padStart(6)}  ${'NO-DATA'.padStart(8)}`);
console.log(SEP2);
for (const rt of TYPE_ORDER) {
  const s = estateByType[rt];
  if (!s) continue;
  const dn = s.n - s['NO-DATA'];
  const wp = pct(s.WIN,     dn);
  const pp = pct(s.PARTIAL, dn);
  const lp = pct(s.LEAK,    dn);
  console.log(`${rt.padEnd(22)} ${String(s.n).padStart(5)}  ${String(dn).padStart(7)}  ${wp.padStart(6)}  ${pp.padStart(6)}  ${lp.padStart(6)}  ${String(s['NO-DATA']).padStart(8)}`);
}
console.log(SEP2);
console.log('');

// ── Write JSON artifact ───────────────────────────────────────────────────────
const today        = new Date().toISOString().slice(0, 10);
const artifactsDir = join(REPO_ROOT, 'artifacts');
await mkdir(artifactsDir, { recursive: true });
const artifactPath = join(artifactsDir, `scorecard-${today}.json`);

const artifact = {
  generated_at:    new Date().toISOString(),
  horizon_filter:  horizonFilter,
  total_stamps:    total,
  verdict_totals:  estateVerdicts,
  adaptations: [
    'NEGATE_TARGET: stamp handler absent; all 37 stamps → NO-DATA',
    'REPLACE_PRODUCT_AD: stamp handler absent; all 3563 stamps → NO-DATA',
    'PROMOTE_TERM/CREATIVE_KEYWORD: impressions absent; clicks>0 as serving proxy',
    'BID_ADJUST direction: resolved from evidence.current_bid vs pushed_bid (fallback: existing_targets[0].bid)',
  ],
  summary:  jsonSummary,
  per_rec:  judged.map(r => ({
    id:          Number(r.id),
    rec_type:    r.rec_type,
    horizon:     r.horizon,
    market:      r.country_code,
    currency:    r.currency_code,
    target_text: r.target_text,
    verdict:     r.judgment.verdict,
    judgment:    r.judgment,
    captured_at: r.captured_at,
  })),
};

await writeFile(artifactPath, JSON.stringify(artifact, null, 2));
console.log(`Artifact written → ${artifactPath}`);
console.log(SEP1);
