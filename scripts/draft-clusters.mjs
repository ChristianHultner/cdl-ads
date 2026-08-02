// scripts/draft-clusters.mjs
// Cluster taxonomy DRAFT — reads catalog via /api/v1/books/public/list,
// deduplicates to one entry per group_id × language (HC preferred),
// then asks claude-sonnet-4-6 to assign every work to a named thematic
// cluster within its language.  Output is a JSON artifact ONLY — zero DB
// writes, zero migrations.
//
// Usage (env already sourced by caller):
//   node scripts/draft-clusters.mjs
//
// Output:
//   ~/cdl-ads/artifacts/cluster-draft-v1.json
//   Readable summary printed to stdout.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join }                     from 'node:path';
import { homedir }                  from 'node:os';

// ── ENV validation ────────────────────────────────────────────────────────────
const CDL_BOOKS_API_URL       = process.env.CDL_BOOKS_API_URL ?? 'https://books.cuentodeluz.com';
const CDL_BOOKS_API_KEY       = process.env.CDL_BOOKS_API_KEY;
const CF_ACCESS_CLIENT_ID     = process.env.CF_ACCESS_CLIENT_ID     ?? '';
const CF_ACCESS_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET ?? '';
const ANTHROPIC_API_KEY       = process.env.ANTHROPIC_API_KEY;

const missing = [];
if (!CDL_BOOKS_API_KEY) missing.push('CDL_BOOKS_API_KEY');
if (!ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

// ── 1. FETCH /list ────────────────────────────────────────────────────────────
const listUrl = `${CDL_BOOKS_API_URL}/api/v1/books/public/list`;
console.log(`Fetching catalog: ${listUrl} …`);

let listRes;
try {
  listRes = await fetch(listUrl, {
    headers: {
      'X-Api-Key': CDL_BOOKS_API_KEY,
      Accept: 'application/json',
      ...(CF_ACCESS_CLIENT_ID && CF_ACCESS_CLIENT_SECRET
        ? {
            'CF-Access-Client-Id':     CF_ACCESS_CLIENT_ID,
            'CF-Access-Client-Secret': CF_ACCESS_CLIENT_SECRET,
          }
        : {}),
    },
  });
} catch (err) {
  console.error(`/list fetch error: ${err.message}`);
  process.exit(1);
}

if (!listRes.ok) {
  const text = await listRes.text();
  console.error(`/list HTTP ${listRes.status}: ${text.slice(0, 300)}`);
  process.exit(1);
}

let listBody;
try {
  listBody = await listRes.json();
} catch (err) {
  console.error(`/list JSON parse error: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(listBody.books)) {
  console.error(`Unexpected /list shape: ${JSON.stringify(listBody).slice(0, 200)}`);
  process.exit(1);
}

console.log(`/list: ${listBody.books.length} total entries`);

// ── 2. DEDUPLICATE by group_id × language ─────────────────────────────────────
// group_id = the HC's isbn.  For each group × language, prefer HC format;
// if multiple HC entries exist (shouldn't happen), keep first.
// This collapses EBOOK/PB/etc. duplicates while preserving bilingual pairs
// as separate works.

const workMap = new Map(); // key: `${group_id}::${language}`

for (const book of listBody.books) {
  if (!book.group_id || !book.title || !book.language) continue;
  const key = `${book.group_id}::${book.language}`;
  if (!workMap.has(key)) {
    workMap.set(key, book);
  } else if (book.format === 'HC') {
    workMap.set(key, book); // HC wins
  }
}

const works = [...workMap.values()];
console.log(`After dedup (group_id × language): ${works.length} works`);

// Language breakdown
const byLang = {};
for (const w of works) {
  byLang[w.language] = (byLang[w.language] ?? 0) + 1;
}
console.log('Language breakdown:', JSON.stringify(byLang));
console.log('');

// ── 3. ASSEMBLE PROMPT ────────────────────────────────────────────────────────
const AGENCY_PRIORS =
  'EMOCIONES Y SENTIMIENTOS · VALORES Y VIRTUDES · AMISTAD · ANIMALES · ' +
  'SUEÑOS Y DORMIR · AMOR DE FAMILIA (relationship slices: mamá/papá/hija/hijo/hermanos/primos/abuelos) · ' +
  'ACOSO · ADOPCIÓN · MATRIMONIO Y DIVORCIO · ACTIVIDADES DIARIAS · ARTE · LA CASA';

// Build works block grouped by language
const langSections = [];
for (const lang of Object.keys(byLang).sort()) {
  const langWorks = works.filter(w => w.language === lang);
  const lines = langWorks.map(w => `  isbn:${w.isbn} | "${w.title}"`).join('\n');
  langSections.push(`=== language: ${lang} (${langWorks.length} works) ===\n${lines}`);
}
const worksBlock = langSections.join('\n\n');

const systemPrompt = [
  'You are a children\'s book catalog strategist for Cuento de Luz, a bilingual Spanish/English picture-book publisher.',
  'Your task: assign every work in the catalog to exactly one named thematic cluster WITHIN its language.',
  '',
  'RULES (non-negotiable):',
  '1. Every work receives exactly one cluster assignment. The "unassigned" array in your output MUST be empty.',
  '2. Clusters are PER-LANGUAGE — a cluster named "Animals" is separate from "Animales"; do not merge languages.',
  '3. Target cluster size: 8–15 works. Hard floor: 5. Any theme that cannot reach 5 works MUST merge into its nearest thematic neighbor.',
  '4. Use the agency priors (listed below) where they fit naturally. Invent better cluster names where they do not fit.',
  '5. AMOR DE FAMILIA / LOVE & FAMILY may keep relationship sub-slices (mamá, papá, hermanos, etc.) ONLY if each sub-slice independently reaches the floor of 5 works.',
  '6. Cluster names must be concise and shopper-facing (a real parent would type this into a search box).',
  '7. Rationale: 1–2 sentences explaining what unites the works in this cluster.',
  '8. Return ONLY valid JSON — no prose, no markdown fences, no explanation outside the JSON.',
  '',
  'OUTPUT SCHEMA (strict — no extra fields):',
  '{"clusters":[{"name":string,"language":string,"rationale":string,"works":[{"isbn":string,"title":string}]}],"unassigned":[]}',
  '',
  'AGENCY PRIORS (historical themes — use where they fit):',
  AGENCY_PRIORS,
].join('\n');

const userMessage = [
  'Assign every work below to exactly one cluster within its language.',
  'All works must be assigned. Return ONLY the JSON object.',
  '',
  worksBlock,
].join('\n');

console.log('=== PROMPT — system ===');
console.log(systemPrompt);
console.log('');
console.log('=== PROMPT — user (first 400 chars) ===');
console.log(userMessage.slice(0, 400) + (userMessage.length > 400 ? '\n…' : ''));
console.log(`(full user message: ${userMessage.length} chars, ${works.length} works)`);
console.log('');

// ── 4. ANTHROPIC API CALL ─────────────────────────────────────────────────────
console.log('Calling Anthropic API (claude-sonnet-4-6) …');

let apiRes;
try {
  apiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 16000,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userMessage }],
    }),
  });
} catch (err) {
  console.error(`Anthropic fetch error: ${err.message}`);
  process.exit(1);
}

if (!apiRes.ok) {
  const text = await apiRes.text();
  console.error(`Anthropic API HTTP ${apiRes.status}: ${text.slice(0, 400)}`);
  process.exit(1);
}

const apiBody   = await apiRes.json();
const rawContent = apiBody?.content?.[0]?.text ?? '';

console.log('=== RAW MODEL RESPONSE ===');
console.log(rawContent);
console.log('');

// ── 5. PARSE DEFENSIVELY ──────────────────────────────────────────────────────
const stripped = rawContent
  .replace(/^```(?:json)?\s*/im, '')
  .replace(/\s*```\s*$/im, '')
  .trim();

let parsed;
try {
  parsed = JSON.parse(stripped);
} catch (err) {
  console.error(`JSON parse FAILED: ${err.message}`);
  console.error('--- RAW RESPONSE (paste for review) ---');
  console.error(rawContent);
  process.exit(1);
}

if (!Array.isArray(parsed?.clusters)) {
  console.error('"clusters" array missing from parsed output:');
  console.error(JSON.stringify(parsed).slice(0, 500));
  process.exit(1);
}

// ── 6. WRITE ARTIFACT ─────────────────────────────────────────────────────────
const artifactsDir = join(homedir(), 'cdl-ads', 'artifacts');
mkdirSync(artifactsDir, { recursive: true });
const artifactPath = join(artifactsDir, 'cluster-draft-v1.json');
writeFileSync(artifactPath, JSON.stringify(parsed, null, 2), 'utf8');
console.log(`Artifact written → ${artifactPath}`);
console.log('');

// ── 7. READABLE SUMMARY ───────────────────────────────────────────────────────
const totalAssigned = parsed.clusters.reduce((sum, c) => sum + (c.works?.length ?? 0), 0);
const unassignedCount = parsed.unassigned?.length ?? 0;

console.log('══════════════════════════════════════════════════════════════════');
console.log('  CLUSTER DRAFT SUMMARY                                          ');
console.log('══════════════════════════════════════════════════════════════════');
console.log(`  Total clusters  : ${parsed.clusters.length}`);
console.log(`  Works assigned  : ${totalAssigned}`);
console.log(`  Unassigned      : ${unassignedCount}`);
console.log('');

// Group by language for display
const clustersByLang = {};
for (const c of parsed.clusters) {
  const lang = c.language ?? 'unknown';
  if (!clustersByLang[lang]) clustersByLang[lang] = [];
  clustersByLang[lang].push(c);
}

for (const lang of Object.keys(clustersByLang).sort()) {
  const clusters = clustersByLang[lang];
  const langTotal = clusters.reduce((s, c) => s + (c.works?.length ?? 0), 0);
  console.log(`── ${lang} — ${clusters.length} cluster(s), ${langTotal} works ──────────────────`);
  for (const c of clusters.sort((a, b) => (b.works?.length ?? 0) - (a.works?.length ?? 0))) {
    const count   = c.works?.length ?? 0;
    const first5  = (c.works ?? []).slice(0, 5).map(w => `"${w.title}"`).join(', ');
    const more    = count > 5 ? ` … +${count - 5} more` : '';
    console.log(`  [${String(count).padStart(2)}] ${c.name}`);
    console.log(`       ${first5}${more}`);
  }
  console.log('');
}

if (unassignedCount > 0) {
  console.log(`⚠ UNASSIGNED (${unassignedCount}):`);
  for (const u of parsed.unassigned) {
    console.log(`  - ${JSON.stringify(u)}`);
  }
  console.log('');
}

console.log('══════════════════════════════════════════════════════════════════');
console.log('  NO database writes. Draft is paper — awaiting Christian\'s red pen.');
console.log('══════════════════════════════════════════════════════════════════');
