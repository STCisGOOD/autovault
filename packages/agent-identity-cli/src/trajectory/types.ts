/**
 * types.ts
 *
 * Core types for the Trajectory Evaluator system (v2.2 spec §9, §10).
 *
 * The trajectory evaluator tracks code-level metrics across a session's edits,
 * producing features that feed into the ARIL backward pass as OutcomeSignals.
 * Metrics are tiered:
 *   - Tier 0: Per-edit AST metrics (fast, <15ms per edit via tree-sitter)
 *   - Tier 1: Cross-file dependency analysis (debounced, via dependency-cruiser)
 */

// =============================================================================
// ENUMS & CONSTANTS
// =============================================================================

export type MetricTier = 0 | 1 | 2;
export type FileRole = 'source' | 'test' | 'config';
export type Granularity = 'file' | 'folder';

export const TRAJECTORY_SCHEMA_VERSION = 1;

/** Base weight per trajectory feature (8 features × 0.02 = 0.16 max). */
export const TRAJECTORY_BASE_WEIGHT = 0.02;

// =============================================================================
// METRIC SNAPSHOTS
// =============================================================================

/** A single metric snapshot row stored in SQLite. */
export interface MetricSnapshot {
  readonly id?: number;
  readonly sessionId: string;
  readonly stepIndex: number;
  readonly timestampMs: number;
  readonly filePath: string;
  readonly toolType: string;            // 'Write' | 'Edit' | 'NotebookEdit'
  readonly granularity: Granularity;
  readonly packageName: string | null;
  readonly fileRole: FileRole;
  readonly metricsJson: Record<string, unknown>;  // {metric_name: value}
  readonly tier: MetricTier;
  readonly schemaVersion: number;
}

// =============================================================================
// TIER RESULTS
// =============================================================================

/** Tier 0 parse result from tree-sitter or TS API fallback. */
export interface Tier0Result {
  readonly snapshot: MetricSnapshot;
  readonly tier1Trigger: boolean;
}

/** Data structure for Tier 1 batch writes. */
export interface Tier1SnapshotData {
  readonly sessionId: string;
  readonly stepIndex: number;
  readonly granularity: Granularity;
  readonly language: string;
  readonly edges: Array<{ from: string; to: string }>;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly circularDeps: number;
  readonly gitSha?: string;
  readonly perFileMetrics?: Array<{
    readonly filePath: string;
    readonly metricsJson: Record<string, unknown>;
  }>;
}

/** Data structure for persisting session features. */
export interface SessionPersistData {
  readonly features: TrajectoryFeatures;
  readonly confidences: Record<string, number>;
  readonly stepCount: number;
  readonly filesTouched: number;
  readonly packagesTouched?: number;
  readonly testFilesTouched?: number;
  readonly sourceFilesTouched?: number;
  readonly tier0SnapshotCount?: number;
  readonly tier1SnapshotCount?: number;
  /** Whether dep-cruiser was available and Tier 1 analysis ran. */
  readonly tier1Available?: boolean;
}

/** Tier 1 coupling metrics stored in metricsJson (keyed with _tier1_ prefix). */
export interface Tier1Metrics {
  readonly _tier1_ca: number;           // Afferent coupling: who depends on me
  readonly _tier1_ce: number;           // Efferent coupling: who I depend on
  readonly _tier1_instability: number;  // Ce / (Ca + Ce)
  readonly _tier1_trigger_step_min: number;
  readonly _tier1_trigger_step_max: number;
}

/** Stored dep graph snapshot (from SQLite). */
export interface DepGraphSnapshot {
  readonly sessionId: string;
  readonly stepIndex: number;
  readonly granularity: Granularity;
  readonly language: string;
  readonly edges: Array<{ from: string; to: string }>;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly circularDeps: number;
  readonly gitSha?: string;
}

// =============================================================================
// TRAJECTORY FEATURES (v2.2 spec §9)
// =============================================================================

/** The 8 trajectory features computed at session end. */
export interface TrajectoryFeatures {
  readonly complexity_shape: number;
  readonly coupling_direction: number;
  readonly edit_dep_alignment: number;
  readonly edit_locality: number;
  readonly complexity_coupling_corr: number;
  readonly structural_churn: number;
  readonly api_surface_delta: number;
  readonly refactor_detected: number;    // 0 or 1
}

export const TRAJECTORY_FEATURE_NAMES = [
  'complexity_shape',
  'coupling_direction',
  'edit_dep_alignment',
  'edit_locality',
  'complexity_coupling_corr',
  'structural_churn',
  'api_surface_delta',
  'refactor_detected',
] as const;

export type TrajectoryFeatureName = typeof TRAJECTORY_FEATURE_NAMES[number];

/** Per-feature result with confidence (v2.2 piecewise ramps). */
export interface TrajectoryFeatureResult {
  readonly name: TrajectoryFeatureName;
  readonly value: number;
  readonly confidence: number;  // [0, 1]
}

// =============================================================================
// CONFIDENCE RAMPS (v2.2 spec §9)
// =============================================================================

/**
 * Piecewise confidence ramp for Tier 0 snapshot count.
 *
 * Maps: 0→0.0, 1→0.1, 3→0.5, 5→0.8, 10→1.0
 * Linear interpolation between breakpoints.
 */
export function tier0Confidence(count: number): number {
  if (count <= 0) return 0.0;
  if (count <= 1) return 0.1;
  if (count <= 3) return 0.1 + (count - 1) * 0.2;
  if (count <= 5) return 0.5 + (count - 3) * 0.15;
  if (count <= 10) return 0.8 + (count - 5) * 0.04;
  return 1.0;
}

/**
 * Piecewise confidence ramp for Tier 1 snapshot count.
 *
 * Maps: 0→0.0, 1→0.2, 3→0.6, 5→1.0
 * Linear interpolation between breakpoints.
 */
export function tier1Confidence(count: number): number {
  if (count <= 0) return 0.0;
  if (count <= 1) return 0.2;
  if (count <= 3) return 0.2 + (count - 1) * 0.2;
  if (count <= 5) return 0.6 + (count - 3) * 0.2;
  return 1.0;
}

// =============================================================================
// QUERY OPTIONS
// =============================================================================

export interface QueryOpts {
  readonly tier?: MetricTier;
  readonly filePath?: string;
  readonly limit?: number;
}

// =============================================================================
// BATCH METADATA (v2.2)
// =============================================================================

export interface BatchMeta {
  readonly triggerStepMin: number;
  readonly triggerStepMax: number;
  readonly batchSpanSteps: number;
  readonly batchFiles: string[];
}
