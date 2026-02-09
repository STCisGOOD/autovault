/**
 * GuidanceEngine.ts
 *
 * Generates prescriptive behavioral directives ranked by ARIL fitness.
 *
 * Directive strength comes from ARIL, not hardcoded thresholds:
 *   'must'     if fitness[i] > f̄ + σ  AND calibrated_confidence > 0.8
 *   'should'   if fitness[i] > f̄      AND calibrated_confidence > 0.6
 *   'consider' otherwise
 *
 * Four directive sources:
 *   1. Compiled patterns — confirmed by ARIL attribution (highest quality)
 *   2. Energy gradients — large |∂E/∂w[i]| → dimension wants to change
 *   3. Replicator fitness — high-fitness dimensions get reinforcement
 *   4. Domain specialization — domain-specific directives
 */

import type { CompiledPattern } from './InsightCompiler';
import type { EnergyGradientResult } from './EnergyGradient';
import type { ConfidenceCalibrator } from './ConfidenceCalibrator';
import type { Specialization } from './DomainTracker';
import type { ModeObservation } from './ModeObserver';
import { safeFinite, safeDivide } from './math';

// =============================================================================
// MÖBIUS DIAGNOSTICS
// =============================================================================

/** Summary of Möbius characteristic function state for guidance generation. */
export interface MobiusDiagnostics {
  /** Number of nonzero interaction terms (|T| ≥ 2) */
  interactionCount: number;
  /** Model fit residual (1 - R²). Lower = better fit. */
  fitResidual: number;
  /** Number of session observations collected */
  observationCount: number;
  /** Current k-additive order */
  currentOrder: number;
  /** Strongest learned interaction, if any */
  strongestInteraction: { dimensions: number[]; strength: number } | null;
  /** Whether observation count is sufficient for current parameter count */
  dataAdequate: boolean;
}

// =============================================================================
// TYPES
// =============================================================================

export interface BehavioralDirective {
  /** Primary dimension */
  dimension: string;
  /** Dimension weight */
  weight: number;
  /** Imperative behavioral instruction */
  imperative: string;
  /** When to apply this directive */
  context: string;
  /** Directive strength — determined by ARIL fitness + calibrated confidence */
  strength: 'must' | 'should' | 'consider';
  /** Where this directive originated */
  source: 'compiled_pattern' | 'energy_gradient' | 'replicator_fitness' | 'domain' | 'mode_observer' | 'mobius_diagnostics';
  /** ARIL fitness score for ranking */
  fitness: number;
}

export interface GuidanceOutput {
  /** All directives, ranked by fitness */
  directives: BehavioralDirective[];
  /** Pre-formatted markdown for CLAUDE.md injection */
  markdown: string;
  /** Number of sessions this guidance is based on */
  sessionCount: number;
  /** Overall ARIL fitness (mean) */
  meanFitness: number;
}

export interface GuidanceConfig {
  /** Max directives to emit (default: 10) */
  maxDirectives: number;
  /** Min fitness for energy gradient directives (default: 0.01) */
  minEnergyGradientMagnitude: number;
}

export const DEFAULT_GUIDANCE_CONFIG: GuidanceConfig = {
  maxDirectives: 10,
  minEnergyGradientMagnitude: 0.01,
};

// =============================================================================
// ENGINE
// =============================================================================

export class GuidanceEngine {
  private readonly config: GuidanceConfig;

  constructor(config: Partial<GuidanceConfig> = {}) {
    this.config = { ...DEFAULT_GUIDANCE_CONFIG, ...config };
  }

  /**
   * Generate behavioral guidance from ARIL state.
   *
   * @param fitness - ARIL fitness per dimension
   * @param dimensions - Dimension names
   * @param weights - Current identity weights
   * @param patterns - Compiled patterns from InsightCompiler
   * @param energyGradient - Current energy gradient
   * @param calibrator - Confidence calibrator (optional)
   * @param specializations - Domain specializations (optional)
   * @param sessionCount - Total session count
   * @param observation - ModeObservation from Layer 3 observer (optional)
   * @param mobiusDiagnostics - Möbius characteristic diagnostics (optional)
   */
  generate(
    fitness: Float64Array,
    dimensions: readonly string[],
    weights: Float64Array,
    patterns: CompiledPattern[],
    energyGradient: EnergyGradientResult | null,
    calibrator: ConfidenceCalibrator | null = null,
    specializations: Specialization[] = [],
    sessionCount: number = 0,
    observation: ModeObservation | null = null,
    mobiusDiagnostics: MobiusDiagnostics | null = null
  ): GuidanceOutput {
    const directives: BehavioralDirective[] = [];
    const n = dimensions.length;

    // Compute fitness statistics (NaN-safe)
    let fBar = 0;
    for (let i = 0; i < n; i++) fBar += safeFinite(fitness[i], 0);
    fBar = safeDivide(fBar, n, 0);

    let fVariance = 0;
    for (let i = 0; i < n; i++) fVariance += (safeFinite(fitness[i], 0) - fBar) ** 2;
    const fStd = Math.sqrt(safeDivide(fVariance, n, 0));

    // === Source 1: Compiled patterns ===
    for (const pattern of patterns) {
      const dimIndex = (dimensions as string[]).indexOf(pattern.dimension);
      if (dimIndex < 0) continue;

      const dimFitness = dimIndex < fitness.length ? safeFinite(fitness[dimIndex], 0) : 0;
      const calibratedConf = calibrator
        ? calibrator.adjustConfidence(pattern.dimension, pattern.confidence)
        : pattern.confidence;

      directives.push({
        dimension: pattern.dimension,
        weight: dimIndex < weights.length ? weights[dimIndex] : 0,
        imperative: pattern.pattern,
        context: `Based on ${pattern.sessionCount} session(s), ${pattern.evidence.length} observations`,
        strength: determineStrength(dimFitness, fBar, fStd, calibratedConf),
        source: 'compiled_pattern',
        fitness: dimFitness,
      });
    }

    // === Source 2: Energy gradient signals ===
    if (energyGradient) {
      for (let i = 0; i < Math.min(n, energyGradient.gradients.length); i++) {
        const grad = safeFinite(energyGradient.gradients[i], 0);
        if (Math.abs(grad) < this.config.minEnergyGradientMagnitude) continue;

        const dimFitness = safeFinite(fitness[i], 0);
        const direction = grad < 0 ? 'increase' : 'decrease';
        const dimName = dimensions[i] as string;

        directives.push({
          dimension: dimName,
          weight: weights[i],
          imperative: `${dimName} wants to ${direction} (gradient: ${grad.toFixed(4)})`,
          context: 'Energy landscape analysis',
          strength: determineStrength(dimFitness, fBar, fStd, 0.5),
          source: 'energy_gradient',
          fitness: dimFitness,
        });
      }
    }

    // === Source 3: Replicator fitness reinforcement ===
    for (let i = 0; i < n; i++) {
      const fi = safeFinite(fitness[i], 0);
      if (fi > fBar + fStd * 0.5) {
        const dimName = dimensions[i] as string;
        directives.push({
          dimension: dimName,
          weight: i < weights.length ? weights[i] : 0,
          imperative: `Continue reinforcing ${dimName} (high fitness: ${fi.toFixed(3)})`,
          context: 'Replicator dynamics — above-average fitness',
          strength: 'should',
          source: 'replicator_fitness',
          fitness: fi,
        });
      }
    }

    // === Source 4: Domain specializations ===
    for (const spec of specializations) {
      for (const guidance of spec.guidance) {
        directives.push({
          dimension: spec.domain,
          weight: 0,
          imperative: guidance,
          context: `${spec.domain} specialization (${spec.level})`,
          strength: spec.level === 'expert' ? 'should' : 'consider',
          source: 'domain',
          fitness: 0,
        });
      }
    }

    // === Source 5: Mode observer diagnostics ===
    if (observation) {
      // Search mode with high tunneling → inform about active exploration
      if (observation.mode === 'search' && observation.globalTunnelingRisk > 0.3) {
        directives.push({
          dimension: 'identity',
          weight: 0,
          imperative: `Active exploration detected (tunneling risk: ${observation.globalTunnelingRisk.toFixed(2)}). Dimensions may shift.`,
          context: `Mode: ${observation.mode}, mode_score: ${observation.modeScore.toFixed(3)}`,
          strength: 'consider',
          source: 'mode_observer',
          fitness: 0,
        });
      }

      // Dimensions near barrier → annotate with transition context
      const barrierDims = observation.dimensionModes.filter(d => d.well === 'barrier');
      if (barrierDims.length > 0) {
        const dimNames = barrierDims.map(d =>
          d.index < dimensions.length ? dimensions[d.index] : `dim[${d.index}]`
        ).join(', ');
        directives.push({
          dimension: 'identity',
          weight: 0,
          imperative: `${dimNames} near decision boundary — identity transition possible`,
          context: 'Curvature analysis: dimensions at barrier between wells',
          strength: 'consider',
          source: 'mode_observer',
          fitness: 0,
        });
      }

      // Consolidation stalling → warn about persistence losing value
      if (observation.consolidationDelta >= -0.001) {
        directives.push({
          dimension: 'identity',
          weight: 0,
          imperative: `Consolidation quality low (Δ=${observation.consolidationDelta.toFixed(4)}). Persisted identity may not be outperforming naive initialization.`,
          context: 'Consolidation tracking: E(w_init) ≈ E(w_random)',
          strength: 'consider',
          source: 'mode_observer',
          fitness: 0,
        });
      }
    }

    // === Source 6: Möbius interaction diagnostics ===
    if (mobiusDiagnostics) {
      // Data inadequacy warning — model can't be trusted yet
      if (!mobiusDiagnostics.dataAdequate) {
        directives.push({
          dimension: 'identity',
          weight: 0,
          imperative: `Interaction model still learning (${mobiusDiagnostics.observationCount} observations, need more). Attribution is additive-only.`,
          context: `Möbius order k=${mobiusDiagnostics.currentOrder}, data inadequate`,
          strength: 'consider',
          source: 'mobius_diagnostics',
          fitness: 0,
        });
      }

      // Poor fit warning — model doesn't explain the data well
      if (mobiusDiagnostics.dataAdequate && mobiusDiagnostics.fitResidual > 0.5) {
        directives.push({
          dimension: 'identity',
          weight: 0,
          imperative: `Interaction model fit is poor (residual: ${mobiusDiagnostics.fitResidual.toFixed(3)}). Dimension interactions may not be stable yet.`,
          context: `${mobiusDiagnostics.observationCount} observations, k=${mobiusDiagnostics.currentOrder}`,
          strength: 'consider',
          source: 'mobius_diagnostics',
          fitness: 0,
        });
      }

      // Synergy detected — inform about coupled dimensions
      if (mobiusDiagnostics.strongestInteraction && mobiusDiagnostics.dataAdequate) {
        const { dimensions: interDims, strength } = mobiusDiagnostics.strongestInteraction;
        const dimNames = interDims.map(i =>
          i < dimensions.length ? dimensions[i] : `dim[${i}]`
        ).join(' + ');

        if (strength > 0.05) {
          directives.push({
            dimension: dimNames,
            weight: 0,
            imperative: `Learned synergy between ${dimNames} (strength: ${strength.toFixed(3)}). These dimensions reinforce each other.`,
            context: `Möbius interaction from ${mobiusDiagnostics.observationCount} sessions, fit residual: ${mobiusDiagnostics.fitResidual.toFixed(3)}`,
            strength: mobiusDiagnostics.fitResidual < 0.2 ? 'should' : 'consider',
            source: 'mobius_diagnostics',
            fitness: 0,
          });
        }
      }

      // Higher-order interactions discovered
      if (mobiusDiagnostics.currentOrder > 2 && mobiusDiagnostics.dataAdequate) {
        directives.push({
          dimension: 'identity',
          weight: 0,
          imperative: `Higher-order interactions detected (k=${mobiusDiagnostics.currentOrder}). ${mobiusDiagnostics.interactionCount} interaction terms learned.`,
          context: 'Order adaptation: pairwise model was insufficient',
          strength: 'consider',
          source: 'mobius_diagnostics',
          fitness: 0,
        });
      }
    }

    // Sort by fitness (descending), then by strength priority
    const strengthOrder = { must: 0, should: 1, consider: 2 };
    directives.sort((a, b) => {
      const strengthDiff = strengthOrder[a.strength] - strengthOrder[b.strength];
      if (strengthDiff !== 0) return strengthDiff;
      return b.fitness - a.fitness;
    });

    // Limit directives
    const limited = directives.slice(0, this.config.maxDirectives);

    // Generate markdown
    const markdown = this.formatMarkdown(limited, sessionCount, fBar);

    return {
      directives: limited,
      markdown,
      sessionCount,
      meanFitness: fBar,
    };
  }

  /**
   * Format directives as markdown for CLAUDE.md injection.
   */
  private formatMarkdown(
    directives: BehavioralDirective[],
    sessionCount: number,
    meanFitness: number
  ): string {
    if (directives.length === 0) {
      return '';
    }

    const lines: string[] = [];
    lines.push(`## Behavioral Directives (${sessionCount} sessions, ARIL fitness: ${safeFinite(meanFitness, 0).toFixed(2)})`);
    lines.push('');

    // Group by strength
    const musts = directives.filter(d => d.strength === 'must');
    const shoulds = directives.filter(d => d.strength === 'should');
    const considers = directives.filter(d => d.strength === 'consider');

    if (musts.length > 0) {
      lines.push('### High-Confidence Directives');
      for (const d of musts) {
        const arrow = d.fitness > 0 ? '\u2191' : d.fitness < 0 ? '\u2193' : '\u2192';
        lines.push(`- **${d.dimension}** (f=${safeFinite(d.fitness, 0).toFixed(2)}, ${arrow}) \u2014 MUST: ${d.imperative}`);
      }
      lines.push('');
    }

    if (shoulds.length > 0) {
      lines.push('### Recommended Directives');
      for (const d of shoulds) {
        lines.push(`- **${d.dimension}** (f=${safeFinite(d.fitness, 0).toFixed(2)}) \u2014 SHOULD: ${d.imperative}`);
      }
      lines.push('');
    }

    if (considers.length > 0) {
      lines.push('### Suggested Directives');
      for (const d of considers) {
        lines.push(`- ${d.dimension} \u2014 CONSIDER: ${d.imperative}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function determineStrength(
  dimFitness: number,
  fBar: number,
  fStd: number,
  calibratedConfidence: number
): 'must' | 'should' | 'consider' {
  // Guard: any NaN input → conservative 'consider'
  const f = safeFinite(dimFitness, 0);
  const bar = safeFinite(fBar, 0);
  const std = safeFinite(fStd, 0);
  const conf = safeFinite(calibratedConfidence, 0);

  if (f > bar + std && conf > 0.8) {
    return 'must';
  }
  if (f > bar && conf > 0.6) {
    return 'should';
  }
  return 'consider';
}
