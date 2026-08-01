// watchdog.mjs — bite 1: freshness, liveness, completion
//               bite 2: WhatsApp alert on OK→ALERT / ALERT→OK transitions
// Writes artifacts/watchdog-status.json and upserts watchdog_status row 1.
import { statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sendAlert } from './notify.mjs';

neonConfig.webSocketConstructor = WebSocket;

const __dirname  = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = join(__dirname, '..');
const ARTIFACTS  = join(REPO_ROOT, 'artifacts');
const LOG_FILE   = join(ARTIFACTS, 'cron-nightly.log');
const STATUS_FILE = join(ARTIFACTS, 'watchdog-status.json');

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');

if (!existsSync(ARTIFACTS)) mkdirSync(ARTIFACTS, { recursive: true });

const now          = new Date();
const localHour    = now.getHours();
const localMinute  = now.getMinutes();
const totalMinutes = localHour * 60 + localMinute;

const checks  = {};
const details = [];
let   verdict = 'OK';

// ---------------------------------------------------------------------------
// FRESHNESS
// ---------------------------------------------------------------------------
{
  const AFTER_0430 = totalMinutes >= (4 * 60 + 30);   // 04:30 local

  const today0300 = new Date(now);
  today0300.setHours(3, 0, 0, 0);

  if (!existsSync(LOG_FILE)) {
    checks.freshness = {
      status:  AFTER_0430 ? 'ALERT' : 'MISSING',
      message: 'cron-nightly.log does not exist',
    };
    if (AFTER_0430) {
      verdict = 'ALERT';
      details.push('nightly did not run');
    }
  } else {
    const mtime = new Date(statSync(LOG_FILE).mtimeMs);
    if (!AFTER_0430) {
      checks.freshness = {
        status:  'INFO',
        mtime:   mtime.toISOString(),
        message: 'before 04:30 threshold — informational only',
      };
    } else if (mtime > today0300) {
      checks.freshness = {
        status:  'OK',
        mtime:   mtime.toISOString(),
        message: 'log updated after today 03:00',
      };
    } else {
      checks.freshness = {
        status:  'ALERT',
        mtime:   mtime.toISOString(),
        message: 'log mtime is before today 03:00',
      };
      verdict = 'ALERT';
      details.push('nightly did not run');
    }
  }
}

// ---------------------------------------------------------------------------
// LIVENESS
// ---------------------------------------------------------------------------
{
  // macOS ps uses etime ([[DD-]HH:]MM:SS); etimes (seconds) is Linux-only.
  function parseEtimeToSecs(s) {
    const parts = s.trim().split(':');
    if (parts.length === 2) return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    if (parts.length === 3) {
      const first = parts[0];
      if (first.includes('-')) {
        const [d, h] = first.split('-');
        return parseInt(d, 10) * 86400 + parseInt(h, 10) * 3600
             + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
      }
      return parseInt(first, 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
    }
    return 0;
  }

  const killed = [];
  try {
    const psOut = execSync('ps -eo pid,etime,args', { encoding: 'utf8' });
    for (const line of psOut.split('\n')) {
      if (!line.includes('nightly-sync.mjs')) continue;
      const parts    = line.trim().split(/\s+/);
      const pid      = parseInt(parts[0], 10);
      const etimeStr = parts[1];
      if (isNaN(pid) || !etimeStr) continue;
      const secs   = parseEtimeToSecs(etimeStr);
      const ageMin = Math.floor(secs / 60);
      if (ageMin >= 50) {
        try {
          process.kill(pid, 9);   // SIGKILL
          killed.push({ pid, ageMin });
        } catch (_) {
          // process already gone — skip
        }
      }
    }
    if (killed.length > 0) {
      const msgs = killed.map(k => `pid ${k.pid} age ${k.ageMin}m`).join(', ');
      checks.liveness = { status: 'ALERT', killed, message: `killed hung sync (${msgs})` };
      for (const k of killed) details.push(`killed hung sync (age ${k.ageMin}m)`);
      verdict = 'ALERT';
    } else {
      checks.liveness = { status: 'OK', message: 'no hung nightly-sync processes' };
    }
  } catch (e) {
    checks.liveness = { status: 'ERROR', message: `ps failed: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// COMPLETION (after 09:00 local — DB-based, log-independent)
// ---------------------------------------------------------------------------
{
  if (totalMinutes < 9 * 60) {
    checks.completion = { status: 'SKIP', message: 'before 09:00 — skipped' };
  } else {
    const pool = new Pool({ connectionString: DATABASE_URL });
    try {
      const { rows } = await pool.query(`
        SELECT p.country_code, p.profile_id::text
        FROM amazon_profiles p
        LEFT JOIN (
          SELECT profile_id, max(landed_at) AS last_landed
          FROM amazon_campaign_daily
          GROUP BY profile_id
        ) d ON d.profile_id = p.profile_id
        WHERE d.last_landed IS NULL
           OR d.last_landed < now() - interval '30 hours'
        ORDER BY p.country_code
      `);
      if (rows.length > 0) {
        const stale = rows.map(r => r.country_code || r.profile_id).join(', ');
        checks.completion = { status: 'ALERT', stale: rows, message: `stale: ${stale}` };
        verdict = 'ALERT';
        details.push(`stale: ${stale}`);
      } else {
        checks.completion = { status: 'OK', message: 'all profiles have recent data' };
      }
    } catch (e) {
      checks.completion = { status: 'ERROR', message: `DB query failed: ${e.message}` };
    } finally {
      await pool.end().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Write status JSON
// ---------------------------------------------------------------------------
const status = { checked_at: now.toISOString(), checks, verdict, details };
writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2) + '\n');
console.log(`[watchdog] checked_at: ${now.toISOString()}`);
console.log(`[watchdog] verdict:    ${verdict}`);
if (details.length > 0) console.log(`[watchdog] details:    ${details.join(' | ')}`);
console.log(`[watchdog] status written → ${STATUS_FILE}`);

// ---------------------------------------------------------------------------
// Upsert watchdog_status table (row 1) + bite-2 transition alerts
// ---------------------------------------------------------------------------
{
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    // Read previous verdict BEFORE upserting (rate-limit: alert only on transitions)
    let previousVerdict = null;
    try {
      const { rows } = await pool.query(
        'SELECT verdict FROM watchdog_status WHERE id = 1',
      );
      if (rows.length > 0) previousVerdict = rows[0].verdict;
    } catch (e) {
      console.error('[watchdog] could not read previous verdict:', e.message);
    }

    await pool.query(`
      INSERT INTO watchdog_status (id, checked_at, verdict, details)
      VALUES (1, $1, $2, $3)
      ON CONFLICT (id) DO UPDATE SET
        checked_at = EXCLUDED.checked_at,
        verdict    = EXCLUDED.verdict,
        details    = EXCLUDED.details
    `, [now.toISOString(), verdict, JSON.stringify(details)]);
    console.log('[watchdog] watchdog_status row 1 upserted');

    // Bite 2: notify on state transitions only
    const wasAlert = previousVerdict === 'ALERT';
    const nowAlert = verdict === 'ALERT';

    if (!wasAlert && nowAlert) {
      // OK → ALERT (or first-ever ALERT)
      const msg = `cdl-ads watchdog ALERT: ${details.join(', ')}`;
      console.log(`[watchdog] transition OK→ALERT — sending WhatsApp alert`);
      await sendAlert(msg);
    } else if (wasAlert && !nowAlert) {
      // ALERT → OK (recovery)
      console.log(`[watchdog] transition ALERT→OK — sending recovery notice`);
      await sendAlert('cdl-ads watchdog: recovered — all checks OK');
    } else {
      console.log(`[watchdog] no transition (${previousVerdict ?? 'first-run'} → ${verdict}) — no alert sent`);
    }
  } catch (e) {
    console.error('[watchdog] DB upsert failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}
