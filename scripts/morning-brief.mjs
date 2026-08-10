// scripts/morning-brief.mjs
// Daily morning brief — one WhatsApp summary of overnight state.
// Reuses notify.mjs (openclaw message send --channel whatsapp).
// Each section degrades gracefully; the brief always sends.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sendAlert } from './notify.mjs';

neonConfig.webSocketConstructor = WebSocket;

const __dirname   = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT   = join(__dirname, '..');
const ARTIFACTS   = join(REPO_ROOT, 'artifacts');
const LOG_FILE    = join(ARTIFACTS, 'cron-nightly.log');
const STATUS_FILE = join(ARTIFACTS, 'watchdog-status.json');

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');

const now     = new Date();
const dateStr = now.toLocaleDateString('en-GB', {
  weekday: 'short', day: 'numeric', month: 'short',
});

function mkPool() {
  return new Pool({ connectionString: DATABASE_URL });
}

async function safe(label, fn) {
  try {
    return await fn();
  } catch (e) {
    console.error(`[brief] ${label} error:`, e.message);
    return `${label} unavailable: ${e.message.slice(0, 60)}`;
  }
}

// ---------------------------------------------------------------------------
// a. QUEUE — DRAFT recs by type
// ---------------------------------------------------------------------------
const queueLine = await safe('Queue', async () => {
  const pool = mkPool();
  try {
    const { rows } = await pool.query(
      `SELECT rec_type, count(*)::int AS n
         FROM recommendations
        WHERE status = 'DRAFT'
        GROUP BY rec_type
        ORDER BY n DESC`,
    );
    if (rows.length === 0) return 'Queue: empty';
    return 'Queue: ' + rows.map(r => `${r.n} ${r.rec_type}`).join(', ');
  } finally {
    await pool.end().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// b. STAMPS — rec_outcomes captured in last 24h, by horizon (t7 first)
// ---------------------------------------------------------------------------
const stampsLine = await safe('Graded overnight', async () => {
  const pool = mkPool();
  try {
    const { rows } = await pool.query(
      `SELECT horizon, count(*)::int AS n
         FROM rec_outcomes
        WHERE captured_at > now() - interval '24h'
        GROUP BY horizon
        ORDER BY horizon DESC`,   // t7 before t14
    );
    if (rows.length === 0) return 'Graded overnight: none due';
    return 'Graded overnight: ' + rows.map(r => `${r.n} ${r.horizon}`).join(', ');
  } finally {
    await pool.end().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// c. SYNC — list only profiles stale > 30h
// ---------------------------------------------------------------------------
const syncLine = await safe('Sync', async () => {
  const pool = mkPool();
  try {
    const { rows } = await pool.query(`
      SELECT p.country_code, max(d.landed_at) AS last_landed
        FROM amazon_profiles p
        LEFT JOIN amazon_campaign_daily d ON d.profile_id = p.profile_id
       WHERE p.profile_id::text <> '1068790837798301'
       GROUP BY p.profile_id, p.country_code
       ORDER BY p.country_code`,
    );
    const THIRTY_H = 30 * 60 * 60 * 1000;
    const stale = rows.filter(r =>
      !r.last_landed ||
      now.getTime() - new Date(r.last_landed).getTime() > THIRTY_H,
    );
    if (stale.length === 0) return `Sync: all ${rows.length} fresh`;
    return 'Sync STALE: ' + stale.map(r => r.country_code).join(', ');
  } finally {
    await pool.end().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// d. RUNS — grep last nightly run for Killed / FAILED
// ---------------------------------------------------------------------------
const runsLine = await safe('Runs', async () => {
  if (!existsSync(LOG_FILE)) return 'Runs: log missing';
  const mtime = statSync(LOG_FILE).mtimeMs;
  const ageH  = (now.getTime() - mtime) / 3_600_000;
  if (ageH > 24) return `Runs: log stale (${Math.round(ageH)}h)`;

  const content  = readFileSync(LOG_FILE, 'utf8');
  const allLines = content.split('\n');

  // Isolate last nightly run: last occurrence of the first-profile header.
  // cron-nightly.sh always starts with profile 2263723137827296.
  let runStart = 0;
  for (let i = allLines.length - 1; i >= 0; i--) {
    if (allLines[i].startsWith('=== nightly-sync profile 2263723137827296')) {
      runStart = i;
      break;
    }
  }
  const lastRun = allLines.slice(runStart).join('\n');

  const killedN   = (lastRun.match(/Killed:\s*9/g) ?? []).length;
  const failMsgs  = lastRun.match(/PROFILE \S+ (?:nightly-sync )?FAILED/g) ?? [];
  const failedIds = [...new Set(failMsgs.map(m => {
    const pid = m.match(/PROFILE (\S+)/)?.[1] ?? '?';
    return '\u2026' + pid.slice(-4);   // last 4 digits, prefixed with ellipsis
  }))];

  if (killedN === 0 && failedIds.length === 0) return 'Runs: clean';
  const parts = [];
  if (killedN > 0)          parts.push(`${killedN} Killed`);
  if (failedIds.length > 0) parts.push(`FAILED: ${failedIds.join(', ')}`);
  return 'Runs: ' + parts.join(' · ');
});

// ---------------------------------------------------------------------------
// e. WATCHDOG — status file first; DB fallback
// ---------------------------------------------------------------------------
const watchdogLine = await safe('Watchdog', async () => {
  let s;
  if (existsSync(STATUS_FILE)) {
    s = JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
  } else {
    const pool = mkPool();
    try {
      const { rows } = await pool.query(
        'SELECT verdict, details, checked_at FROM watchdog_status WHERE id = 1',
      );
      if (rows.length === 0) return 'Watchdog: no status row';
      s = rows[0];
    } finally {
      await pool.end().catch(() => {});
    }
  }
  const agoMin = Math.round(
    (now.getTime() - new Date(s.checked_at).getTime()) / 60_000,
  );
  const det = (s.details ?? []).length > 0
    ? ' \u2014 ' + s.details.join(', ')
    : '';
  return `Watchdog: ${s.verdict}${det} (${agoMin}m ago)`;
});

// ---------------------------------------------------------------------------
// f. CLUSTER ROOMS — yesterday's totals for campaigns named *CLUSTER*
// ---------------------------------------------------------------------------
const clusterLine = await safe('Cluster rooms', async () => {
  const pool = mkPool();
  try {
    const { rows } = await pool.query(`
      SELECT sum(d.impressions)::bigint    AS impr,
             sum(d.clicks)::bigint        AS clicks,
             sum(d.cost)::numeric(10,2)   AS cost,
             sum(d.purchases_14d)::int    AS orders
        FROM amazon_campaign_daily d
        JOIN amazon_campaigns c ON c.campaign_id = d.campaign_id
       WHERE c.name ilike '%CLUSTER%'
         AND d.date = current_date - 1`,
    );
    const r = rows[0];
    if (!r || r.impr === null) return 'Cluster rooms: no data for yesterday';
    const imprFmt = parseInt(r.impr) >= 1000
      ? (parseInt(r.impr) / 1000).toFixed(1) + 'k'
      : String(r.impr);
    const orders = r.orders ?? 0;
    return `Cluster rooms: ${imprFmt} impr, ${r.clicks} clicks, \u20ac${r.cost}, ${orders} order${orders === 1 ? '' : 's'}`;
  } finally {
    await pool.end().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// g. LEDGER — all-time stamp totals + PUSHED count
// ---------------------------------------------------------------------------
const ledgerLine = await safe('Ledger', async () => {
  const pool = mkPool();
  try {
    const [stamps, pushed] = await Promise.all([
      pool.query(
        `SELECT horizon, count(*)::int AS n FROM rec_outcomes GROUP BY horizon ORDER BY horizon DESC`,
      ),
      pool.query(
        `SELECT count(*)::int AS n FROM recommendations WHERE status = 'PUSHED'`,
      ),
    ]);
    const t7  = stamps.rows.find(r => r.horizon === 't7')?.n  ?? 0;
    const t14 = stamps.rows.find(r => r.horizon === 't14')?.n ?? 0;
    const n   = pushed.rows[0]?.n ?? 0;
    return `Ledger: ${t7} t7 / ${t14} t14 stamps \u00b7 ${n} PUSHED awaiting first grade`;
  } finally {
    await pool.end().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Compose + send
// ---------------------------------------------------------------------------
const SEP     = '\u2500'.repeat(30);
const message = [
  `cdl-ads morning brief \u00b7 ${dateStr}`,
  SEP,
  queueLine,
  stampsLine,
  syncLine,
  runsLine,
  watchdogLine,
  clusterLine,
  SEP,
  ledgerLine,
].join('\n');

console.log('\n=== COMPOSED MESSAGE ===');
console.log(message);
console.log('========================\n');

const ok = await sendAlert(message);
if (ok) {
  console.log('[brief] sent OK');
  process.exit(0);
} else {
  console.error('[brief] send FAILED');
  process.exit(1);
}
