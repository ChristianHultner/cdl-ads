#!/usr/bin/env node
/**
 * fetch-b0-titles.mjs
 * One-time migration artifact: fetch product titles for a hardcoded
 * head list of B0 ASINs from amazon.es product pages.
 * Writes: ~/cdl-ads/artifacts/b0-titles-head.json
 */

import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = join(__dirname, '..', 'artifacts');

const ASINS = [
  'B0BSTMDQ5Y', 'B0BSTLRB5S', 'B0965W45ST', 'B005N0TKLM', 'B0050IPWLY',
  'B016C6841M', 'B07NV4P9Z2', 'B0BSTL6FJQ', 'B0CV74W5SF', 'B005N0TME2',
  'B07N6MVQN5', 'B06WW82S4V', 'B0087GZBNA', 'B01MYLTYJA', 'B086L41LGB',
  'B00TQ7UKCG', 'B0087GZ6OE', 'B01CIR4V2K', 'B016C685UW', 'B016C687BE',
];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const DELAY_MS = 5000;
const SUFFIX_RE = /\s*[\-–—|:,]\s*(versión kindle|ebook kindle|kindle edition|edición kindle|ebook|kindle)\s*$/i;
const BRACKET_RE = /\s*[\(\[（【][^\)\]）】]*[\)\]）】]\s*$/;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function extractTitle(html) {
  // Try #productTitle first
  const ptMatch = html.match(/id="productTitle"[^>]*>\s*([\s\S]*?)\s*<\/span>/i);
  if (ptMatch) {
    return ptMatch[1].replace(/\s+/g, ' ').trim();
  }
  // Fallback: og:title meta
  const ogMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
                || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  if (ogMatch) {
    return ogMatch[1].replace(/\s+/g, ' ').trim();
  }
  return null;
}

function cleanTitle(raw) {
  if (!raw) return raw;
  let t = raw.replace(/\s+/g, ' ').trim();
  // Strip Kindle suffixes
  t = t.replace(SUFFIX_RE, '').trim();
  // Strip bracketed/parenthetical trailers
  t = t.replace(BRACKET_RE, '').trim();
  return t;
}

async function fetchWithRetry(asin) {
  const url = `https://www.amazon.es/dp/${asin}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      if (res.status === 200) {
        const html = await res.text();
        // Detect captcha / robot check
        if (html.includes('Type the characters you see in this image')
            || html.includes('api-services-support@amazon.com')
            || html.includes('validateCaptcha')) {
          return { asin, status: 'captcha', raw_title: null, title: null };
        }
        const raw = extractTitle(html);
        const title = cleanTitle(raw);
        return { asin, status: 'ok', raw_title: raw, title };
      } else if (res.status === 404) {
        return { asin, status: '404', raw_title: null, title: null };
      } else if (res.status === 503) {
        if (attempt === 1) {
          console.error(`  ${asin}: 503 — waiting 8s before retry`);
          await sleep(8000);
          continue;
        }
        return { asin, status: '503', raw_title: null, title: null };
      } else {
        if (attempt === 1) {
          console.error(`  ${asin}: HTTP ${res.status} — retrying`);
          await sleep(3000);
          continue;
        }
        return { asin, status: `http_${res.status}`, raw_title: null, title: null };
      }
    } catch (err) {
      if (attempt === 1) {
        console.error(`  ${asin}: fetch error (${err.message}) — retrying`);
        await sleep(3000);
        continue;
      }
      return { asin, status: `error:${err.message}`, raw_title: null, title: null };
    }
  }
}

async function main() {
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  const results = [];

  for (let i = 0; i < ASINS.length; i++) {
    const asin = ASINS[i];
    console.log(`[${i + 1}/${ASINS.length}] ${asin} …`);
    const result = await fetchWithRetry(asin);
    console.log(`  → status=${result.status} title=${JSON.stringify(result.title)}`);
    results.push(result);
    if (i < ASINS.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  const out = join(ARTIFACTS_DIR, 'b0-titles-head.json');
  await writeFile(out, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\nWrote ${results.length} entries → ${out}`);

  const ok = results.filter(r => r.status === 'ok' && r.title).length;
  const fail = results.filter(r => r.status !== 'ok' || !r.title).length;
  console.log(`ok=${ok}  failed/no-title=${fail}`);
}

main().catch(err => { console.error(err); process.exit(1); });
