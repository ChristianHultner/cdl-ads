// scripts/load-clusters.mjs
// Load cluster-draft-v2.json into book_clusters table.
// One row per work (keyed by group HC isbn = the isbn from the draft).
// Idempotent: TRUNCATE first, then bulk INSERT.
// ZERO migrations here — table must already exist (migration 025).
//
// Usage (env already sourced by caller):
//   node scripts/load-clusters.mjs

import { readFileSync }      from 'node:fs';
import { join }              from 'node:path';
import { homedir }           from 'node:os';
import { Pool, neonConfig }  from '@neondatabase/serverless';

neonConfig.webSocketConstructor = WebSocket;

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }

const v2Path = join(homedir(), 'cdl-ads', 'artifacts', 'cluster-draft-v2.json');
const draft  = JSON.parse(readFileSync(v2Path, 'utf8'));

const pool = new Pool({ connectionString: DATABASE_URL });

// Build rows
const rows = [];
for (const c of draft.clusters) {
  for (const w of c.works) {
    rows.push({
      isbn13:       w.isbn,
      work_title:   w.title,
      language:     c.language,
      cluster_name: c.name,
    });
  }
}
console.log(`Preparing ${rows.length} rows for book_clusters …`);

// TRUNCATE + bulk INSERT in a single transaction
await pool.query('BEGIN');
try {
  await pool.query('TRUNCATE book_clusters');
  for (const r of rows) {
    await pool.query(
      `INSERT INTO book_clusters (isbn13, work_title, language, cluster_name)
       VALUES ($1, $2, $3, $4)`,
      [r.isbn13, r.work_title, r.language, r.cluster_name],
    );
  }
  await pool.query('COMMIT');
  console.log(`✓ Loaded ${rows.length} rows into book_clusters.`);
} catch (err) {
  await pool.query('ROLLBACK');
  console.error(`INSERT failed, rolled back: ${err.message}`);
  await pool.end();
  process.exit(1);
}

// Verification query
const { rows: summary } = await pool.query(`
  SELECT language, cluster_name, count(*)::int
    FROM book_clusters
   GROUP BY 1, 2
   ORDER BY 1, 3 DESC
`);

console.log('\nSELECT language, cluster_name, count(*) FROM book_clusters GROUP BY 1,2 ORDER BY 1,3 DESC;\n');
console.log(' language | cluster_name                              | count');
console.log('----------+-------------------------------------------+------');
for (const r of summary) {
  const lang    = r.language.padEnd(8);
  const cluster = r.cluster_name.padEnd(42);
  console.log(` ${lang} | ${cluster} | ${r.count}`);
}
console.log(`\n(${summary.length} rows)`);

await pool.end();
