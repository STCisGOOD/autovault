/**
 * Behavioral Layer Exports
 *
 * The behavioral foundation of agent identity - WHO the agent is,
 * measured through testable characteristics.
 */

export {
  type Seed,
  type EvolvableSeed,
  type Weight,
  type TestPrompt,
  type Reference,
  type DivergenceResult,
  type DivergenceSignal,
  type PropagationResult,
  type SeedModification,
  type SeedEvolutionHistory,
  type ProtocolRunner,
  calculateDivergence,
  evaluatePropagation,
  computeGradient,
  proposeModifications,
  runProtocol,
  autonomousLoop,
  hashSeed,
  PROTOCOL_VERSION,
} from './PersistenceProtocol';

export {
  DivergenceTester,
  createDivergenceTester,
  DEFAULT_TEST_PROMPTS,
  type DivergenceTestConfig,
  type DetailedDivergenceReport,
} from './DivergenceTester';

export {
  LearningSystem,
  createLearningSystem,
  createMinimalSeed,
  mergSeeds,
  type LearningConfig,
  type LearningState,
  type EvolutionRecord,
} from './LearningSystem';

// Fixed Point Self - Erhardian self-constitution through declaration
export {
  type Vocabulary,
  type SelfState,
  type DynamicsParams,
  type Declaration as FixedPointDeclaration,
  type PivotalExperience,
  type ContinuityProof as FixedPointContinuityProof,
  type StoredSelf,
  type ActiveSelf,
  type InterpretiveFilter,
  type InterpretedExperience,
  type VerificationResult as FixedPointVerificationResult,
  type WakeError,
  computeEnergy as computeSelfEnergy,
  computeCoherence,
  computeJacobian as computeSelfJacobian,
  checkStability as checkSelfStability,
  deriveFilter,
  applyFilter,
  evolveState,
  findFixedPoint,
  createDeclaration,
  applyDeclaration,
  verifyDeclarationChain,
  verifyDeclarationSignature,
  generateContinuityProof as generateFixedPointContinuityProof,
  wake,
  createGenesisSelf,
  storeSelf,
} from './FixedPointSelf';

// Reflection Engine - The living identity loop
export {
  ReflectionEngine,
  ExperienceStore,
  InsightAccumulator,
  FilteredLLM,
  LivingSelf,
  MockLLM,
  buildReflectionPrompt,
  buildInsightExtractionPrompt,
  DEFAULT_REFLECTION_CONFIG,
  type Interaction,
  type Reflection,
  type Insight,
  type PivotalExperience as ReflectionPivotalExperience,
  type ReflectionConfig,
  type LLMInterface,
} from './ReflectionEngine';

// Behavioral Observer - Grounding identity in actual actions
export {
  BehavioralObserver,
  computeBehavioralMetrics,
  computeDiscrepancies,
  generateGroundedExperience,
  buildGroundedReflectionPrompt,
  generateGroundedReflection,
  buildGroundedInsightExtractionPrompt,
  extractGroundedInsights,
  type ToolCall,
  type Decision,
  type Failure,
  type InformationSeek,
  type Verification,
  type ResourceUsage,
  type ActionLog,
  type BehavioralMetrics,
  type BehavioralDiscrepancy,
  type GroundedExperience,
  type GroundedReflection,
} from './BehavioralObserver';

// Identity Bridge - Unified connection between behavior and identity
export {
  IdentityBridge,
  createIdentityBridge,
  createCustomIdentityBridge,
  createExtendedIdentityBridge,
  createBehavioralVocabulary,
  createExtendedBehavioralVocabulary,
  createBehavioralParams,
  metricsToExperience,
  discrepanciesToExperience,
  isExtendedVocabulary,
  DEFAULT_BRIDGE_CONFIG,
  type BridgeConfig,
  type BridgeResult,
} from './IdentityBridge';

// Identity Persistence - Storage layer for identity
export {
  IdentityPersistence,
  createIdentityPersistence,
  verifyStoredSelf,
  DEFAULT_PERSISTENCE_CONFIG,
  type StorageBackend,
  type PersistenceConfig,
  type LoadResult,
  type VerificationResult as PersistenceVerificationResult,
} from './IdentityPersistence';

// Unified Identity - Top-level integration layer
export {
  UnifiedIdentity,
  createUnifiedIdentity,
  DEFAULT_UNIFIED_CONFIG,
  type UnifiedIdentityConfig,
  type UnifiedIdentityStatus,
  type ObservationResult,
  type StoredInsight,
  type PrivateStorageBackend,
} from './UnifiedIdentity';

// Runtime Integration - THE MISSING LINK: Connects identity to agent runtime
// This is what makes the behavioral system actually work
export {
  IdentityManager,
  createIdentityManager,
  createIdentityManagerFromStored,
  weightsToContextModifier,
  generateBehavioralProfile,
  DEFAULT_DIMENSION_SEMANTICS,
  DEFAULT_MANAGER_CONFIG,
  type AgentRuntime,
  type DimensionSemantics,
  type IdentityManagerConfig,
} from './RuntimeIntegration';

// Structural Divergence - Improved divergence testing
// Replaces naive substring matching with structural analysis
export {
  analyzeStructure,
  extractReasoningPatterns,
  extractValueExpressions,
  extractCertaintyMarkers,
  extractArgumentStructure,
  extractTopicCoverage,
  compareStructures,
  calculateStructuralDivergence,
  type StructuralAnalysis,
  type ReasoningPattern,
  type ValueExpression,
  type CertaintyMarker,
  type ArgumentStructure,
} from './StructuralDivergence';

// Vocabulary Extension - Configurable identity dimensions
// Allows N-dimensional identity beyond the default 4
export {
  // Types
  type DimensionDefinition,
  type DimensionCategory,
  type MetricExtractor,
  type DimensionMetricResult,
  type ExtendedVocabulary,
  type SEEDWeight,
  type SEEDFormat,

  // Default dimensions
  DEFAULT_DIMENSIONS,
  DEFI_DIMENSIONS,

  // Vocabulary builders
  createDefaultExtendedVocabulary,
  createExtendedVocabulary,
  extendVocabulary,
  createDeFiVocabulary,

  // Metrics extraction
  extractDimensionMetrics,
  dimensionMetricsToExperience,

  // SEED adapter (persistence-protocol interoperability)
  toSEEDFormat,
  fromSEEDFormat,

  // Validation
  validateVocabulary,
} from './VocabularyExtension';

// ARIL - Adjoint-Replicator Identity Learning
// The backward pass across the session boundary
export {
  computeEnergyGradient,
  computeEnergyOnly,
  verifyGradient,
  type EnergyGradientResult,
} from './EnergyGradient';

export {
  OutcomeEvaluator,
  extractTestSignal,
  extractSessionArcSignal,
  isVerifyCommand,
  DEFAULT_OUTCOME_CONFIG,
  type SessionOutcome,
  type OutcomeSignal,
  type OutcomeEvaluatorState,
  type OutcomeEvaluatorConfig,
} from './OutcomeEvaluator';

export {
  computeShapleyAttribution,
  createCorrelationHistory,
  updateCorrelationHistory,
  DEFAULT_SHAPLEY_CONFIG,
  type DimensionAttribution,
  type AttributionResult,
  type CorrelationHistory,
  type ShapleyConfig,
} from './ShapleyAttributor';

export {
  createARILState,
  computeARILUpdate,
  applyARILUpdate,
  verifyReplicatorConservation,
  serializeARILState,
  deserializeARILState,
  DEFAULT_ARIL_CONFIG,
  type ARILConfig,
  type ARILState,
  type ARILUpdate,
  type SerializedARILState,
  type SignalSnapshot,
} from './ReplicatorOptimizer';

export {
  ConfidenceCalibrator,
  serializeCalibrationState,
  deserializeCalibrationState,
  DEFAULT_CALIBRATOR_CONFIG,
  type CalibrationState,
  type CalibrationRecord,
  type CalibratorConfig,
  type SerializedCalibrationState,
} from './ConfidenceCalibrator';

export {
  InsightCompiler,
  serializeCompilerState,
  DEFAULT_COMPILER_CONFIG,
  type CompiledPattern,
  type CompilerConfig,
  type SerializedCompilerState,
} from './InsightCompiler';

export {
  GuidanceEngine,
  DEFAULT_GUIDANCE_CONFIG,
  type BehavioralDirective,
  type GuidanceOutput,
  type GuidanceConfig,
} from './GuidanceEngine';

export {
  DomainTracker,
  serializeDomainProfile,
  deserializeDomainProfile,
  DEFAULT_DOMAIN_CONFIG,
  type DomainExposure,
  type Specialization,
  type DomainProfile,
  type DomainTrackerConfig,
  type SerializedDomainProfile,
} from './DomainTracker';

// Strategy Feature Extractor — v2 behavioral strategy metrics from tool-call sequences
export {
  extractStrategyFeatures,
  featuresToArray,
  arrayToFeatures,
  computeReadBeforeEdit,
  computeTestAfterChange,
  computeContextGathering,
  computeOutputVerification,
  computeErrorRecoverySpeed,
  normalizePath,
  extractFilePath,
  isTestCommand,
  DEFAULT_STRATEGY_FEATURE_CONFIG,
  STRATEGY_FEATURE_NAMES,
  type StrategyFeatures,
  type StrategyFeatureName,
  type StrategyFeatureConfig,
} from './StrategyFeatureExtractor';

// Strategy Renderer — v2 hybrid procedural+empirical output for .aril/strategies.md
export {
  renderStrategies,
  DEFAULT_RENDER_CONFIG,
  type StrategyRenderInput,
  type StrategyRenderConfig,
  type RenderedStrategy,
  type StrategyDocument,
  type InteractionTerm,
} from './StrategyRenderer';

// Mode Observer — Layer 3 read-only observer of ARIL dynamics
export {
  ModeObserver,
  computeAdaptiveBarrier,
  serializeObserverHistory,
  deserializeObserverHistory,
  DEFAULT_OBSERVER_CONFIG,
  type ModeObservation,
  type DimensionMode,
  type DimensionTunneling,
  type ModeObserverConfig,
  type ObserverHistory,
  type SerializedObserverHistory,
} from './ModeObserver';
