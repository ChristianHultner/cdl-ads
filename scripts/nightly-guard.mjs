// nightly-guard.mjs — retry-slot guard for cron-nightly.sh
// Exits 0 if all 9 profiles have max(landed_at) > today 02:00 (nothing to do).
// Exits 1 if any profile is stale or check fails (proceed with sync).
import { Pool, neonConfig } from '@neondatabase/serverless';

neonConfig.webSocketConstructor = WebSocket;

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) process.exit(1);   // can't check → assume stale

const pool = new Pool({ connectionString: DATABASE_URL });
try {
  const { rows } = await pool.query(`
    SELECT count(*) AS stale_count
    FROM (VALUES
      (2263723137827296::bigint),(139446882235960::bigint),(395707988492653::bigint),
      (350599867165328::bigint), (1711934819800765::bigint),(1068790837798301::bigint),
      (2213278747143677::bigint),(3035560362970447::bigint),(2286455750996728::bigint)
    ) AS p(pid)
    LEFT JOIN (
      SELECT profile_id, max(landed_at) AS last_landed
      FROM amazon_campaign_daily
      GROUP BY profile_id
    ) d ON d.profile_id = p.pid
    WHERE d.last_landed IS NULL
       OR d.last_landed < CURRENT_DATE + TIME '02:00:00'
  `);
  await pool.end();
  const stale = parseInt(rows[0].stale_count, 10);
  process.exit(stale === 0 ? 0 : 1);
} catch (e) {
  await pool.end().catch(() => {});
  process.exit(1);   // error → assume stale, proceed with sync
}
