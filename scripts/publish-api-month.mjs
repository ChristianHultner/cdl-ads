// Publish one complete month of Amazon API ad totals into console_history (source='api').
// Same function as the Vercel publish-month step; see docs/doctrine.md, "Automatic monthly publication".
// node --env-file=.env.local scripts/publish-api-month.mjs --month 2026-10 [--dry-run]
import { parseArgs } from 'node:util';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { isAmazonDatabase, publishMonth } from '../lib/amazon/sync-runner.ts';

const { values } = parseArgs({ options: { month: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
const m = /^(\d{4})-(\d{2})$/.exec(values.month ?? '');
if (!m) throw new Error('--month YYYY-MM required');
if (!isAmazonDatabase(process.env.DATABASE_URL)) throw new Error('WRONG DATABASE');
neonConfig.webSocketConstructor = WebSocket;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  const result = await publishMonth(client, { year: Number(m[1]), month: Number(m[2]) }, { dryRun: values['dry-run'] === true });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
