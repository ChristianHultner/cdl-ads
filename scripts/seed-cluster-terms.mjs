// scripts/seed-cluster-terms.mjs
// Usage: node --env-file=.env.local scripts/seed-cluster-terms.mjs \
//   --cluster "Bienestar y Camino de Vida" --language spa --profile <id>
//
// Read-only analysis. Given --cluster / --language / --profile:
//
//   Attribution grain:
//     Qualifying ad groups = those where the cluster's ASINs make up
//     >50% of ENABLED product ads in the group.  Big catch-alls
//     (one cluster book out of twenty) do NOT qualify; title-specific
//     rooms and tight cluster rooms DO qualify.
//
//   Term hygiene (applied before the top-30 ranking):
//     • ASIN-shaped terms  (^b0[a-z0-9]{8}$ | ^[0-9]{9}[0-9x]$, case-
//       insensitive) — product traffic, not keyword intent.
//       Counted separately as asin_terms_excluded.
//     • Own-brand variants — searches for our publisher name / titles
//       (e.g. "cuento de luz", "la luz de lucia").
//     • Single-word competitor publisher brand tokens (kalandraka-class).
//   All filtered terms are listed in the output.
//
// Writes artifacts/seed-<cluster-slug>.json + prints table.
//
// ⚠  READ-ONLY — no DB writes, no API calls.

import { parseArgs }        from 'node:util';
import { writeFileSync }    from 'node:fs';
import { fileURLToPath }    from 'node:url';
import { join, dirname }    from 'node:path';
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

// ── 1. Cluster → ASINs via title_cache ───────────────────────────────────────
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
    `No cluster entries for cluster="${clusterName}" language="${language}".`,
  );
}

const asins = clusterRows.map(r => r.asin).filter(Boolean);

console.log(`Cluster     : ${clusterName}`);
console.log(`Slug        : ${clusterSlug}`);
console.log(`Language    : ${language}`);
console.log(`Profile     : ${profileId}`);
console.log(`Works       : ${clusterRows.length}  (${asins.length} with ASIN)`);
for (const r of clusterRows) {
  console.log(`  ${(r.asin ?? '(no asin)').padEnd(12)}  ${r.work_title}`);
}
console.log('');

if (asins.length === 0) {
  await pool.end();
  throw new Error('No ASINs resolved from title_cache — cannot continue.');
}

// ── 2. Qualifying ad groups: cluster ASINs > 50% of ENABLED product ads ───────
// For every ad group that contains ≥1 cluster ASIN (ENABLED), compute the
// ratio cluster_asin_count / total_enabled_count.  Keep only ratio > 0.50.
const { rows: groupRows } = await pool.query(
  `SELECT
       ad_group_id,
       COUNT(*)                                           AS total_count,
       COUNT(*) FILTER (WHERE asin = ANY($2))            AS cluster_count,
       ROUND(
         COUNT(*) FILTER (WHERE asin = ANY($2))::numeric
           / COUNT(*)::numeric * 100,
       1)                                                 AS pct
     FROM amazon_product_ads
    WHERE profile_id = $1
      AND state      = 'ENABLED'
      AND ad_group_id IN (
            SELECT DISTINCT ad_group_id
              FROM amazon_product_ads
             WHERE profile_id = $1
               AND state      = 'ENABLED'
               AND asin       = ANY($2)
          )
    GROUP BY ad_group_id
   HAVING COUNT(*) FILTER (WHERE asin = ANY($2))::float
            / COUNT(*)::float > 0.50
    ORDER BY
      COUNT(*) FILTER (WHERE asin = ANY($2))::float / COUNT(*)::float DESC,
      cluster_count DESC`,
  [profileId, asins],
);

const qualifyingGroupIds = groupRows.map(r => r.ad_group_id);

console.log(`Qualifying ad groups (>50% cluster ASINs): ${qualifyingGroupIds.length}`);
for (const r of groupRows) {
  console.log(
    `  ${r.ad_group_id}  ` +
    `cluster ${r.cluster_count}/${r.total_count} (${r.pct}%)`,
  );
}
console.log('');

if (qualifyingGroupIds.length === 0) {
  await pool.end();
  console.log(
    'No qualifying groups — no seed terms.\n' +
    'All cluster books live inside catch-alls; create cluster-room pair first.',
  );
  process.exit(0);
}

// ── 3. Converted terms from qualifying groups (365d; no LIMIT — filter first) ─
const { rows: rawTermRows } = await pool.query(
  `SELECT
       search_term,
       SUM(clicks)        AS clicks,
       SUM(purchases_14d) AS orders,
       SUM(cost)          AS spend
     FROM amazon_search_term_daily
    WHERE profile_id    = $1
      AND ad_group_id   = ANY($2)
      AND date         >= CURRENT_DATE - INTERVAL '365 days'
      AND purchases_14d > 0
    GROUP BY search_term
    ORDER BY SUM(purchases_14d) DESC, SUM(cost) DESC`,
  [profileId, qualifyingGroupIds],
);
console.log(`Converted terms (qualifying groups, raw): ${rawTermRows.length}`);
console.log('');

// ── 4. Term hygiene filters ───────────────────────────────────────────────────

// 4a. ASIN-shaped: ISBN-10 (10 chars, last may be x/X) or Amazon ASIN (B0…)
const ASIN_RE = /^(b0[a-z0-9]{8}|[0-9]{9}[0-9x])$/i;

// 4b. Own-brand: CdL publisher brand / title variants
//   Patterns are intentionally tight to avoid false positives on genre terms.
const OWN_BRAND_RES = [
  /cuento[s]?\s+de\s+luz/i,       // "cuento de luz", "cuentos de luz"
  /\bcuento\s*luz\b/i,            // "cuento luz"
  /cuentodeluz/i,                  // concatenated form
  /la\s+luz\s+de\s+luc[ií]a/i,   // CdL title "La Luz de Lucía"
];
const isOwnBrand = (t) => OWN_BRAND_RES.some(re => re.test(t));

// 4c. Single-word competitor publisher brand tokens (combel-class).
//   A term is filtered only if it IS the brand name and nothing else.
const PUBLISHER_BRANDS = new Set([
  'kalandraka', 'combel', 'edelvives', 'nubeocho',
  'alfaguara', 'bruño', 'anaya', 'beascoa',
]);
const isPublisherBrand = (t) => {
  const lower = t.trim().toLowerCase();
  return !lower.includes(' ') && PUBLISHER_BRANDS.has(lower);
};

const asinExcluded      = [];  // counted as asin_terms_excluded
const ownBrandExcluded  = [];
const publisherExcluded = [];
const cleanTerms        = [];

for (const r of rawTermRows) {
  const entry = {
    term:   r.search_term,
    orders: Number(r.orders),
    clicks: Number(r.clicks),
    spend:  Number(r.spend),
  };
  if      (ASIN_RE.test(r.search_term))     asinExcluded.push(entry);
  else if (isOwnBrand(r.search_term))       ownBrandExcluded.push(entry);
  else if (isPublisherBrand(r.search_term)) publisherExcluded.push(entry);
  else                                      cleanTerms.push(entry);
}

// Top 30 clean terms (already ordered by orders DESC from the DB query)
const top30 = cleanTerms.slice(0, 30).map((t, i) => ({
  rank:   i + 1,
  term:   t.term,
  orders: t.orders,
  clicks: t.clicks,
  spend:  t.spend,
}));

// ── 5. Write JSON artifact ────────────────────────────────────────────────────
const output = {
  cluster:      clusterName,
  cluster_slug: clusterSlug,
  language,
  profile_id:   String(profileId),
  generated_at: new Date().toISOString(),
  asins: clusterRows.map(r => ({
    asin:   r.asin ?? null,
    title:  r.work_title,
    isbn13: r.isbn13,
  })),
  qualifying_group_count: qualifyingGroupIds.length,
  raw_converted_count:    rawTermRows.length,
  asin_terms_excluded:    asinExcluded.length,
  filtered_terms: {
    asin:      asinExcluded,
    own_brand: ownBrandExcluded,
    publisher: publisherExcluded,
  },
  terms: top30,
};

writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
console.log(`Written: ${outputPath}`);
console.log('');

// ── 6. Filter report ─────────────────────────────────────────────────────────
console.log('── Filter report ──────────────────────────────────────────────────────');
console.log(`  ASIN-shaped (asin_terms_excluded): ${asinExcluded.length}`);
for (const t of asinExcluded) {
  console.log(`    ${t.term.padEnd(22)} ${String(t.orders).padStart(3)} orders`);
}
if (ownBrandExcluded.length > 0) {
  console.log(`  Own-brand: ${ownBrandExcluded.length}`);
  for (const t of ownBrandExcluded) {
    console.log(`    "${t.term}"  (${t.orders} orders)`);
  }
} else {
  console.log(`  Own-brand: 0`);
}
if (publisherExcluded.length > 0) {
  console.log(`  Publisher-brand: ${publisherExcluded.length}`);
  for (const t of publisherExcluded) {
    console.log(`    "${t.term}"  (${t.orders} orders)`);
  }
} else {
  console.log(`  Publisher-brand: 0`);
}
console.log('');

// ── 7. Printed table ──────────────────────────────────────────────────────────
const TERM_COL = 45;
const hdr =
  `${'Rank'.padStart(4)}  ${'Term'.padEnd(TERM_COL)}  ` +
  `${'Orders'.padStart(6)}  ${'Clicks'.padStart(6)}  ${'Spend'.padStart(9)}`;
const sep = '─'.repeat(hdr.length);
console.log(hdr);
console.log(sep);
for (const t of top30) {
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
  `Cluster: ${clusterName} | Qualifying groups: ${qualifyingGroupIds.length} | ` +
  `Raw converted: ${rawTermRows.length} | Clean: ${cleanTerms.length} | ` +
  `Top ${top30.length} shown`,
);

await pool.end();
process.exit(0);
