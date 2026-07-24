import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Pool, neonConfig } from '@neondatabase/serverless';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', 'migrations');

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');

// Node 22+ has native WebSocket
neonConfig.webSocketConstructor = WebSocket;

const pool = new Pool({ connectionString: DATABASE_URL });

// Ensure _migrations tracking table exists
await pool.query(`
  CREATE TABLE IF NOT EXISTS _migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`);

// Get already-applied migrations
const { rows: applied } = await pool.query('SELECT filename FROM _migrations');
const appliedSet = new Set(applied.map(r => r.filename));

// Read migration files sorted by filename
const files = (await readdir(migrationsDir))
  .filter(f => f.endsWith('.sql'))
  .sort();

let ran = 0;
for (const file of files) {
  if (appliedSet.has(file)) {
    console.log(`skip  ${file}`);
    continue;
  }
  const sqlText = await readFile(join(migrationsDir, file), 'utf8');
  console.log(`apply ${file} ...`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sqlText);
    await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
    await client.query('COMMIT');
    console.log(`done  ${file}`);
    ran++;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

await pool.end();
console.log(`\nMigrations complete. ${ran} applied, ${files.length - ran} skipped.`);
