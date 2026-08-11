// watchdog.mjs — bite 1: freshness, liveness, completion
//               bite 2: WhatsApp alert on OK→ALERT / ALERT→OK transitions
//               bite 3: ALERT→ALERT re-escalation + self-heartbeat
// Writes artifacts/watchdog-status.json and upserts watchdog_status row 1.
import { statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sendAlert } from './notify.mjs';

neonConfig.webSocketConstructor = WebSocket;

const __dirname       = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT       = join(__dirname, '..');
const ARTIFACTS       = join(REPO_ROOT, 'artifacts');
const LOG_FILE        = join(ARTIFACTS, 'cron-nightly.log');
const STATUS_FILE     = join(ARTIFACTS, 'watchdog-status.json');
const HEARTBEAT_FILE  = join(ARTIFACTS, 'watchdog-heartbeat');

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
        WHERE (d.last_landed IS NULL
           OR d.last_landed < now() - interval '30 hours')
          -- CA2 retired 2026-08-02, dead shell — see Christian's ruling
          AND p.profile_id::text <> '1068790837798301'
        ORDER BY p.country_code
      `);
      if (rows.length > 0) {
        const stale = rows.map(r => `${r.country_code}(…${r.profile_id.slice(-4)})`).join(', ');
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
// B0_EXTINCTION (policy 2026-08-01, HC only)
// Ensures Kindle B0 ASINs purged in the 315-REPLACE wave never re-enter ENABLED state.
// ---------------------------------------------------------------------------
{
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n
         FROM amazon_product_ads
        WHERE asin ~* '^B0'
          AND state = 'ENABLED'
          AND asin NOT IN ('B0FTZT6YS7','B0FTZTZHKB','B0FTZWPR42')
          -- pack exceptions, Christian 2026-08-02`,
    );
    const n = rows[0].n;
    if (n > 0) {
      checks.b0_extinction = {
        status:  'ALERT',
        count:   n,
        message: `B0 ads re-enabled: ${n}`,
      };
      verdict = 'ALERT';
      details.push(`B0 ads re-enabled: ${n}`);
    } else {
      checks.b0_extinction = { status: 'OK', message: 'no B0 ENABLED product ads' };
    }
  } catch (e) {
    checks.b0_extinction = { status: 'ERROR', message: `DB query failed: ${e.message}` };
  } finally {
    await pool.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// GENERATION_LIVENESS (cause-agnostic weekly-gen health check)
//
// Incident 2026-08-06: the Monday weekly (which includes generation) silently
// failed. launchd reported exit 1 with zero log output. Root cause: an editor
// save had applied a quarantine xattr to cron-weekly.sh; macOS Gatekeeper
// refused direct-exec. Repaired manually:
//   xattr -c scripts/cron-weekly.sh
//   launchctl kickstart -k gui/$(id -u)/com.cdl-ads.weekly
//
// Lesson: editor saves (VS Code, Zed, etc.) can quarantine scripts that run
// via launchd direct-exec plists. xattr -c <script> cures it. Any future
// silent Monday failure should be suspected as the same class of problem.
//
// This check is cause-agnostic: it only asks "has generation produced anything
// in the last 8 days?" — 8d = one weekly cycle (7d) + 1d slack. Quiet-but-
// healthy estates stay under the threshold because weeklies always produce at
// least one row, or the estate is truly frozen and the alert is correct.
// ---------------------------------------------------------------------------
{
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const { rows } = await pool.query(
      `SELECT max(created_at) AS last_born FROM recommendations`,
    );
    const lastBorn      = rows[0]?.last_born;   // null if table is empty
    const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;
    const tooOld        = !lastBorn || (now.getTime() - new Date(lastBorn).getTime() > EIGHT_DAYS_MS);
    if (tooOld) {
      checks.generation_liveness = {
        status:    'ALERT',
        last_born: lastBorn ? new Date(lastBorn).toISOString() : null,
        message:   'no recommendation born in >8d — generation leg may be dead',
      };
      verdict = 'ALERT';
      details.push('no recommendation born in >8d — generation leg may be dead');
    } else {
      checks.generation_liveness = {
        status:    'OK',
        last_born: new Date(lastBorn).toISOString(),
        message:   'recommendations born within last 8 days',
      };
    }
  } catch (e) {
    checks.generation_liveness = { status: 'ERROR', message: `DB query failed: ${e.message}` };
  } finally {
    await pool.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// SALES_TREND — revenue backstop 2026-08-11
//
// Efficiency must never grade itself EXCELLENT while ad-sales fall.
// A = sum(sales_14d) last 7 settled days (skip today + yesterday; attribution
//     still filling — window is CURRENT_DATE-2 through CURRENT_DATE-8).
// B = same 7-day sum averaged over prior 4 calendar weeks (days 9-36 back).
// Alert when B > floor (20 local-currency units) AND A < 0.65 × B.
// Same-currency per profile — no FX conversion anywhere.
// ---------------------------------------------------------------------------
{
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const { rows } = await pool.query(`
      WITH profiles AS (
        SELECT profile_id, country_code, currency_code
        FROM   amazon_profiles
        WHERE  profile_id::text <> '1068790837798301'   -- CA2 retired
      ),
      recent AS (
        SELECT profile_id, COALESCE(SUM(sales_14d), 0) AS sales_a
        FROM   amazon_campaign_daily
        WHERE  date >= CURRENT_DATE - 8
          AND  date <= CURRENT_DATE - 2
        GROUP  BY profile_id
      ),
      w1 AS (SELECT profile_id, COALESCE(SUM(sales_14d),0) AS s FROM amazon_campaign_daily WHERE date >= CURRENT_DATE-15 AND date <= CURRENT_DATE-9  GROUP BY profile_id),
      w2 AS (SELECT profile_id, COALESCE(SUM(sales_14d),0) AS s FROM amazon_campaign_daily WHERE date >= CURRENT_DATE-22 AND date <= CURRENT_DATE-16 GROUP BY profile_id),
      w3 AS (SELECT profile_id, COALESCE(SUM(sales_14d),0) AS s FROM amazon_campaign_daily WHERE date >= CURRENT_DATE-29 AND date <= CURRENT_DATE-23 GROUP BY profile_id),
      w4 AS (SELECT profile_id, COALESCE(SUM(sales_14d),0) AS s FROM amazon_campaign_daily WHERE date >= CURRENT_DATE-36 AND date <= CURRENT_DATE-30 GROUP BY profile_id)
      SELECT
        p.profile_id::text,
        p.country_code,
        p.currency_code,
        COALESCE(r.sales_a, 0)::float                                                          AS sales_a,
        ((COALESCE(w1.s,0)+COALESCE(w2.s,0)+COALESCE(w3.s,0)+COALESCE(w4.s,0)) / 4.0)::float AS sales_b
      FROM   profiles p
      LEFT JOIN recent r  ON r.profile_id  = p.profile_id
      LEFT JOIN w1        ON w1.profile_id = p.profile_id
      LEFT JOIN w2        ON w2.profile_id = p.profile_id
      LEFT JOIN w3        ON w3.profile_id = p.profile_id
      LEFT JOIN w4        ON w4.profile_id = p.profile_id
      ORDER  BY p.country_code
    `);

    const FLOOR     = 20;    // local-currency units; skip dead/tiny profiles
    const THRESHOLD = 0.65;  // alert when A < 65% of 4wk avg B

    const flagged        = [];
    const profileResults = [];

    for (const r of rows) {
      const salesA = Number(r.sales_a);
      const salesB = Number(r.sales_b);
      const skip   = salesB <= FLOOR;
      const pctVsAvg = salesB > 0
        ? `${((salesA - salesB) / salesB * 100).toFixed(1)}%`
        : 'n/a';

      profileResults.push({
        market:     r.country_code,
        currency:   r.currency_code,
        sales_a:    salesA.toFixed(2),
        sales_b:    salesB.toFixed(2),
        skip,
        pct_vs_avg: pctVsAvg,
      });

      if (!skip && salesA < THRESHOLD * salesB) {
        const pctDown = ((1 - salesA / salesB) * 100).toFixed(0);
        flagged.push(`${r.country_code} \u2212${pctDown}% vs 4wk avg`);
      }
    }

    if (flagged.length > 0) {
      const msg = `ad sales down: ${flagged.join(', ')}`;
      checks.sales_trend = {
        status:   'ALERT',
        flagged,
        profiles: profileResults,
        message:  msg,
      };
      verdict = 'ALERT';
      details.push(msg);
    } else {
      checks.sales_trend = {
        status:   'OK',
        profiles: profileResults,
        message:  'all meaningful markets within 35% of 4wk avg',
      };
    }
  } catch (e) {
    checks.sales_trend = { status: 'ERROR', message: `DB query failed: ${e.message}` };
  } finally {
    await pool.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Write status JSON + self-heartbeat (always — even if DB fails later)
// ---------------------------------------------------------------------------
const status = { checked_at: now.toISOString(), checks, verdict, details };
writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2) + '\n');
// Self-heartbeat: mtime = proof the watchdog ran this cycle.
writeFileSync(HEARTBEAT_FILE, '');
console.log(`[watchdog] checked_at: ${now.toISOString()}`);
console.log(`[watchdog] verdict:    ${verdict}`);
if (details.length > 0) console.log(`[watchdog] details:    ${details.join(' | ')}`);
console.log(`[watchdog] status written    → ${STATUS_FILE}`);
console.log(`[watchdog] heartbeat touched → ${HEARTBEAT_FILE}`);

// ---------------------------------------------------------------------------
// Upsert watchdog_status table (row 1) + bite-3 escalation alerts
//
// Alert fires when ANY of:
//   (a) OK→ALERT transition (or first-ever ALERT)
//   (b) verdict stays ALERT and last_alert_sent_at > 6 hours ago
//   (c) details CHANGED vs last_details while already ALERT (new/different problem)
// Recovery ping (ALERT→OK) unchanged.
// ---------------------------------------------------------------------------
{
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    // Read previous state BEFORE upserting
    let previousVerdict   = null;
    let lastAlertSentAt   = null;   // Date | null
    let lastDetailsFromDb = null;   // array | null

    try {
      const { rows } = await pool.query(
        'SELECT verdict, last_alert_sent_at, last_details FROM watchdog_status WHERE id = 1',
      );
      if (rows.length > 0) {
        previousVerdict   = rows[0].verdict;
        lastAlertSentAt   = rows[0].last_alert_sent_at;   // already a JS Date from pg
        lastDetailsFromDb = rows[0].last_details;
      }
    } catch (e) {
      console.error('[watchdog] could not read previous state:', e.message);
    }

    const wasAlert = previousVerdict === 'ALERT';
    const nowAlert = verdict === 'ALERT';

    // -------------------------------------------------------------------------
    // Escalation decision
    // -------------------------------------------------------------------------
    let shouldAlert = false;
    let alertReason = '';

    if (!wasAlert && nowAlert) {
      // (a) OK→ALERT (or first-ever ALERT with no previous row)
      shouldAlert = true;
      alertReason = 'OK→ALERT transition';
    } else if (wasAlert && nowAlert) {
      // Persistent ALERT — check (b) and (c)
      const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
      const alertAgeMs   = lastAlertSentAt
        ? now.getTime() - new Date(lastAlertSentAt).getTime()
        : Infinity;

      if (alertAgeMs > SIX_HOURS_MS) {
        // (b) no ping in over 6 hours
        shouldAlert = true;
        const ageStr = isFinite(alertAgeMs)
          ? `${Math.floor(alertAgeMs / 3_600_000)}h ago`
          : 'never alerted';
        alertReason = `ALERT persists — last alert ${ageStr}`;
      } else {
        // (c) problem changed while already red
        const prevJson = JSON.stringify(lastDetailsFromDb ?? []);
        const currJson = JSON.stringify(details);
        if (prevJson !== currJson) {
          shouldAlert = true;
          alertReason = 'problem changed while already ALERT';
        }
      }
    }

    const isRecovery = wasAlert && !nowAlert;

    // -------------------------------------------------------------------------
    // Compute columns to persist
    //   last_alert_sent_at — update whenever any alert fires (ALERT or recovery)
    //   last_details       — update only on ALERT sends (baseline for condition-c)
    // -------------------------------------------------------------------------
    const newLastAlertSentAt = (shouldAlert || isRecovery)
      ? now.toISOString()
      : (lastAlertSentAt ? new Date(lastAlertSentAt).toISOString() : null);

    const newLastDetails = shouldAlert
      ? details
      : (lastDetailsFromDb ?? null);

    await pool.query(`
      INSERT INTO watchdog_status (id, checked_at, verdict, details, last_alert_sent_at, last_details)
      VALUES (1, $1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE SET
        checked_at         = EXCLUDED.checked_at,
        verdict            = EXCLUDED.verdict,
        details            = EXCLUDED.details,
        last_alert_sent_at = EXCLUDED.last_alert_sent_at,
        last_details       = EXCLUDED.last_details
    `, [
      now.toISOString(),
      verdict,
      JSON.stringify(details),
      newLastAlertSentAt,
      JSON.stringify(newLastDetails ?? []),
    ]);
    console.log('[watchdog] watchdog_status row 1 upserted');

    // -------------------------------------------------------------------------
    // Send alerts
    // -------------------------------------------------------------------------
    if (shouldAlert) {
      const msg = `cdl-ads watchdog ALERT (${alertReason}): ${details.join(', ')}`;
      console.log(`[watchdog] sending alert — ${alertReason}`);
      await sendAlert(msg);
    } else if (isRecovery) {
      console.log('[watchdog] transition ALERT→OK — sending recovery notice');
      await sendAlert('cdl-ads watchdog: recovered — all checks OK');
    } else {
      const ageNote = (wasAlert && nowAlert && lastAlertSentAt)
        ? ` (last alert ${Math.floor((now.getTime() - new Date(lastAlertSentAt).getTime()) / 3_600_000)}h ago)`
        : '';
      console.log(
        `[watchdog] no alert — ${previousVerdict ?? 'first-run'} → ${verdict}${ageNote}`,
      );
    }
  } catch (e) {
    console.error('[watchdog] DB upsert failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}
