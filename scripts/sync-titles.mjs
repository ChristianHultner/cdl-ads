import { Pool, neonConfig } from '@neondatabase/serverless';
import { isbn10ToIsbn13 } from './lib/isbn.mjs';

// ---------------------------------------------------------------------------
// Env pattern (document for operators):
//   cd ~/cdl-ads && vercel env pull .env.local --environment production &&
//   set -a; source .env.local; source ~/secrets/cdl-ads-books.env; set +a
// ---------------------------------------------------------------------------

// Node 22+ native WebSocket
neonConfig.webSocketConstructor = WebSocket;

// ---------------------------------------------------------------------------
// Endpoint — verified live 2026-07-26. GET ?isbns=<isbn13> returns envelope
// { books: [{isbn, found, title, cover_url, …}], count }.
// NOTE: cdl-books requires ISBN-13; we convert ISBN-10s before querying.
// ---------------------------------------------------------------------------
const BOOKS_API_PATH = '/api/v1/books/public'; // ?isbns=<isbn13> query param

const DELAY_MS = 100; // ms between API calls

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const profileArgIdx = process.argv.indexOf('--profile');
const profileId     = profileArgIdx !== -1 ? process.argv[profileArgIdx + 1] : null;
if (profileId) console.log(`sync-titles: filtering to profile ${profileId}`);

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------
const CDL_BOOKS_API_URL = process.env.CDL_BOOKS_API_URL ?? 'https://books.cuentodeluz.com';
const CDL_BOOKS_API_KEY = process.env.CDL_BOOKS_API_KEY;
if (!CDL_BOOKS_API_KEY)
  throw new Error('CDL_BOOKS_API_KEY not set — source ~/secrets/cdl-ads-books.env');

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------
const pool = new Pool({ connectionString: DATABASE_URL });

// ---------------------------------------------------------------------------
// ASIN classifier
//   isbn10  → ^[0-9]{9}[0-9Xx]$  (10 chars, standard ISBN-10 shape)
//   b0      → ^B0[A-Z0-9]{8}$    (10 chars, Kindle ASIN; cannot convert)
//   other   → everything else
// ---------------------------------------------------------------------------
function classifyAsin(asin) {
  if (/^[0-9]{9}[0-9Xx]$/.test(asin)) return 'isbn10';
  if (/^B0[A-Z0-9]{8}$/.test(asin))   return 'b0';
  return 'other';
}

// ---------------------------------------------------------------------------
// Candidate ASINs: in amazon_product_ads but not recently cached (30 days),
// AND not permanently settled (no_isbn_bridge / unrecognized_shape are never
// retried regardless of age).
// ---------------------------------------------------------------------------
const candidateQuery = profileId
  ? `SELECT DISTINCT pa.asin
       FROM amazon_product_ads pa
      WHERE pa.asin IS NOT NULL
        AND pa.profile_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM title_cache tc
           WHERE tc.asin = pa.asin
             AND (
               tc.fetched_at > now() - interval '30 days'
               OR tc.status IN ('no_isbn_bridge', 'unrecognized_shape')
             )
        )
      ORDER BY pa.asin`
  : `SELECT DISTINCT pa.asin
       FROM amazon_product_ads pa
      WHERE pa.asin IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM title_cache tc
           WHERE tc.asin = pa.asin
             AND (
               tc.fetched_at > now() - interval '30 days'
               OR tc.status IN ('no_isbn_bridge', 'unrecognized_shape')
             )
        )
      ORDER BY pa.asin`;

const { rows: candidateRows } = await pool.query(
  candidateQuery,
  profileId ? [profileId] : [],
);

const candidates = candidateRows.map(r => r.asin);
console.log(`sync-titles: ${candidates.length} candidate ASINs`);

if (candidates.length === 0) {
  console.log('sync-titles: nothing to do');
  await pool.end();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Partition: settle non-queryable ASINs immediately (no API call)
// ---------------------------------------------------------------------------
const isbn10Candidates = [];
let noIsbnBridge = 0, unrecognizedShape = 0;

for (const asin of candidates) {
  const kind = classifyAsin(asin);
  if (kind === 'isbn10') {
    isbn10Candidates.push(asin);
    continue;
  }

  const status = kind === 'b0' ? 'no_isbn_bridge' : 'unrecognized_shape';
  await pool.query(
    `INSERT INTO title_cache (asin, found, status, fetched_at)
     VALUES ($1, false, $2, now())
     ON CONFLICT (asin) DO UPDATE SET
       found      = false,
       status     = EXCLUDED.status,
       fetched_at = EXCLUDED.fetched_at`,
    [asin, status],
  );

  if (kind === 'b0') {
    console.log(`${asin}: no_isbn_bridge (B0 Kindle ASIN — skipped)`);
    noIsbnBridge++;
  } else {
    console.log(`${asin}: unrecognized_shape — skipped`);
    unrecognizedShape++;
  }
}

console.log(`sync-titles: partitioned — isbn10: ${isbn10Candidates.length}, no_isbn_bridge: ${noIsbnBridge}, unrecognized_shape: ${unrecognizedShape}`);

if (isbn10Candidates.length === 0) {
  console.log('sync-titles: no ISBN-10 candidates to query');
  await pool.end();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Fetch helper — always sends ISBN-13 to the books API
// ---------------------------------------------------------------------------
async function fetchBook(isbn13) {
  return fetch(`${CDL_BOOKS_API_URL}${BOOKS_API_PATH}?isbns=${encodeURIComponent(isbn13)}`, {
    headers: {
      'X-Api-Key': CDL_BOOKS_API_KEY,
      'Accept':    'application/json',
      ...(process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
        ? {
            'CF-Access-Client-Id':     process.env.CF_ACCESS_CLIENT_ID,
            'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET,
          }
        : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// PROBE: first ISBN-10 candidate — confirm auth + shape before bulk run.
//   Uses the converted ISBN-13 for the actual request.
//   401/403            → auth failure   → EXIT nonzero
//   2xx, bad shape     → unrecognized   → EXIT nonzero
//   2xx, title present → shape confirmed → proceed
//   not-found          → auth OK, ASIN not in books DB → proceed
//   anything else      → unexpected     → EXIT nonzero
// The main loop re-processes this ASIN; probe is validation only.
// ---------------------------------------------------------------------------
{
  const probeAsin   = isbn10Candidates[0];
  const probeIsbn13 = isbn10ToIsbn13(probeAsin);
  console.log(`sync-titles: probing ${probeAsin} → ${probeIsbn13}…`);

  let probeRes;
  try {
    probeRes = await fetchBook(probeIsbn13);
  } catch (err) {
    console.error(`probe: network error — ${err.message}`);
    await pool.end();
    process.exit(1);
  }

  if (probeRes.status === 401 || probeRes.status === 403) {
    const body = await probeRes.text();
    console.error(`probe: auth failed (HTTP ${probeRes.status}): ${body.slice(0, 300)}`);
    await pool.end();
    process.exit(1);
  }

  if (probeRes.ok) {
    const raw = await probeRes.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch (_) {
      console.error(`probe: response not valid JSON (HTTP ${probeRes.status}): ${raw.slice(0, 300)}`);
      await pool.end();
      process.exit(1);
    }
    if (!body || !Array.isArray(body.books)) {
      console.error(`probe: unrecognized shape (HTTP ${probeRes.status}): ${raw.slice(0, 300)}`);
      await pool.end();
      process.exit(1);
    }
    const probeRecord = body.books[0];
    if (probeRecord?.found) {
      if (typeof probeRecord.title !== 'string' || !('cover_url' in probeRecord)) {
        console.error(`probe: unexpected record keys — ${JSON.stringify(Object.keys(probeRecord))}`);
        await pool.end();
        process.exit(1);
      }
      console.log(`probe: shape confirmed via ${probeAsin}→${probeIsbn13} (title present)`);
    } else {
      console.log(`probe: not-found on ${probeIsbn13} — auth OK, endpoint reachable`);
    }
  } else {
    const body = await probeRes.text();
    console.error(`probe: unexpected HTTP ${probeRes.status}: ${body.slice(0, 300)}`);
    await pool.end();
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Process all ISBN-10 candidates
// Row keyed by original ASIN; isbn13 column stores the EAN-13 sent to API.
// ---------------------------------------------------------------------------
let found = 0, notFound = 0, errors = 0;

for (const asin of isbn10Candidates) {
  const isbn13 = isbn10ToIsbn13(asin); // guaranteed non-null (classifier ensures ^[0-9]{9}[0-9Xx]$)

  let res;
  try {
    res = await fetchBook(isbn13);
  } catch (err) {
    console.error(`${asin}: fetch error — ${err.message}`);
    errors++;
    await new Promise(r => setTimeout(r, DELAY_MS));
    continue;
  }

  if (res.ok) {
    let body;
    try {
      body = await res.json();
    } catch (err) {
      console.error(`${asin}: JSON parse error — ${err.message}`);
      errors++;
      await new Promise(r => setTimeout(r, DELAY_MS));
      continue;
    }

    const record = body.books?.[0];
    if (record?.found) {
      const title     = record.title     ?? null;
      const cover_url = record.cover_url ?? null;
      await pool.query(
        `INSERT INTO title_cache (asin, isbn13, title, cover_url, found, status, fetched_at)
         VALUES ($1, $2, $3, $4, true, 'found', now())
         ON CONFLICT (asin) DO UPDATE SET
           isbn13     = EXCLUDED.isbn13,
           title      = EXCLUDED.title,
           cover_url  = EXCLUDED.cover_url,
           found      = true,
           status     = 'found',
           fetched_at = EXCLUDED.fetched_at`,
        [asin, isbn13, title, cover_url],
      );
      console.log(`${asin} → ${isbn13}: found — ${title}`);
      found++;
    } else {
      // found:false on a converted ISBN-13 = genuine catalog miss
      await pool.query(
        `INSERT INTO title_cache (asin, isbn13, found, status, fetched_at)
         VALUES ($1, $2, false, 'not_in_catalog', now())
         ON CONFLICT (asin) DO UPDATE SET
           isbn13     = EXCLUDED.isbn13,
           found      = false,
           status     = 'not_in_catalog',
           fetched_at = EXCLUDED.fetched_at`,
        [asin, isbn13],
      );
      console.log(`${asin} → ${isbn13}: not_in_catalog`);
      notFound++;
    }
  } else {
    const body = await res.text();
    console.error(`${asin}: HTTP ${res.status} — ${body.slice(0, 200)}`);
    errors++;
  }

  await new Promise(r => setTimeout(r, DELAY_MS));
}

await pool.end();

// Summary
console.log(
  `sync-titles: candidates ${candidates.length}, ` +
  `isbn10 ${isbn10Candidates.length}, ` +
  `no_isbn_bridge ${noIsbnBridge}, ` +
  `unrecognized_shape ${unrecognizedShape}, ` +
  `found ${found}, not_in_catalog ${notFound}, errors ${errors}`,
);
