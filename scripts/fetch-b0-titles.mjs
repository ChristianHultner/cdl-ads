#!/usr/bin/env node
/**
 * fetch-b0-titles.mjs
 * Migration artifact: fetch product titles for B0 ASINs from Amazon product pages.
 *
 * Default (no --all):
 *   Uses the hardcoded head list of 20 ASINs, fetches from amazon.es.
 *   Writes: artifacts/b0-titles-head.json
 *
 * --all:
 *   Queries DB for all ENABLED B0 ASINs not yet in b0_hc_candidates.
 *   Resolves fetch domain by majority-profile rule (see PROFILE_DOMAIN /
 *   COUNTRY_DOMAIN below).  Appends to artifacts/b0-titles-tail.json.
 *   Resumable: skips ASINs already present in the output file.
 *
 * Domain resolution for --all:
 *   Profile 2263723137827296 (ES) → amazon.es
 *   Profile 139446882235960  (US) → amazon.com
 *   Profile 395707988492653  (MX) → amazon.com.mx
 *   Other profiles               → amazon_profiles.country_code → COUNTRY_DOMAIN
 *                                  else amazon.com
 *
 * Output shape per entry:
 *   { asin, domain, status, raw_title, title }
 *   status: 'ok' | '404' | '503' | 'captcha' | 'http_<N>' | 'error:<msg>'
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'node:util';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = join(__dirname, '..', 'artifacts');

// ── Args ─────────────────────────────────────────────────────────────────────
const { values: cliValues } = parseArgs({
  args:    process.argv.slice(2),
  options: {
    all:   { type: 'boolean', default: false },
    delay: { type: 'string',  default: '5'   },
  },
  strict:  false,
});
const ALL_MODE = cliValues.all === true;
const delayMs  = Math.max(0, Number(cliValues.delay ?? 5) || 5) * 1000;

// ── Head list (default mode) ─────────────────────────────────────────────────
const HEAD_ASINS = [
  'B0BSTMDQ5Y', 'B0BSTLRB5S', 'B0965W45ST', 'B005N0TKLM', 'B0050IPWLY',
  'B016C6841M', 'B07NV4P9Z2', 'B0BSTL6FJQ', 'B0CV74W5SF', 'B005N0TME2',
  'B07N6MVQN5', 'B06WW82S4V', 'B0087GZBNA', 'B01MYLTYJA', 'B086L41LGB',
  'B00TQ7UKCG', 'B0087GZ6OE', 'B01CIR4V2K', 'B016C685UW', 'B016C687BE',
];

// ── Domain maps ──────────────────────────────────────────────────────────────
// Known profile → domain (explicit per spec)
const PROFILE_DOMAIN = {
  '2263723137827296': 'amazon.es',
  '139446882235960':  'amazon.com',
  '395707988492653':  'amazon.com.mx',
};

// country_code fallback for other profiles
const COUNTRY_DOMAIN = {
  ES: 'amazon.es',
  US: 'amazon.com',
  MX: 'amazon.com.mx',
  DE: 'amazon.de',
  FR: 'amazon.fr',
  IT: 'amazon.it',
  GB: 'amazon.co.uk',
  UK: 'amazon.co.uk',
  CA: 'amazon.ca',
  JP: 'amazon.co.jp',
  IN: 'amazon.in',
  BR: 'amazon.com.br',
  AU: 'amazon.com.au',
  NL: 'amazon.nl',
  SE: 'amazon.se',
  PL: 'amazon.pl',
  TR: 'amazon.com.tr',
  SA: 'amazon.sa',
  AE: 'amazon.ae',
  SG: 'amazon.sg',
};

function domainForProfile(profileId, countryCode) {
  if (PROFILE_DOMAIN[profileId])                                      return PROFILE_DOMAIN[profileId];
  if (countryCode && COUNTRY_DOMAIN[countryCode.toUpperCase()])       return COUNTRY_DOMAIN[countryCode.toUpperCase()];
  return 'amazon.com';
}

function acceptLang(domain) {
  if (domain === 'amazon.es' || domain === 'amazon.com.mx')           return 'es-ES,es;q=0.9,en;q=0.8';
  if (domain === 'amazon.de')                                         return 'de-DE,de;q=0.9,en;q=0.8';
  if (domain === 'amazon.fr')                                         return 'fr-FR,fr;q=0.9,en;q=0.8';
  if (domain === 'amazon.it')                                         return 'it-IT,it;q=0.9,en;q=0.8';
  if (domain === 'amazon.co.jp')                                      return 'ja-JP,ja;q=0.9,en;q=0.8';
  return 'en-US,en;q=0.9';
}

// ── Constants ─────────────────────────────────────────────────────────────────
const UA         = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const SUFFIX_RE  = /\s*[\-\u2013\u2014|:,]\s*(versi[oó]n kindle|ebook kindle|kindle edition|edici[oó]n kindle|ebook|kindle)\s*$/i;
const BRACKET_RE = /\s*[\(\[（【][^\)\]）】]*[\)\]）】]\s*$/;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractTitle(html) {
  const ptMatch = html.match(/id="productTitle"[^>]*>\s*([\s\S]*?)\s*<\/span>/i);
  if (ptMatch) return ptMatch[1].replace(/\s+/g, ' ').trim();
  const ogMatch =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  if (ogMatch) return ogMatch[1].replace(/\s+/g, ' ').trim();
  return null;
}

function cleanTitle(raw) {
  if (!raw) return raw;
  let t = raw.replace(/\s+/g, ' ').trim();
  t = t.replace(SUFFIX_RE, '').trim();
  t = t.replace(BRACKET_RE, '').trim();
  return t;
}

// ── Fetch one ASIN (1 retry) ─────────────────────────────────────────────────
async function fetchOne(asin, domain) {
  const url  = `https://www.${domain}/dp/${asin}`;
  const lang = acceptLang(domain);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':      UA,
          'Accept-Language': lang,
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      if (res.status === 200) {
        const html = await res.text();
        if (
          html.includes('Type the characters you see in this image') ||
          html.includes('api-services-support@amazon.com')           ||
          html.includes('validateCaptcha')
        ) {
          return { asin, domain, status: 'captcha', raw_title: null, title: null };
        }
        const raw   = extractTitle(html);
        const title = cleanTitle(raw);
        return { asin, domain, status: 'ok', raw_title: raw, title };

      } else if (res.status === 404) {
        return { asin, domain, status: '404', raw_title: null, title: null };

      } else if (res.status === 503) {
        if (attempt === 1) { console.error(`  ${asin}: 503 — waiting 8s before retry`); await sleep(8000); continue; }
        return { asin, domain, status: '503', raw_title: null, title: null };

      } else {
        if (attempt === 1) { console.error(`  ${asin}: HTTP ${res.status} — retrying`); await sleep(3000); continue; }
        return { asin, domain, status: `http_${res.status}`, raw_title: null, title: null };
      }

    } catch (err) {
      if (attempt === 1) { console.error(`  ${asin}: fetch error (${err.message}) — retrying`); await sleep(3000); continue; }
      return { asin, domain, status: `error:${err.message}`, raw_title: null, title: null };
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  await mkdir(ARTIFACTS_DIR, { recursive: true });

  // ── Default mode: head list, amazon.es → b0-titles-head.json ─────────────
  if (!ALL_MODE) {
    const results = [];
    for (let i = 0; i < HEAD_ASINS.length; i++) {
      const asin = HEAD_ASINS[i];
      console.log(`[${i + 1}/${HEAD_ASINS.length}] ${asin} (amazon.es) …`);
      const result = await fetchOne(asin, 'amazon.es');
      console.log(`  → status=${result.status} title=${JSON.stringify(result.title)}`);
      results.push(result);
      if (i < HEAD_ASINS.length - 1) await sleep(delayMs);
    }
    const out = join(ARTIFACTS_DIR, 'b0-titles-head.json');
    await writeFile(out, JSON.stringify(results, null, 2), 'utf8');
    console.log(`\nWrote ${results.length} entries → ${out}`);
    const ok = results.filter(r => r.status === 'ok' && r.title).length;
    console.log(`ok=${ok}  failed/no-title=${results.length - ok}`);
    return;
  }

  // ── --all mode: DB-driven, domain per majority profile ─────────────────────
  const { Pool, neonConfig } = await import('@neondatabase/serverless');
  neonConfig.webSocketConstructor = WebSocket;

  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL) throw new Error('DATABASE_URL not set');

  const pool = new Pool({ connectionString: DATABASE_URL });

  // Majority-profile query: for each uncovered B0, the profile with the most ad rows wins.
  const { rows: asinRows } = await pool.query(`
    WITH ranked AS (
      SELECT pa.asin,
             pa.profile_id::text   AS profile_id,
             COUNT(*)               AS ad_rows,
             ROW_NUMBER() OVER (
               PARTITION BY pa.asin
               ORDER BY COUNT(*) DESC
             ) AS rn
      FROM amazon_product_ads pa
      LEFT JOIN b0_hc_candidates hc ON hc.b0_asin = pa.asin
      WHERE pa.asin ILIKE 'B0%'
        AND hc.b0_asin IS NULL
      GROUP BY pa.asin, pa.profile_id
    )
    SELECT r.asin, r.profile_id, p.country_code
    FROM ranked r
    JOIN amazon_profiles p ON p.profile_id::text = r.profile_id
    WHERE r.rn = 1
    ORDER BY r.asin
  `);

  await pool.end();

  console.log(`Uncovered B0 ASINs from DB: ${asinRows.length}`);

  // Build (asin, domain) list
  const asinDomains = asinRows.map(r => ({
    asin:   r.asin,
    domain: domainForProfile(r.profile_id, r.country_code),
  }));

  // Summary of domain distribution
  const domainCount = {};
  for (const { domain } of asinDomains) domainCount[domain] = (domainCount[domain] ?? 0) + 1;
  console.log('Domain distribution:', JSON.stringify(domainCount));

  // Load existing tail file for resumability
  const outPath = join(ARTIFACTS_DIR, 'b0-titles-tail.json');
  let existingResults = [];
  try {
    existingResults = JSON.parse(await readFile(outPath, 'utf8'));
    console.log(`Loaded ${existingResults.length} existing entries (resuming)`);
  } catch {
    console.log('Starting fresh tail file.');
  }
  // Resume: skip ONLY entries with a non-null title.
  // Entries with title=null (captcha/failed/404/error) are retried on re-run
  // and their existing json entries are overwritten by the new attempt.
  const resultsMap = new Map(existingResults.map(r => [r.asin, r]));
  const doneSet    = new Set(existingResults.filter(r => r.title != null).map(r => r.asin));

  const toFetch = asinDomains.filter(({ asin }) => !doneSet.has(asin));
  console.log(`To fetch: ${toFetch.length}  (skipping ${doneSet.size} with confirmed title)\n`);

  for (let i = 0; i < toFetch.length; i++) {
    const { asin, domain } = toFetch[i];
    console.log(`[${i + 1}/${toFetch.length}] ${asin} (${domain}) …`);
    const result = await fetchOne(asin, domain);
    console.log(`  → status=${result.status} title=${JSON.stringify(result.title)}`);
    resultsMap.set(asin, result);  // upsert — overwrites null-title entry if present
    // Write after every entry — safe resume point if killed
    await writeFile(outPath, JSON.stringify([...resultsMap.values()], null, 2), 'utf8');
    if (i < toFetch.length - 1) await sleep(delayMs);
  }

  const allResults = [...resultsMap.values()];
  const ok   = allResults.filter(r => r.status === 'ok' && r.title).length;
  const fail = allResults.filter(r => r.status !== 'ok' || !r.title).length;
  console.log(`\nWrote ${allResults.length} total entries → ${outPath}`);
  console.log(`ok=${ok}  failed/no-title=${fail}`);
}

main().catch(err => { console.error(err); process.exit(1); });
