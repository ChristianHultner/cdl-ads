// scripts/backdate-pushed-at.mjs
// ONE-SHOT: stamp pushed_at for all PUSHED recs where pushed_at IS NULL.
//
// Sources in priority order per rec:
//   (a) evidence->>'pushed_at'   if present and parseable  → source='evidence_field'
//   (b) drain logs (REPLACE):    logs carry NO wall-clock timestamps (see finding below)
//                                → skipped; all REPLACE recs fall through to (c).
//   (c) wave-date fallback (REPLACE_PRODUCT_AD only):
//         created_at <  2026-08-02T14:00Z → 2026-08-02T16:00:00Z  (wave1)
//         created_at <  2026-08-03T09:00Z → 2026-08-03T02:00:00Z  (waves2-3)
//         created_at >= 2026-08-03T09:00Z → 2026-08-03T11:00:00Z  (wave4)
//       source='wave_fallback_wave1' | 'wave_fallback_waves2-3' | 'wave_fallback_wave4'
//
// Stamps evidence.pushed_at_source per rec.
// Verify SELECT at end: null_pushed_at must = 0 across all PUSHED recs.

import { Pool, neonConfig } from '@neondatabase/serverless';
neonConfig.webSocketConstructor = WebSocket;

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL not set');

const pool = new Pool({ connectionString: DATABASE_URL });

// ── Step (b) finding ──────────────────────────────────────────────────────────
console.log('LOG INSPECTION FINDING (step b):');
console.log('  Drain logs (artifacts/replace-*.log) carry per-rec PUSHED markers');
console.log('  ("Rec N → PUSHED …") but contain NO wall-clock timestamps around');
console.log('  those lines. Cannot extract timestamps from logs.');
console.log('  All REPLACE_PRODUCT_AD recs fall to wave-date fallback (c).');
console.log('');

// ── Fetch all PUSHED recs with NULL pushed_at ────────────────────────────────
const { rows } = await pool.query(`
  SELECT id, rec_type, created_at, evidence
    FROM recommendations
   WHERE status = 'PUSHED' AND pushed_at IS NULL
   ORDER BY id
`);
console.log(`Found ${rows.length} PUSHED recs with pushed_at IS NULL.`);
console.log('');

// ── Wave boundaries (step c) ─────────────────────────────────────────────────
const WAVE1_CUTOFF    = new Date('2026-08-02T14:00:00Z');
const WAVE4_CUTOFF    = new Date('2026-08-03T09:00:00Z');
const WAVE1_DATE      = '2026-08-02T16:00:00.000Z';
const WAVES23_DATE    = '2026-08-03T02:00:00.000Z';
const WAVE4_DATE      = '2026-08-03T11:00:00.000Z';

// ── Per-source counters ───────────────────────────────────────────────────────
const counts = {
  evidence_field:          0,
  wave_fallback_wave1:     0,
  'wave_fallback_waves2-3': 0,
  wave_fallback_wave4:     0,
  unresolved:              0,
};
let updated = 0;

for (const rec of rows) {
  const ev = typeof rec.evidence === 'string' ? JSON.parse(rec.evidence) : (rec.evidence ?? {});
  let pushedAt = null;
  let source   = null;

  // (a) evidence->>'pushed_at'
  if (ev.pushed_at) {
    const candidate = new Date(ev.pushed_at);
    if (!isNaN(candidate.getTime())) {
      pushedAt = candidate.toISOString();
      source   = 'evidence_field';
    }
  }

  // (b) logs — no timestamps (see finding); skip.

  // (c) wave-date fallback for REPLACE_PRODUCT_AD
  if (!pushedAt && rec.rec_type === 'REPLACE_PRODUCT_AD') {
    const createdAt = new Date(rec.created_at);
    if (createdAt < WAVE1_CUTOFF) {
      pushedAt = WAVE1_DATE;
      source   = 'wave_fallback_wave1';
    } else if (createdAt < WAVE4_CUTOFF) {
      pushedAt = WAVES23_DATE;
      source   = 'wave_fallback_waves2-3';
    } else {
      pushedAt = WAVE4_DATE;
      source   = 'wave_fallback_wave4';
    }
  }

  if (!pushedAt) {
    console.log(`  UNRESOLVED: id=${rec.id} rec_type=${rec.rec_type} created_at=${rec.created_at}`);
    counts.unresolved++;
    continue;
  }

  counts[source] = (counts[source] ?? 0) + 1;

  await pool.query(
    `UPDATE recommendations
        SET pushed_at = $2,
            evidence  = evidence || jsonb_build_object('pushed_at_source', $3::text)
      WHERE id = $1 AND pushed_at IS NULL`,
    [rec.id, pushedAt, source],
  );
  updated++;
}

console.log('=== per-source counts ===');
for (const [k, v] of Object.entries(counts)) {
  if (v > 0 || k === 'unresolved') console.log(`  ${k}: ${v}`);
}
console.log(`  total updated: ${updated}`);
console.log('');

// ── Verify: null_pushed_at must = 0 ─────────────────────────────────────────
const { rows: verify } = await pool.query(`
  SELECT rec_type, COUNT(*) AS null_pushed_at
    FROM recommendations
   WHERE status = 'PUSHED' AND pushed_at IS NULL
   GROUP BY rec_type
`);
if (verify.length === 0) {
  console.log('VERIFY OK: null_pushed_at = 0 across all PUSHED recs.');
} else {
  console.error('VERIFY FAIL — remaining nulls:');
  verify.forEach(r => console.error(`  ${r.rec_type}: ${r.null_pushed_at}`));
}

await pool.end();
