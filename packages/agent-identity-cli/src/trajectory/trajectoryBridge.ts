/**
 * trajectoryBridge.ts
 *
 * Converts trajectory features into OutcomeSignals for the ARIL backward pass
 * (v2.2 spec §9, fix #24).
 *
 * Key design: confidence is PRE-BAKED into the weight field.
 * `weight = TRAJECTORY_BASE_WEIGHT * confidence`
 *
 * This means:
 *   - Zero-confidence features produce zero-weight signals → naturally filtered
 *   - No `confidence` field on OutcomeSignal (doesn't exist in the type)
 *   - OutcomeEvaluator's weighted average auto-normalizes the contributions
 */

import type { TrajectoryFeatures } from './types';
import { TRAJECTORY_BASE_WEIGHT, TRAJECTORY_FEATURE_NAMES } from './types';

/** Matches the OutcomeSignal interface from agent-identity. */
export interface TrajectoryOutcomeSignal {
  source: 'trajectory';
  value: number;
  weight: number;
}

/**
 * Convert trajectory features + confidences into OutcomeSignals.
 *
 * Filters out zero-confidence features (v2.2: skip zero-confidence).
 * Pre-bakes confidence into weight (v2.2 fix #24).
 */
export function trajectoryFeaturesToSignals(
  features: TrajectoryFeatures,
  confidences: Record<string, number>,
): TrajectoryOutcomeSignal[] {
  const signals: TrajectoryOutcomeSignal[] = [];

  for (const name of TRAJECTORY_FEATURE_NAMES) {
    const confidence = confidences[name] ?? 0;
    if (confidence <= 0) continue; // v2.2: skip zero-confidence

    const value = normalizeFeatureValue(name, features[name]);
    const weight = TRAJECTORY_BASE_WEIGHT * confidence;

    signals.push({
      source: 'trajectory',
      value,
      weight,
    });
  }

  return signals;
}

/**
 * Normalize a feature value to [-1, 1] range for OutcomeSignal.
 *
 * Different features have different natural ranges:
 *   - complexity_shape: typically [-5, 5] → clamp to [-1, 1]
 *   - coupling_direction: integer deltas → clamp
 *   - edit_dep_alignment: already [-1, 1] (Spearman rho)
 *   - edit_locality: already [0, 1] (normalized entropy)
 *   - complexity_coupling_corr: already [-1, 1] (Pearson corr)
 *   - structural_churn: [0, ∞) → sigmoid mapping
 *   - api_surface_delta: integer → clamp
 *   - refactor_detected: 0 or 1 → pass through
 */
function normalizeFeatureValue(name: string, value: number): number {
  if (!Number.isFinite(value)) return 0;

  switch (name) {
    case 'edit_dep_alignment':
    case 'complexity_coupling_corr':
      // Already [-1, 1]
      return clamp(value, -1, 1);

    case 'edit_locality':
      // [0, 1] → map to [-1, 1]: low entropy (focused) is positive
      return 1 - 2 * clamp(value, 0, 1);

    case 'refactor_detected':
      // 0 or 1 → positive signal when detected
      return value > 0 ? 0.5 : 0;

    case 'complexity_shape':
      // Negative trend (simplifying) is good → invert
      return clamp(-value, -1, 1);

    case 'coupling_direction':
      // Negative change (decoupling) is good → invert and scale
      return clamp(-value * 0.2, -1, 1);

    case 'structural_churn':
      // Low churn is good → invert with sigmoid
      return clamp(1 - 2 * sigmoid(value), -1, 1);

    case 'api_surface_delta':
      // Moderate increase is neutral, large change → slight signal
      return clamp(value * 0.1, -1, 1);

    default:
      return clamp(value, -1, 1);
  }
}

function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
