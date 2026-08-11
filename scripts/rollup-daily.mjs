import { parseArgs } from 'node:util';
import { Pool, neonConfig } from '@neondatabase/serverless';

// Node 22+ native WebSocket
neonConfig.webSocketConstructor = WebSocket;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    days: { type: 'string' },
  },
});

const days = parseInt(values.days ?? '3', 10);
if (!Number.isFinite(days) || days < 1) throw new Error('--days must be a positive integer');

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');

const pool = new Pool({ connectionString: DATABASE_URL });

// ---------------------------------------------------------------------------
// Upsert rollups: aggregate amazon_campaign_daily per profile per date
// Window: [CURRENT_DATE - (days-1), CURRENT_DATE] inclusive
// Currency: joined from amazon_profiles (source of truth)
// acos: spend/sales where sales > 0; NULL otherwise — never divide by zero
// ---------------------------------------------------------------------------
try {
  const { rowCount } = await pool.query(
    `INSERT INTO daily_rollup
       (profile_id, date, currency, spend, sales, orders, clicks, impressions, acos, computed_at)
     SELECT
       d.profile_id,
       d.date,
       p.currency_code                       AS currency,
       SUM(d.cost)                           AS spend,
       SUM(d.sales_14d)                      AS sales,
       SUM(d.purchases_14d)::int             AS orders,
       SUM(d.clicks)::int                    AS clicks,
       SUM(d.impressions)                    AS impressions,
       CASE WHEN SUM(d.sales_14d) > 0
            THEN ROUND(SUM(d.cost) / SUM(d.sales_14d), 4)
            ELSE NULL
       END                                   AS acos,
       now()                                 AS computed_at
     FROM amazon_campaign_daily d
     JOIN amazon_profiles p ON p.profile_id = d.profile_id
     WHERE d.date >= CURRENT_DATE - ($1::int - 1)
       AND d.date <= CURRENT_DATE
     GROUP BY d.profile_id, d.date, p.currency_code
     ON CONFLICT (profile_id, date) DO UPDATE SET
       currency    = EXCLUDED.currency,
       spend       = EXCLUDED.spend,
       sales       = EXCLUDED.sales,
       orders      = EXCLUDED.orders,
       clicks      = EXCLUDED.clicks,
       impressions = EXCLUDED.impressions,
       acos        = EXCLUDED.acos,
       computed_at = EXCLUDED.computed_at`,
    [days],
  );

  console.log(`rollup-daily: upserted ${rowCount} rows (last ${days} days, window ${days}-1 days back → today)`);
} finally {
  await pool.end();
}
