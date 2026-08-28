#!/usr/bin/env node
// import-console-history.mjs
// Reads an Amazon Ads console monthly-export CSV and upserts into console_history.
// Usage: node scripts/import-console-history.mjs <path-to-csv>
//
// display-only truth layer — writes ONLY to console_history.
// All-or-nothing per file: any unknown currency aborts before any DB write.
// Skips year=2026 month=8 (partial month).

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Pool, neonConfig } from '@neondatabase/serverless';

// Node 22+ has native WebSocket
neonConfig.webSocketConstructor = WebSocket;

const CURRENCY_MAP = { USD: 'US', MXN: 'MX', CAD: 'CA', EUR: 'ES' };
const SKIP_YEAR = 2026;
const SKIP_MONTH = 8;

// ---------- CSV helpers ----------

function parseCSVLine(line) {
  const fields = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { field += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      fields.push(field); field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

function parseCSV(filePath) {
  let content = readFileSync(filePath, 'utf8');
  // Strip UTF-8 BOM
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

  const lines = content.split(/\r?\n/);
  if (lines.length < 2) throw new Error('CSV has fewer than 2 lines');

  const headers = parseCSVLine(lines[0]).map(h => h.trim());

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const vals = parseCSVLine(line);
    const row = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] ?? '').trim(); });
    rows.push(row);
  }
  return rows;
}

function toNum(s) {
  const v = parseFloat((s || '0').replace(/,/g, ''));
  return isNaN(v) ? 0 : v;
}
function toInt(s) {
  const v = parseInt((s || '0').replace(/,/g, ''), 10);
  return isNaN(v) ? 0 : v;
}

// ---------- Main ----------

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/import-console-history.mjs <path-to-csv>');
  process.exit(1);
}

const absPath = resolve(filePath);
console.log(`Reading: ${absPath}`);

const rows = parseCSV(absPath);
console.log(`Parsed ${rows.length} data rows`);

// Validate ALL currencies before touching the DB (all-or-nothing)
const unknown = new Set();
for (const row of rows) {
  const cur = (row['Budget currency'] || '').trim();
  if (cur && !CURRENCY_MAP[cur]) unknown.add(cur);
}
if (unknown.size > 0) {
  console.error(`STOP: unknown currency in file: ${[...unknown].join(', ')} — importing nothing from this file.`);
  process.exit(1);
}

// Aggregate by (currency, year, month)
const agg = new Map();
let skippedPartial = 0;

for (const row of rows) {
  const currency = (row['Budget currency'] || '').trim();
  const year     = toInt(row['Year']);
  const month    = toInt(row['Month']);

  if (!currency || !year || !month) continue;

  if (year === SKIP_YEAR && month === SKIP_MONTH) { skippedPartial++; continue; }

  const market = CURRENCY_MAP[currency];
  const key    = `${market}|${currency}|${year}|${month}`;
  const bucket = agg.get(key) ?? { market, currency, year, month, spend: 0, sales: 0, orders: 0, units: 0 };

  bucket.spend  += toNum(row['Total cost']);
  bucket.sales  += toNum(row['Sales']);
  bucket.orders += toInt(row['Purchases']);
  bucket.units  += toInt(row['Units sold']);

  agg.set(key, bucket);
}

console.log(`Skipped ${skippedPartial} rows (partial ${SKIP_YEAR}-${String(SKIP_MONTH).padStart(2, '0')})`);
console.log(`Aggregated into ${agg.size} (market, year, month) buckets`);

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');

const pool = new Pool({ connectionString: DATABASE_URL });

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const r of agg.values()) {
      await client.query(
        `INSERT INTO console_history (market, currency, year, month, spend, sales, orders, units)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (market, year, month) DO UPDATE SET
           currency    = EXCLUDED.currency,
           spend       = EXCLUDED.spend,
           sales       = EXCLUDED.sales,
           orders      = EXCLUDED.orders,
           units       = EXCLUDED.units,
           imported_at = now()`,
        [r.market, r.currency, r.year, r.month,
         r.spend.toFixed(4), r.sales.toFixed(4), r.orders, r.units]
      );
    }

    await client.query('COMMIT');
    console.log(`Upserted ${agg.size} rows into console_history.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
