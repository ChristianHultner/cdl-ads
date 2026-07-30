import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Pool, neonConfig } from '@neondatabase/serverless';

neonConfig.webSocketConstructor = WebSocket;

const __dir = fileURLToPath(new URL('.', import.meta.url));

// 13 ranges: 2025-07 through 2026-06 full months + 2026-07-01..29
// 2025-06 already loaded; 2026-07-23..29 already loaded (idempotent).
const RANGES = [
  ['2025-07-01', '2025-07-31'],
  ['2025-08-01', '2025-08-31'],
  ['2025-09-01', '2025-09-30'],
  ['2025-10-01', '2025-10-31'],
  ['2025-11-01', '2025-11-30'],
  ['2025-12-01', '2025-12-31'],
  ['2026-01-01', '2026-01-31'],
  ['2026-02-01', '2026-02-28'],
  ['2026-03-01', '2026-03-31'],
  ['2026-04-01', '2026-04-30'],
  ['2026-05-01', '2026-05-31'],
  ['2026-06-01', '2026-06-30'],
  ['2026-07-01', '2026-07-29'],
];

const pool = new Pool({ connectionString: process.env.GOOGLE_DATABASE_URL });

for (const [from, to] of RANGES) {
  // a. dry run — capture and parse summary
  const dry = spawnSync(process.execPath, ['sync-search-terms.mjs', `--from=${from}`, `--to=${to}`], {
    cwd: __dir,
    env: process.env,
    encoding: 'utf8',
  });
  if (dry.status !== 0) {
    console.error(`MONTH ${from} DRY RUN FAILED`);
    console.error(dry.stderr || dry.stdout);
    await pool.end();
    process.exit(1);
  }

  // Print DRY RUN / ROWS / DAYS / TOTAL lines
  for (const line of dry.stdout.split('\n').filter(l =>
    l.startsWith('DRY RUN') || l.startsWith('ROWS') || l.startsWith('DAYS') || l.startsWith('TOTAL')
  )) {
    console.log(line);
  }

  const rowsMatch  = dry.stdout.match(/^ROWS (\d+)/m);
  const totalMatch = dry.stdout.match(/^TOTAL clicks=(\d+) cost_micros=(\d+)/m);
  if (!rowsMatch || !totalMatch) {
    console.error(`MONTH ${from} FAIL: could not parse dry run output`);
    console.error(dry.stdout);
    await pool.end();
    process.exit(1);
  }
  const dryRows   = parseInt(rowsMatch[1],  10);
  const dryClicks = parseInt(totalMatch[1], 10);
  const dryCost   = parseInt(totalMatch[2], 10);

  // b. execute — require exit 0
  const exec = spawnSync(
    process.execPath,
    ['sync-search-terms.mjs', `--from=${from}`, `--to=${to}`, '--execute'],
    { cwd: __dir, env: process.env, encoding: 'utf8' }
  );
  if (exec.status !== 0) {
    console.error(`MONTH ${from} EXECUTE FAILED`);
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

  // c. reconciliation SELECT
  const r = await pool.query(
    'SELECT count(*) rows, sum(clicks) clicks, sum(cost_micros) cost_micros FROM google_search_term_daily WHERE date BETWEEN $1 AND $2',
    [from, to]
  );
  const db = r.rows[0];
  const dbRows   = parseInt(db.rows          ?? '0', 10);
  const dbClicks = parseInt(db.clicks        ?? '0', 10);
  const dbCost   = parseInt(db.cost_micros   ?? '0', 10);

  // d. compare — all three must match
  if (dryRows === dbRows && dryClicks === dbClicks && dryCost === dbCost) {
    console.log(`MONTH ${from} OK rows=${dryRows}`);
  } else {
    console.log(
      `MONTH ${from} FAIL ` +
      `dry=rows:${dryRows},clicks:${dryClicks},cost_micros:${dryCost} ` +
      `db=rows:${dbRows},clicks:${dbClicks},cost_micros:${dbCost}`
    );
    await pool.end();
    process.exit(1);
  }
}

await pool.end();
console.log('BACKFILL COMPLETE');
