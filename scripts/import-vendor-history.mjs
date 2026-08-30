#!/usr/bin/env node
// Reads pre-aggregated Amazon Vendor invoice sell-in history and upserts it.
// Usage: node scripts/import-vendor-history.mjs <path-to-csv>
// Writes ONLY to vendor_history.

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Pool, neonConfig } from '@neondatabase/serverless';

neonConfig.webSocketConstructor = WebSocket;

const REQUIRED_HEADERS = [
  'market',
  'currency',
  'year',
  'month',
  'units',
  'net_revenue',
  'source',
];

function parseCSVLine(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }

  if (inQuotes) throw new Error('CSV contains an unterminated quoted field');
  fields.push(field);
  return fields;
}

function parseCSV(filePath) {
  let content = readFileSync(filePath, 'utf8');
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);

  const lines = content.split(/\r?\n/);
  const headers = parseCSVLine(lines[0] ?? '').map((header) => header.trim());
  const missingHeaders = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missingHeaders.length > 0) {
    throw new Error(`CSV is missing required headers: ${missingHeaders.join(', ')}`);
  }

  return lines.slice(1).flatMap((line, index) => {
    if (!line.trim()) return [];

    const values = parseCSVLine(line);
    if (values.length !== headers.length) {
      throw new Error(`CSV row ${index + 2} has ${values.length} fields; expected ${headers.length}`);
    }

    return [Object.fromEntries(headers.map((header, column) => [header, values[column].trim()]))];
  });
}

function validateRows(rows) {
  if (rows.length === 0) throw new Error('CSV contains no data rows');

  return rows.map((row, index) => {
    const rowNumber = index + 2;
    const year = Number(row.year);
    const month = Number(row.month);
    const units = Number(row.units);

    if (!row.market || !row.currency || !row.source) {
      throw new Error(`CSV row ${rowNumber} has a blank market, currency, or source`);
    }
    if (!Number.isInteger(year)) throw new Error(`CSV row ${rowNumber} has an invalid year`);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new Error(`CSV row ${rowNumber} has an invalid month`);
    }
    if (!Number.isSafeInteger(units)) throw new Error(`CSV row ${rowNumber} has invalid units`);
    if (!/^-?\d+(?:\.\d+)?$/.test(row.net_revenue)) {
      throw new Error(`CSV row ${rowNumber} has invalid net_revenue`);
    }

    return { ...row, year, month, units };
  });
}

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/import-vendor-history.mjs <path-to-csv>');
  process.exit(1);
}

const absolutePath = resolve(filePath);
console.log(`Reading: ${absolutePath}`);

const rows = validateRows(parseCSV(absolutePath));
console.log(`Parsed ${rows.length} data rows`);

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');

const pool = new Pool({ connectionString: DATABASE_URL });

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const row of rows) {
      await client.query(
        `INSERT INTO vendor_history
           (market, currency, year, month, units, net_revenue, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (market, year, month) DO UPDATE SET
           currency = EXCLUDED.currency,
           units = EXCLUDED.units,
           net_revenue = EXCLUDED.net_revenue,
           source = EXCLUDED.source,
           imported_at = now()`,
        [
          row.market,
          row.currency,
          row.year,
          row.month,
          row.units,
          row.net_revenue,
          row.source,
        ],
      );
    }

    await client.query('COMMIT');
    console.log(`Upserted ${rows.length} rows into vendor_history.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
