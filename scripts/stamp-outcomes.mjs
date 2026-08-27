// scripts/stamp-outcomes.mjs
// Usage: node --env-file=.env.local scripts/stamp-outcomes.mjs --profile <id>
//
// Layer 3.2: gp_per_order basis. gp_basis ('unit'|'revenue') + gp_per_order
// stamped into every outcome. Unit basis: purchases_14d × gp_per_order − spend.
// Revenue basis (NULL gp_per_order): sales_14d − spend, unchanged.
//
// Per-handler additions vs Layer 3.1:
//
//  NEGATE_TERM        : + purchases_14d (after); + before_purchases_14d;
//                         + gp_basis, gp_per_order
//  NEGATE_TARGET      : same
//  PROMOTE_TERM/CK    : + gp_basis, gp_per_order (purchases already present)
//  PROMOTE_ASIN/CT    : + gp_basis, gp_per_order (purchases already present)
//  REPLACE_PRODUCT_AD : + b0_orders (after); + before_b0_orders,
//                         before_hc_orders; + gp_basis, gp_per_order
//  BID_ADJUST family  : + purchases_14d (after); + before_purchases_14d;
//                         + gp_basis, gp_per_order
//
// rows_found honest as ever: 0 → still insert, never fake before-window.
// DO NOT run during write+commit bites; call only when grading.

import { parseArgs } from 'node:util';
import { Pool, neonConfig } from '@neondatabase/serverless';

neonConfig.webSocketConstructor = WebSocket;

// ── Args ─────────────────────────────────────────────────────────────────────
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { profile: { type: 'string' } },
});
if (!values.profile) throw new Error('--profile <id> required');
const profileId    = BigInt(values.profile);
const profileIdStr = String(profileId);

// ── DB ───────────────────────────────────────────────────────────────────────
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
const pool = new Pool({ connectionString: DATABASE_URL });

// ── Horizon definitions ──────────────────────────────────────────────────────
const HORIZONS = [
  { key: 't7',  days: 7  },
  { key: 't14', days: 14 },
  { key: 't30', days: 30 },
];
const MS_PER_DAY = 86_400_000;

// ── Fetch gp_per_order for this profile (once per run) ───────────────────────
const { rows: profRows } = await pool.query(
  `SELECT gp_per_order::float AS gp_per_order FROM amazon_profiles WHERE profile_id = $1`,
  [profileIdStr],
);
const gpPerOrder = (profRows[0]?.gp_per_order != null) ? Number(profRows[0].gp_per_order) : null;
const gpBasis    = gpPerOrder != null ? 'unit' : 'revenue';
console.log(`profile ${profileId}: gp_basis=${gpBasis}${gpPerOrder != null ? ` (gp_per_order=${gpPerOrder})` : ''}`);

// ── 1. Fetch PUSHED recs with a resolvable pushed_at ───────────────────────
const { rows: recs } = await pool.query(
  `SELECT id, rec_type, profile_id, campaign_id, target_text, evidence,
          COALESCE(pushed_at, (evidence->>'pushed_at')::timestamptz) AS pushed_at_resolved
     FROM recommendations
    WHERE status     = 'PUSHED'
      AND profile_id = $1
      AND COALESCE(pushed_at, (evidence->>'pushed_at')::timestamptz) IS NOT NULL`,
  [profileIdStr],
);

// ── 2. Fetch already-stamped horizons ───────────────────────────────────────
const recIds = recs.map(r => r.id);
const stampedSet = new Set();
if (recIds.length > 0) {
  const { rows: existing } = await pool.query(
    `SELECT rec_id::text, horizon FROM rec_outcomes WHERE rec_id = ANY($1::bigint[])`,
    [recIds],
  );
  for (const row of existing) stampedSet.add(`${row.rec_id}:${row.horizon}`);
}

const now = Date.now();
let recsWithDue  = 0;
let stampsWritten = 0;

// ── 3. Stamp due horizons ────────────────────────────────────────────────────
for (const rec of recs) {
  const ev       = typeof rec.evidence === 'string' ? JSON.parse(rec.evidence) : rec.evidence;
  const pushedAt = new Date(rec.pushed_at_resolved ?? ev.pushed_at);
  const pushedMs = pushedAt.getTime();

  const dueHorizons = HORIZONS.filter(h => {
    const dueMs = pushedMs + h.days * MS_PER_DAY;
    return dueMs <= now && !stampedSet.has(`${rec.id}:${h.key}`);
  });
  if (dueHorizons.length === 0) continue;

  recsWithDue++;
  const stamped = [];

  for (const horizon of dueHorizons) {
    // After-window: [pushed_at_date, pushed_at_date + horizon_days)
    const windowStart = pushedAt.toISOString().slice(0, 10);
    const windowEnd   = new Date(pushedMs + horizon.days * MS_PER_DAY).toISOString().slice(0, 10);
    // Before-window (equal-length, immediately preceding pushed_at)
    const beforeEnd   = windowStart;
    const beforeStart = new Date(pushedMs - horizon.days * MS_PER_DAY).toISOString().slice(0, 10);

    let metrics = { window_days: horizon.days, rows_found: 0 };

    try {
      // ── NEGATE_TERM ──────────────────────────────────────────────────────
      // Layer 3.1: sales_14d (after); before-window (cost, sales_14d,
      //   clicks, rows_found).
      // Layer 3.2: + purchases_14d (after); + before_purchases_14d;
      //             + gp_basis, gp_per_order
      if (rec.rec_type === 'NEGATE_TERM') {
        const { rows } = await pool.query(
          `SELECT COALESCE(SUM(clicks),        0)::bigint AS clicks,
                  COALESCE(SUM(cost),          0)         AS cost,
                  COALESCE(SUM(purchases_14d), 0)::bigint AS purchases_14d,
                  COALESCE(SUM(sales_14d),     0)         AS sales_14d,
                  COUNT(*)::int                           AS rows_found
             FROM amazon_search_term_daily
            WHERE profile_id  = $1 AND search_term = $2
              AND date >= $3::date AND date < $4::date`,
          [profileIdStr, rec.target_text, windowStart, windowEnd],
        );
        const { rows: bRows } = await pool.query(
          `SELECT COALESCE(SUM(clicks),        0)::bigint AS before_clicks,
                  COALESCE(SUM(cost),          0)         AS before_cost,
                  COALESCE(SUM(purchases_14d), 0)::bigint AS before_purchases_14d,
                  COALESCE(SUM(sales_14d),     0)         AS before_sales_14d,
                  COUNT(*)::int                           AS before_rows_found
             FROM amazon_search_term_daily
            WHERE profile_id  = $1 AND search_term = $2
              AND date >= $3::date AND date < $4::date`,
          [profileIdStr, rec.target_text, beforeStart, beforeEnd],
        );
        const r = rows[0]; const b = bRows[0];
        metrics = {
          ...metrics,
          clicks:               Number(r.clicks),
          cost:                 Number(r.cost),
          purchases_14d:        Number(r.purchases_14d),
          sales_14d:            Number(r.sales_14d),
          rows_found:           Number(r.rows_found),
          before_clicks:        Number(b.before_clicks),
          before_cost:          Number(b.before_cost),
          before_purchases_14d: Number(b.before_purchases_14d),
          before_sales_14d:     Number(b.before_sales_14d),
          before_rows_found:    Number(b.before_rows_found),
          gp_basis: gpBasis,
          gp_per_order:         gpPerOrder,
        };

      // ── NEGATE_TARGET ────────────────────────────────────────────────────
      // Layer 3.1: sales_14d (after); before-window (cost, sales_14d,
      //   clicks, rows_found).
      // Layer 3.2: + purchases_14d (after); + before_purchases_14d;
      //             + gp_basis, gp_per_order
      } else if (rec.rec_type === 'NEGATE_TARGET') {
        const targetAsin = (rec.target_text || '').toLowerCase();
        const { rows: ntRows } = await pool.query(
          `SELECT COALESCE(SUM(clicks),        0)::bigint AS clicks,
                  COALESCE(SUM(cost),          0)         AS cost,
                  COALESCE(SUM(purchases_14d), 0)::bigint AS purchases_14d,
                  COALESCE(SUM(sales_14d),     0)         AS sales_14d,
                  COUNT(*)::int                           AS rows_found
             FROM amazon_search_term_daily
            WHERE profile_id = $1 AND LOWER(search_term) = $2
              AND date >= $3::date AND date < $4::date`,
          [profileIdStr, targetAsin, windowStart, windowEnd],
        );
        const { rows: nbRows } = await pool.query(
          `SELECT COALESCE(SUM(clicks),        0)::bigint AS before_clicks,
                  COALESCE(SUM(cost),          0)         AS before_cost,
                  COALESCE(SUM(purchases_14d), 0)::bigint AS before_purchases_14d,
                  COALESCE(SUM(sales_14d),     0)         AS before_sales_14d,
                  COUNT(*)::int                           AS before_rows_found
             FROM amazon_search_term_daily
            WHERE profile_id = $1 AND LOWER(search_term) = $2
              AND date >= $3::date AND date < $4::date`,
          [profileIdStr, targetAsin, beforeStart, beforeEnd],
        );
        const ntr = ntRows[0]; const nb = nbRows[0];
        metrics = {
          ...metrics,
          clicks:               Number(ntr.clicks),
          cost:                 Number(ntr.cost),
          purchases_14d:        Number(ntr.purchases_14d),
          sales_14d:            Number(ntr.sales_14d),
          rows_found:           Number(ntr.rows_found),
          before_clicks:        Number(nb.before_clicks),
          before_cost:          Number(nb.before_cost),
          before_purchases_14d: Number(nb.before_purchases_14d),
          before_sales_14d:     Number(nb.before_sales_14d),
          before_rows_found:    Number(nb.before_rows_found),
          gp_basis: gpBasis,
          gp_per_order:         gpPerOrder,
        };

      // ── PROMOTE_TERM / CREATIVE_KEYWORD ──────────────────────────────────
      // Layer 3.1: before-window (cost, sales_14d, clicks,
      //   purchases_14d, rows_found).
      // Layer 3.2: + gp_basis, gp_per_order (purchases already present)
      } else if (rec.rec_type === 'PROMOTE_TERM' || rec.rec_type === 'CREATIVE_KEYWORD') {
        const { rows } = await pool.query(
          `SELECT COALESCE(SUM(clicks),        0)::bigint AS clicks,
                  COALESCE(SUM(cost),          0)         AS cost,
                  COALESCE(SUM(purchases_14d), 0)::bigint AS purchases_14d,
                  COALESCE(SUM(sales_14d),     0)         AS sales_14d,
                  COUNT(*)::int                           AS rows_found
             FROM amazon_search_term_daily
            WHERE profile_id  = $1 AND search_term = $2
              AND date >= $3::date AND date < $4::date`,
          [profileIdStr, rec.target_text, windowStart, windowEnd],
        );
        const { rows: bRows } = await pool.query(
          `SELECT COALESCE(SUM(clicks),        0)::bigint AS before_clicks,
                  COALESCE(SUM(cost),          0)         AS before_cost,
                  COALESCE(SUM(purchases_14d), 0)::bigint AS before_purchases_14d,
                  COALESCE(SUM(sales_14d),     0)         AS before_sales_14d,
                  COUNT(*)::int                           AS before_rows_found
             FROM amazon_search_term_daily
            WHERE profile_id  = $1 AND search_term = $2
              AND date >= $3::date AND date < $4::date`,
          [profileIdStr, rec.target_text, beforeStart, beforeEnd],
        );
        const r = rows[0]; const b = bRows[0];
        metrics = {
          ...metrics,
          clicks:               Number(r.clicks),
          cost:                 Number(r.cost),
          purchases_14d:        Number(r.purchases_14d),
          sales_14d:            Number(r.sales_14d),
          rows_found:           Number(r.rows_found),
          before_clicks:        Number(b.before_clicks),
          before_cost:          Number(b.before_cost),
          before_purchases_14d: Number(b.before_purchases_14d),
          before_sales_14d:     Number(b.before_sales_14d),
          before_rows_found:    Number(b.before_rows_found),
          gp_basis: gpBasis,
          gp_per_order:         gpPerOrder,
        };

      // ── PROMOTE_ASIN / CREATIVE_TARGET ───────────────────────────────────
      // Layer 3.1: before-window (cost, sales (sales_14d), clicks,
      //   purchases, rows_found).
      // Layer 3.2: + gp_basis, gp_per_order (purchases already present)
      } else if (rec.rec_type === 'PROMOTE_ASIN' || rec.rec_type === 'CREATIVE_TARGET') {
        const asin = rec.target_text.toLowerCase();
        const { rows } = await pool.query(
          `SELECT COALESCE(SUM(clicks),        0)::bigint AS clicks,
                  COALESCE(SUM(cost),          0)         AS cost,
                  COALESCE(SUM(purchases_14d), 0)::bigint AS purchases,
                  COALESCE(SUM(sales_14d),     0)         AS sales,
                  COUNT(*)::int                           AS rows_found
             FROM amazon_search_term_daily
            WHERE profile_id = $1 AND LOWER(search_term) = $2
              AND date >= $3::date AND date < $4::date`,
          [profileIdStr, asin, windowStart, windowEnd],
        );
        const { rows: bRows } = await pool.query(
          `SELECT COALESCE(SUM(clicks),        0)::bigint AS before_clicks,
                  COALESCE(SUM(cost),          0)         AS before_cost,
                  COALESCE(SUM(purchases_14d), 0)::bigint AS before_purchases,
                  COALESCE(SUM(sales_14d),     0)         AS before_sales,
                  COUNT(*)::int                           AS before_rows_found
             FROM amazon_search_term_daily
            WHERE profile_id = $1 AND LOWER(search_term) = $2
              AND date >= $3::date AND date < $4::date`,
          [profileIdStr, asin, beforeStart, beforeEnd],
        );
        const r = rows[0]; const b = bRows[0];
        metrics = {
          ...metrics,
          clicks:            Number(r.clicks),
          cost:              Number(r.cost),
          purchases:         Number(r.purchases),
          sales:             Number(r.sales),
          rows_found:        Number(r.rows_found),
          before_clicks:     Number(b.before_clicks),
          before_cost:       Number(b.before_cost),
          before_purchases:  Number(b.before_purchases),
          before_sales:      Number(b.before_sales),
          before_rows_found: Number(b.before_rows_found),
          gp_basis: gpBasis,
          gp_per_order:      gpPerOrder,
        };

      // ── REPLACE_PRODUCT_AD ───────────────────────────────────────────────
      // Layer 3.1: b0_sales, hc_sales (after-window); before-window for
      //   both B0 and HC.
      // Layer 3.2: + b0_orders (after); + before_b0_orders, before_hc_orders;
      //             + gp_basis, gp_per_order
      } else if (rec.rec_type === 'REPLACE_PRODUCT_AD') {
        const b0Asin = (ev.b0_asin   || '').toLowerCase();
        const hcAsin = (ev.hc_isbn10 || '').toLowerCase();
        const campId = String(ev.campaign_id ?? rec.campaign_id ?? '');

        // B0 after
        const { rows: b0Rows } = await pool.query(
          `SELECT COALESCE(SUM(cost),          0)         AS b0_spend,
                  COALESCE(SUM(clicks),        0)::bigint AS b0_clicks,
                  COALESCE(SUM(impressions),   0)::bigint AS b0_impressions,
                  COALESCE(SUM(purchases_14d), 0)::bigint AS b0_orders,
                  COALESCE(SUM(sales_14d),     0)         AS b0_sales,
                  COUNT(*)::int                           AS b0_rows_found
             FROM amazon_advertised_product_daily
            WHERE profile_id = $1 AND LOWER(asin) = $2 AND campaign_id = $3
              AND date >= $4::date AND date < $5::date`,
          [profileIdStr, b0Asin, campId, windowStart, windowEnd],
        );
        // HC after
        const { rows: hcRows } = await pool.query(
          `SELECT COALESCE(SUM(cost),          0)         AS hc_spend,
                  COALESCE(SUM(clicks),        0)::bigint AS hc_clicks,
                  COALESCE(SUM(impressions),   0)::bigint AS hc_impressions,
                  COALESCE(SUM(purchases_14d), 0)::bigint AS hc_orders,
                  COALESCE(SUM(sales_14d),     0)         AS hc_sales,
                  COUNT(*)::int                           AS hc_rows_found
             FROM amazon_advertised_product_daily
            WHERE profile_id = $1 AND LOWER(asin) = $2 AND campaign_id = $3
              AND date >= $4::date AND date < $5::date`,
          [profileIdStr, hcAsin, campId, windowStart, windowEnd],
        );
        // B0 before
        const { rows: b0bRows } = await pool.query(
          `SELECT COALESCE(SUM(cost),          0)         AS before_b0_spend,
                  COALESCE(SUM(purchases_14d), 0)::bigint AS before_b0_orders,
                  COALESCE(SUM(sales_14d),     0)         AS before_b0_sales,
                  COUNT(*)::int                           AS before_b0_rows_found
             FROM amazon_advertised_product_daily
            WHERE profile_id = $1 AND LOWER(asin) = $2 AND campaign_id = $3
              AND date >= $4::date AND date < $5::date`,
          [profileIdStr, b0Asin, campId, beforeStart, beforeEnd],
        );
        // HC before
        const { rows: hcbRows } = await pool.query(
          `SELECT COALESCE(SUM(cost),          0)         AS before_hc_spend,
                  COALESCE(SUM(purchases_14d), 0)::bigint AS before_hc_orders,
                  COALESCE(SUM(sales_14d),     0)         AS before_hc_sales,
                  COUNT(*)::int                           AS before_hc_rows_found
             FROM amazon_advertised_product_daily
            WHERE profile_id = $1 AND LOWER(asin) = $2 AND campaign_id = $3
              AND date >= $4::date AND date < $5::date`,
          [profileIdStr, hcAsin, campId, beforeStart, beforeEnd],
        );

        const b0 = b0Rows[0]; const hc = hcRows[0];
        const b0b = b0bRows[0]; const hcb = hcbRows[0];
        metrics = {
          ...metrics,
          grain:                'asin+campaign_id',
          b0_asin:              ev.b0_asin,
          hc_asin:              ev.hc_isbn10,
          b0_spend:             Number(b0.b0_spend),
          b0_clicks:            Number(b0.b0_clicks),
          b0_impressions:       Number(b0.b0_impressions),
          b0_orders:            Number(b0.b0_orders),
          b0_sales:             Number(b0.b0_sales),
          hc_spend:             Number(hc.hc_spend),
          hc_clicks:            Number(hc.hc_clicks),
          hc_impressions:       Number(hc.hc_impressions),
          hc_orders:            Number(hc.hc_orders),
          hc_sales:             Number(hc.hc_sales),
          before_b0_spend:      Number(b0b.before_b0_spend),
          before_b0_orders:     Number(b0b.before_b0_orders),
          before_b0_sales:      Number(b0b.before_b0_sales),
          before_b0_rows_found: Number(b0b.before_b0_rows_found),
          before_hc_spend:      Number(hcb.before_hc_spend),
          before_hc_orders:     Number(hcb.before_hc_orders),
          before_hc_sales:      Number(hcb.before_hc_sales),
          before_hc_rows_found: Number(hcb.before_hc_rows_found),
          rows_found:           Number(b0.b0_rows_found) + Number(hc.hc_rows_found),
          b0_rows_found:        Number(b0.b0_rows_found),
          hc_rows_found:        Number(hc.hc_rows_found),
          gp_basis: gpBasis,
          gp_per_order:         gpPerOrder,
        };

      // ── BID_ADJUST (incl. REVIVE) / BUDGET_ADJUST / PAUSE_CAMPAIGN / CREATE_STRUCTURE
      // Layer 3.1: before/after cost + sales already present.
      // Layer 3.2: + purchases_14d (after); + before_purchases_14d;
      //             + gp_basis, gp_per_order
      } else if (
        rec.rec_type === 'BID_ADJUST'       ||
        rec.rec_type === 'BUDGET_ADJUST'    ||
        rec.rec_type === 'PAUSE_CAMPAIGN'   ||
        rec.rec_type === 'CREATE_STRUCTURE'
      ) {
        const campId = String(ev.campaign_id ?? rec.campaign_id ?? rec.target_text);
        const { rows: curr } = await pool.query(
          `SELECT COALESCE(SUM(cost),          0)         AS cost,
                  COALESCE(SUM(purchases_14d), 0)::bigint AS purchases_14d,
                  COALESCE(SUM(sales_14d),     0)         AS sales_14d,
                  COALESCE(SUM(clicks),        0)::bigint AS clicks,
                  COALESCE(SUM(impressions),   0)::bigint AS impressions,
                  COUNT(*)::int                           AS rows_found
             FROM amazon_campaign_daily
            WHERE profile_id = $1 AND campaign_id = $2
              AND date >= $3::date AND date < $4::date`,
          [profileIdStr, campId, windowStart, windowEnd],
        );
        const { rows: before } = await pool.query(
          `SELECT COALESCE(SUM(cost),          0)         AS before_cost,
                  COALESCE(SUM(purchases_14d), 0)::bigint AS before_purchases_14d,
                  COALESCE(SUM(sales_14d),     0)         AS before_sales_14d,
                  COALESCE(SUM(clicks),        0)::bigint AS before_clicks,
                  COALESCE(SUM(impressions),   0)::bigint AS before_impressions,
                  COUNT(*)::int                           AS before_rows_found
             FROM amazon_campaign_daily
            WHERE profile_id = $1 AND campaign_id = $2
              AND date >= $3::date AND date < $4::date`,
          [profileIdStr, campId, beforeStart, beforeEnd],
        );
        const c = curr[0]; const b = before[0];
        metrics = {
          ...metrics,
          cost:                 Number(c.cost),
          purchases_14d:        Number(c.purchases_14d),
          sales_14d:            Number(c.sales_14d),
          clicks:               Number(c.clicks),
          impressions:          Number(c.impressions),
          rows_found:           Number(c.rows_found),
          before_cost:          Number(b.before_cost),
          before_purchases_14d: Number(b.before_purchases_14d),
          before_sales_14d:     Number(b.before_sales_14d),
          before_clicks:        Number(b.before_clicks),
          before_impressions:   Number(b.before_impressions),
          before_rows_found:    Number(b.before_rows_found),
          gp_basis: gpBasis,
          gp_per_order:         gpPerOrder,
        };
      }
    } catch (err) {
      metrics = { ...metrics, rows_found: 0, capture_error: err.message };
    }

    await pool.query(
      `INSERT INTO rec_outcomes (rec_id, horizon, metrics)
       VALUES ($1, $2, $3)
       ON CONFLICT (rec_id, horizon) DO NOTHING`,
      [rec.id, horizon.key, JSON.stringify(metrics)],
    );
    stamped.push(horizon.key);
    stampsWritten++;
  }

  if (stamped.length > 0) {
    console.log(`rec ${rec.id} [${rec.rec_type}] → stamped ${stamped.join(', ')}`);
  }
}

await pool.end();
console.log(`profile ${profileId}: ${recsWithDue} rec(s) with due horizons, ${stampsWritten} stamp(s) written`);
