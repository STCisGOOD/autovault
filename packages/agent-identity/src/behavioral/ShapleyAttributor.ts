/**
 * ShapleyAttributor.ts
 *
 * Attributes session outcome R to individual identity dimensions using
 * Shapley values — the unique solution from cooperative game theory that
 * satisfies efficiency, symmetry, and null-player axioms.
 *
 * For N ≤ 16 dimensions, we use EXACT Shapley computation by enumerating
 * all 2^N coalitions. For N=16 this is 65,536 evaluations — trivially
 * tractable on modern hardware. This gives mathematically perfect values:
 *
 *   δ[i] = Σ_{S ⊆ N\{i}} [|S|!(N-|S|-1)!/N!] · [v(S∪{i}) - v(S)]
 *
 * Per SHAP Theorem 1 (Lundberg & Lee, NeurIPS 2017), Shapley values are
 * the unique solution satisfying local accuracy, missingness, and consistency.
 *
 * For N > 16, falls back to permutation sampling (Castro et al., 2009).
 *
 * Value function v(S) approximation:
 *   Primary: v(S) ≈ R · Σ_{i∈S} corr(metrics[i], outcome) / Z
 *   Fallback: v(S) ≈ R · Σ_{i∈S} |Δw[i]| / Σ_j |Δw[j]|
 *
 * Properties (EXACT for N ≤ 16):
 *   - Efficiency: Σδ[i] = v(N) - v(∅) exactly
 *   - Symmetry: identical metrics → equal attribution
 *   - Null player: zero contribution → zero attribution
 */

import {
  safeClamp,
  safeFinite,
  safeDivide,
  assertCompatibleLengths,
} from './math';

// =============================================================================
// TYPES
// =============================================================================

export interface DimensionAttribution {
  /** Dimension name */
  dimension: string;
  /** Dimension index */
  index: number;
  /** Shapley value δ[i] — marginal contribution to R */
  shapleyValue: number;
  /** Estimation confidence based on sampling convergence */
  confidence: number;
  /** Human-readable evidence for this attribution */
  evidence: string[];
}

export interface AttributionResult {
  /** Per-dimension attributions */
  attributions: DimensionAttribution[];
  /** Sum of Shapley values (should ≈ R) */
  efficiencyCheck: number;
  /** Max deviation from R */
  efficiencyError: number;
  /** Number of permutation samples used */
  sampleCount: number;
}

export interface CorrelationHistory {
  /** Per-dimension running correlation with outcome */
  correlations: Float64Array;
  /** Number of sessions in history */
  sessionCount: number;
  /** Running mean of dimension metrics */
  metricMeans: Float64Array;
  /** Running mean of outcomes */
  outcomeMean: number;
  /** Running covariance (metric[i], outcome) */
  covariances: Float64Array;
  /** Running variance of metrics */
  metricVariances: Float64Array;
  /** Running variance of outcomes */
  outcomeVariance: number;
}

export interface ShapleyConfig {
  /** Number of permutation samples — only used when N > exactThreshold (default: 100) */
  numPermutations: number;
  /** RNG seed for reproducibility (null = random) */
  seed: number | null;
  /** Max N for exact computation; above this, fall back to permutation sampling (default: 16) */
  exactThreshold?: number;
}

export const DEFAULT_SHAPLEY_CONFIG: ShapleyConfig = {
  numPermutations: 100,
  seed: null,
  exactThreshold: 16,
};

// =============================================================================
// CORRELATION TRACKING
// =============================================================================

/**
 * Create initial correlation history for n dimensions.
 */
export function createCorrelationHistory(n: number): CorrelationHistory {
  return {
    correlations: new Float64Array(n),
    sessionCount: 0,
    metricMeans: new Float64Array(n),
    outcomeMean: 0,
    covariances: new Float64Array(n),
    metricVariances: new Float64Array(n).fill(1), // Avoid div-by-zero
    outcomeVariance: 1,
  };
}

/**
 * Update correlation history with new session data.
 * Uses Welford's online algorithm for numerically stable running statistics.
 *
 * @param history - Current correlation state
 * @param dimensionMetrics - Observed metric per dimension (e.g., |Δw[i]|)
 * @param outcome - Session outcome R
 */
export function updateCorrelationHistory(
  history: CorrelationHistory,
  dimensionMetrics: Float64Array,
  outcome: number
): void {
  const n = dimensionMetrics.length;
  const safeOutcome = safeFinite(outcome, 0);
  history.sessionCount++;
  const count = history.sessionCount;

  // Update outcome running stats
  const oldOutcomeMean = history.outcomeMean;
  history.outcomeMean = safeFinite(
    oldOutcomeMean + safeDivide(safeOutcome - oldOutcomeMean, count, 0), oldOutcomeMean
  );

  if (count > 1) {
    history.outcomeVariance = Math.max(0, safeFinite(
      history.outcomeVariance
        + (safeOutcome - oldOutcomeMean) * (safeOutcome - history.outcomeMean)
        - safeDivide(history.outcomeVariance, count, 0),
      history.outcomeVariance
    ));
  }

  // Update per-dimension stats
  for (let i = 0; i < n; i++) {
    const x = safeFinite(dimensionMetrics[i], 0);
    const oldMean = history.metricMeans[i];
    history.metricMeans[i] = safeFinite(
      oldMean + safeDivide(x - oldMean, count, 0), oldMean
    );

    if (count > 1) {
      // Update variance (Welford) — clamp to non-negative
      history.metricVariances[i] = Math.max(0, safeFinite(
        history.metricVariances[i]
          + (x - oldMean) * (x - history.metricMeans[i])
          - safeDivide(history.metricVariances[i], count, 0),
        history.metricVariances[i]
      ));

      // Update covariance
      history.covariances[i] = safeFinite(
        history.covariances[i]
          + (x - oldMean) * (safeOutcome - history.outcomeMean)
          - safeDivide(history.covariances[i], count, 0),
        history.covariances[i]
      );
    }

    // Compute correlation
    const denom = Math.sqrt(
      Math.max(history.metricVariances[i], 1e-10) *
      Math.max(history.outcomeVariance, 1e-10)
    );
    history.correlations[i] = denom > 0 ? safeDivide(history.covariances[i], denom, 0) : 0;
  }
}

// =============================================================================
// SHAPLEY COMPUTATION
// =============================================================================

/**
 * Precomputed factorial table for n! up to 16.
 * factorial[k] = k!
 */
const FACTORIAL: number[] = [1]; // 0! = 1
for (let i = 1; i <= 17; i++) {
  FACTORIAL[i] = FACTORIAL[i - 1] * i;
}

/**
 * Count set bits in a 32-bit integer (popcount).
 */
function popcount(x: number): number {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  return (((x + (x >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}

/**
 * Simple seeded PRNG (Mulberry32).
 */
function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates shuffle using provided RNG.
 */
function shuffle(arr: number[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

/**
 * Value function v(S) — estimates the value of a coalition of dimensions.
 *
 * Primary mode (with correlation history):
 *   v(S) = R · Σ_{i∈S} |corr[i]| / Z
 *   where Z = Σ_j |corr[j]| (normalizing constant)
 *
 * Fallback mode (no history / cold start):
 *   v(S) = R · Σ_{i∈S} |Δw[i]| / Σ_j |Δw[j]|
 */
function valueFunction(
  coalition: Set<number>,
  R: number,
  weightChanges: Float64Array,
  history: CorrelationHistory | null,
  n: number
): number {
  if (coalition.size === 0) return 0;

  // Use correlation-based if we have sufficient history
  if (history && history.sessionCount >= 5) {
    let coalitionWeight = 0;
    let totalWeight = 0;
    for (let i = 0; i < n; i++) {
      const absCorr = Math.abs(history.correlations[i]);
      totalWeight += absCorr;
      if (coalition.has(i)) {
        coalitionWeight += absCorr;
      }
    }
    if (totalWeight > 1e-10) {
      return safeFinite(R * safeDivide(coalitionWeight, totalWeight, 0), 0);
    }
  }

  // Fallback: weight-change-based
  let coalitionChange = 0;
  let totalChange = 0;
  for (let i = 0; i < n; i++) {
    const absChange = Math.abs(weightChanges[i]);
    totalChange += absChange;
    if (coalition.has(i)) {
      coalitionChange += absChange;
    }
  }

  if (totalChange < 1e-10) {
    // No changes at all — uniform attribution
    return safeFinite(R * safeDivide(coalition.size, n, 0), 0);
  }

  return safeFinite(R * safeDivide(coalitionChange, totalChange, 0), 0);
}

/**
 * Compute Shapley attribution for a session outcome.
 *
 * For N ≤ exactThreshold (default 16), uses exact enumeration over all 2^N
 * coalitions. For N > exactThreshold, falls back to permutation sampling.
 *
 * @param R - Session outcome quality [-1, 1]
 * @param weightChanges - |Δw[i]| per dimension from this session
 * @param dimensions - Dimension names
 * @param history - Correlation history (null for cold start)
 * @param config - Shapley configuration
 */
export function computeShapleyAttribution(
  R: number,
  weightChanges: Float64Array,
  dimensions: readonly string[],
  history: CorrelationHistory | null = null,
  config: ShapleyConfig = DEFAULT_SHAPLEY_CONFIG
): AttributionResult {
  const n = dimensions.length;
  const safeR = safeFinite(R, 0);
  const threshold = safeFinite(config.exactThreshold, 16);

  // Early return for degenerate cases
  if (n === 0) {
    return { attributions: [], efficiencyCheck: 0, efficiencyError: Math.abs(safeR), sampleCount: 0 };
  }

  // Length validation
  if (weightChanges.length !== n) {
    assertCompatibleLengths(
      'computeShapleyAttribution',
      ['dimensions', { length: n }],
      ['weightChanges', weightChanges],
    );
  }

  // Dispatch: exact for small N, sampling for large N
  if (n <= threshold) {
    return computeExactShapley(safeR, weightChanges, dimensions, history, n);
  }
  return computeSamplingShapley(safeR, weightChanges, dimensions, history, n, config);
}

/**
 * Exact Shapley computation via 2^N coalition enumeration.
 *
 * δ[i] = Σ_{S ⊆ N\{i}} [|S|!(N-|S|-1)!/N!] · [v(S∪{i}) - v(S)]
 *
 * Complexity: 2^N evaluations of v + N·2^(N-1) lookups.
 * For N=16: 65,536 + 524,288 = sub-second on any modern hardware.
 */
function computeExactShapley(
  R: number,
  weightChanges: Float64Array,
  dimensions: readonly string[],
  history: CorrelationHistory | null,
  n: number,
): AttributionResult {
  const totalCoalitions = 1 << n; // 2^N
  const nFactorial = FACTORIAL[n];

  // Step 1: Precompute all 2^N coalition values
  const coalitionValues = new Float64Array(totalCoalitions);
  for (let mask = 0; mask < totalCoalitions; mask++) {
    coalitionValues[mask] = valueFunctionBitmask(mask, R, weightChanges, history, n);
  }

  // Step 2: Compute exact Shapley values
  const shapleyValues = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const iBit = 1 << i;
    let sv = 0;

    // Iterate over all coalitions S that do NOT contain i
    for (let mask = 0; mask < totalCoalitions; mask++) {
      if (mask & iBit) continue; // Skip coalitions containing i

      const s = popcount(mask);
      const weight = FACTORIAL[s] * FACTORIAL[n - s - 1] / nFactorial;

      // Marginal contribution: v(S ∪ {i}) - v(S)
      const maskWithI = mask | iBit;
      const marginal = coalitionValues[maskWithI] - coalitionValues[mask];

      sv += weight * marginal;
    }

    shapleyValues[i] = safeFinite(sv, 0);
  }

  // Step 3: Build result with evidence
  const attributions: DimensionAttribution[] = [];
  let efficiencySum = 0;

  // Efficiency reference: v(N) - v(∅)
  const vGrand = coalitionValues[totalCoalitions - 1];
  const vEmpty = coalitionValues[0];

  for (let i = 0; i < n; i++) {
    const sv = shapleyValues[i];

    // Build evidence
    const evidence: string[] = [];
    if (Math.abs(weightChanges[i]) > 0.01) {
      evidence.push(`Weight changed by ${weightChanges[i].toFixed(4)}`);
    }
    if (history && history.sessionCount >= 5) {
      evidence.push(`Correlation with outcome: ${history.correlations[i].toFixed(3)}`);
    }
    if (sv > 0) {
      evidence.push('Positively contributed to outcome');
    } else if (sv < 0) {
      evidence.push('Negatively contributed to outcome');
    }

    attributions.push({
      dimension: dimensions[i] as string,
      index: i,
      shapleyValue: sv,
      confidence: 1.0, // Exact computation — no sampling uncertainty
      evidence,
    });

    efficiencySum += sv;
  }

  return {
    attributions,
    efficiencyCheck: efficiencySum,
    efficiencyError: Math.abs(efficiencySum - (vGrand - vEmpty)),
    sampleCount: totalCoalitions,
  };
}

/**
 * Permutation-sampling Shapley for N > exactThreshold.
 * Fallback for dimensions > 16 (if ever needed).
 */
function computeSamplingShapley(
  R: number,
  weightChanges: Float64Array,
  dimensions: readonly string[],
  history: CorrelationHistory | null,
  n: number,
  config: ShapleyConfig,
): AttributionResult {
  const K = Math.max(1, Math.floor(safeFinite(config.numPermutations, 100)));

  // RNG setup
  const rng = config.seed !== null
    ? mulberry32(config.seed)
    : () => Math.random();

  // Accumulate marginal contributions
  const marginalSums = new Float64Array(n);
  const marginalSumsSq = new Float64Array(n);

  const indices = Array.from({ length: n }, (_, i) => i);

  for (let k = 0; k < K; k++) {
    const perm = [...indices];
    shuffle(perm, rng);

    const coalition = new Set<number>();

    for (const i of perm) {
      const vBefore = valueFunction(coalition, R, weightChanges, history, n);
      coalition.add(i);
      const vAfter = valueFunction(coalition, R, weightChanges, history, n);

      const marginal = vAfter - vBefore;
      marginalSums[i] += marginal;
      marginalSumsSq[i] += marginal * marginal;
    }
  }

  // Compute means and confidence
  const attributions: DimensionAttribution[] = [];
  let efficiencySum = 0;

  for (let i = 0; i < n; i++) {
    const mean = safeDivide(marginalSums[i], K, 0);
    const variance = Math.max(0, safeDivide(marginalSumsSq[i], K, 0) - mean * mean);
    const stdErr = Math.sqrt(safeDivide(variance, K, 0));

    const confidence = Math.abs(mean) > 1e-10
      ? safeClamp(1 - safeDivide(stdErr, Math.abs(mean), 1), 0, 1, 0)
      : 0;

    const evidence: string[] = [];
    if (Math.abs(weightChanges[i]) > 0.01) {
      evidence.push(`Weight changed by ${weightChanges[i].toFixed(4)}`);
    }
    if (history && history.sessionCount >= 5) {
      evidence.push(`Correlation with outcome: ${history.correlations[i].toFixed(3)}`);
    }
    if (mean > 0) {
      evidence.push('Positively contributed to outcome');
    } else if (mean < 0) {
      evidence.push('Negatively contributed to outcome');
    }

    attributions.push({
      dimension: dimensions[i] as string,
      index: i,
      shapleyValue: mean,
      confidence,
      evidence,
    });

    efficiencySum += mean;
  }

  return {
    attributions,
    efficiencyCheck: efficiencySum,
    efficiencyError: Math.abs(efficiencySum - R),
    sampleCount: K,
  };
}

// =============================================================================
// BITMASK VALUE FUNCTION (for exact computation)
// =============================================================================

/**
 * Value function v(S) using bitmask representation for exact Shapley.
 *
 * Same logic as valueFunction() but operates on integer bitmask
 * instead of Set<number> for performance in the 2^N enumeration.
 */
function valueFunctionBitmask(
  mask: number,
  R: number,
  weightChanges: Float64Array,
  history: CorrelationHistory | null,
  n: number
): number {
  if (mask === 0) return 0;

  // Use correlation-based if we have sufficient history
  if (history && history.sessionCount >= 5) {
    let coalitionWeight = 0;
    let totalWeight = 0;
    for (let i = 0; i < n; i++) {
      const absCorr = Math.abs(history.correlations[i]);
      totalWeight += absCorr;
      if (mask & (1 << i)) {
        coalitionWeight += absCorr;
      }
    }
    if (totalWeight > 1e-10) {
      return safeFinite(R * safeDivide(coalitionWeight, totalWeight, 0), 0);
    }
  }

  // Fallback: weight-change-based
  let coalitionChange = 0;
  let totalChange = 0;
  for (let i = 0; i < n; i++) {
    const absChange = Math.abs(weightChanges[i]);
    totalChange += absChange;
    if (mask & (1 << i)) {
      coalitionChange += absChange;
    }
  }

  if (totalChange < 1e-10) {
    // No changes at all — uniform attribution
    return safeFinite(R * safeDivide(popcount(mask), n, 0), 0);
  }

  return safeFinite(R * safeDivide(coalitionChange, totalChange, 0), 0);
}

// (clamp replaced by safeClamp from ./math)
