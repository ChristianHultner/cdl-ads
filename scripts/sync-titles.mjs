import { Pool, neonConfig } from '@neondatabase/serverless';

// ---------------------------------------------------------------------------
// Env pattern (document for operators):
//   cd ~/cdl-ads && vercel env pull .env.local --environment production &&
//   set -a; source .env.local; source ~/secrets/cdl-ads-books.env; set +a
// ---------------------------------------------------------------------------

// Node 22+ native WebSocket
neonConfig.webSocketConstructor = WebSocket;

// ---------------------------------------------------------------------------
// Endpoint — BEST GUESS; shape confirmed by first probe at runtime, never
// assumed. Adjust if the API uses a different path (e.g. /api/books/<isbn>).
// ---------------------------------------------------------------------------
const BOOKS_API_PATH = '/api/public/books'; // /<asin> appended per call

const DELAY_MS = 100; // ms between API calls

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
// Candidate ASINs: in amazon_product_ads but not recently cached (30 days)
// ---------------------------------------------------------------------------
const { rows: candidateRows } = await pool.query(
  `SELECT DISTINCT pa.asin
     FROM amazon_product_ads pa
    WHERE pa.asin IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM title_cache tc
         WHERE tc.asin = pa.asin
           AND tc.fetched_at > now() - interval '30 days'
      )
    ORDER BY pa.asin`,
);

const candidates = candidateRows.map(r => r.asin);
console.log(`sync-titles: ${candidates.length} candidate ASINs`);

if (candidates.length === 0) {
  console.log('sync-titles: nothing to do');
  await pool.end();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------
async function fetchBook(asin) {
  return fetch(`${CDL_BOOKS_API_URL}${BOOKS_API_PATH}/${encodeURIComponent(asin)}`, {
    headers: {
      'X-Api-Key': CDL_BOOKS_API_KEY,
      'Accept':    'application/json',
    },
  });
}

// ---------------------------------------------------------------------------
// PROBE: first ASIN — confirm auth + shape before bulk run.
//   401/403            → auth failure   → EXIT nonzero
//   2xx, bad shape     → unrecognized   → EXIT nonzero
//   2xx, title present → shape confirmed → proceed
//   404                → auth OK, ASIN not in books DB → proceed
//   anything else      → unexpected     → EXIT nonzero
// The main loop re-fetches this ASIN; probe is validation only.
// ---------------------------------------------------------------------------
{
  const probeAsin = candidates[0];
  console.log(`sync-titles: probing ${probeAsin}…`);

  let probeRes;
  try {
    probeRes = await fetchBook(probeAsin);
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
    if (!body || typeof body.title !== 'string') {
      console.error(`probe: unrecognized shape (HTTP ${probeRes.status}): ${raw.slice(0, 300)}`);
      await pool.end();
      process.exit(1);
    }
    console.log(`probe: shape confirmed via ${probeAsin} (title present)`);
  } else if (probeRes.status === 404) {
    console.log(`probe: 404 on ${probeAsin} — auth OK, endpoint reachable`);
  } else {
    const body = await probeRes.text();
    console.error(`probe: unexpected HTTP ${probeRes.status}: ${body.slice(0, 300)}`);
    await pool.end();
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Process all candidates
// ---------------------------------------------------------------------------
let found = 0, notFound = 0, errors = 0;

for (const asin of candidates) {
  let res;
  try {
    res = await fetchBook(asin);
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
    const title     = body.title     ?? null;
    const cover_url = body.coverUrl  ?? body.cover_url ?? body.cover ?? null;
    await pool.query(
      `INSERT INTO title_cache (asin, title, cover_url, found, fetched_at)
       VALUES ($1, $2, $3, true, now())
       ON CONFLICT (asin) DO UPDATE SET
         title      = EXCLUDED.title,
         cover_url  = EXCLUDED.cover_url,
         found      = true,
         fetched_at = EXCLUDED.fetched_at`,
      [asin, title, cover_url],
    );
    console.log(`${asin}: found — ${title}`);
    found++;
  } else if (res.status === 404) {
    // Negative cache — third-party ASINs stay quiet for 30 days
    await pool.query(
      `INSERT INTO title_cache (asin, found, fetched_at)
       VALUES ($1, false, now())
       ON CONFLICT (asin) DO UPDATE SET
         found      = false,
         fetched_at = EXCLUDED.fetched_at`,
      [asin],
    );
    notFound++;
  } else {
    const body = await res.text();
    console.error(`${asin}: HTTP ${res.status} — ${body.slice(0, 200)}`);
    errors++;
  }

  await new Promise(r => setTimeout(r, DELAY_MS));
}

await pool.end();

// Summary — nonzero exit only on auth/shape failure (handled above in probe)
console.log(`sync-titles: candidates ${candidates.length}, found ${found}, not-found ${notFound}, errors ${errors}`);
