// scripts/stamp-outcomes.mjs
// Usage: node --env-file=.env.local scripts/stamp-outcomes.mjs --profile <id>
//
// For each PUSHED rec (with evidence->>'pushed_at' set) belonging to the
// given profile, computes which t7/t14/t30 horizons are due and not yet
// stamped in rec_outcomes, captures metrics from our own reporting tables
// for the window [pushed_at, pushed_at + horizon_days), and inserts one
// rec_outcomes row per due horizon.  Missing underlying data → still inserts
// with rows_found: 0 (honest null, not a skip).
// Prints per-rec: id, type, horizons stamped.
// DO NOT run this script during write+commit bites; call only when grading.

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

// ── 1. Fetch PUSHED recs with a resolvable pushed_at ───────────────────────
// Column is authoritative (set by push scripts and backdate); evidence legacy fallback.
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
  for (const row of existing) {
    stampedSet.add(`${row.rec_id}:${row.horizon}`);
  }
}

const now = Date.now();

// ── 3. Stamp due horizons ────────────────────────────────────────────────────
let recsWithDue  = 0;
let stampsWritten = 0;

for (const rec of recs) {
  const ev        = typeof rec.evidence === 'string' ? JSON.parse(rec.evidence) : rec.evidence;
  // Column authoritative; evidence.pushed_at is legacy fallback.
  const pushedAt  = new Date(rec.pushed_at_resolved ?? ev.pushed_at);
  const pushedMs  = pushedAt.getTime();

  const dueHorizons = HORIZONS.filter(h => {
    const dueMs = pushedMs + h.days * MS_PER_DAY;
    return dueMs <= now && !stampedSet.has(`${rec.id}:${h.key}`);
  });

  if (dueHorizons.length === 0) continue;

  recsWithDue++;
  const stamped = [];

  for (const horizon of dueHorizons) {
    // Window: [pushed_at_date, pushed_at_date + horizon_days)
    const windowStart = pushedAt.toISOString().slice(0, 10);
    const windowEnd   = new Date(pushedMs + horizon.days * MS_PER_DAY).toISOString().slice(0, 10);

    let metrics = { window_days: horizon.days, rows_found: 0 };

    try {
      // ── NEGATE_TERM ────────────────────────────────────────────────────────
      if (rec.rec_type === 'NEGATE_TERM') {
        const { rows } = await pool.query(
          `SELECT
             COALESCE(SUM(clicks), 0)::bigint AS clicks,
             COALESCE(SUM(cost),   0)         AS cost,
             COUNT(*)::int                    AS rows_found
           FROM amazon_search_term_daily
          WHERE profile_id  = $1
            AND search_term = $2
            AND date >= $3::date
            AND date <  $4::date`,
          [profileIdStr, rec.target_text, windowStart, windowEnd],
        );
        const r = rows[0];
        metrics = {
          ...metrics,
          clicks:     Number(r.clicks),
          cost:       Number(r.cost),
          rows_found: Number(r.rows_found),
        };

      // ── NEGATE_TARGET ──────────────────────────────────────────────────────
      // target_text = negated ASIN (ISBN10 used as Amazon ASIN in product targeting)
      // Metrics: that ASIN's spend/clicks as a search-term hit post-negation.
      // Table: amazon_search_term_daily, search_term column, scoped to profile + window.
      } else if (rec.rec_type === 'NEGATE_TARGET') {
        const targetAsin = (rec.target_text || '').toLowerCase();
        const { rows: ntRows } = await pool.query(
          `SELECT
             COALESCE(SUM(clicks), 0)::bigint AS clicks,
             COALESCE(SUM(cost),   0)         AS cost,
             COUNT(*)::int                    AS rows_found
           FROM amazon_search_term_daily
          WHERE profile_id          = $1
            AND LOWER(search_term)  = $2
            AND date >= $3::date
            AND date <  $4::date`,
          [profileIdStr, targetAsin, windowStart, windowEnd],
        );
        const ntr = ntRows[0];
        metrics = {
          ...metrics,
          clicks:     Number(ntr.clicks),
          cost:       Number(ntr.cost),
          rows_found: Number(ntr.rows_found),
        };

      // ── PROMOTE_TERM / CREATIVE_KEYWORD ────────────────────────────────────
      } else if (rec.rec_type === 'PROMOTE_TERM' || rec.rec_type === 'CREATIVE_KEYWORD') {
        const { rows } = await pool.query(
          `SELECT
             COALESCE(SUM(clicks),        0)::bigint AS clicks,
             COALESCE(SUM(cost),          0)         AS cost,
             COALESCE(SUM(purchases_14d), 0)::bigint AS purchases_14d,
             COALESCE(SUM(sales_14d),     0)         AS sales_14d,
             COUNT(*)::int                           AS rows_found
           FROM amazon_search_term_daily
          WHERE profile_id  = $1
            AND search_term = $2
            AND date >= $3::date
            AND date <  $4::date`,
          [profileIdStr, rec.target_text, windowStart, windowEnd],
        );
        const r = rows[0];
        metrics = {
          ...metrics,
          clicks:        Number(r.clicks),
          cost:          Number(r.cost),
          purchases_14d: Number(r.purchases_14d),
          sales_14d:     Number(r.sales_14d),
          rows_found:    Number(r.rows_found),
        };

      // ── PROMOTE_ASIN / CREATIVE_TARGET ─────────────────────────────────────
      } else if (rec.rec_type === 'PROMOTE_ASIN' || rec.rec_type === 'CREATIVE_TARGET') {
        const asin = rec.target_text.toLowerCase();
        const { rows } = await pool.query(
          `SELECT
             COALESCE(SUM(clicks),        0)::bigint AS clicks,
             COALESCE(SUM(cost),          0)         AS cost,
             COALESCE(SUM(purchases_14d), 0)::bigint AS purchases,
             COALESCE(SUM(sales_14d),     0)         AS sales,
             COUNT(*)::int                           AS rows_found
           FROM amazon_search_term_daily
          WHERE profile_id          = $1
            AND LOWER(search_term)  = $2
            AND date >= $3::date
            AND date <  $4::date`,
          [profileIdStr, asin, windowStart, windowEnd],
        );
        const r = rows[0];
        metrics = {
          ...metrics,
          clicks:     Number(r.clicks),
          cost:       Number(r.cost),
          purchases:  Number(r.purchases),
          sales:      Number(r.sales),
          rows_found: Number(r.rows_found),
        };

      // ── REPLACE_PRODUCT_AD ─────────────────────────────────────────────────
      // evidence: b0_asin (B0 being replaced), hc_isbn10 (HC ASIN = isbn10 used
      // by Amazon as ASIN for HC/paperback editions), campaign_id.
      // Table: amazon_advertised_product_daily — has campaign_id column ✓,
      //   impressions ✓, profile_id = text.
      // Grain: asin + campaign_id scoped (approximate if ASIN rides other
      //   campaigns; those are excluded). Recorded as grain:'asin+campaign_id'.
      } else if (rec.rec_type === 'REPLACE_PRODUCT_AD') {
        const b0Asin = (ev.b0_asin   || '').toLowerCase();
        const hcAsin = (ev.hc_isbn10 || '').toLowerCase();  // isbn10 = HC ASIN in Amazon
        const campId = String(ev.campaign_id ?? rec.campaign_id ?? '');

        // B0 metrics: the paused ad
        const { rows: b0Rows } = await pool.query(
          `SELECT
             COALESCE(SUM(cost),        0)         AS b0_spend,
             COALESCE(SUM(clicks),      0)::bigint AS b0_clicks,
             COALESCE(SUM(impressions), 0)::bigint AS b0_impressions,
             COUNT(*)::int                         AS b0_rows_found
           FROM amazon_advertised_product_daily
          WHERE profile_id  = $1
            AND LOWER(asin) = $2
            AND campaign_id = $3
            AND date >= $4::date
            AND date <  $5::date`,
          [profileIdStr, b0Asin, campId, windowStart, windowEnd],
        );

        // HC metrics: the replacement ad
        const { rows: hcRows } = await pool.query(
          `SELECT
             COALESCE(SUM(cost),          0)         AS hc_spend,
             COALESCE(SUM(clicks),        0)::bigint AS hc_clicks,
             COALESCE(SUM(impressions),   0)::bigint AS hc_impressions,
             COALESCE(SUM(purchases_14d), 0)::bigint AS hc_orders,
             COUNT(*)::int                           AS hc_rows_found
           FROM amazon_advertised_product_daily
          WHERE profile_id  = $1
            AND LOWER(asin) = $2
            AND campaign_id = $3
            AND date >= $4::date
            AND date <  $5::date`,
          [profileIdStr, hcAsin, campId, windowStart, windowEnd],
        );

        const b0 = b0Rows[0];
        const hc = hcRows[0];
        metrics = {
          ...metrics,
          grain:          'asin+campaign_id',
          b0_asin:        ev.b0_asin,
          hc_asin:        ev.hc_isbn10,
          b0_spend:       Number(b0.b0_spend),
          b0_clicks:      Number(b0.b0_clicks),
          b0_impressions: Number(b0.b0_impressions),
          hc_spend:       Number(hc.hc_spend),
          hc_clicks:      Number(hc.hc_clicks),
          hc_impressions: Number(hc.hc_impressions),
          hc_orders:      Number(hc.hc_orders),
          rows_found:     Number(b0.b0_rows_found) + Number(hc.hc_rows_found),
          b0_rows_found:  Number(b0.b0_rows_found),
          hc_rows_found:  Number(hc.hc_rows_found),
        };

      // ── BID_ADJUST (incl. REVIVE) / BUDGET_ADJUST / PAUSE_CAMPAIGN / CREATE_STRUCTURE
      } else if (
        rec.rec_type === 'BID_ADJUST'       ||
        rec.rec_type === 'BUDGET_ADJUST'    ||
        rec.rec_type === 'PAUSE_CAMPAIGN'   ||
        rec.rec_type === 'CREATE_STRUCTURE'
      ) {
        // campaign_id: evidence.campaign_id → rec.campaign_id → rec.target_text
        const campId = String(ev.campaign_id ?? rec.campaign_id ?? rec.target_text);

        // Current window [pushed_at, pushed_at + horizon_days)
        const { rows: curr } = await pool.query(
          `SELECT
             COALESCE(SUM(cost),        0)         AS cost,
             COALESCE(SUM(sales_14d),   0)         AS sales_14d,
             COALESCE(SUM(clicks),      0)::bigint AS clicks,
             COALESCE(SUM(impressions), 0)::bigint AS impressions,
             COUNT(*)::int                         AS rows_found
           FROM amazon_campaign_daily
          WHERE profile_id  = $1
            AND campaign_id = $2
            AND date >= $3::date
            AND date <  $4::date`,
          [profileIdStr, campId, windowStart, windowEnd],
        );

        // Before window: equal-length immediately before pushed_at
        const beforeEnd   = windowStart;  // exclusive upper bound = pushed_at date
        const beforeStart = new Date(pushedMs - horizon.days * MS_PER_DAY).toISOString().slice(0, 10);
        const { rows: before } = await pool.query(
          `SELECT
             COALESCE(SUM(cost),        0)         AS before_cost,
             COALESCE(SUM(sales_14d),   0)         AS before_sales_14d,
             COALESCE(SUM(clicks),      0)::bigint AS before_clicks,
             COALESCE(SUM(impressions), 0)::bigint AS before_impressions,
             COUNT(*)::int                         AS before_rows_found
           FROM amazon_campaign_daily
          WHERE profile_id  = $1
            AND campaign_id = $2
            AND date >= $3::date
            AND date <  $4::date`,
          [profileIdStr, campId, beforeStart, beforeEnd],
        );

        const c = curr[0];
        const b = before[0];
        metrics = {
          ...metrics,
          cost:               Number(c.cost),
          sales_14d:          Number(c.sales_14d),
          clicks:             Number(c.clicks),
          impressions:        Number(c.impressions),
          rows_found:         Number(c.rows_found),
          before_cost:        Number(b.before_cost),
          before_sales_14d:   Number(b.before_sales_14d),
          before_clicks:      Number(b.before_clicks),
          before_impressions: Number(b.before_impressions),
          before_rows_found:  Number(b.before_rows_found),
        };
      }
    } catch (err) {
      // Honest null: still insert, record the error, rows_found stays 0
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
