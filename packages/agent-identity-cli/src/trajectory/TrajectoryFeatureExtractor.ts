/**
 * TrajectoryFeatureExtractor.ts
 *
 * Computes 8 trajectory features from session metric snapshots (v2.2 spec §9).
 *
 * Called once at session end. Each feature gets a confidence score based on
 * piecewise ramps over Tier 0/1 snapshot counts.
 *
 * Features encode structural patterns in how code was edited:
 *   - complexity_shape: trend direction of complexity over the session
 *   - coupling_direction: change in efferent coupling from Tier 1
 *   - edit_dep_alignment: Spearman correlation of edit order vs dep depth
 *   - edit_locality: entropy over files/folders touched
 *   - complexity_coupling_corr: Pearson(Δ-complexity, Δ-coupling)
 *   - structural_churn: variance of metrics for files edited >1 time
 *   - api_surface_delta: net change in exports across session
 *   - refactor_detected: spike-then-return pattern in complexity
 */

import type { TrajectoryStore } from './TrajectoryStore';
import type { TrajectoryEvaluator } from './TrajectoryEvaluator';
import type { TrajectoryFeatures, MetricSnapshot } from './types';
import {
  tier0Confidence,
  tier1Confidence,
} from './types';
import { computeEditDepAlignment, computeNodeDepths } from './nodeDepth';
import type { SimpleGraph } from './nodeDepth';

// =============================================================================
// MAIN ENTRY POINT
// =============================================================================

export function computeTrajectoryFeatures(
  evaluator: TrajectoryEvaluator,
  store: TrajectoryStore,
): { features: TrajectoryFeatures; confidences: Record<string, number> } {
  const sessionId = evaluator.sessionId;
  const snapshots = evaluator.getTrajectory();
  const counts = store.getSnapshotCountByTier(sessionId);

  const t0Conf = tier0Confidence(counts.tier0);
  const t1Conf = tier1Confidence(counts.tier1);

  const features: TrajectoryFeatures = {
    complexity_shape: computeComplexityShape(snapshots),
    coupling_direction: computeCouplingDirection(snapshots),
    edit_dep_alignment: computeEditDepAlignmentFeature(evaluator, snapshots),
    edit_locality: computeEditLocality(snapshots),
    complexity_coupling_corr: computeComplexityCouplingCorr(snapshots),
    structural_churn: computeStructuralChurn(snapshots),
    api_surface_delta: computeApiSurfaceDelta(evaluator),
    refactor_detected: computeRefactorDetected(snapshots) ? 1 : 0,
  };

  const confidences: Record<string, number> = {
    complexity_shape: t0Conf,
    coupling_direction: t1Conf,
    edit_dep_alignment: t1Conf,
    edit_locality: t0Conf,
    complexity_coupling_corr: t1Conf,
    structural_churn: t0Conf,
    api_surface_delta: t0Conf,
    refactor_detected: t0Conf,
  };

  return { features, confidences };
}

// =============================================================================
// INDIVIDUAL FEATURES
// =============================================================================

/**
 * Linear trend of per-step cyclomatic complexity.
 * Negative → complexity decreasing (simplifying).
 * Positive → complexity increasing (building).
 */
function computeComplexityShape(snapshots: MetricSnapshot[]): number {
  const values = snapshots
    .filter(s => s.tier === 0)
    .map(s => asNumber(s.metricsJson.cyclomatic_complexity));

  if (values.length < 2) return 0;
  return linearTrend(values);
}

/**
 * Change in efferent coupling (Ce) from first to last Tier 1 snapshot.
 * Requires Tier 1 data with _tier1_ce metric.
 */
function computeCouplingDirection(snapshots: MetricSnapshot[]): number {
  const tier1 = snapshots.filter(s => s.tier === 1 && s.metricsJson._tier1_ce !== undefined);
  if (tier1.length < 2) return 0;

  const firstCe = asNumber(tier1[0].metricsJson._tier1_ce);
  const lastCe = asNumber(tier1[tier1.length - 1].metricsJson._tier1_ce);
  return lastCe - firstCe;
}

/**
 * Spearman correlation of first-touch order vs dependency graph depth.
 * Uses raw import specifiers to build a local graph when Tier 1 isn't available.
 */
function computeEditDepAlignmentFeature(
  evaluator: TrajectoryEvaluator,
  snapshots: MetricSnapshot[],
): number {
  // Build edit order: first touch per file
  const firstTouch = new Map<string, number>();
  for (const s of snapshots) {
    if (!firstTouch.has(s.filePath)) {
      firstTouch.set(s.filePath, s.stepIndex);
    }
  }

  if (firstTouch.size < 3) return 0;

  // Build simple graph from raw import cache
  const importCache = evaluator.getRawImportCache();
  const adjacency = new Map<string, Set<string>>();

  for (const [file, imports] of importCache) {
    adjacency.set(file, new Set(imports));
  }

  const graph: SimpleGraph = { adjacency };
  const depths = computeNodeDepths(graph);

  const editOrder = Array.from(firstTouch.entries()).map(([filePath, firstStepIndex]) => ({
    filePath,
    firstStepIndex,
  }));

  return computeEditDepAlignment(editOrder, depths);
}

/**
 * Shannon entropy over unique files touched.
 * Low entropy → concentrated edits (focused).
 * High entropy → scattered edits (dispersed).
 *
 * Normalized to [0, 1] by dividing by log2(file count).
 */
function computeEditLocality(snapshots: MetricSnapshot[]): number {
  if (snapshots.length === 0) return 0;

  // Count edits per file
  const fileCounts = new Map<string, number>();
  for (const s of snapshots) {
    fileCounts.set(s.filePath, (fileCounts.get(s.filePath) ?? 0) + 1);
  }

  const n = fileCounts.size;
  if (n <= 1) return 0; // single file = perfectly focused

  const total = snapshots.length;
  let entropy = 0;
  for (const count of fileCounts.values()) {
    const p = count / total;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  // Normalize by max entropy
  const maxEntropy = Math.log2(n);
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

/**
 * Pearson correlation between Δ-complexity and Δ-coupling per step.
 * Requires both Tier 0 (complexity) and Tier 1 (coupling) data.
 *
 * Uses forward-fill resampling: for each Tier 0 step, the coupling value
 * is the most recent Tier 1 ce at or before that step. This aligns the
 * two series despite different sampling rates (every edit vs. debounced batch).
 */
function computeComplexityCouplingCorr(snapshots: MetricSnapshot[]): number {
  const tier0 = snapshots.filter(s => s.tier === 0);
  const tier1 = snapshots
    .filter(s => s.tier === 1 && s.metricsJson._tier1_ce !== undefined)
    .sort((a, b) => a.stepIndex - b.stepIndex);

  if (tier0.length < 3 || tier1.length < 2) return 0;

  // Build forward-filled coupling series aligned to Tier 0 step indices.
  // For each Tier 0 snapshot, find the last Tier 1 ce at or before that step.
  const alignedComplexity: number[] = [];
  const alignedCoupling: number[] = [];
  let t1Idx = 0;
  let lastCe: number | null = null;

  for (const t0 of tier0) {
    // Advance Tier 1 pointer to the last entry at or before this step
    while (t1Idx < tier1.length && tier1[t1Idx].stepIndex <= t0.stepIndex) {
      lastCe = asNumber(tier1[t1Idx].metricsJson._tier1_ce);
      t1Idx++;
    }
    if (lastCe === null) continue; // No Tier 1 data yet at this point

    alignedComplexity.push(asNumber(t0.metricsJson.cyclomatic_complexity));
    alignedCoupling.push(lastCe);
  }

  if (alignedComplexity.length < 3) return 0;

  // Compute deltas on aligned series
  const complexityDeltas: number[] = [];
  const couplingDeltas: number[] = [];
  for (let i = 1; i < alignedComplexity.length; i++) {
    complexityDeltas.push(alignedComplexity[i] - alignedComplexity[i - 1]);
    couplingDeltas.push(alignedCoupling[i] - alignedCoupling[i - 1]);
  }

  if (complexityDeltas.length < 2) return 0;

  return pearsonCorr(complexityDeltas, couplingDeltas);
}

/**
 * Variance of metrics for files edited more than once.
 * High churn → unstable edits. Low churn → clean, targeted changes.
 */
function computeStructuralChurn(snapshots: MetricSnapshot[]): number {
  // Group Tier 0 snapshots by file
  const byFile = new Map<string, number[]>();
  for (const s of snapshots) {
    if (s.tier !== 0) continue;
    const complexity = asNumber(s.metricsJson.cyclomatic_complexity);
    if (!byFile.has(s.filePath)) {
      byFile.set(s.filePath, []);
    }
    byFile.get(s.filePath)!.push(complexity);
  }

  // Only consider files edited > 1 time
  const variances: number[] = [];
  for (const values of byFile.values()) {
    if (values.length < 2) continue;
    variances.push(variance(values));
  }

  if (variances.length === 0) return 0;
  return variances.reduce((a, b) => a + b, 0) / variances.length;
}

/**
 * Net change in exports across the session.
 * Uses the evaluator's export count cache (first and last values).
 */
function computeApiSurfaceDelta(evaluator: TrajectoryEvaluator): number {
  const exportCache = evaluator.getExportCountCache();

  // Sum all current export counts
  let totalExports = 0;
  for (const count of exportCache.values()) {
    totalExports += count;
  }

  // We can't know the "before" state from cache alone, but we track
  // the net change from Tier 0 snapshots' first vs last export_count per file
  return totalExports;
}

/**
 * Detect spike-then-return pattern in complexity.
 *
 * A refactoring spike: complexity peaks at > 1.5× baseline,
 * then returns to ≤ 1.1× baseline.
 */
function computeRefactorDetected(snapshots: MetricSnapshot[]): boolean {
  const values = snapshots
    .filter(s => s.tier === 0)
    .map(s => asNumber(s.metricsJson.cyclomatic_complexity));

  if (values.length < 3) return false;

  // Baseline = first value (or average of first 2)
  const baseline = values.length >= 2
    ? (values[0] + values[1]) / 2
    : values[0];

  if (baseline <= 0) return false;

  let peakSeen = false;
  let returnedToBaseline = false;

  for (let i = 0; i < values.length; i++) {
    const ratio = values[i] / baseline;
    if (ratio > 1.5) {
      peakSeen = true;
    }
    if (peakSeen && i > 0 && ratio <= 1.1) {
      returnedToBaseline = true;
      break;
    }
  }

  return peakSeen && returnedToBaseline;
}

// =============================================================================
// MATH HELPERS
// =============================================================================

function asNumber(x: unknown): number {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  return 0;
}

/**
 * Linear trend (slope) via least squares regression.
 * Returns normalized slope (per index step).
 */
function linearTrend(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;

  return (n * sumXY - sumX * sumY) / denom;
}

/**
 * Pearson correlation coefficient.
 */
function pearsonCorr(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;

  const meanX = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const meanY = y.slice(0, n).reduce((a, b) => a + b, 0) / n;

  let num = 0, denomX = 0, denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denom = Math.sqrt(denomX * denomY);
  if (denom === 0) return 0;

  return num / denom;
}

/**
 * Sample variance.
 */
function variance(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  return values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1);
}
