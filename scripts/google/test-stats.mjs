/**
 * scripts/google/test-stats.mjs
 *
 * Assertion suite for lib/google/stats.mjs (P3 spec fixtures).
 * Exits 1 on any failure, prints "STATS TESTS PASS" on success.
 */

import {
  regularizedIncompleteBeta,
  posterior,
  probRateBelow,
  fourState,
} from '../../lib/google/stats.mjs';

// ---------------------------------------------------------------------------
// Tiny assertion harness
// ---------------------------------------------------------------------------

let _passed = 0;
let _failed = 0;

function assert(condition, label) {
  if (condition) {
    _passed++;
    console.log(`  ✓  ${label}`);
  } else {
    _failed++;
    console.error(`  ✗  ${label}`);
  }
}

function assertClose(actual, expected, tol, label) {
  const ok = Math.abs(actual - expected) <= tol;
  if (ok) {
    _passed++;
    console.log(`  ✓  ${label}  (got ${actual.toFixed(9)})`);
  } else {
    _failed++;
    console.error(
      `  ✗  ${label}  — expected ${expected} ± ${tol}, got ${actual.toFixed(9)}`
    );
  }
}

function assertRange(actual, lo, hi, label) {
  const ok = actual >= lo && actual <= hi;
  if (ok) {
    _passed++;
    console.log(`  ✓  ${label}  (got ${actual.toFixed(9)})`);
  } else {
    _failed++;
    console.error(
      `  ✗  ${label}  — expected [${lo}, ${hi}], got ${actual.toFixed(9)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Worked example A  (spec §1.2)
//   c=0, n=12, parent=0.075
//   alpha_prior = 0.075×30 = 2.25,  beta_prior = 0.925×30 = 27.75
//   posterior  → alpha=2.25, beta=39.75,  pointEstimate=2.25/42 ≈ 0.05357
// ---------------------------------------------------------------------------
console.log('\nExample A: c=0, n=12, parent=0.075');
const A = posterior(0, 12, 0.075);
assertClose(A.pointEstimate, 0.054, 0.003, 'pointEstimate ≈ 0.054 ± 0.003');
const pA = probRateBelow(0.075, A.alpha, A.beta);
assertRange(pA, 0.770, 0.778, 'probRateBelow(0.075) ∈ [0.770, 0.778]  (tight pin)');
assert(fourState(pA, false) === 'INSUFFICIENT',
  'fourState(pA, gate1Met=false) === INSUFFICIENT');
assert(fourState(0.7736, true) === 'WATCH',
  'fourState(0.7736, gate1Met=true) === WATCH  (77% does not reach ACT threshold)');

// ---------------------------------------------------------------------------
// Worked example B
//   c=0, n=45, parent=0.075
//   posterior → alpha=2.25, beta=72.75,  pointEstimate=2.25/75 = 0.030
// ---------------------------------------------------------------------------
console.log('\nExample B: c=0, n=45, parent=0.075');
const B = posterior(0, 45, 0.075);
assertClose(B.pointEstimate, 0.030, 0.003, 'pointEstimate ≈ 0.030 ± 0.003');
const pB = probRateBelow(0.0375, B.alpha, B.beta);
assertRange(pB, 0.709, 0.717, 'probRateBelow(0.0375) ∈ [0.709, 0.717]  (tight pin)');

// ---------------------------------------------------------------------------
// Sanity checks
// ---------------------------------------------------------------------------
console.log('\nSanity checks');

// 1. probRateBelow is monotonic in threshold
{
  const alpha = 2.25, beta = 39.75;
  const thresholds = [0.005, 0.01, 0.02, 0.03, 0.04, 0.05,
                      0.06, 0.07, 0.08, 0.10, 0.15, 0.20];
  const probs = thresholds.map(t => probRateBelow(t, alpha, beta));
  const monotonic = probs.every((p, i) => i === 0 || p >= probs[i - 1]);
  assert(monotonic, 'probRateBelow is monotonic in threshold');
}

// 2. posterior(5, 10, 0.5, m=0) → pointEstimate === 0.5 exactly
//    (pure MLE: alpha=5, beta=5, mean=0.5)
{
  const P0 = posterior(5, 10, 0.5, 0);
  assert(P0.pointEstimate === 0.5,
    'posterior(5, 10, 0.5, m=0).pointEstimate === 0.5 exactly');
}

// 3. I_x(1, 1) === x for x ∈ {0.1, 0.5, 0.9}
//    Beta(1,1) is Uniform[0,1]; CDF at x is exactly x
for (const x of [0.1, 0.5, 0.9]) {
  assertClose(regularizedIncompleteBeta(x, 1, 1), x, 1e-9,
    `I_x(1,1) = ${x}  (uniform CDF identity)`);
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
console.log('');
if (_failed > 0) {
  console.error(`${_failed} test(s) FAILED  (${_passed} passed)`);
  process.exit(1);
}
console.log(`STATS TESTS PASS  (${_passed} assertions)`);
