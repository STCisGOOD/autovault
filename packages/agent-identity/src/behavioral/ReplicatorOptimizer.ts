/**
 * ReplicatorOptimizer.ts
 *
 * The unified ARIL (Adjoint-Replicator Identity Learning) optimizer.
 * Combines three gradient signals into the identity update rule:
 *
 *   Δw[i] = -αₑ · ∂E/∂w[i]               // Energy gradient (T1)
 *         + αₒ · R_adj · δ_shapley[i]    // Outcome gradient (T2, REINFORCE)
 *         + αᵣ · (w[i]+μ) · (f[i] - f̄)  // Replicator-mutator gradient (T3)
 *
 * Three forces shape identity evolution:
 *
 * 1. Energy gradient — Analytical derivative of the Lyapunov energy.
 *    Pushes weights toward stable minima of the Allen-Cahn landscape.
 *
 * 2. Outcome gradient — Session quality R attributed via Shapley values.
 *    REINFORCE-style gradient through non-differentiable LLM components.
 *    Baseline-subtracted for variance reduction.
 *
 * 3. Replicator-mutator gradient — From evolutionary game theory.
 *    Dimensions with above-average fitness grow; below-average decay.
 *    Mutation floor μ prevents permanent dimension extinction.
 *
 * Also implements neuroplasticity: per-dimension adaptive meta-learning
 * rates. High-variance dimensions explore more (increase rate),
 * low-variance dimensions exploit (decrease rate).
 */

import { type EnergyGradientResult } from './EnergyGradient';
import { type DimensionAttribution } from './ShapleyAttributor';
import {
  safeClamp,
  safeFinite,
  safeDivide,
  assertCompatibleLengths,
  sanitizeFloat64Array,
} from './math';

// =============================================================================
// TYPES
// =============================================================================

export interface ARILConfig {
  /** αₑ — energy learning rate (default: 0.01) */
  alphaEnergy: number;
  /** αₒ — outcome learning rate (default: 0.05) */
  alphaOutcome: number;
  /** αᵣ — replicator learning rate (default: 0.02) */
  alphaReplicator: number;
  /** γ for fitness EMA decay (default: 0.1) */
  fitnessDecay: number;
  /** Max |Δw| per step (default: 0.1) */
  clipGradient: number;
  /** Weight floor (default: 0.01) */
  minWeight: number;
  /** Weight ceiling (default: 0.99) */
  maxWeight: number;
  /** Neuroplasticity variance target (default: 0.01) */
  neuroplasticityTarget: number;
  /** Neuroplasticity adaptation rate (default: 0.1) */
  neuroplasticityRate: number;
  /** Min meta-learning rate multiplier (default: 0.5) */
  minMetaRate: number;
  /** Max meta-learning rate multiplier (default: 2.0) */
  maxMetaRate: number;
  /** Mutation floor μ — prevents permanent dimension extinction (default: 1e-6) */
  mutationFloor?: number;
}

/** Minimum attribution history length before neuroplasticity activates.
 *  Variance estimation needs >=3 data points to be meaningful.
 *  Referenced by ARIL.test.ts ordering proof — if you change this,
 *  the activation-boundary test must be updated. */
export const MIN_NEUROPLASTICITY_SESSIONS = 3;

export const DEFAULT_ARIL_CONFIG: ARILConfig = {
  alphaEnergy: 0.01,
  alphaOutcome: 0.05,
  alphaReplicator: 0.02,
  fitnessDecay: 0.1,
  clipGradient: 0.1,
  minWeight: 0.01,
  maxWeight: 0.99,
  neuroplasticityTarget: 0.01,
  neuroplasticityRate: 0.1,
  minMetaRate: 0.5,
  maxMetaRate: 2.0,
  mutationFloor: 1e-6,
};

/** Per-session audit record. Phase 1 fields (signals→R) captured before backward
 *  pass; Phase 2 fields (gradients, attributions, weights) enriched after.
 *  Phase 2 fields are optional for backward compat with pre-v2.1 snapshots. */
export interface SignalSnapshot {
  /** Session index (pre-increment: captured before computeARILUpdate) */
  sessionIndex: number;
  /** Unix timestamp (ms) */
  timestamp: number;
  /** Aggregate outcome R ∈ [-1, 1] */
  R: number;
  /** Baseline-subtracted outcome (R - EMA baseline) */
  R_adj: number;
  /** Individual contributing signals */
  signals: ReadonlyArray<{ source: string; value: number; weight: number }>;

  // --- Phase 2: backward pass audit (optional, absent in pre-v2.1 snapshots) ---

  /** Weights at session start (pre-bridge PDE evolution, pre-ARIL) */
  weightsSessionStart?: number[];
  /** Weights after bridge PDE evolution, before ARIL backward pass */
  weightsBefore?: number[];
  /** Weights after ARIL update */
  weightsAfter?: number[];
  /** Combined per-dimension Δw[i] */
  deltaW?: number[];
  /** Decomposed gradient components */
  gradients?: {
    energy: number[];
    outcome: number[];
    replicator: number[];
  };
  /** Blended Shapley attributions per dimension (post-Möbius) */
  attributions?: number[];
  /** Meta-learning rates active when update was computed (pre-mutation) */
  metaLearningRates?: number[];
  /** Fitness values after this session's EMA update */
  fitness?: number[];
  /** Möbius blend factor α ∈ [0, 1]. 0 = pure additive, 1 = pure Möbius. Absent pre-v2.2. */
  blendAlpha?: number;
  /** Möbius characteristic sum v_learned(N) - v_learned(∅). Present only when blendAlpha > 0.
   *  Algebraic invariant: Σφ[i] = (1-blendAlpha)·R + blendAlpha·mobiusV */
  mobiusV?: number;
}

export interface ARILState {
  /** f[i] — EMA of attributed outcomes per dimension */
  fitness: Float64Array;
  /** Per-dimension meta-learning rate multiplier (neuroplasticity) */
  metaLearningRates: Float64Array;
  /** Recent attribution history (last N sessions, for variance computation) */
  recentAttributions: number[][];
  /** Number of sessions processed */
  sessionCount: number;
  /** Per-session R decomposition (last 20 sessions). Enables "why did weights change?" queries. */
  signalHistory: SignalSnapshot[];
}

export interface ARILUpdate {
  /** Combined Δw[i] */
  deltaW: Float64Array;
  /** Decomposed gradient components */
  components: {
    /** -αₑ · ∂E/∂w[i] */
    energyGrad: Float64Array;
    /** αₒ · R_adj · δ[i] */
    outcomeGrad: Float64Array;
    /** αᵣ · w[i] · (f[i] - f̄) */
    replicatorGrad: Float64Array;
  };
  /** Per-dimension: |Δw[i]| > threshold → should declare */
  shouldDeclare: boolean[];
  /** Human-readable update explanation */
  explanation: string;
  /** Updated fitness values */
  fitness: Float64Array;
  /** Updated meta-learning rates */
  metaLearningRates: Float64Array;
}

// =============================================================================
// OPTIMIZER
// =============================================================================

/**
 * Create initial ARIL state for n dimensions.
 */
export function createARILState(n: number): ARILState {
  return {
    fitness: new Float64Array(n).fill(0),
    metaLearningRates: new Float64Array(n).fill(1.0),
    recentAttributions: [],
    sessionCount: 0,
    signalHistory: [],
  };
}

/**
 * Compute the unified ARIL update.
 *
 * This is the "backward pass across the session boundary" —
 * the discrete optimization step that runs AFTER the within-session
 * PDE evolution.
 *
 * @param weights - Current identity weights w[i]
 * @param energyGradient - Analytical ∂E/∂w from EnergyGradient module
 * @param R_adj - Baseline-subtracted outcome (from OutcomeEvaluator)
 * @param R_raw - Raw outcome R ∈ [-1, 1] for fitness EMA (NOT baseline-subtracted)
 * @param attributions - Shapley attributions per dimension
 * @param state - Mutable ARIL state (fitness, meta-rates, history)
 * @param config - ARIL configuration
 * @param declarationThreshold - Min |Δw| to recommend declaration (default: 0.05)
 */
export function computeARILUpdate(
  weights: Float64Array,
  energyGradient: EnergyGradientResult,
  R_adj: number,
  R_raw: number,
  attributions: DimensionAttribution[],
  state: ARILState,
  config: ARILConfig = DEFAULT_ARIL_CONFIG,
  declarationThreshold: number = 0.05
): ARILUpdate {
  const n = weights.length;

  // --- Input validation ---
  if (n === 0) {
    return {
      deltaW: new Float64Array(0),
      components: {
        energyGrad: new Float64Array(0),
        outcomeGrad: new Float64Array(0),
        replicatorGrad: new Float64Array(0),
      },
      shouldDeclare: [],
      explanation: 'ARIL Update: no dimensions',
      fitness: new Float64Array(0),
      metaLearningRates: new Float64Array(0),
    };
  }

  assertCompatibleLengths(
    'computeARILUpdate',
    ['weights', weights],
    ['energyGradient.gradients', energyGradient.gradients],
    ['state.fitness', state.fitness],
    ['state.metaLearningRates', state.metaLearningRates],
  );

  // Sanitize non-finite inputs — a NaN R_adj would poison all downstream state
  R_adj = safeFinite(R_adj, 0);
  declarationThreshold = safeFinite(declarationThreshold, 0.05);

  const { alphaEnergy, alphaOutcome, alphaReplicator, fitnessDecay, mutationFloor } = config;
  const mu = safeFinite(mutationFloor, 1e-6);

  // Sanitize R_raw — a NaN R_raw would poison fitness EMA
  R_raw = safeFinite(R_raw, 0);

  // === 1. Update fitness EMA ===
  // f[i] = (1-γ)·f[i] + γ·R·|δ[i]|
  // Fitness tracks how consistently a dimension contributes to positive outcomes.
  // Uses R_raw (absolute quality) NOT R_adj (baseline-subtracted).
  // R_adj oscillates around 0 by design (REINFORCE variance reduction), which
  // would cause fitness to decay during winning streaks.
  //
  // DESIGN DECISION: No EMA bias correction.
  //
  // Standard bias correction divides by (1 - β^t) to compensate for zero-
  // initialization. In ARIL, all N dimensions share the same correction
  // factor, so the replicator growth differential is:
  //   f_corrected[i] - f̄_corrected = (f[i] - f̄) / (1 - β^t)
  //
  // This is a uniform scalar on all growth rates — it changes HOW FAST
  // dimensions separate, not WHICH dimension grows fastest. Applying it
  // is equivalent to amplifying αR by 1/(1-β^t): 10× at session 1,
  // 2.4× at session 5, ~1× at session 20. The cancellation proof is
  // pure algebra — it holds because all dimensions receive the same R
  // on each session, so the correction factor is identical across them.
  //
  // The uncorrected EMA provides a conservative cold-start that
  // functions as confidence-weighted signal strength: early sessions
  // (sparse data) contribute weak replicator dynamics; later sessions
  // (accumulated evidence) contribute strong dynamics. At session 1,
  // correction would amplify replicator growth 10×, driving large
  // irreversible weight shifts from a single observation. The
  // uncorrected path lets outcome and energy gradients (direct learning)
  // dominate until fitness estimates stabilize.
  //
  // FUTURE: The principled replacement is not bias correction but
  // Bayesian posterior tracking — Beta-distribution or Kalman filter
  // per-dimension fitness estimates that provide explicit uncertainty
  // (cf. SASR, Ma et al. ICLR 2025 for self-adaptive success rates;
  // BONE, Duran-Martin et al. 2024 for Bayesian online non-stationary
  // estimation). These frameworks arrive at confidence-weighted dynamics
  // through proper posterior updates, not through an EMA side-effect.
  // This would require the replicator gradient to consume variance
  // alongside mean fitness.
  const R = R_raw;
  for (let i = 0; i < n; i++) {
    const attr = attributions.find(a => a.index === i);
    const absDelta = attr ? Math.abs(safeFinite(attr.shapleyValue, 0)) : 0;
    state.fitness[i] = safeFinite(
      (1 - fitnessDecay) * state.fitness[i] + fitnessDecay * R * absDelta,
      state.fitness[i]
    );
  }

  // Average fitness f̄
  let fBar = 0;
  for (let i = 0; i < n; i++) {
    fBar += safeFinite(state.fitness[i], 0);
  }
  fBar = safeDivide(fBar, n, 0);

  // === 2. Record attributions for neuroplasticity ===
  const currentAttributions: number[] = [];
  for (let i = 0; i < n; i++) {
    const attr = attributions.find(a => a.index === i);
    currentAttributions.push(attr ? attr.shapleyValue : 0);
  }
  state.recentAttributions.push(currentAttributions);
  // Keep last 20 sessions
  if (state.recentAttributions.length > 20) {
    state.recentAttributions.shift();
  }

  // === 3. Compute three gradient components ===
  const energyGrad = new Float64Array(n);
  const outcomeGrad = new Float64Array(n);
  const replicatorGrad = new Float64Array(n);
  const deltaW = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const metaRate = safeFinite(state.metaLearningRates[i], 1.0);
    const attr = attributions.find(a => a.index === i);
    const shapleyDelta = attr ? safeFinite(attr.shapleyValue, 0) : 0;

    // Energy gradient: push toward stable minimum
    energyGrad[i] = safeFinite(
      -alphaEnergy * metaRate * safeFinite(energyGradient.gradients[i], 0), 0
    );

    // Outcome gradient: reward what worked (REINFORCE)
    outcomeGrad[i] = safeFinite(alphaOutcome * metaRate * R_adj * shapleyDelta, 0);

    // Replicator gradient: evolve toward fitness (with mutation floor μ)
    // The +μ prevents permanent extinction: even at w[i]=0, this term is nonzero
    replicatorGrad[i] = safeFinite(
      alphaReplicator * metaRate * (weights[i] + mu) * (safeFinite(state.fitness[i], 0) - fBar), 0
    );

    // (clipping applied after convergence check below)
  }

  // === Convergence check (spec §2.3) ===
  // Compare norms of the three already-scaled gradient arrays.
  // All three include their respective α and per-dimension metaRate,
  // so the comparison is on a consistent basis.
  // When far from a minimum (‖T1‖ > threshold), ensure energy descent dominates:
  //   ‖T1‖ ≥ ‖T2‖ + ‖T3‖
  // If violated, scale T2 and T3 down proportionally.
  // Near a minimum (‖T1‖ ≈ 0), allow tunneling — don't scale.
  const GRAD_THRESHOLD = 1e-4;
  let t1Norm = 0;
  let t2Norm = 0;
  let t3Norm = 0;
  for (let i = 0; i < n; i++) {
    t1Norm += energyGrad[i] * energyGrad[i];
    t2Norm += outcomeGrad[i] * outcomeGrad[i];
    t3Norm += replicatorGrad[i] * replicatorGrad[i];
  }
  t1Norm = Math.sqrt(t1Norm);
  t2Norm = Math.sqrt(t2Norm);
  t3Norm = Math.sqrt(t3Norm);

  if (t1Norm > GRAD_THRESHOLD) {
    const rhs = t2Norm + t3Norm;
    if (rhs > 0 && t1Norm < rhs) {
      const scale = safeFinite(t1Norm / (rhs + 1e-8), 1.0);
      for (let i = 0; i < n; i++) {
        outcomeGrad[i] *= scale;
        replicatorGrad[i] *= scale;
      }
    }
  }

  // === Apply gradient clipping ===
  for (let i = 0; i < n; i++) {
    const raw = energyGrad[i] + outcomeGrad[i] + replicatorGrad[i];
    deltaW[i] = safeClamp(raw, -config.clipGradient, config.clipGradient, 0);
  }

  // === 4. Neuroplasticity: adapt meta-learning rates ===
  if (state.recentAttributions.length >= MIN_NEUROPLASTICITY_SESSIONS) {
    for (let i = 0; i < n; i++) {
      // Compute variance of recent attributions for dimension i
      const values = state.recentAttributions.map(a => safeFinite(a[i], 0));
      const mean = safeDivide(values.reduce((s, v) => s + v, 0), values.length, 0);
      const variance = Math.max(
        0,
        safeDivide(values.reduce((s, v) => s + (v - mean) ** 2, 0), values.length, 0)
      );

      // High variance → explore more (increase rate)
      // Low variance → exploit (decrease rate)
      const adjustment = safeFinite(
        1 + config.neuroplasticityRate * (variance - config.neuroplasticityTarget), 1.0
      );
      state.metaLearningRates[i] = safeClamp(
        state.metaLearningRates[i] * adjustment,
        config.minMetaRate,
        config.maxMetaRate,
        1.0
      );
    }
  }

  state.sessionCount++;

  // === 5. Determine which dimensions should declare ===
  const shouldDeclare: boolean[] = [];
  for (let i = 0; i < n; i++) {
    shouldDeclare.push(Math.abs(deltaW[i]) > declarationThreshold);
  }

  // === 6. Generate explanation ===
  const explanation = generateExplanation(
    n, deltaW, energyGrad, outcomeGrad, replicatorGrad,
    state.fitness, fBar, state.metaLearningRates, R_adj
  );

  return {
    deltaW,
    components: { energyGrad, outcomeGrad, replicatorGrad },
    shouldDeclare,
    explanation,
    fitness: new Float64Array(state.fitness),
    metaLearningRates: new Float64Array(state.metaLearningRates),
  };
}

/**
 * Apply an ARIL update to weights, respecting bounds.
 *
 * @param weights - Current weights (NOT mutated)
 * @param update - ARIL update result
 * @param config - ARIL config (for bounds)
 * @returns New weights
 */
export function applyARILUpdate(
  weights: Float64Array,
  update: ARILUpdate,
  config: ARILConfig = DEFAULT_ARIL_CONFIG
): Float64Array {
  const n = weights.length;
  const newWeights = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const delta = safeFinite(update.deltaW[i], 0);
    newWeights[i] = safeClamp(
      weights[i] + delta,
      config.minWeight,
      config.maxWeight,
      weights[i] // Fallback: keep current weight if computation fails
    );
  }

  return newWeights;
}

/**
 * Verify the replicator conservation property:
 * Σ w[i]·(f[i]-f̄) should equal 0 (to machine epsilon).
 */
export function verifyReplicatorConservation(
  weights: Float64Array,
  fitness: Float64Array
): { conserved: boolean; sum: number } {
  const n = weights.length;
  if (n === 0 || fitness.length !== n) {
    return { conserved: true, sum: 0 };
  }

  let fBar = 0;
  for (let i = 0; i < n; i++) {
    fBar += safeFinite(fitness[i], 0);
  }
  fBar = safeDivide(fBar, n, 0);

  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += safeFinite(weights[i], 0) * (safeFinite(fitness[i], 0) - fBar);
  }

  return {
    conserved: Math.abs(sum) < 1e-10,
    sum,
  };
}

// =============================================================================
// SERIALIZATION
// =============================================================================

export interface SerializedARILState {
  fitness: number[];
  metaLearningRates: number[];
  recentAttributions: number[][];
  sessionCount: number;
  /** Per-session signal decomposition (added in v2). Missing = [] for backward compat. */
  signalHistory?: SignalSnapshot[];
}

export function serializeARILState(state: ARILState): SerializedARILState {
  return {
    fitness: Array.from(state.fitness),
    metaLearningRates: Array.from(state.metaLearningRates),
    recentAttributions: state.recentAttributions,
    sessionCount: state.sessionCount,
    signalHistory: state.signalHistory,
  };
}

export function deserializeARILState(data: SerializedARILState): ARILState {
  // Validate signalHistory entries: reject malformed snapshots (RT-H8 pattern)
  const rawHistory = Array.isArray(data.signalHistory) ? data.signalHistory : [];
  const signalHistory: SignalSnapshot[] = [];
  for (const snap of rawHistory) {
    if (
      snap &&
      typeof snap.sessionIndex === 'number' && Number.isFinite(snap.sessionIndex) &&
      typeof snap.timestamp === 'number' && Number.isFinite(snap.timestamp) &&
      typeof snap.R === 'number' && Number.isFinite(snap.R) &&
      typeof snap.R_adj === 'number' && Number.isFinite(snap.R_adj) &&
      Array.isArray(snap.signals)
    ) {
      // Phase 2 fields: validate if present, strip if malformed (don't reject entire snapshot)
      const cleaned: SignalSnapshot = {
        sessionIndex: snap.sessionIndex,
        timestamp: snap.timestamp,
        R: snap.R,
        R_adj: snap.R_adj,
        signals: snap.signals,
      };
      if (isFiniteArray(snap.weightsSessionStart)) cleaned.weightsSessionStart = snap.weightsSessionStart;
      if (isFiniteArray(snap.weightsBefore)) cleaned.weightsBefore = snap.weightsBefore;
      if (isFiniteArray(snap.weightsAfter)) cleaned.weightsAfter = snap.weightsAfter;
      if (isFiniteArray(snap.deltaW)) cleaned.deltaW = snap.deltaW;
      if (isFiniteArray(snap.attributions)) cleaned.attributions = snap.attributions;
      if (isFiniteArray(snap.metaLearningRates)) cleaned.metaLearningRates = snap.metaLearningRates;
      if (isFiniteArray(snap.fitness)) cleaned.fitness = snap.fitness;
      if (typeof snap.blendAlpha === 'number' && Number.isFinite(snap.blendAlpha)) cleaned.blendAlpha = snap.blendAlpha;
      if (typeof snap.mobiusV === 'number' && Number.isFinite(snap.mobiusV)) cleaned.mobiusV = snap.mobiusV;
      if (
        snap.gradients &&
        isFiniteArray(snap.gradients.energy) &&
        isFiniteArray(snap.gradients.outcome) &&
        isFiniteArray(snap.gradients.replicator)
      ) {
        cleaned.gradients = snap.gradients;
      }
      signalHistory.push(cleaned);
    }
  }

  return {
    fitness: sanitizeFloat64Array(Float64Array.from(data.fitness ?? [])),
    metaLearningRates: sanitizeFloat64Array(Float64Array.from(data.metaLearningRates ?? []), 1.0),
    recentAttributions: (data.recentAttributions ?? []).slice(-20),
    sessionCount: Math.max(0, Math.floor(data.sessionCount ?? 0)),
    signalHistory: signalHistory.slice(-20),
  };
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/** Validate that v is a non-empty array of finite numbers (for Phase 2 deserialization). */
function isFiniteArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'number' && Number.isFinite(x));
}

function generateExplanation(
  n: number,
  deltaW: Float64Array,
  energyGrad: Float64Array,
  outcomeGrad: Float64Array,
  replicatorGrad: Float64Array,
  fitness: Float64Array,
  fBar: number,
  metaRates: Float64Array,
  R_adj: number
): string {
  const lines: string[] = [];
  lines.push(`ARIL Update (R_adj=${safeFinite(R_adj, 0).toFixed(3)}, f̄=${safeFinite(fBar, 0).toFixed(4)}):`);

  // Find dimensions with largest updates
  const indexed = Array.from({ length: n }, (_, i) => ({
    i,
    delta: deltaW[i],
    absDelta: Math.abs(deltaW[i]),
  }));
  indexed.sort((a, b) => b.absDelta - a.absDelta);

  const top = indexed.slice(0, Math.min(3, n));
  for (const { i, delta } of top) {
    const dir = delta > 0 ? '↑' : '↓';
    const dominant = findDominant(energyGrad[i], outcomeGrad[i], replicatorGrad[i]);
    lines.push(
      `  dim[${i}]: ${dir}${Math.abs(safeFinite(delta, 0)).toFixed(4)} ` +
      `(f=${safeFinite(fitness[i], 0).toFixed(3)}, meta=${safeFinite(metaRates[i], 1).toFixed(2)}, via ${dominant})`
    );
  }

  return lines.join('\n');
}

function findDominant(energy: number, outcome: number, replicator: number): string {
  const absE = Math.abs(energy);
  const absO = Math.abs(outcome);
  const absR = Math.abs(replicator);
  if (absE >= absO && absE >= absR) return 'energy';
  if (absO >= absE && absO >= absR) return 'outcome';
  return 'replicator';
}
