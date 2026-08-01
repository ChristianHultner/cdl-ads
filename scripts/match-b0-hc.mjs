#!/usr/bin/env node
/**
 * match-b0-hc.mjs
 * Reads b0-titles-head.json + catalog from /list.
 * Dry-run default: prints proposed pairs.
 * --execute: upserts PROPOSED rows into b0_hc_candidates (never overwrites CONFIRMED/REJECTED).
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Pool, neonConfig } from '@neondatabase/serverless';

neonConfig.webSocketConstructor = WebSocket;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = join(__dirname, '..', 'artifacts');

const { DATABASE_URL, CDL_BOOKS_API_KEY, CDL_BOOKS_API_URL } = process.env;
const BOOKS_BASE = CDL_BOOKS_API_URL ?? 'https://books.cuentodeluz.com';

const execute = process.argv.includes('--execute');

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------
const EDITION_NOISE = [
  /versión kindle/gi,
  /\(spanish edition\)/gi,
  /\(english edition\)/gi,
  /ebook kindle/gi,
  /edición kindle/gi,
  /\bkindle\b/gi,
  /\bebook\b/gi,
  /\bedición\b/gi,
  /\bboard book\b/gi,
];
const BRACKET_RE   = /[\(\[（【][^\)\]）】]*[\)\]）】]/g;
const PUNCT_RE     = /[^a-z0-9\s]/g;
const MULTI_SP_RE  = /\s+/g;

function normalize(str) {
  if (!str) return '';
  let s = str.toLowerCase();
  // strip accents
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // strip edition noise
  for (const re of EDITION_NOISE) s = s.replace(re, ' ');
  // strip bracketed trailers
  s = s.replace(BRACKET_RE, ' ');
  // strip punctuation
  s = s.replace(PUNCT_RE, ' ');
  // collapse whitespace
  s = s.replace(MULTI_SP_RE, ' ').trim();
  return s;
}

// ---------------------------------------------------------------------------
// Token-Jaccard
// ---------------------------------------------------------------------------
function jaccard(a, b) {
  const setA = new Set(a.split(' ').filter(Boolean));
  const setB = new Set(b.split(' ').filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 0;
  const inter = new Set([...setA].filter(t => setB.has(t)));
  const union = new Set([...setA, ...setB]);
  return inter.size / union.size;
}

// ---------------------------------------------------------------------------
// Language heuristic (Spanish stopwords)
// ---------------------------------------------------------------------------
const ES_STOPS = new Set(['el','la','los','las','un','una','unos','unas','de','del',
  'en','y','que','es','con','por','para','al','se','le','su','una','pero','como',
  'yo','tu','mi','me','te','nos','vos','ellos','ellas','era','ser','ha','han',
  'muy','más','si','no','yo','sus']);

function guessLanguage(title) {
  if (!title) return null;
  const words = title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').split(/\s+/);
  const hits = words.filter(w => ES_STOPS.has(w)).length;
  return hits >= 2 ? 'es' : (hits === 0 ? 'en' : null);
}

// ---------------------------------------------------------------------------
// Catalog fetch
// ---------------------------------------------------------------------------
async function fetchCatalog() {
  const res = await fetch(`${BOOKS_BASE}/api/v1/books/public/list`, {
    headers: { 'X-Api-Key': CDL_BOOKS_API_KEY },
  });
  if (!res.ok) throw new Error(`/api/v1/books/public/list returned HTTP ${res.status}`);
  const data = await res.json();
  const entries = data.books ?? [];
  return entries;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!DATABASE_URL)      throw new Error('DATABASE_URL not set');
  if (!CDL_BOOKS_API_KEY) throw new Error('CDL_BOOKS_API_KEY not set');

  // Load b0 titles
  const titlesPath = join(ARTIFACTS_DIR, 'b0-titles-head.json');
  const rawTitles = JSON.parse(await readFile(titlesPath, 'utf8'));
  // Map asin → title (null if unavailable)
  const asinTitle = {};
  for (const entry of rawTitles) {
    asinTitle[entry.asin] = (entry.title && entry.status === 'ok') ? entry.title : null;
  }

  // Fetch catalog
  console.log('Fetching catalog from /list …');
  const catalog = await fetchCatalog();
  console.log(`Catalog entries: ${catalog.length}`);

  // Build group map: group_id → entries[]
  const groupMap = {};
  for (const entry of catalog) {
    const gid = entry.group_id;
    if (!groupMap[gid]) groupMap[gid] = [];
    groupMap[gid].push(entry);
  }

  // Pre-normalise catalog
  const normCatalog = catalog.map(e => ({ ...e, _norm: normalize(e.title) }));

  const proposals = [];

  for (const [b0asin, rawTitle] of Object.entries(asinTitle)) {
    if (!rawTitle) {
      proposals.push({
        b0_asin: b0asin,
        amazon_title: null,
        hc_isbn13: null,
        hc_title: null,
        confidence: 0,
        method: 'no_title',
        matched_via: null,
        status: 'NO_MATCH',
      });
      continue;
    }

    const normB0 = normalize(rawTitle);
    const b0Lang = guessLanguage(rawTitle);

    let bestScore = 0;
    let bestEntry = null;
    let bestMethod = null;

    for (const ce of normCatalog) {
      if (!ce._norm) continue;
      let score, method;
      if (normB0 === ce._norm) {
        score = 1.0;
        method = 'exact';
      } else {
        score = jaccard(normB0, ce._norm);
        method = 'jaccard';
      }
      if (score > bestScore) {
        bestScore = score;
        bestEntry = ce;
        bestMethod = method;
      }
    }

    if (bestScore < 0.35 || !bestEntry) {
      proposals.push({
        b0_asin: b0asin,
        amazon_title: rawTitle,
        hc_isbn13: null,
        hc_title: null,
        confidence: Math.round(bestScore * 10000) / 10000,
        method: bestMethod ?? 'jaccard',
        matched_via: null,
        status: 'NO_MATCH',
      });
      continue;
    }

    // Language mismatch check
    const catLang = bestEntry.language ?? null;
    let confidence = Math.round(bestScore * 10000) / 10000;
    if (b0Lang && catLang && b0Lang !== catLang) {
      confidence = Math.round(confidence * 0.5 * 10000) / 10000;
    }

    // Resolve HC via group_id
    const groupEntries = groupMap[bestEntry.group_id] ?? [];
    const hcEntry = groupEntries.find(e => e.format === 'HC');

    if (!hcEntry) {
      proposals.push({
        b0_asin: b0asin,
        amazon_title: rawTitle,
        hc_isbn13: null,
        hc_title: null,
        confidence,
        method: 'no_hc_in_group',
        matched_via: bestEntry.format,
        status: 'NO_MATCH',
      });
      continue;
    }

    proposals.push({
      b0_asin: b0asin,
      amazon_title: rawTitle,
      hc_isbn13: hcEntry.isbn,
      hc_title: hcEntry.title,
      confidence,
      method: bestMethod,
      matched_via: bestEntry.format,
      status: 'PROPOSED',
    });
  }

  // ---------------------------------------------------------------------------
  // Dry-run report
  // ---------------------------------------------------------------------------
  const proposed   = proposals.filter(p => p.status === 'PROPOSED');
  const noMatch    = proposals.filter(p => p.status === 'NO_MATCH');
  const exact      = proposed.filter(p => p.method === 'exact');
  const high       = proposed.filter(p => p.confidence >= 0.7 && p.confidence < 1.0);
  const mid        = proposed.filter(p => p.confidence >= 0.35 && p.confidence < 0.7);
  const noHc       = noMatch.filter(p => p.method === 'no_hc_in_group');
  const noTitle    = noMatch.filter(p => p.method === 'no_title');
  const lowScore   = noMatch.filter(p => p.method !== 'no_hc_in_group' && p.method !== 'no_title');

  console.log('\n=== DRY-RUN DISTRIBUTION ===');
  console.log(`exact (1.0):          ${exact.length}`);
  console.log(`high  (0.7–0.99):     ${high.length}`);
  console.log(`mid   (0.35–0.69):    ${mid.length}`);
  console.log(`NO_MATCH low-score:   ${lowScore.length}`);
  console.log(`NO_MATCH no_hc_in_group: ${noHc.length}`);
  console.log(`NO_MATCH no_title:    ${noTitle.length}`);
  console.log(`Total:                ${proposals.length}`);

  console.log('\n=== ALL 20 PROPOSED PAIRS ===');
  for (const p of proposals) {
    console.log(JSON.stringify({
      b0: p.b0_asin,
      amazon_title: p.amazon_title,
      hc_title: p.hc_title,
      hc_isbn13: p.hc_isbn13,
      confidence: p.confidence,
      method: p.method,
      matched_via: p.matched_via,
      status: p.status,
    }));
  }

  if (!execute) {
    console.log('\n(dry-run — pass --execute to write to DB)');
    return;
  }

  // ---------------------------------------------------------------------------
  // Execute: upsert PROPOSED rows only; never overwrite CONFIRMED/REJECTED
  // ---------------------------------------------------------------------------
  const pool = new Pool({ connectionString: DATABASE_URL });
  let upserted = 0;
  let skipped  = 0;

  for (const p of proposals) {
    const res = await pool.query(`
      INSERT INTO b0_hc_candidates
        (b0_asin, amazon_title, hc_isbn13, hc_title, confidence, method, matched_via, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (b0_asin) DO UPDATE SET
        amazon_title = EXCLUDED.amazon_title,
        hc_isbn13    = EXCLUDED.hc_isbn13,
        hc_title     = EXCLUDED.hc_title,
        confidence   = EXCLUDED.confidence,
        method       = EXCLUDED.method,
        matched_via  = EXCLUDED.matched_via,
        status       = EXCLUDED.status,
        created_at   = b0_hc_candidates.created_at
      WHERE b0_hc_candidates.status NOT IN ('CONFIRMED','REJECTED')
    `, [p.b0_asin, p.amazon_title, p.hc_isbn13, p.hc_title, p.confidence, p.method, p.matched_via, p.status]);
    if (res.rowCount > 0) upserted++; else skipped++;
  }

  await pool.end();
  console.log(`\n--execute done: upserted=${upserted}  skipped(protected)=${skipped}`);
}

main().catch(err => { console.error(err); process.exit(1); });
