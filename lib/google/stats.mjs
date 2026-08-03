/**
 * lib/google/stats.mjs
 *
 * Pure Bayesian statistics for the Google Ads honesty layer (P3 spec).
 * No external dependencies. All functions are named exports.
 *
 * Engine anchor : target CPA 2.50 EUR
 * Prior strength : m = 30 (default)
 * Confidence floor : 0.90 (ACT threshold)
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Natural log of the Gamma function via the Lanczos approximation (g=7, n=9).
 * Accurate to ~1e-15 for Re(z) > 0.
 */
function _lnGamma(z) {
  const p = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    // Reflection formula: Γ(z)Γ(1-z) = π/sin(πz)
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - _lnGamma(1 - z);
  }
  z -= 1;
  let a = p[0];
  for (let i = 1; i < 9; i++) a += p[i] / (z + i);
  const t = z + 7.5; // g + 0.5 where g = 7
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * Lentz continued-fraction evaluator for the regularized incomplete beta
 * function.  Returns the CF component CF(x, a, b) such that:
 *
 *   I_x(a,b) = [x^a (1-x)^b / (a B(a,b))] × CF(x, a, b)   (x < (a+1)/(a+b+2))
 *
 * Reference: Numerical Recipes §6.4 (betacf).
 */
function _betacf(x, a, b) {
  const MAXIT = 300;
  const EPS   = 3e-10;                      // drives ~1e-9 absolute accuracy
  const FPMIN = Number.MIN_VALUE / EPS;

  const qab = a + b;
  const qap = a + 1.0;
  const qam = a - 1.0;

  let c = 1.0;
  let d = 1.0 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1.0 / d;
  let h = d;

  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;

    // Even step (d_{2m})
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1.0 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1.0 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1.0 / d;
    h *= d * c;

    // Odd step (d_{2m+1})
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1.0 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1.0 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1.0 / d;
    const del = d * c;
    h *= del;

    if (Math.abs(del - 1.0) <= EPS) break;
  }
  return h;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Regularized incomplete beta function I_x(a, b) via the Lentz
 * continued-fraction method.
 *
 * Accurate to ~1e-9 on 0 ≤ x ≤ 1, a > 0, b > 0.
 *
 * @param {number} x  Evaluation point in [0, 1]
 * @param {number} a  First shape parameter (> 0)
 * @param {number} b  Second shape parameter (> 0)
 * @returns {number}  I_x(a, b) ∈ [0, 1]
 */
export function regularizedIncompleteBeta(x, a, b) {
  if (x < 0 || x > 1) throw new RangeError(`x must be in [0, 1], got ${x}`);
  if (x === 0) return 0.0;
  if (x === 1) return 1.0;

  // log of the complete beta function B(a, b)
  const lbeta = _lnGamma(a) + _lnGamma(b) - _lnGamma(a + b);
  const bt    = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta);

  // Use symmetry to keep x in the region where the CF converges fastest
  if (x < (a + 1) / (a + b + 2)) {
    return bt * _betacf(x, a, b) / a;
  } else {
    return 1.0 - bt * _betacf(1 - x, b, a) / b;
  }
}

/**
 * Compute Beta posterior parameters for a conversion rate given observed
 * counts and a conjugate Beta prior anchored to a parent rate.
 *
 * Prior  : Beta(parentRate × m,  (1 − parentRate) × m)
 * Posterior after c conversions in n clicks:
 *         Beta(alpha, beta)  where
 *           alpha = parentRate × m + c
 *           beta  = (1 − parentRate) × m + (n − c)
 *
 * @param {number} c          Observed conversions
 * @param {number} n          Observed clicks  (≥ c)
 * @param {number} parentRate Parent / benchmark conversion rate  (0 < p < 1)
 * @param {number} [m=30]     Prior strength (pseudo-sample size)
 * @returns {{ alpha: number, beta: number, pointEstimate: number }}
 */
export function posterior(c, n, parentRate, m = 30) {
  const alpha = parentRate * m + c;
  const beta  = (1 - parentRate) * m + (n - c);
  return {
    alpha,
    beta,
    pointEstimate: alpha / (alpha + beta),
  };
}

/**
 * Probability that the true conversion rate is strictly below `threshold`,
 * given a Beta(alpha, beta) posterior.
 *
 * Returns I_{threshold}(alpha, beta).
 *
 * @param {number} threshold  Rate threshold in (0, 1)
 * @param {number} alpha      Posterior alpha parameter
 * @param {number} beta       Posterior beta parameter
 * @returns {number}          Probability in [0, 1]
 */
export function probRateBelow(threshold, alpha, beta) {
  return regularizedIncompleteBeta(threshold, alpha, beta);
}

/**
 * Map a posterior probability and a gate flag to a four-state engine signal.
 *
 * States per P3 spec §1.3 / §1.5:
 *   INSUFFICIENT — gate1 not met (insufficient data or eligibility)
 *   ACT          — probability ≥ 0.90
 *   WATCH        — probability ≥ 0.60
 *   NEUTRAL      — probability < 0.60
 *
 * @param {number}  probability  Result of probRateBelow (or equivalent)
 * @param {boolean} gate1Met     Whether the gate-1 eligibility check is met
 * @returns {'ACT'|'WATCH'|'NEUTRAL'|'INSUFFICIENT'}
 */
export function fourState(probability, gate1Met) {
  if (!gate1Met)           return 'INSUFFICIENT';
  if (probability >= 0.90) return 'ACT';
  if (probability >= 0.60) return 'WATCH';
  return 'NEUTRAL';
}
