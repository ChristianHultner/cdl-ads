import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Pool, neonConfig } from '@neondatabase/serverless';

const __dirname = dirname(fileURLToPath(import.meta.url));

const url = process.env.GOOGLE_DATABASE_URL;

if (!url) {
  console.error('MISSING GOOGLE_DATABASE_URL');
  process.exit(1);
}

if (!url.includes('ep-holy-star-afsf5u86')) {
  console.error('WRONG DATABASE');
  process.exit(1);
}

// Node 22+ has native WebSocket
neonConfig.webSocketConstructor = WebSocket;

const pool = new Pool({ connectionString: url });

// Ensure tracking table exists
await pool.query(`
  CREATE TABLE IF NOT EXISTS google_migrations (
    id serial PRIMARY KEY,
    filename text UNIQUE NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`);

const migrationsDir = join(__dirname, '..', '..', 'migrations-google');
const files = (await readdir(migrationsDir))
  .filter(f => f.endsWith('.sql'))
  .sort();

for (const filename of files) {
  const { rows } = await pool.query(
    'SELECT 1 FROM google_migrations WHERE filename = $1',
    [filename]
  );
  if (rows.length > 0) {
    console.log(`SKIP ${filename} (already applied)`);
    continue;
  }
  const sql = await readFile(join(migrationsDir, filename), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO google_migrations (filename) VALUES ($1)',
      [filename]
    );
    await client.query('COMMIT');
    console.log(`APPLIED ${filename}`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

await pool.end();
