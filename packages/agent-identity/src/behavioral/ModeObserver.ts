/**
 * ModeObserver.ts
 *
 * Layer 3: Read-only observer of ARIL dynamics.
 * Watches and reports; never acts. Never modifies weights, fitness, or ARIL state.
 *
 * Three diagnostic metrics from the ARIL mathematical specification:
 *
 * 1. mode_score (§7.1) — search vs. insight mode from energy landscape position
 *    mode_score = ‖∇E‖² / (E - E_min + ε_clip)
 *
 * 2. Tunneling probability (§2.4) — barrier crossing likelihood per dimension
 *    P_tunnel[i] = 1 - exp(-σ²_eff[i] / (2·B[i]))
 *
 * 3. ρ_proxy / consolidation quality (§8.3) — tracks whether persistence helps
 *    Δ_consolidation = E(w_init) - E(w_random)
 *
 * Plus per-dimension mode classification via curvature V''(w[i], a).
 */

import type { SelfState, DynamicsParams, Vocabulary } from './FixedPointSelf';
import type { EnergyGradientResult } from './EnergyGradient';
import type { ARILState, ARILConfig } from './ReplicatorOptimizer';
import type { DimensionAttribution } from './ShapleyAttributor';
import { computeEnergyGradient } from './EnergyGradient';
import { safeFinite, safeClamp, safeDivide, sanitizeFloat64Array } from './math';

// =============================================================================
// TYPES
// =============================================================================

export interface DimensionMode {
  /** Dimension index */
  index: number;
  /** Which well or barrier region */
  well: 'low' | 'high' | 'barrier';
  /** V''(w[i], a) — second derivative of double-well potential */
  curvature: number;
  /** |w[i] - a| — distance from the saddle point */
  distanceFromSaddle: number;
}

export interface DimensionTunneling {
  /** Dimension index */
  index: number;
  /** V(a) - V(w[i]) — barrier remaining to cross */
  barrierHeight: number;
  /** σ²_eff[i] — effective noise from outcome + replicator terms */
  effectiveNoise: number;
  /** P_tunnel[i] = 1 - exp(-σ²_eff / (2B)) */
  probability: number;
}

export interface ModeObservation {
  /** §7.1 mode_score = ‖∇E‖² / (E - E_min + ε) */
  modeScore: number;
  /** Thresholded mode classification */
  mode: 'search' | 'insight';
  /** Per-dimension basin classification */
  dimensionModes: DimensionMode[];
  /** §2.4 per-dimension tunneling analysis */
  tunneling: DimensionTunneling[];
  /** Max tunneling probability across dimensions */
  globalTunnelingRisk: number;
  /** §8.3 consolidation quality: E(w_init) - E(w_random) */
  consolidationDelta: number;
  /** Timestamp */
  timestamp: number;
}

export interface ModeObserverConfig {
  /** History window for variance computation (default: 10) */
  historyWindow: number;
  /** mode_score threshold for search vs insight (default: 1.0) */
  modeThreshold: number;
  /** Barrier proximity threshold for dimension classification (default: 0.1) */
  barrierThreshold: number;
}

export const DEFAULT_OBSERVER_CONFIG: ModeObserverConfig = {
  historyWindow: 10,
  modeThreshold: 1.0,
  barrierThreshold: 0.1,
};

/** Serializable observer state persisted between sessions */
export interface ObserverHistory {
  /** Energy values per session */
  energyHistory: number[];
  /** Minimum observed energy */
  minObservedEnergy: number;
  /** R_adj * δ[i] per session, per dimension (for σ²_eff T2 term) */
  outcomeTermHistory: number[][];
  /** (w[i]+μ)*(f[i]-f̄) per session, per dimension (for σ²_eff T3 term) */
  replicatorTermHistory: number[][];
  /** Session count */
  sessionCount: number;
}

/** JSON-safe serialized form */
export interface SerializedObserverHistory {
  energyHistory: number[];
  minObservedEnergy: number;
  outcomeTermHistory: number[][];
  replicatorTermHistory: number[][];
  sessionCount: number;
}

// =============================================================================
// DOUBLE-WELL POTENTIAL MATH
// =============================================================================

/**
 * Double-well potential V(u, a) = u⁴/4 - (1+a)u³/3 + au²/2
 */
function potential(u: number, a: number): number {
  return (u * u * u * u) / 4 - ((1 + a) * u * u * u) / 3 + (a * u * u) / 2;
}

/**
 * Second derivative V''(u, a) = 3u² - 2(1+a)u + a
 * Used for dimension classification (well vs. barrier).
 */
function potentialSecondDeriv(u: number, a: number): number {
  return 3 * u * u - 2 * (1 + a) * u + a;
}

// =============================================================================
// OBSERVER
// =============================================================================

export class ModeObserver {
  private readonly config: ModeObserverConfig;
  private history: ObserverHistory;

  constructor(
    config: Partial<ModeObserverConfig> = {},
    initialHistory?: ObserverHistory
  ) {
    this.config = { ...DEFAULT_OBSERVER_CONFIG, ...config };
    this.history = initialHistory ?? {
      energyHistory: [],
      minObservedEnergy: Infinity,
      outcomeTermHistory: [],
      replicatorTermHistory: [],
      sessionCount: 0,
    };
  }

  /**
   * Main entry point — called once per session after ARIL update.
   * Observes current state and returns diagnostic metrics.
   * Does NOT modify any input state.
   *
   * @param state - Current SelfState (weights, self-model)
   * @param params - Dynamics parameters (includes barrier parameter a)
   * @param vocabulary - Vocabulary (for energy computation)
   * @param energyGradient - Pre-computed energy gradient result
   * @param arilState - Current ARIL state (fitness, session count)
   * @param arilConfig - ARIL configuration (learning rates)
   * @param R_adj - Baseline-subtracted outcome for this session
   * @param attributions - Shapley attributions per dimension
   */
  observe(
    state: SelfState,
    params: DynamicsParams,
    vocabulary: Vocabulary,
    energyGradient: EnergyGradientResult,
    arilState: ARILState,
    arilConfig: ARILConfig,
    R_adj: number,
    attributions: DimensionAttribution[]
  ): ModeObservation {
    const n = state.dimension;
    const a = safeFinite(params.a, 0.5);
    const mu = safeFinite(arilConfig.mutationFloor, 1e-6);
    const safeR = safeFinite(R_adj, 0);

    // === 1. Classify each dimension (well/barrier) from curvature ===
    const dimensionModes = this.classifyDimensions(state.w, a, n);

    // === 2. Compute mode_score from §7.1 formula ===
    const energy = safeFinite(energyGradient.energy, 0);

    // Update energy history
    this.history.energyHistory.push(energy);
    if (this.history.energyHistory.length > this.config.historyWindow) {
      this.history.energyHistory.shift();
    }
    if (energy < this.history.minObservedEnergy) {
      this.history.minObservedEnergy = energy;
    }

    const modeScore = this.computeModeScore(energyGradient, this.history.minObservedEnergy);
    const mode: 'search' | 'insight' = modeScore > this.config.modeThreshold ? 'search' : 'insight';

    // === 3. Update history with this session's outcome/replicator terms ===
    this.recordTermHistory(state.w, arilState, arilConfig, safeR, attributions, mu, n);

    // === 4-6. Compute tunneling per dimension ===
    const tunneling = this.computeTunneling(state.w, a, arilConfig, n);

    // === 7. Compute consolidation delta ===
    const consolidationDelta = this.computeConsolidationDelta(
      energy, state, params, vocabulary, n
    );

    this.history.sessionCount++;

    // Max tunneling risk
    let globalTunnelingRisk = 0;
    for (const t of tunneling) {
      if (t.probability > globalTunnelingRisk) {
        globalTunnelingRisk = t.probability;
      }
    }

    return {
      modeScore,
      mode,
      dimensionModes,
      tunneling,
      globalTunnelingRisk,
      consolidationDelta,
      timestamp: Date.now(),
    };
  }

  /**
   * Get serializable history for persistence.
   */
  getHistory(): ObserverHistory {
    return {
      energyHistory: [...this.history.energyHistory],
      minObservedEnergy: this.history.minObservedEnergy,
      outcomeTermHistory: this.history.outcomeTermHistory.map(a => [...a]),
      replicatorTermHistory: this.history.replicatorTermHistory.map(a => [...a]),
      sessionCount: this.history.sessionCount,
    };
  }

  // ---------------------------------------------------------------------------
  // §7.1 — mode_score
  // ---------------------------------------------------------------------------

  /**
   * mode_score = ‖∇E‖² / (E - E_min + ε_clip)
   *
   * High mode_score → large gradient forces relative to energy depth → SEARCH mode
   * Low mode_score → small gradient, settled near minimum → INSIGHT mode
   */
  private computeModeScore(
    energyGradient: EnergyGradientResult,
    minEnergy: number
  ): number {
    const EPS_CLIP = 1e-8;

    // ‖∇E‖² = sum of squared gradients
    let gradNormSq = 0;
    for (let i = 0; i < energyGradient.gradients.length; i++) {
      const g = safeFinite(energyGradient.gradients[i], 0);
      gradNormSq += g * g;
    }

    const energy = safeFinite(energyGradient.energy, 0);
    const eMin = Number.isFinite(minEnergy) ? minEnergy : energy;
    const denominator = energy - eMin + EPS_CLIP;

    return safeFinite(safeDivide(gradNormSq, denominator, 0), 0);
  }

  // ---------------------------------------------------------------------------
  // Dimension classification via curvature
  // ---------------------------------------------------------------------------

  /**
   * Per-dimension mode classification using curvature V''(w[i], a):
   * - V'' > 0 and w < a → in well at u=0 (low)
   * - V'' > 0 and w > a → in well at u=1 (high)
   * - V'' < 0 (or |w-a| < threshold) → at barrier
   */
  private classifyDimensions(
    w: Float64Array,
    a: number,
    n: number
  ): DimensionMode[] {
    const modes: DimensionMode[] = [];

    for (let i = 0; i < n; i++) {
      const wi = safeFinite(w[i], 0.5);
      const curvature = safeFinite(potentialSecondDeriv(wi, a), 0);
      const distanceFromSaddle = Math.abs(wi - a);

      let well: 'low' | 'high' | 'barrier';
      if (curvature < 0 || distanceFromSaddle < this.config.barrierThreshold) {
        well = 'barrier';
      } else if (wi < a) {
        well = 'low';
      } else {
        well = 'high';
      }

      modes.push({ index: i, well, curvature, distanceFromSaddle });
    }

    return modes;
  }

  // ---------------------------------------------------------------------------
  // §2.4 — Tunneling probability
  // ---------------------------------------------------------------------------

  /**
   * Record outcome and replicator terms for variance computation.
   * These are the T2 and T3 perturbation values per dimension per session.
   */
  private recordTermHistory(
    w: Float64Array,
    arilState: ARILState,
    arilConfig: ARILConfig,
    R_adj: number,
    attributions: DimensionAttribution[],
    mu: number,
    n: number
  ): void {
    // Compute f̄ (average fitness)
    let fBar = 0;
    for (let i = 0; i < n; i++) {
      fBar += safeFinite(arilState.fitness[i], 0);
    }
    fBar = n > 0 ? fBar / n : 0;

    // T2 terms: R_adj * δ[i] (outcome perturbation per dimension)
    const outcomeTerms: number[] = [];
    for (let i = 0; i < n; i++) {
      const attr = attributions.find(a => a.index === i);
      const delta = attr ? safeFinite(attr.shapleyValue, 0) : 0;
      outcomeTerms.push(safeFinite(R_adj * delta, 0));
    }

    // T3 terms: (w[i]+μ)*(f[i]-f̄) (replicator perturbation per dimension)
    const replicatorTerms: number[] = [];
    for (let i = 0; i < n; i++) {
      const wi = safeFinite(w[i], 0.5);
      const fi = safeFinite(arilState.fitness[i], 0);
      replicatorTerms.push(safeFinite((wi + mu) * (fi - fBar), 0));
    }

    this.history.outcomeTermHistory.push(outcomeTerms);
    this.history.replicatorTermHistory.push(replicatorTerms);

    // Trim to window size
    while (this.history.outcomeTermHistory.length > this.config.historyWindow) {
      this.history.outcomeTermHistory.shift();
    }
    while (this.history.replicatorTermHistory.length > this.config.historyWindow) {
      this.history.replicatorTermHistory.shift();
    }
  }

  /**
   * Compute tunneling probability per dimension.
   *
   * P_tunnel[i] = 1 - exp(-σ²_eff[i] / (2·B[i]))
   *
   * Where:
   * - B[i] = V(a) - V(w[i]) is the barrier height from current position
   * - σ²_eff[i] = αₒ²·Var[R_adj·δ[i]] + αᵣ²·Var[(w+μ)(f-f̄)]
   */
  private computeTunneling(
    w: Float64Array,
    a: number,
    arilConfig: ARILConfig,
    n: number
  ): DimensionTunneling[] {
    const result: DimensionTunneling[] = [];
    const alphaO = safeFinite(arilConfig.alphaOutcome, 0.05);
    const alphaR = safeFinite(arilConfig.alphaReplicator, 0.02);
    const Va = safeFinite(potential(a, a), 0);

    // Cold start: need >= 3 sessions for meaningful variance
    const hasHistory = this.history.outcomeTermHistory.length >= 3;

    for (let i = 0; i < n; i++) {
      const wi = safeFinite(w[i], 0.5);
      const Vw = safeFinite(potential(wi, a), 0);
      const barrierHeight = Math.max(0, Va - Vw);

      let effectiveNoise = 0;
      let probability = 0;

      if (hasHistory) {
        // Compute variance of T2 terms for dimension i
        const t2Values = this.history.outcomeTermHistory.map(s => safeFinite(s[i], 0));
        const varT2 = computeVariance(t2Values);

        // Compute variance of T3 terms for dimension i
        const t3Values = this.history.replicatorTermHistory.map(s => safeFinite(s[i], 0));
        const varT3 = computeVariance(t3Values);

        // σ²_eff = αₒ²·Var[T2] + αᵣ²·Var[T3]
        effectiveNoise = safeFinite(alphaO * alphaO * varT2 + alphaR * alphaR * varT3, 0);

        // P_tunnel = 1 - exp(-σ²_eff / (2B))
        if (barrierHeight > 0) {
          const exponent = safeDivide(-effectiveNoise, 2 * barrierHeight, 0);
          probability = safeClamp(1 - Math.exp(exponent), 0, 1, 0);
        } else {
          // No barrier → already at or past saddle
          probability = effectiveNoise > 0 ? 1 : 0;
        }
      }

      result.push({
        index: i,
        barrierHeight,
        effectiveNoise,
        probability,
      });
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // §8.3 — Consolidation quality
  // ---------------------------------------------------------------------------

  /**
   * Δ_consolidation = E(w_init) - E(w_random)
   *
   * - E(w_init) = current session energy (the identity we've evolved)
   * - E(w_random) = energy with all weights at 0.5 (naive midpoint)
   *
   * Negative delta → consolidation helps (identity is better than random)
   * Near zero → consolidation isn't adding value
   * Positive → identity is worse than starting fresh (rare, indicates problems)
   */
  private computeConsolidationDelta(
    currentEnergy: number,
    state: SelfState,
    params: DynamicsParams,
    vocabulary: Vocabulary,
    n: number
  ): number {
    if (n === 0) return 0;

    // Create synthetic "random" state at midpoint w=0.5
    const randomW = new Float64Array(n).fill(0.5);
    const randomM = new Float64Array(n).fill(0.5);
    const randomState: SelfState = {
      dimension: n,
      w: randomW,
      m: randomM,
      time: 0,
    };

    const randomResult = computeEnergyGradient(randomState, params, vocabulary);
    const randomEnergy = safeFinite(randomResult.energy, 0);

    return safeFinite(currentEnergy - randomEnergy, 0);
  }
}

// =============================================================================
// §6 — ADAPTIVE BARRIER
// =============================================================================

/**
 * §6: Compute adaptive barrier parameter from expertise level.
 *
 * a(expertise) = aMax - (aMax - aMin) · clamp(expertise, 0, 1)
 *
 * - Novice (expertise ≈ 0): a → aMax (high barrier, harder to tunnel, more stable)
 * - Expert (expertise ≈ 1): a → aMin (low barrier, easier to tunnel, more flexible)
 *
 * This is a pure function — the caller decides whether to apply it.
 */
export function computeAdaptiveBarrier(
  expertise: number,
  aMin: number = 0.25,
  aMax: number = 0.75
): number {
  const e = safeClamp(expertise, 0, 1, 0);
  return safeFinite(aMax - (aMax - aMin) * e, 0.5);
}

// =============================================================================
// SERIALIZATION
// =============================================================================

export function serializeObserverHistory(h: ObserverHistory): SerializedObserverHistory {
  return {
    energyHistory: [...h.energyHistory],
    minObservedEnergy: Number.isFinite(h.minObservedEnergy) ? h.minObservedEnergy : 0,
    outcomeTermHistory: h.outcomeTermHistory.map(a => [...a]),
    replicatorTermHistory: h.replicatorTermHistory.map(a => [...a]),
    sessionCount: h.sessionCount,
  };
}

export function deserializeObserverHistory(data: SerializedObserverHistory): ObserverHistory {
  return {
    energyHistory: (data.energyHistory ?? []).map(v => safeFinite(v, 0)),
    minObservedEnergy: safeFinite(data.minObservedEnergy, Infinity),
    outcomeTermHistory: (data.outcomeTermHistory ?? []).map(
      (arr: number[]) => arr.map(v => safeFinite(v, 0))
    ),
    replicatorTermHistory: (data.replicatorTermHistory ?? []).map(
      (arr: number[]) => arr.map(v => safeFinite(v, 0))
    ),
    sessionCount: Math.max(0, Math.floor(safeFinite(data.sessionCount, 0))),
  };
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/**
 * Compute sample variance of a number array.
 * Returns 0 for empty or single-element arrays.
 */
function computeVariance(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;

  let mean = 0;
  for (let i = 0; i < n; i++) {
    mean += values[i];
  }
  mean /= n;

  let sumSqDiff = 0;
  for (let i = 0; i < n; i++) {
    const diff = values[i] - mean;
    sumSqDiff += diff * diff;
  }

  // Population variance (not sample) — matches spec Var[] notation
  return safeFinite(sumSqDiff / n, 0);
}
