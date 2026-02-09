/**
 * ConfidenceCalibrator.ts
 *
 * Closes the meta-loop: tracks whether high-confidence insights
 * actually led to good outcomes, then adjusts confidence accordingly.
 *
 * After each session:
 *   calibration[dim] = EMA(actual_outcomes[dim]) / EMA(predicted_confidence[dim])
 *   adjusted_confidence = raw_confidence · calibration[dim]
 *
 * Interpretation:
 *   > 1.0: LLM underestimates confidence → trust more
 *   < 1.0: LLM overestimates confidence → trust less
 *   = 1.0: Well-calibrated
 *
 * This means the LLM's own insight quality is subject to gradient-like
 * optimization — the system learns which of its own judgments to trust.
 */

import type { Insight } from './ReflectionEngine';
import { safeClamp, safeFinite, safeDivide } from './math';

// =============================================================================
// TYPES
// =============================================================================

export interface CalibrationRecord {
  /** Predicted confidence from insight */
  predicted: number;
  /** Actual outcome quality for this dimension */
  actual: number;
  /** Which dimension this record is for */
  dimension: string;
  /** Timestamp */
  timestamp: number;
}

export interface CalibrationState {
  /** Per-dimension calibration factor */
  calibrationFactors: Map<string, number>;
  /** Running EMA of predicted confidence per dimension */
  predictedEMA: Map<string, number>;
  /** Running EMA of actual outcomes per dimension */
  actualEMA: Map<string, number>;
  /** Number of calibration updates */
  updateCount: number;
}

export interface CalibratorConfig {
  /** EMA decay rate for calibration tracking (default: 0.1) */
  decay: number;
  /** Minimum factor floor (default: 0.3) */
  minFactor: number;
  /** Maximum factor ceiling (default: 3.0) */
  maxFactor: number;
  /** Minimum sessions before calibration activates (default: 3) */
  warmupSessions: number;
}

export const DEFAULT_CALIBRATOR_CONFIG: CalibratorConfig = {
  decay: 0.1,
  minFactor: 0.3,
  maxFactor: 3.0,
  warmupSessions: 3,
};

// =============================================================================
// CALIBRATOR
// =============================================================================

export class ConfidenceCalibrator {
  private state: CalibrationState;
  private readonly config: CalibratorConfig;

  constructor(
    config: Partial<CalibratorConfig> = {},
    initialState?: CalibrationState
  ) {
    this.config = { ...DEFAULT_CALIBRATOR_CONFIG, ...config };
    this.state = initialState ?? {
      calibrationFactors: new Map(),
      predictedEMA: new Map(),
      actualEMA: new Map(),
      updateCount: 0,
    };
  }

  /**
   * Update calibration with a session's insights and outcomes.
   *
   * @param insights - Insights from this session (with confidence)
   * @param dimensionOutcomes - Map of dimension → actual outcome quality [0, 1]
   */
  calibrate(
    insights: Insight[],
    dimensionOutcomes: Map<string, number>
  ): void {
    const decay = this.config.decay;

    for (const insight of insights) {
      const dim = insight.dimension;
      const predicted = safeFinite(insight.confidence, 0.5);
      const actual = safeFinite(dimensionOutcomes.get(dim) ?? 0, 0);

      // Update predicted EMA
      const prevPredicted = this.state.predictedEMA.get(dim) ?? predicted;
      const newPredicted = safeFinite((1 - decay) * prevPredicted + decay * predicted, prevPredicted);
      this.state.predictedEMA.set(dim, newPredicted);

      // Update actual EMA
      const prevActual = this.state.actualEMA.get(dim) ?? actual;
      const newActual = safeFinite((1 - decay) * prevActual + decay * actual, prevActual);
      this.state.actualEMA.set(dim, newActual);

      // Compute calibration factor (guarded division)
      if (newPredicted > 1e-6) {
        const factor = safeClamp(
          safeDivide(newActual, newPredicted, 1.0),
          this.config.minFactor,
          this.config.maxFactor,
          1.0
        );
        this.state.calibrationFactors.set(dim, factor);
      }
    }

    this.state.updateCount++;
  }

  /**
   * Adjust a raw confidence value using calibration data.
   *
   * @param dimension - The dimension to calibrate for
   * @param rawConfidence - The raw confidence from the LLM
   * @returns Calibrated confidence
   */
  adjustConfidence(dimension: string, rawConfidence: number): number {
    // Don't calibrate during warmup
    if (this.state.updateCount < this.config.warmupSessions) {
      return rawConfidence;
    }

    const factor = this.state.calibrationFactors.get(dimension);
    if (factor === undefined) {
      return rawConfidence;
    }

    return safeClamp(rawConfidence * factor, 0, 1, rawConfidence);
  }

  /**
   * Get calibration factor for a dimension.
   * Returns 1.0 if no calibration data exists.
   */
  getCalibrationFactor(dimension: string): number {
    return this.state.calibrationFactors.get(dimension) ?? 1.0;
  }

  /**
   * Get all calibration factors.
   */
  getAllFactors(): Map<string, number> {
    return new Map(this.state.calibrationFactors);
  }

  /**
   * Get calibrator state for serialization.
   */
  getState(): CalibrationState {
    return {
      calibrationFactors: new Map(this.state.calibrationFactors),
      predictedEMA: new Map(this.state.predictedEMA),
      actualEMA: new Map(this.state.actualEMA),
      updateCount: this.state.updateCount,
    };
  }

  /**
   * Get update count.
   */
  getUpdateCount(): number {
    return this.state.updateCount;
  }
}

// =============================================================================
// SERIALIZATION
// =============================================================================

export interface SerializedCalibrationState {
  calibrationFactors: Record<string, number>;
  predictedEMA: Record<string, number>;
  actualEMA: Record<string, number>;
  updateCount: number;
}

export function serializeCalibrationState(state: CalibrationState): SerializedCalibrationState {
  return {
    calibrationFactors: Object.fromEntries(state.calibrationFactors),
    predictedEMA: Object.fromEntries(state.predictedEMA),
    actualEMA: Object.fromEntries(state.actualEMA),
    updateCount: state.updateCount,
  };
}

export function deserializeCalibrationState(data: SerializedCalibrationState): CalibrationState {
  return {
    calibrationFactors: new Map(Object.entries(data.calibrationFactors)),
    predictedEMA: new Map(Object.entries(data.predictedEMA)),
    actualEMA: new Map(Object.entries(data.actualEMA)),
    updateCount: data.updateCount,
  };
}

// (clamp replaced by safeClamp from ./math)
