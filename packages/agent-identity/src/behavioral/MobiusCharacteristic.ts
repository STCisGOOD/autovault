/**
 * MobiusCharacteristic.ts
 *
 * Learns the Möbius coefficients (Harsanyi dividends) of a characteristic
 * function from session history, replacing the additive v(S) in the Shapley
 * attributor with a non-additive learned function that captures dimension
 * interactions.
 *
 * Mathematical foundation:
 *   Every v: 2^N → ℝ has a unique multilinear polynomial expansion:
 *     v(S) = Σ_{T⊆S} m(T)
 *   where m(T) = Σ_{L⊆T} (-1)^{|T|-|L|} · v(L) are the Möbius coefficients.
 *
 *   Each m(T) quantifies the irreducible interaction among exactly the
 *   players in T — the portion of value not attributable to any proper
 *   sub-coalition. This is not an approximation; it's a mathematical identity.
 *
 * For k-additive games (m(T) = 0 for |T| > k), Shapley values have a
 * closed-form expression:
 *   φ[i] = Σ_{T∋i, |T|≤k} m(T) / |T|
 *
 * The coefficients are learned via LASSO (L1-regularized least squares)
 * on session history, with temporal decay weighting recent sessions more.
 * L1 enforces sparsity — the model must earn non-additivity from the data.
 *
 * @see Grabisch (1997) — k-additive games
 * @see Harsanyi (1963) — dividends
 * @see Stobbe & Krause (2012) — compressed sensing for set functions
 */

import { safeFinite, safeDivide } from './math';

// =============================================================================
// TYPES
// =============================================================================

export interface MobiusConfig {
  /** Max interaction order k (start at 2 for pairwise) */
  maxOrder: number;
  /** L1 penalty λ for LASSO — high = conservative, prior toward additivity */
  regularization: number;
  /** Per-day temporal decay rate for old observations */
  decayRate: number;
  /** Sessions before enabling non-additive mode */
  minObservations: number;
  /** R² threshold below which order k is increased */
  residualThreshold: number;
  /** How much a dimension must deviate from baseline to be "active" */
  activationThreshold: number;
  /** Sliding window: max observations to retain */
  maxObservations: number;
  /** LASSO coordinate descent max iterations */
  lassoMaxIter: number;
  /** LASSO convergence tolerance */
  lassoTol: number;
}

export const DEFAULT_MOBIUS_CONFIG: MobiusConfig = {
  maxOrder: 2,
  regularization: 0.1,
  decayRate: 0.01,
  minObservations: 20,
  residualThreshold: 0.3,
  activationThreshold: 0.1,
  maxObservations: 1000,
  lassoMaxIter: 1000,
  lassoTol: 1e-8,
};

export interface CoalitionObservation {
  /** Session index */
  sessionId: number;
  /** Bitmask of dimensions that deviated from baseline (the "active set") */
  activeMask: number;
  /** Actual weight values at session end */
  weights: number[];
  /** Consolidated init values (counterfactual baseline) */
  baselineWeights: number[];
  /** Session outcome R */
  outcome: number;
  /** Timestamp for temporal decay */
  timestamp: number;
}

export interface MobiusState {
  /** Bitmask → m(T) coefficient (only nonzero entries stored) */
  coefficients: Map<number, number>;
  /** Session observation history */
  observations: CoalitionObservation[];
  /** Current interaction order k */
  currentOrder: number;
  /** Current model fit quality (1 - R²) */
  fitResidual: number;
  /** Dimension count */
  dimensionCount: number;
}

/** Serializable form of MobiusState for persistence */
export interface SerializedMobiusState {
  coefficients: [number, number][];
  observations: CoalitionObservation[];
  currentOrder: number;
  fitResidual: number;
  dimensionCount: number;
}

// =============================================================================
// BIT UTILITIES
// =============================================================================

/**
 * Count set bits in a 32-bit integer (popcount).
 */
export function popcount(x: number): number {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  return (((x + (x >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}

/**
 * Check if bitmask T is a subset of bitmask S: T ⊆ S.
 */
export function isSubset(T: number, S: number): boolean {
  return (T & S) === T;
}

// =============================================================================
// COALITION ENUMERATION
// =============================================================================

/**
 * Enumerate all coalitions T with |T| ≤ maxOrder for N dimensions.
 *
 * Returns sorted bitmasks. For N=4, k=2:
 *   0b0000 (∅), 0b0001, 0b0010, 0b0100, 0b1000 (singletons),
 *   0b0011, 0b0101, 0b0110, 0b1001, 0b1010, 0b1100 (pairs) = 11 entries
 */
export function enumerateCoalitions(N: number, maxOrder: number): number[] {
  const coalitions: number[] = [];
  const totalMasks = 1 << N;
  for (let mask = 0; mask < totalMasks; mask++) {
    if (popcount(mask) <= maxOrder) {
      coalitions.push(mask);
    }
  }
  return coalitions;
}

/**
 * Count parameters for a k-additive game with N dimensions.
 * = Σ_{j=0}^{k} C(N, j)
 */
export function parameterCount(N: number, k: number): number {
  let count = 0;
  for (let j = 0; j <= Math.min(k, N); j++) {
    count += binomial(N, j);
  }
  return count;
}

function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 0; i < Math.min(k, n - k); i++) {
    result = result * (n - i) / (i + 1);
  }
  return Math.round(result);
}

// =============================================================================
// ACTIVE SET DETECTION
// =============================================================================

/**
 * Determine which dimensions are "active" — deviated significantly from baseline.
 *
 * A dimension is active if |w[i] - baseline[i]| > threshold.
 * Returns a bitmask.
 */
export function getActiveSet(
  sessionWeights: number[],
  baselineWeights: number[],
  threshold: number = 0.1
): number {
  let mask = 0;
  const n = Math.min(sessionWeights.length, baselineWeights.length);
  for (let i = 0; i < n; i++) {
    if (Math.abs(sessionWeights[i] - baselineWeights[i]) > threshold) {
      mask |= (1 << i);
    }
  }
  return mask;
}

// =============================================================================
// DESIGN MATRIX
// =============================================================================

/**
 * Build the design matrix Φ for LASSO regression.
 *
 * Φ[i][j] = 1 if coalition[j] ⊆ activeSet(observation[i]), else 0
 *
 * Each row is an observation (session). Each column is a Möbius coefficient
 * (coalition T). The entry is 1 when all members of T were active in that
 * session — meaning T's interaction could have contributed to the outcome.
 */
export function buildDesignMatrix(
  observations: CoalitionObservation[],
  coalitions: number[]
): number[][] {
  const n = observations.length;
  const p = coalitions.length;
  const Phi: number[][] = new Array(n);

  for (let i = 0; i < n; i++) {
    const row = new Array(p);
    const activeMask = observations[i].activeMask;
    for (let j = 0; j < p; j++) {
      row[j] = isSubset(coalitions[j], activeMask) ? 1 : 0;
    }
    Phi[i] = row;
  }

  return Phi;
}

// =============================================================================
// LASSO SOLVER
// =============================================================================

/**
 * Solve LASSO via coordinate descent with precomputed Gram matrix.
 *
 * minimize  ½||y - Φm||²₂ + λ||m||₁
 *
 * Uses the Gram matrix G = Φ^T Φ (precomputed) for O(p) per coordinate
 * instead of O(np). Temporal weighting is applied to BOTH Φ and y before
 * Gram computation (weighted LASSO).
 *
 * @param G - Gram matrix Φ_w^T Φ_w (p × p) where Φ_w is temporally weighted
 * @param PhiTy - Φ_w^T y_w vector (p × 1)
 * @param lambda - L1 penalty
 * @param p - Number of coefficients
 * @param warmStart - Previous solution for warm-starting
 * @param maxIter - Maximum iterations
 * @param tol - Convergence tolerance
 */
export function solveLASSO(
  G: number[][],
  PhiTy: number[],
  lambda: number,
  p: number,
  warmStart?: number[],
  maxIter: number = 1000,
  tol: number = 1e-8
): number[] {
  const m = warmStart ? warmStart.slice() : new Array(p).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    let maxChange = 0;

    for (let j = 0; j < p; j++) {
      if (G[j][j] < 1e-12) continue; // degenerate column

      // Compute partial residual: ρ_j = Φ_w^T y_w[j] - Σ_{k≠j} G[j][k] · m[k]
      let rho = PhiTy[j];
      for (let k = 0; k < p; k++) {
        if (k === j) continue;
        rho -= G[j][k] * m[k];
      }

      // Soft thresholding
      const oldM = m[j];
      if (rho > lambda) {
        m[j] = (rho - lambda) / G[j][j];
      } else if (rho < -lambda) {
        m[j] = (rho + lambda) / G[j][j];
      } else {
        m[j] = 0;
      }

      maxChange = Math.max(maxChange, Math.abs(m[j] - oldM));
    }

    if (maxChange < tol) break;
  }

  return m;
}

/**
 * Precompute the Gram matrix and Φ^T y for weighted LASSO.
 *
 * Applies temporal decay weights to both Φ and y before computing:
 *   G = Φ_w^T Φ_w
 *   PhiTy = Φ_w^T y_w
 *
 * where Φ_w[i] = sqrt(w_i) · Φ[i] and y_w[i] = sqrt(w_i) · y[i].
 */
export function precomputeGram(
  Phi: number[][],
  y: number[],
  temporalWeights: number[]
): { G: number[][]; PhiTy: number[] } {
  const n = Phi.length;
  const p = Phi[0]?.length ?? 0;

  // Initialize
  const G: number[][] = new Array(p);
  for (let j = 0; j < p; j++) {
    G[j] = new Array(p).fill(0);
  }
  const PhiTy: number[] = new Array(p).fill(0);

  // Accumulate: G[j][k] = Σ_i w_i · Φ[i][j] · Φ[i][k]
  //             PhiTy[j] = Σ_i w_i · Φ[i][j] · y[i]
  for (let i = 0; i < n; i++) {
    const w = temporalWeights[i];
    const row = Phi[i];
    const yi = y[i];

    for (let j = 0; j < p; j++) {
      if (row[j] === 0) continue; // sparse optimization
      const wPhiJ = w * row[j];
      PhiTy[j] += wPhiJ * yi;
      for (let k = j; k < p; k++) {
        if (row[k] === 0) continue;
        const val = wPhiJ * row[k];
        G[j][k] += val;
        if (k !== j) G[k][j] += val; // symmetric
      }
    }
  }

  return { G, PhiTy };
}

/**
 * Compute temporal decay weights for observations.
 * Weight = exp(-age_days * decayRate)
 */
export function computeTemporalWeights(
  observations: CoalitionObservation[],
  decayRate: number,
  now: number = Date.now()
): number[] {
  const MS_PER_DAY = 86400000;
  return observations.map(obs => {
    const ageDays = (now - obs.timestamp) / MS_PER_DAY;
    return Math.exp(-ageDays * decayRate);
  });
}

// =============================================================================
// COEFFICIENT LEARNING
// =============================================================================

/**
 * Learn Möbius coefficients from session observations via weighted LASSO.
 *
 * @param observations - Session history
 * @param coalitions - Enumerated coalition bitmasks for current k
 * @param config - Möbius configuration
 * @param warmStart - Previous coefficients for warm-starting
 * @returns Map from coalition bitmask to Möbius coefficient (sparse: zeros omitted)
 */
export function learnCoefficients(
  observations: CoalitionObservation[],
  coalitions: number[],
  config: MobiusConfig,
  warmStart?: Map<number, number>
): Map<number, number> {
  if (observations.length === 0) return new Map();

  const p = coalitions.length;

  // Build design matrix
  const Phi = buildDesignMatrix(observations, coalitions);
  const y = observations.map(obs => obs.outcome);

  // Compute temporal weights
  const temporalWeights = computeTemporalWeights(observations, config.decayRate);

  // Precompute Gram matrix with temporal weighting
  const { G, PhiTy } = precomputeGram(Phi, y, temporalWeights);

  // Warm-start from previous solution
  let warmStartArray: number[] | undefined;
  if (warmStart && warmStart.size > 0) {
    warmStartArray = coalitions.map(mask => warmStart.get(mask) ?? 0);
  }

  // Solve LASSO
  const mArray = solveLASSO(
    G, PhiTy, config.regularization, p,
    warmStartArray, config.lassoMaxIter, config.lassoTol
  );

  // Package as sparse map (only nonzero entries)
  const coefficients = new Map<number, number>();
  for (let j = 0; j < p; j++) {
    if (Math.abs(mArray[j]) > 1e-10) {
      coefficients.set(coalitions[j], mArray[j]);
    }
  }

  return coefficients;
}

// =============================================================================
// CHARACTERISTIC FUNCTION EVALUATION
// =============================================================================

/**
 * Evaluate v(S) = Σ_{T⊆S} m(T) from learned Möbius coefficients.
 */
export function evaluateCharacteristic(
  coalitionMask: number,
  coefficients: Map<number, number>
): number {
  let value = 0;
  for (const [T, mT] of coefficients) {
    if (isSubset(T, coalitionMask)) {
      value += mT;
    }
  }
  return safeFinite(value, 0);
}

/**
 * Evaluate v(S) for all 2^N coalitions. Returns array indexed by bitmask.
 */
export function evaluateAllCoalitions(
  N: number,
  coefficients: Map<number, number>
): number[] {
  const total = 1 << N;
  const values = new Array(total).fill(0);
  for (let mask = 0; mask < total; mask++) {
    values[mask] = evaluateCharacteristic(mask, coefficients);
  }
  return values;
}

// =============================================================================
// SHAPLEY FROM MÖBIUS (CLOSED FORM)
// =============================================================================

/**
 * Compute exact Shapley values from Möbius coefficients.
 *
 *   φ[i] = Σ_{T∋i} m(T) / |T|
 *
 * This is O(|nonzero coefficients| × N) — near-instant for sparse models.
 *
 * Property: Σ φ[i] = v(N) - v(∅) (efficiency) holds by construction.
 */
export function shapleyFromMobius(
  N: number,
  coefficients: Map<number, number>
): number[] {
  const phi = new Array(N).fill(0);

  for (const [T, mT] of coefficients) {
    const size = popcount(T);
    if (size === 0) continue; // m(∅) doesn't contribute to Shapley values

    const share = mT / size;
    for (let i = 0; i < N; i++) {
      if (T & (1 << i)) {
        phi[i] += share;
      }
    }
  }

  return phi.map(v => safeFinite(v, 0));
}

// =============================================================================
// MÖBIUS TRANSFORM (EXACT, for testing/verification)
// =============================================================================

/**
 * Compute the exact Möbius transform (inverse zeta transform) from a
 * complete set of coalition values.
 *
 *   m(T) = Σ_{L⊆T} (-1)^{|T|-|L|} · v(L)
 *
 * Requires v(S) for ALL 2^N coalitions. Used for testing the learned
 * coefficients against a known ground truth.
 *
 * @param coalitionValues - Array indexed by bitmask: coalitionValues[mask] = v(mask)
 * @param N - Number of dimensions
 * @returns Map from coalition bitmask to Möbius coefficient
 */
export function exactMobiusTransform(
  coalitionValues: number[],
  N: number
): Map<number, number> {
  const total = 1 << N;
  const coefficients = new Map<number, number>();

  for (let T = 0; T < total; T++) {
    let mT = 0;
    // Sum over all subsets L of T
    // Enumerate subsets of T using the bitmask subset trick
    let L = T;
    while (true) {
      const sign = ((popcount(T) - popcount(L)) % 2 === 0) ? 1 : -1;
      mT += sign * (coalitionValues[L] ?? 0);
      if (L === 0) break;
      L = (L - 1) & T; // next subset of T
    }

    if (Math.abs(mT) > 1e-12) {
      coefficients.set(T, mT);
    }
  }

  return coefficients;
}

/**
 * Compute exact Shapley values via full 2^N enumeration for verification.
 *
 *   δ[i] = Σ_{S ⊆ N\{i}} [|S|!(N-|S|-1)!/N!] · [v(S∪{i}) - v(S)]
 */
export function exactShapleyFromValues(
  coalitionValues: number[],
  N: number
): number[] {
  const phi = new Array(N).fill(0);
  const total = 1 << N;
  const nFact = factorial(N);

  for (let i = 0; i < N; i++) {
    const iBit = 1 << i;
    let sv = 0;

    for (let mask = 0; mask < total; mask++) {
      if (mask & iBit) continue; // skip coalitions containing i

      const s = popcount(mask);
      const weight = factorial(s) * factorial(N - s - 1) / nFact;
      const marginal = coalitionValues[mask | iBit] - coalitionValues[mask];
      sv += weight * marginal;
    }

    phi[i] = safeFinite(sv, 0);
  }

  return phi;
}

function factorial(n: number): number {
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

// =============================================================================
// FIT QUALITY / ORDER ADAPTATION
// =============================================================================

/**
 * Compute the R² fit quality of the current model against observations.
 *
 * R² = 1 - Var(residuals) / Var(outcomes)
 *
 * Returns fitResidual = 1 - R² (lower is better).
 */
export function computeFitResidual(
  observations: CoalitionObservation[],
  coefficients: Map<number, number>
): number {
  if (observations.length < 2) return 1.0;

  const outcomes = observations.map(o => o.outcome);
  const predictions = observations.map(obs =>
    evaluateCharacteristic(obs.activeMask, coefficients)
  );

  const residuals = outcomes.map((y, i) => y - predictions[i]);

  const meanOutcome = outcomes.reduce((a, b) => a + b, 0) / outcomes.length;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < outcomes.length; i++) {
    ssRes += residuals[i] * residuals[i];
    ssTot += (outcomes[i] - meanOutcome) * (outcomes[i] - meanOutcome);
  }

  if (ssTot < 1e-12) return 0; // constant outcome → perfect fit trivially
  const rSquared = 1 - ssRes / ssTot;
  return safeFinite(1 - rSquared, 1.0);
}

/**
 * Check whether the model order should be increased.
 *
 * Triggers when:
 *   1. Fit residual exceeds threshold (model doesn't explain enough variance)
 *   2. There's enough data for the next order (≥ 3× overdetermined)
 */
export function checkOrderAdaptation(
  observations: CoalitionObservation[],
  coefficients: Map<number, number>,
  currentOrder: number,
  N: number,
  config: MobiusConfig
): number {
  const residual = computeFitResidual(observations, coefficients);
  const nextOrderParams = parameterCount(N, currentOrder + 1);

  if (residual > config.residualThreshold
      && observations.length > nextOrderParams * 3
      && currentOrder + 1 <= Math.min(N, config.maxOrder)) {
    return currentOrder + 1;
  }

  return currentOrder;
}

// =============================================================================
// BLEND TRANSITION
// =============================================================================

/**
 * Compute blend weight for transitioning from additive to Möbius attribution.
 *
 * blend = 0 → pure additive (existing behavior)
 * blend = 1 → pure Möbius
 *
 * Ramps linearly from 0 to 1 over [minObservations, 2 * minObservations].
 */
export function computeBlend(
  sessionCount: number,
  minObservations: number
): number {
  if (sessionCount < minObservations) return 0;
  const ramp = (sessionCount - minObservations) / Math.max(1, minObservations);
  return Math.min(1, ramp);
}

/**
 * Blend additive and Möbius Shapley values.
 */
export function blendShapley(
  additiveShapley: number[],
  mobiusShapley: number[],
  blend: number
): number[] {
  const n = Math.min(additiveShapley.length, mobiusShapley.length);
  const result = new Array(n);
  for (let i = 0; i < n; i++) {
    result[i] = (1 - blend) * additiveShapley[i] + blend * mobiusShapley[i];
  }
  return result;
}

// =============================================================================
// STATE MANAGEMENT
// =============================================================================

/**
 * Create initial Möbius state.
 */
export function createMobiusState(N: number, config: MobiusConfig = DEFAULT_MOBIUS_CONFIG): MobiusState {
  return {
    coefficients: new Map(),
    observations: [],
    currentOrder: config.maxOrder,
    fitResidual: 1.0,
    dimensionCount: N,
  };
}

/**
 * Serialize MobiusState for persistence.
 */
export function serializeMobiusState(state: MobiusState): SerializedMobiusState {
  return {
    coefficients: Array.from(state.coefficients.entries()),
    observations: state.observations,
    currentOrder: state.currentOrder,
    fitResidual: state.fitResidual,
    dimensionCount: state.dimensionCount,
  };
}

/**
 * Deserialize MobiusState from persistence.
 */
export function deserializeMobiusState(data: SerializedMobiusState): MobiusState {
  return {
    coefficients: new Map(data.coefficients),
    observations: data.observations,
    currentOrder: data.currentOrder,
    fitResidual: data.fitResidual,
    dimensionCount: data.dimensionCount,
  };
}

/**
 * Prune observations to stay within the sliding window.
 * Removes oldest observations first.
 */
export function pruneObservations(
  state: MobiusState,
  maxObservations: number
): void {
  if (state.observations.length > maxObservations) {
    state.observations = state.observations.slice(
      state.observations.length - maxObservations
    );
  }
}

// =============================================================================
// HIGH-LEVEL API
// =============================================================================

/**
 * MobiusCharacteristic — the learned characteristic function.
 *
 * Encapsulates the full lifecycle: observation collection, coefficient
 * learning, Shapley computation, and state management.
 */
export class MobiusCharacteristic {
  private readonly config: MobiusConfig;
  private state: MobiusState;

  constructor(N: number, config: Partial<MobiusConfig> = {}) {
    this.config = { ...DEFAULT_MOBIUS_CONFIG, ...config };
    this.state = createMobiusState(N, this.config);
  }

  /** Get current Möbius state (read-only view). */
  getState(): Readonly<MobiusState> {
    return this.state;
  }

  /** Get the dimension count. */
  get N(): number {
    return this.state.dimensionCount;
  }

  /**
   * Add a session observation.
   *
   * @param sessionWeights - Weights at session end
   * @param baselineWeights - Consolidated init (counterfactual baseline)
   * @param outcome - Session outcome R
   * @param sessionId - Session index
   */
  addObservation(
    sessionWeights: number[],
    baselineWeights: number[],
    outcome: number,
    sessionId: number = this.state.observations.length,
    timestamp: number = Date.now()
  ): void {
    const activeMask = getActiveSet(
      sessionWeights, baselineWeights, this.config.activationThreshold
    );

    this.state.observations.push({
      sessionId,
      activeMask,
      weights: sessionWeights.slice(),
      baselineWeights: baselineWeights.slice(),
      outcome,
      timestamp,
    });

    // Enforce sliding window
    pruneObservations(this.state, this.config.maxObservations);
  }

  /**
   * Re-learn Möbius coefficients from current observations.
   * Warm-starts from previous solution.
   */
  updateCoefficients(): void {
    if (this.state.observations.length === 0) return;

    const coalitions = enumerateCoalitions(
      this.state.dimensionCount, this.state.currentOrder
    );

    this.state.coefficients = learnCoefficients(
      this.state.observations,
      coalitions,
      this.config,
      this.state.coefficients
    );

    // Update fit residual
    this.state.fitResidual = computeFitResidual(
      this.state.observations, this.state.coefficients
    );

    // Check order adaptation
    const newOrder = checkOrderAdaptation(
      this.state.observations,
      this.state.coefficients,
      this.state.currentOrder,
      this.state.dimensionCount,
      this.config
    );

    if (newOrder > this.state.currentOrder) {
      this.state.currentOrder = newOrder;
      // Re-learn with expanded order
      const expandedCoalitions = enumerateCoalitions(
        this.state.dimensionCount, newOrder
      );
      this.state.coefficients = learnCoefficients(
        this.state.observations,
        expandedCoalitions,
        this.config,
        this.state.coefficients
      );
      this.state.fitResidual = computeFitResidual(
        this.state.observations, this.state.coefficients
      );
    }
  }

  /**
   * Evaluate the learned characteristic function v(S).
   */
  evaluate(coalitionMask: number): number {
    return evaluateCharacteristic(coalitionMask, this.state.coefficients);
  }

  /**
   * Compute Shapley values from the learned Möbius coefficients.
   */
  computeShapley(): number[] {
    return shapleyFromMobius(this.state.dimensionCount, this.state.coefficients);
  }

  /**
   * Get the number of nonzero interaction terms (|T| ≥ 2).
   */
  interactionCount(): number {
    let count = 0;
    for (const [T] of this.state.coefficients) {
      if (popcount(T) >= 2) count++;
    }
    return count;
  }

  /**
   * Get the strongest interaction (highest |m(T)| for |T| ≥ 2).
   */
  strongestInteraction(): { dimensions: number[]; strength: number } | null {
    let best: { dimensions: number[]; strength: number } | null = null;

    for (const [T, mT] of this.state.coefficients) {
      if (popcount(T) < 2) continue;
      const strength = Math.abs(mT);
      if (!best || strength > best.strength) {
        const dims: number[] = [];
        for (let i = 0; i < this.state.dimensionCount; i++) {
          if (T & (1 << i)) dims.push(i);
        }
        best = { dimensions: dims, strength };
      }
    }

    return best;
  }

  /** Serialize for persistence. */
  serialize(): SerializedMobiusState {
    return serializeMobiusState(this.state);
  }

  /** Restore from serialized state. */
  static deserialize(data: SerializedMobiusState, config: Partial<MobiusConfig> = {}): MobiusCharacteristic {
    const mc = new MobiusCharacteristic(data.dimensionCount, config);
    mc.state = deserializeMobiusState(data);
    return mc;
  }
}
