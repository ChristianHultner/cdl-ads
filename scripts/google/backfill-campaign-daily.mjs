import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Pool, neonConfig } from '@neondatabase/serverless';

neonConfig.webSocketConstructor = WebSocket;

const __dir = fileURLToPath(new URL('.', import.meta.url));

// 13 ranges: 24-month backfill + 2026-07-22..29 tail (idempotent with 7-day seed).
const RANGES = [
  ['2024-08-01', '2024-09-29'],
  ['2024-09-30', '2024-11-28'],
  ['2024-11-29', '2025-01-27'],
  ['2025-01-28', '2025-03-28'],
  ['2025-03-29', '2025-05-27'],
  ['2025-05-28', '2025-07-26'],
  ['2025-07-27', '2025-09-24'],
  ['2025-09-25', '2025-11-23'],
  ['2025-11-24', '2026-01-22'],
  ['2026-01-23', '2026-03-23'],
  ['2026-03-24', '2026-05-22'],
  ['2026-05-23', '2026-07-21'],
  ['2026-07-22', '2026-07-29'],
];

const pool = new Pool({ connectionString: process.env.GOOGLE_DATABASE_URL });

for (const [from, to] of RANGES) {
  // a. dry run — capture and parse summary
  const dry = spawnSync(
    process.execPath,
    ['sync-campaign-daily.mjs', `--from=${from}`, `--to=${to}`],
    { cwd: __dir, env: process.env, encoding: 'utf8' }
  );
  if (dry.status !== 0) {
    console.error(`RANGE ${from} DRY RUN FAILED`);
    console.error(dry.stderr || dry.stdout);
    await pool.end();
    process.exit(1);
  }

  // Print DRY RUN / ROWS / DAYS / CAMPAIGNS / TOTAL lines
  for (const line of dry.stdout.split('\n').filter(l =>
    l.startsWith('DRY RUN') || l.startsWith('ROWS') || l.startsWith('DAYS') ||
    l.startsWith('CAMPAIGNS') || l.startsWith('TOTAL')
  )) {
    console.log(line);
  }

  const rowsMatch  = dry.stdout.match(/^ROWS (\d+)/m);
  const totalMatch = dry.stdout.match(/^TOTAL clicks=(\d+) cost_micros=(\d+) conversions=([\d.]+)/m);
  if (!rowsMatch || !totalMatch) {
    console.error(`RANGE ${from} FAIL: could not parse dry run output`);
    console.error(dry.stdout);
    await pool.end();
    process.exit(1);
  }
  const dryRows   = parseInt(rowsMatch[1],  10);
  const dryClicks = parseInt(totalMatch[1], 10);
  const dryCost   = parseInt(totalMatch[2], 10);
  const dryConv   = parseFloat(totalMatch[3]);

  // b. execute — require exit 0
  const exec = spawnSync(
    process.execPath,
    ['sync-campaign-daily.mjs', `--from=${from}`, `--to=${to}`, '--execute'],
    { cwd: __dir, env: process.env, encoding: 'utf8' }
  );
  if (exec.status !== 0) {
    console.error(`RANGE ${from} EXECUTE FAILED`);
    console.error(exec.stderr || exec.stdout);
    await pool.end();
    process.exit(1);
  }

  // Print BATCH first+last + UPSERTED
  const execLines  = exec.stdout.trim().split('\n');
  const batchLines = execLines.filter(l => l.startsWith('BATCH'));
  if (batchLines.length > 1) {
    console.log(batchLines[0]);
    console.log(batchLines[batchLines.length - 1]);
  } else {
    for (const l of batchLines) console.log(l);
  }
  const upsertedLine = execLines.find(l => l.startsWith('UPSERTED'));
  if (upsertedLine) console.log(upsertedLine);

  // c. reconciliation SELECT — count, clicks, cost_micros, conversions
  const r = await pool.query(
    `SELECT count(*) rows, sum(clicks) clicks, sum(cost_micros) cost_micros,
            round(sum(conversions)::numeric, 2) conversions
     FROM google_campaign_daily
     WHERE date BETWEEN $1 AND $2`,
    [from, to]
  );
  const db = r.rows[0];
  const dbRows   = parseInt(db.rows        ?? '0', 10);
  const dbClicks = parseInt(db.clicks      ?? '0', 10);
  const dbCost   = parseInt(db.cost_micros ?? '0', 10);
  const dbConv   = parseFloat(db.conversions ?? '0');

  // d. compare — all four must match
  const convMatch = Math.abs(dryConv - dbConv) < 0.01;
  if (dryRows === dbRows && dryClicks === dbClicks && dryCost === dbCost && convMatch) {
    console.log(`RANGE ${from} OK rows=${dryRows}`);
  } else {
    console.log(
      `RANGE ${from} FAIL ` +
      `dry=rows:${dryRows},clicks:${dryClicks},cost_micros:${dryCost},conversions:${dryConv} ` +
      `db=rows:${dbRows},clicks:${dbClicks},cost_micros:${dbCost},conversions:${dbConv}`
    );
    await pool.end();
    process.exit(1);
  }
}

await pool.end();
console.log('BACKFILL COMPLETE');
