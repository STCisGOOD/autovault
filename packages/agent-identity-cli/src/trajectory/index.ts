/**
 * Trajectory Evaluator module.
 *
 * Tracks code-level metrics across a session's edits, producing features
 * that feed into the ARIL backward pass as OutcomeSignals.
 */

export { TrajectoryEvaluator, normalizePath } from './TrajectoryEvaluator';
export type { ResolvedGraphRef, TrajectoryEvaluatorConfig } from './TrajectoryEvaluator';

export { TrajectoryStore } from './TrajectoryStore';

export { computeTrajectoryFeatures } from './TrajectoryFeatureExtractor';

export { trajectoryFeaturesToSignals } from './trajectoryBridge';
export type { TrajectoryOutcomeSignal } from './trajectoryBridge';

export { DepGraphManager } from './DepGraphManager';
export type { DepCruiserResult, CouplingMetrics } from './DepGraphManager';

export { Tier1Debouncer } from './Tier1Debouncer';
export type { Tier1Handler } from './Tier1Debouncer';

export { classifyFileRole, classifyPackage } from './fileClassifier';

export { spearmanRho, computeNodeDepths, computeEditDepAlignment } from './nodeDepth';

export type {
  MetricSnapshot,
  MetricTier,
  FileRole,
  Granularity,
  Tier0Result,
  Tier1SnapshotData,
  SessionPersistData,
  DepGraphSnapshot,
  TrajectoryFeatures,
  TrajectoryFeatureName,
  TrajectoryFeatureResult,
  QueryOpts,
  BatchMeta,
  Tier1Metrics,
} from './types';

export {
  TRAJECTORY_SCHEMA_VERSION,
  TRAJECTORY_BASE_WEIGHT,
  TRAJECTORY_FEATURE_NAMES,
  tier0Confidence,
  tier1Confidence,
} from './types';
