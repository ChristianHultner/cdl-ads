// scripts/apply-cluster-corrections.mjs
// Apply Christian's 7 red-pen corrections to cluster-draft-v1.json,
// producing artifacts/cluster-draft-v2.json.
// Correction 5 uses ONE Anthropic API call (claude-sonnet-4-6) to
// split 'Naturaleza, Medio Ambiente y Mindfulness' and rebalance
// 'Bienestar y Camino de Vida'. ZERO database writes.
//
// Usage (env already sourced by caller):
//   node scripts/apply-cluster-corrections.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join }                                   from 'node:path';
import { homedir }                                from 'node:os';

// ── ENV ──────────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY missing'); process.exit(1); }

// ── PATHS ────────────────────────────────────────────────────────────────────
const artifactsDir = join(homedir(), 'cdl-ads', 'artifacts');
const v1Path = join(artifactsDir, 'cluster-draft-v1.json');
const v2Path = join(artifactsDir, 'cluster-draft-v2.json');

// ── LOAD V1 ──────────────────────────────────────────────────────────────────
const draft = JSON.parse(readFileSync(v1Path, 'utf8'));

// ── HELPERS ──────────────────────────────────────────────────────────────────
const norm = s => (s ?? '').toLowerCase().trim();

/** Find a cluster by exact name (normalised) and language. */
function fc(name, lang) {
  return draft.clusters.find(c => c.language === lang && norm(c.name) === norm(name));
}

/** Find a work by isbn within a cluster. */
function fw(cluster, isbn) {
  return cluster?.works.find(w => w.isbn === isbn);
}

/** Find a work by title (normalised) within a cluster. */
function fwt(cluster, title) {
  return cluster?.works.find(w => norm(w.title) === norm(title));
}

/** Remove a work by isbn from a cluster. Returns the removed work or null. */
function removeIsbn(cluster, isbn) {
  const idx = cluster?.works.findIndex(w => w.isbn === isbn);
  if (idx === -1 || idx === undefined) return null;
  return cluster.works.splice(idx, 1)[0];
}

/** Remove a work by title (normalised) from a cluster. Returns count removed. */
function removeTitle(cluster, title) {
  const before = cluster?.works.length ?? 0;
  if (cluster) cluster.works = cluster.works.filter(w => norm(w.title) !== norm(title));
  return before - (cluster?.works.length ?? 0);
}

/** Add work to cluster if isbn not already present. */
function addWork(cluster, work) {
  if (!cluster.works.find(w => w.isbn === work.isbn)) {
    cluster.works.push(work);
    return true;
  }
  return false;
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  APPLYING CORRECTIONS 1–7 TO cluster-draft-v1.json');
console.log('═══════════════════════════════════════════════════════════════\n');

// ─────────────────────────────────────────────────────────────────────────────
// CORRECTION 1 — Confirm 'Primos' in spa 'Amor de Familia'
// ─────────────────────────────────────────────────────────────────────────────
const amorFam = fc('Amor de Familia', 'spa');
if (!amorFam) { console.error('FATAL: spa "Amor de Familia" not found'); process.exit(1); }
const primosWork = fwt(amorFam, 'Primos');
if (primosWork) {
  console.log('C1 ✓ Primos already in spa Amor de Familia — confirmed.');
} else {
  // Search for it elsewhere in spa clusters
  let found = null;
  for (const c of draft.clusters.filter(c => c.language === 'spa')) {
    const w = fwt(c, 'Primos');
    if (w) { found = w; removeTitle(c, 'Primos'); break; }
  }
  if (found) { addWork(amorFam, found); console.log('C1 ✓ Primos moved from another cluster to spa Amor de Familia.'); }
  else { console.warn('C1 ⚠ Primos not found anywhere in spa — skipped.'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// CORRECTION 2 — 'Tren de invierno' → Bienestar only (remove from Actividades)
// ─────────────────────────────────────────────────────────────────────────────
const actividades = fc('Actividades Diarias y Crecimiento', 'spa');
if (!actividades) { console.error('FATAL: spa "Actividades Diarias y Crecimiento" not found'); process.exit(1); }
const bienestar   = fc('Bienestar y Camino de Vida', 'spa');
if (!bienestar)   { console.error('FATAL: spa "Bienestar y Camino de Vida" not found');       process.exit(1); }

const trenIsbn = '9788415784807';
const removedFromActividades = removeIsbn(actividades, trenIsbn);
if (removedFromActividades) {
  console.log(`C2 ✓ Tren de invierno (${trenIsbn}) removed from Actividades Diarias. Stays in Bienestar.`);
} else {
  console.warn('C2 ⚠ Tren de invierno not found in Actividades — already resolved or isbn mismatch.');
}
// Verify it is in Bienestar
if (fw(bienestar, trenIsbn)) console.log('C2 ✓ Tren de invierno confirmed in Bienestar y Camino de Vida.');
else console.warn('C2 ⚠ Tren de invierno NOT in Bienestar — check v1 data.');

console.log(`C7 ✓ Actividades Diarias now has ${actividades.works.length} works (floor exception approved).`);

// ─────────────────────────────────────────────────────────────────────────────
// CORRECTION 3 — 'La familia Bola' STAYS in 'Comunidad y Amistad'
// ─────────────────────────────────────────────────────────────────────────────
const comunidad = fc('Comunidad y Amistad', 'spa');
if (!comunidad) { console.error('FATAL: spa "Comunidad y Amistad" not found'); process.exit(1); }
if (fwt(comunidad, 'La familia Bola')) {
  console.log('C3 ✓ La familia Bola confirmed in Comunidad y Amistad.');
} else {
  console.warn('C3 ⚠ La familia Bola NOT found in Comunidad y Amistad — check v1 data.');
}

// ─────────────────────────────────────────────────────────────────────────────
// CORRECTION 4 — 'Luciérnagas' → Bienestar; 'Mamá se va a la guerra' stays
// ─────────────────────────────────────────────────────────────────────────────
const historias = fc('Historias Reales Inspiradoras', 'spa');
if (!historias) { console.error('FATAL: spa "Historias Reales Inspiradoras" not found'); process.exit(1); }

const lucIsbn = '9788416733538';   // Luciérnagas
const lucWork = removeIsbn(historias, lucIsbn)
  ?? (() => { // fallback: title search
    const w = fwt(historias, 'Luciérnagas');
    if (w) { removeTitle(historias, 'Luciérnagas'); return w; }
    return null;
  })();
if (lucWork) {
  addWork(bienestar, lucWork);
  console.log(`C4 ✓ Luciérnagas moved Historias → Bienestar. Historias: ${historias.works.length}, Bienestar: ${bienestar.works.length}.`);
} else {
  console.warn('C4 ⚠ Luciérnagas not found in Historias Reales Inspiradoras.');
}

const mamaGuerra = fwt(historias, 'Mamá se va a la guerra');
if (mamaGuerra) console.log('C4 ✓ Mamá se va a la guerra confirmed in Historias Reales.');
else console.warn('C4 ⚠ Mamá se va a la guerra not found in Historias — check v1 data.');

// ─────────────────────────────────────────────────────────────────────────────
// CORRECTION 6 — Amor de Familia stays ONE cluster (log only)
// ─────────────────────────────────────────────────────────────────────────────
const afCount = draft.clusters.filter(c => c.language === 'spa' && norm(c.name).includes('amor de familia')).length;
console.log(`C6 ✓ spa Amor de Familia: ${afCount} cluster(s) — stays ONE.`);

// ─────────────────────────────────────────────────────────────────────────────
// DUPLICATE RESOLUTION (before correction 5 API call)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Resolving all duplicates before C5 API call ─────────────────');

// Actividades Diarias is authoritative for its remaining works.
// Remove those ISBNs from any OTHER cluster.
const activISBNs = new Set(actividades.works.map(w => w.isbn));
for (const c of draft.clusters) {
  if (c === actividades) continue;
  const before = c.works.length;
  c.works = c.works.filter(w => !activISBNs.has(w.isbn));
  const diff = before - c.works.length;
  if (diff > 0) console.log(`  DEDUP: removed ${diff} Actividades work(s) from "${c.name}" [${c.language}]`);
}

// Con ojos de niño (9788415784487): keep in Diversidad e Inclusión, remove from Bienestar
const conOjosIsbn = '9788415784487';
const diversidad = fc('Diversidad e Inclusión', 'spa');
if (removeIsbn(bienestar, conOjosIsbn)) {
  console.log('  DEDUP: Con ojos de niño removed from Bienestar (kept in Diversidad e Inclusión)');
}

// English duplicates
// Superabuelas isbn 9788410438279 in both eng Love & Family AND spa Amor de Familia:
//   correct language is spa — remove from eng
const engLoveFamily = fc('Love & Family', 'eng');
if (removeIsbn(engLoveFamily, '9788410438279')) {
  console.log('  DEDUP: 9788410438279 (Superabuelas/Supergrannies) removed from eng Love & Family (kept in spa Amor de Familia)');
}

// Walking Eagle (9788415784364): keep in eng Diversity & Inclusion, remove from eng Wellbeing & Life's Journey
const engWellbeing = fc("Wellbeing & Life's Journey", 'eng');
if (removeIsbn(engWellbeing, '9788415784364')) {
  console.log("  DEDUP: Walking Eagle removed from eng Wellbeing & Life's Journey (kept in Diversity & Inclusion)");
}

// What Are You Scared of Little Mouse? (9788415784685): keep in eng Emotions & Feelings, remove from eng Wellbeing
if (removeIsbn(engWellbeing, '9788415784685')) {
  console.log("  DEDUP: What Are You Scared of Little Mouse? removed from eng Wellbeing & Life's Journey (kept in Emotions & Feelings)");
}

// ─────────────────────────────────────────────────────────────────────────────
// CORRECTION 5 — Split 'Naturaleza, Medio Ambiente y Mindfulness' via API
// ─────────────────────────────────────────────────────────────────────────────
const naturaleza = fc('Naturaleza, Medio Ambiente y Mindfulness', 'spa');
if (!naturaleza) { console.error('FATAL: spa "Naturaleza, Medio Ambiente y Mindfulness" not found'); process.exit(1); }

console.log(`\nC5: Naturaleza cluster: ${naturaleza.works.length} works`);
console.log(`C5: Bienestar cluster (after prior corrections): ${bienestar.works.length} works`);
console.log('C5: Calling Anthropic API (claude-sonnet-4-6) for reassignment …\n');

const natBlock = naturaleza.works.map(w => `  isbn:${w.isbn} | "${w.title}"`).join('\n');
const bieBlock = bienestar.works.map(w => `  isbn:${w.isbn} | "${w.title}"`).join('\n');

const c5System = [
  'You are reorganising Spanish children\'s book clusters for Cuento de Luz.',
  '',
  'INPUT: two clusters',
  '  A) "Naturaleza, Medio Ambiente y Mindfulness" — split into:',
  '       "Naturaleza y Medio Ambiente"   (ecology, trees, sea, animals-in-nature, harvests)',
  '       "Mindfulness y Bienestar Interior" (meditation, yoga, inner calm, contemplation, breath)',
  '  B) "Bienestar y Camino de Vida" — keep as is, but calmer/more meditative titles may migrate',
  '       to "Mindfulness y Bienestar Interior" if doing so helps all three land in the 8–15 band.',
  '',
  'HARD RULES:',
  '1. Every work from A must appear in exactly one of the two new clusters.',
  '2. Every work from B must appear in exactly one output cluster (naturaleza, mindfulness, or bienestar).',
  '   B works must NOT appear in naturaleza; they stay in bienestar OR migrate to mindfulness.',
  '3. All three output clusters must have between 8 and 15 works inclusive.',
  '4. Return ONLY valid JSON, no prose, no fences:',
  '   {"naturaleza":[{"isbn":string,"title":string},...],',
  '    "mindfulness":[{"isbn":string,"title":string},...],',
  '    "bienestar":[{"isbn":string,"title":string},...]}',
  '5. Use the exact isbn and title strings from the input. Do not invent, merge, or drop any work.',
].join('\n');

const c5User = [
  '=== Cluster A (SPLIT into naturaleza + mindfulness) ===',
  natBlock,
  '',
  '=== Cluster B (stays bienestar OR migrates to mindfulness) ===',
  bieBlock,
].join('\n');

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
      max_tokens: 4000,
      system:     c5System,
      messages:   [{ role: 'user', content: c5User }],
    }),
  });
} catch (err) {
  console.error(`Anthropic fetch error: ${err.message}`);
  process.exit(1);
}
if (!apiRes.ok) {
  const text = await apiRes.text();
  console.error(`Anthropic HTTP ${apiRes.status}: ${text.slice(0, 400)}`);
  process.exit(1);
}

const apiBody    = await apiRes.json();
const rawContent = apiBody?.content?.[0]?.text ?? '';

console.log('=== C5 RAW API RESPONSE ===');
console.log(rawContent);
console.log('');

// Extract JSON: handle prose-before-fence by finding the first ```json or ``` block,
// or fall back to the first '{' if no fence is present.
let stripped;
const fenceMatch = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/);
if (fenceMatch) {
  stripped = fenceMatch[1].trim();
} else {
  const braceStart = rawContent.indexOf('{');
  stripped = braceStart !== -1 ? rawContent.slice(braceStart).trim() : rawContent.trim();
}
let split5;
try {
  split5 = JSON.parse(stripped);
} catch (err) {
  console.error(`JSON parse FAILED: ${err.message}`);
  console.error('--- RAW (paste for review) ---');
  console.error(rawContent);
  process.exit(1);
}
if (!Array.isArray(split5?.naturaleza) || !Array.isArray(split5?.mindfulness) || !Array.isArray(split5?.bienestar)) {
  console.error('C5 response missing naturaleza/mindfulness/bienestar arrays:');
  console.error(JSON.stringify(split5).slice(0, 500));
  process.exit(1);
}

// Validate sizes
const n5 = split5.naturaleza.length, m5 = split5.mindfulness.length, b5 = split5.bienestar.length;
console.log(`C5 sizes → naturaleza:${n5}  mindfulness:${m5}  bienestar:${b5}`);
for (const [label, count] of [['naturaleza', n5], ['mindfulness', m5], ['bienestar', b5]]) {
  if (count < 8 || count > 15) console.warn(`C5 ⚠ ${label} has ${count} works — outside 8–15 band`);
}

// Apply to draft: remove old naturaleza cluster; update bienestar; insert two new clusters
const natIdx = draft.clusters.indexOf(naturaleza);
draft.clusters.splice(natIdx, 1); // remove Naturaleza, Medio Ambiente y Mindfulness

bienestar.works = split5.bienestar; // update bienestar in place

const newNat = {
  name:      'Naturaleza y Medio Ambiente',
  language:  'spa',
  rationale: 'Libros que celebran el mundo natural: bosques, mar, árboles, ecosistemas y ecología.',
  works:     split5.naturaleza,
};
const newMind = {
  name:      'Mindfulness y Bienestar Interior',
  language:  'spa',
  rationale: 'Libros que guían a los niños en meditación, yoga y reflexión interior para cultivar la calma.',
  works:     split5.mindfulness,
};
// Insert new clusters where naturaleza was (index may have shifted; insert before bienestar for grouping)
const insertAt = Math.min(natIdx, draft.clusters.length);
draft.clusters.splice(insertAt, 0, newNat, newMind);

console.log(`C5 ✓ Naturaleza, Medio Ambiente y Mindfulness split into:`);
console.log(`  [${newNat.works.length}]  ${newNat.name}`);
console.log(`  [${newMind.works.length}]  ${newMind.name}`);
console.log(`  [${bienestar.works.length}]  ${bienestar.name} (rebalanced)`);

// ─────────────────────────────────────────────────────────────────────────────
// FINAL DUPLICATE CHECK (by ISBN — every isbn must appear exactly once)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  FINAL DUPLICATE CHECK');
console.log('═══════════════════════════════════════════════════════════════');

const seenIsbn = new Map();   // isbn → "cluster[lang]"
const duplicates = [];

for (const c of draft.clusters) {
  for (const w of c.works) {
    const key = w.isbn;
    const label = `${c.name}[${c.language}]`;
    if (seenIsbn.has(key)) {
      duplicates.push({ isbn: key, title: w.title, c1: seenIsbn.get(key), c2: label });
    } else {
      seenIsbn.set(key, label);
    }
  }
}

if (duplicates.length > 0) {
  console.error(`DUPLICATE CHECK FAILED — ${duplicates.length} residual duplicate(s):`);
  for (const d of duplicates) {
    console.error(`  isbn:${d.isbn}  "${d.title}"`);
    console.error(`    in [${d.c1}]`);
    console.error(`    in [${d.c2}]`);
  }
  console.error('\n--- paste above and STOP ---');
  process.exit(1);
}

const totalWorks = [...seenIsbn.keys()].length;
console.log(`✓ ${totalWorks} works — no duplicates. All ISBNs appear exactly once.\n`);

// ─────────────────────────────────────────────────────────────────────────────
// WRITE V2
// ─────────────────────────────────────────────────────────────────────────────
mkdirSync(artifactsDir, { recursive: true });
writeFileSync(v2Path, JSON.stringify(draft, null, 2), 'utf8');
console.log(`Artifact written → ${v2Path}\n`);

// ─────────────────────────────────────────────────────────────────────────────
// PRINT CORRECTED SPANISH WING IN FULL
// ─────────────────────────────────────────────────────────────────────────────
const spa2 = draft.clusters.filter(c => c.language === 'spa');
console.log('═══════════════════════════════════════════════════════════════');
console.log('  CORRECTED SPANISH WING — v2');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  ${spa2.length} clusters · ${spa2.reduce((s, c) => s + c.works.length, 0)} works\n`);
for (const c of spa2) {
  console.log(`[${c.works.length}] ${c.name}`);
  for (const w of c.works) console.log(`    ${w.title}`);
  console.log('');
}

// ─────────────────────────────────────────────────────────────────────────────
// ONE-LINE COUNT SUMMARY — OTHER LANGUAGES
// ─────────────────────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════════');
console.log('  OTHER LANGUAGES (unchanged)');
console.log('═══════════════════════════════════════════════════════════════');
const byLang = {};
for (const c of draft.clusters.filter(c => c.language !== 'spa')) {
  if (!byLang[c.language]) byLang[c.language] = { clusters: 0, works: 0 };
  byLang[c.language].clusters++;
  byLang[c.language].works += c.works.length;
}
for (const [lang, s] of Object.entries(byLang).sort())
  console.log(`  ${lang}: ${s.clusters} cluster(s), ${s.works} work(s)`);
console.log('═══════════════════════════════════════════════════════════════');
