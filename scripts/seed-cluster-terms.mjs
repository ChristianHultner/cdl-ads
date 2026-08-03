// scripts/seed-cluster-terms.mjs
// Usage: node --env-file=.env.local scripts/seed-cluster-terms.mjs \
//   --cluster "Bienestar y Camino de Vida" --language spa --profile <id>
//
// Read-only analysis: for a given cluster, resolves the cluster's ASINs via
// book_clusters → title_cache, then from amazon_search_term_daily pulls search
// terms that CONVERTED (purchases_14d > 0) on those ASINs' traffic over the
// past 365 days, aggregated by term (clicks, orders, spend).
// Outputs top 30 by orders to artifacts/seed-<cluster-slug>.json and prints
// a table. These are the keyword seeds — terms the cluster's books already
// prove they win.
//
// ⚠  READ-ONLY — no DB writes, no API calls.

import { parseArgs }       from 'node:util';
import { writeFileSync }   from 'node:fs';
import { fileURLToPath }   from 'node:url';
import { join, dirname }   from 'node:path';
import { Pool, neonConfig } from '@neondatabase/serverless';

// Node 22+ native WebSocket
neonConfig.webSocketConstructor = WebSocket;

// ── Args ─────────────────────────────────────────────────────────────────────
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    cluster:  { type: 'string' },
    language: { type: 'string' },
    profile:  { type: 'string' },
  },
});
if (!values.cluster)  throw new Error('--cluster "<name>" required');
if (!values.language) throw new Error('--language <lang> required');
if (!values.profile)  throw new Error('--profile <id> required');

const clusterName = values.cluster;
const language    = values.language;
const profileId   = BigInt(values.profile);

// ── Slug helper ───────────────────────────────────────────────────────────────
// "Bienestar y Camino de Vida" → "bienestar-y-camino-de-vida"
const toSlug = (s) =>
  s.toLowerCase()
   .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
   .replace(/\s+/g, '-')
   .replace(/[^a-z0-9-]/g, '');

const clusterSlug = toSlug(clusterName);

// ── Paths ─────────────────────────────────────────────────────────────────────
const __dirname    = dirname(fileURLToPath(import.meta.url));
const artifactsDir = join(__dirname, '..', 'artifacts');
const outputPath   = join(artifactsDir, `seed-${clusterSlug}.json`);

// ── DB ───────────────────────────────────────────────────────────────────────
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
const pool = new Pool({ connectionString: DATABASE_URL });

// ── 1. Cluster → ISBNs → ASINs via title_cache ───────────────────────────────
const { rows: clusterRows } = await pool.query(
  `SELECT bc.isbn13, bc.work_title, tc.asin
     FROM book_clusters bc
     JOIN title_cache   tc ON tc.isbn13 = bc.isbn13
    WHERE bc.cluster_name = $1
      AND bc.language     = $2
    ORDER BY bc.isbn13`,
  [clusterName, language],
);

if (clusterRows.length === 0) {
  await pool.end();
  throw new Error(
    `No cluster entries found for cluster="${clusterName}" language="${language}". ` +
    `Check book_clusters.cluster_name and book_clusters.language values.`,
  );
}

const asins        = clusterRows.map(r => r.asin).filter(Boolean);
const asinTitleMap = new Map(clusterRows.map(r => [r.asin, r.work_title]));

console.log(`Cluster     : ${clusterName}`);
console.log(`Slug        : ${clusterSlug}`);
console.log(`Language    : ${language}`);
console.log(`Profile     : ${profileId}`);
console.log(`Works found : ${clusterRows.length} (${asins.length} with ASIN)`);
for (const r of clusterRows) {
  console.log(`  ${r.asin ?? '(no asin)'.padEnd(10)}  ${r.work_title}`);
}
console.log('');

if (asins.length === 0) {
  await pool.end();
  throw new Error('No ASINs resolved from title_cache — cannot continue.');
}

// ── 2. ASINs → ad_group_ids (ENABLED product ads for this profile) ────────────
const { rows: paRows } = await pool.query(
  `SELECT DISTINCT ad_group_id
     FROM amazon_product_ads
    WHERE profile_id = $1
      AND asin       = ANY($2)
      AND state      = 'ENABLED'`,
  [profileId, asins],
);

const adGroupIds = paRows.map(r => r.ad_group_id);
console.log(`Ad groups (ENABLED product ads for cluster ASINs): ${adGroupIds.length}`);

if (adGroupIds.length === 0) {
  await pool.end();
  console.log('No ENABLED product ads found for these ASINs on this profile.');
  console.log('No seed terms can be derived. Output not written.');
  process.exit(0);
}

// ── 3. Search terms that CONVERTED on those ad groups over 365 days ───────────
// CONVERTED = purchases_14d > 0 on that day's row.
// Aggregated across the full 365-day window.
const { rows: termRows } = await pool.query(
  `SELECT
       search_term,
       SUM(clicks)         AS clicks,
       SUM(purchases_14d)  AS orders,
       SUM(cost)           AS spend
     FROM amazon_search_term_daily
    WHERE profile_id    = $1
      AND ad_group_id   = ANY($2)
      AND date         >= CURRENT_DATE - INTERVAL '365 days'
      AND purchases_14d > 0
    GROUP BY search_term
    ORDER BY SUM(purchases_14d) DESC, SUM(cost) DESC
    LIMIT 30`,
  [profileId, adGroupIds],
);

console.log(`Converted terms (purchases_14d > 0, 365d window): ${termRows.length}`);
console.log('');

// ── 4. Build structured output ────────────────────────────────────────────────
const terms = termRows.map((r, i) => ({
  rank:   i + 1,
  term:   r.search_term,
  orders: Number(r.orders),
  clicks: Number(r.clicks),
  spend:  Number(r.spend),
}));

const output = {
  cluster:      clusterName,
  cluster_slug: clusterSlug,
  language,
  profile_id:   String(profileId),
  generated_at: new Date().toISOString(),
  asins:        clusterRows.map(r => ({
    asin:   r.asin   ?? null,
    title:  r.work_title,
    isbn13: r.isbn13,
  })),
  ad_group_count: adGroupIds.length,
  terms,
};

writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
console.log(`Written: ${outputPath}`);
console.log('');

// ── 5. Printed table ──────────────────────────────────────────────────────────
const TERM_COL = 45;
const hdr =
  `${'Rank'.padStart(4)}  ${'Term'.padEnd(TERM_COL)}  ${'Orders'.padStart(6)}  ${'Clicks'.padStart(6)}  ${'Spend'.padStart(9)}`;
const sep = '─'.repeat(hdr.length);
console.log(hdr);
console.log(sep);
for (const t of terms) {
  const display = t.term.length > TERM_COL
    ? t.term.slice(0, TERM_COL - 1) + '…'
    : t.term;
  console.log(
    `${String(t.rank).padStart(4)}  ${display.padEnd(TERM_COL)}  ` +
    `${String(t.orders).padStart(6)}  ${String(t.clicks).padStart(6)}  ` +
    `€${t.spend.toFixed(2).padStart(8)}`,
  );
}
console.log(sep);
console.log(
  `Cluster: ${clusterName} | Top ${terms.length} converted term(s) in 365d | ` +
  `Seed: artifacts/seed-${clusterSlug}.json`,
);

await pool.end();
process.exit(0);
