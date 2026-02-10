/**
 * UnifiedIdentity.ts
 *
 * The top-level integration layer for agent identity.
 *
 * This module provides a single entry point that orchestrates:
 * - BehavioralObserver: Tracking agent actions
 * - IdentityBridge: Mapping behavior to identity evolution
 * - IdentityPersistence: Saving/loading identity to storage
 *
 * Usage:
 * ```typescript
 * const identity = await UnifiedIdentity.create(storage);
 * await identity.initialize([0.5, 0.5, 0.5, 0.5]);
 *
 * // During interaction
 * identity.startObservation(interactionId);
 * identity.recordToolCall('Read', params, result, true, 100);
 * // ... more actions ...
 * const result = await identity.endObservation(interaction);
 *
 * // Auto-saves if significant changes occurred
 * ```
 */

import {
  BehavioralObserver,
  type ActionLog,
  type ToolCall,
} from './BehavioralObserver';

import {
  IdentityBridge,
  createIdentityBridge,
  type BridgeConfig,
  type BridgeResult,
  DEFAULT_BRIDGE_CONFIG,
} from './IdentityBridge';

import { computeEnergyGradient, type EnergyGradientResult } from './EnergyGradient';
import { OutcomeEvaluator, type SessionOutcome, type OutcomeEvaluatorState } from './OutcomeEvaluator';
import {
  computeShapleyAttribution,
  createCorrelationHistory,
  updateCorrelationHistory,
  type CorrelationHistory,
  type AttributionResult,
  type DimensionAttribution,
} from './ShapleyAttributor';
import {
  createARILState,
  computeARILUpdate,
  applyARILUpdate,
  serializeARILState,
  deserializeARILState,
  DEFAULT_ARIL_CONFIG,
  type ARILConfig,
  type ARILState,
  type ARILUpdate,
  type SerializedARILState,
} from './ReplicatorOptimizer';
import {
  ConfidenceCalibrator,
  serializeCalibrationState,
  deserializeCalibrationState,
  type SerializedCalibrationState,
} from './ConfidenceCalibrator';
import { InsightCompiler, serializeCompilerState, type CompiledPattern } from './InsightCompiler';
import { GuidanceEngine, type GuidanceOutput, type MobiusDiagnostics } from './GuidanceEngine';
import {
  DomainTracker,
  serializeDomainProfile,
  deserializeDomainProfile,
  type SerializedDomainProfile,
} from './DomainTracker';

import {
  ModeObserver,
  computeAdaptiveBarrier,
  serializeObserverHistory,
  deserializeObserverHistory,
  type ModeObservation,
  type SerializedObserverHistory,
} from './ModeObserver';

import {
  MobiusCharacteristic,
  computeBlend,
  blendShapley,
  popcount,
  DEFAULT_MOBIUS_CONFIG,
  type SerializedMobiusState,
} from './MobiusCharacteristic';

import {
  extractStrategyFeatures,
  featuresToArray,
  STRATEGY_FEATURE_NAMES,
  type StrategyFeatures,
} from './StrategyFeatureExtractor';
import type { InteractionTerm } from './StrategyRenderer';

import {
  IdentityPersistence,
  createIdentityPersistence,
  type StorageBackend,
  type PersistenceConfig,
  type LoadResult,
  type Intuition,
  DEFAULT_PERSISTENCE_CONFIG,
} from './IdentityPersistence';

import { type Interaction, type LLMInterface, type Insight } from './ReflectionEngine';
import { type StoredSelf, type SelfState, type Declaration } from './FixedPointSelf';

// Re-export PrivateStorageBackend and StoredInsight from bootstrap layer
// for consumers who don't want to import from bootstrap directly
export type {
  PrivateStorageBackend,
  StoredInsight,
} from '../bootstrap/PrivateStorage';

import type { PrivateStorageBackend, StoredInsight } from '../bootstrap/PrivateStorage';

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Configuration for the unified identity system.
 */
export interface UnifiedIdentityConfig {
  /** Bridge configuration */
  bridge: BridgeConfig;

  /** Persistence configuration */
  persistence: PersistenceConfig;

  /** Auto-save after interactions with new declarations */
  autoSaveOnDeclaration: boolean;

  /** Auto-save interval in milliseconds (0 = disabled) */
  autoSaveIntervalMs: number;

  /** Minimum weight change to trigger auto-save */
  minWeightChangeForSave: number;
}

export const DEFAULT_UNIFIED_CONFIG: UnifiedIdentityConfig = {
  bridge: DEFAULT_BRIDGE_CONFIG,
  persistence: DEFAULT_PERSISTENCE_CONFIG,
  autoSaveOnDeclaration: true,
  autoSaveIntervalMs: 60000, // 1 minute
  minWeightChangeForSave: 0.05,
};

// =============================================================================
// STATUS TYPES
// =============================================================================

/**
 * Current status of the unified identity system.
 */
export interface UnifiedIdentityStatus {
  /** Whether identity has been initialized */
  initialized: boolean;

  /** Whether storage is persistent */
  persistent: boolean;

  /** Current observation ID (if observing) */
  currentObservationId: string | null;

  /** Number of declarations made */
  declarationCount: number;

  /** Current identity weights */
  weights: number[];

  /** Current identity dimensions */
  dimensions: string[];

  /** Last save timestamp */
  lastSaveTime: number | null;

  /** Pending changes (not yet saved) */
  pendingChanges: boolean;
}

/**
 * Result of processing an observation.
 */
export interface ObservationResult {
  /** The bridge result with all evolution details */
  bridgeResult: BridgeResult;

  /** Whether auto-save was triggered */
  autoSaved: boolean;

  /** Warnings from the observation */
  warnings: string[];

  /** Hash of the ActionLog (if private storage is configured) */
  actionLogHash?: string | null;
}

// =============================================================================
// CONSOLIDATION TYPES (§8)
// =============================================================================

/**
 * §8.1: Snapshot of ARIL state at session end for consolidated initialization.
 */
export interface ConsolidationSnapshot {
  /** w[i] at session end */
  weights: number[];
  /** ARIL fitness f[i] at session end */
  fitness: number[];
  /** Session outcome R_total */
  outcome: number;
  /** Hessian diagonal from energy gradient (curvature info) */
  hessianDiag: number[];
  /** Per-dimension Shapley attributions δ[i] — for consistency-based learning rate scaling */
  attributions: number[];
  /** Expertise level at session end */
  expertise: number;
  /** Timestamp */
  timestamp: number;
}

/**
 * §8.2: Result of consolidated initialization across all ARIL dimensions.
 */
interface ConsolidatedInit {
  /** Softmax-weighted average of session-end weights */
  weights: Float64Array;
  /** Consolidated fitness: 0.8 · f_weighted + 0.2 · (1/N) */
  fitness: Float64Array;
  /** Consistency-based learning rate scaling per dimension */
  metaRateScaling: Float64Array;
}

// =============================================================================
// UNIFIED IDENTITY
// =============================================================================

/**
 * UnifiedIdentity: The single entry point for agent identity management.
 */
export class UnifiedIdentity {
  private readonly storage: StorageBackend;
  private readonly config: UnifiedIdentityConfig;
  private privateStorage: PrivateStorageBackend | null = null;
  private persistence: IdentityPersistence | null = null;
  private bridge: IdentityBridge | null = null;
  private observer: BehavioralObserver | null = null;
  private llm: LLMInterface | null = null;
  private currentObservationId: string | null = null;
  private lastSaveTime: number | null = null;
  private pendingChanges: boolean = false;
  private isSaving: boolean = false;
  private autoSaveTimer: ReturnType<typeof setInterval> | null = null;
  private latestActionLogHash: string | null = null;
  private loadedInsights: StoredInsight[] = [];

  // ARIL components
  private readonly arilConfig: ARILConfig = DEFAULT_ARIL_CONFIG;
  private arilState: ARILState | null = null;
  private outcomeEvaluator: OutcomeEvaluator | null = null;
  private correlationHistory: CorrelationHistory | null = null;
  private confidenceCalibrator: ConfidenceCalibrator | null = null;
  private insightCompiler: InsightCompiler | null = null;
  private guidanceEngine: GuidanceEngine | null = null;
  private domainTracker: DomainTracker | null = null;
  private modeObserver: ModeObserver | null = null;
  private lastObservation: ModeObservation | null = null;
  private consolidationSnapshots: ConsolidationSnapshot[] = [];
  private telemetryNoncePromise: Promise<string | null> | null = null;
  private mobiusCharacteristic: MobiusCharacteristic | null = null;
  private mobiusBaseline: number[] | null = null;
  private lastGuidance: GuidanceOutput | null = null;
  private pendingExtraSignals: import('./OutcomeEvaluator').OutcomeSignal[] = [];
  private pendingImportCache: ReadonlyMap<string, ReadonlySet<string>> | null = null;

  // Strategy ARIL sub-pipeline
  private static readonly STRATEGY_N = STRATEGY_FEATURE_NAMES.length; // 5
  private static readonly STRATEGY_EMA_ALPHA = 0.1;
  private static readonly STRATEGY_RUNNING_MEAN_INIT = 0.5;
  private strategyCorrelation: CorrelationHistory | null = null;
  private strategyMobius: MobiusCharacteristic | null = null;
  private strategyMobiusBaseline: number[] | null = null;
  private strategyFeatureRunningMean: Float64Array | null = null;
  private lastStrategyAttributions: DimensionAttribution[] | null = null;
  private lastStrategyInteractions: InteractionTerm[] | null = null;
  private lastStrategyFeatures: StrategyFeatures | null = null;

  private constructor(storage: StorageBackend, config: UnifiedIdentityConfig) {
    this.storage = storage;
    this.config = config;
  }

  /**
   * Create a new UnifiedIdentity instance.
   */
  static create(
    storage: StorageBackend,
    config: Partial<UnifiedIdentityConfig> = {}
  ): UnifiedIdentity {
    const fullConfig: UnifiedIdentityConfig = {
      ...DEFAULT_UNIFIED_CONFIG,
      ...config,
      bridge: { ...DEFAULT_UNIFIED_CONFIG.bridge, ...config.bridge },
      persistence: { ...DEFAULT_UNIFIED_CONFIG.persistence, ...config.persistence },
    };
    return new UnifiedIdentity(storage, fullConfig);
  }

  /**
   * Set the private storage backend for ActionLogs.
   * This stores the full behavioral data locally (trainable, private).
   * Only the hash goes on-chain (verifiable, public).
   */
  setPrivateStorage(privateStorage: PrivateStorageBackend): void {
    this.privateStorage = privateStorage;
    console.log('[UnifiedIdentity] Private storage configured for ActionLogs');
  }

  /**
   * Get the latest ActionLog hash (for verification).
   */
  getLatestActionLogHash(): string | null {
    return this.latestActionLogHash;
  }

  /**
   * Set the LLM interface for reflection and insight extraction.
   */
  setLLM(llm: LLMInterface | null): void {
    this.llm = llm;
    if (this.persistence) {
      this.persistence.setLLM(llm);
    }
  }

  /**
   * Initialize the identity system.
   *
   * Loads existing identity from storage or creates a new one.
   * Also loads accumulated insights from private storage for both:
   * - Intuition (semantic guidance via persistence layer)
   * - Raw insights (for getAccumulatedWisdom() detailed output)
   */
  async initialize(defaultWeights: number[]): Promise<LoadResult> {
    // Create persistence layer (now includes private storage for insight loading)
    this.persistence = createIdentityPersistence(
      this.storage,
      this.config.persistence,
      this.privateStorage || undefined
    );
    this.persistence.setLLM(this.llm);
    this.persistence.setBridgeConfig(this.config.bridge);

    // Load or create identity (also loads intuition from private storage)
    const result = await this.persistence.load(defaultWeights);
    this.bridge = result.bridge;

    // Also load raw insights for getAccumulatedWisdom() detailed output
    if (this.privateStorage) {
      try {
        this.loadedInsights = await this.privateStorage.getPivotalInsights();
        if (this.loadedInsights.length > 0) {
          console.log(
            `[UnifiedIdentity] Loaded ${this.loadedInsights.length} pivotal insight(s) for wisdom accumulation`
          );
        }
      } catch (err) {
        console.warn('[UnifiedIdentity] Failed to load insights from private storage:', err);
        this.loadedInsights = [];
      }
    }

    // Initialize ARIL components
    const n = this.bridge?.getState()?.dimension ?? 4;
    this.arilState = createARILState(n);
    this.outcomeEvaluator = new OutcomeEvaluator();
    this.correlationHistory = createCorrelationHistory(n);
    this.confidenceCalibrator = new ConfidenceCalibrator();
    this.insightCompiler = new InsightCompiler();
    this.guidanceEngine = new GuidanceEngine();
    this.domainTracker = new DomainTracker();
    this.modeObserver = new ModeObserver();
    this.mobiusCharacteristic = new MobiusCharacteristic(n);

    // Strategy sub-pipeline (independent of personality dimensions)
    const sN = UnifiedIdentity.STRATEGY_N;
    this.strategyCorrelation = createCorrelationHistory(sN);
    this.strategyMobius = new MobiusCharacteristic(sN);
    this.strategyMobiusBaseline = new Array(sN).fill(0);
    this.strategyFeatureRunningMean = new Float64Array(sN).fill(UnifiedIdentity.STRATEGY_RUNNING_MEAN_INIT);

    // Load persisted ARIL state if available
    if (this.privateStorage) {
      try {
        await this.loadARILState();
      } catch (err) {
        console.warn('[UnifiedIdentity] Failed to load ARIL state:', err);
      }
    }

    // §8.2: Apply consolidated initialization from snapshots
    if (this.consolidationSnapshots.length > 0 && this.bridge) {
      const consolidated = this.computeConsolidatedInit();
      if (consolidated) {
        // Apply consolidated weights to bridge
        this.bridge.setState(consolidated.weights);

        // Apply consolidated fitness to ARIL state
        if (this.arilState) {
          for (let i = 0; i < Math.min(consolidated.fitness.length, this.arilState.fitness.length); i++) {
            this.arilState.fitness[i] = consolidated.fitness[i];
          }

          // Apply consistency-based meta-learning rate scaling (assignment, not multiplication)
          // Each consolidation cycle resets rates from the current window's consistency signal.
          // Multiplicative application would be one-directional (scaling ∈ [1.0, 1.5])
          // and would push all rates to maxMetaRate over enough save/load cycles.
          for (let i = 0; i < Math.min(consolidated.metaRateScaling.length, this.arilState.metaLearningRates.length); i++) {
            this.arilState.metaLearningRates[i] = consolidated.metaRateScaling[i];
            // Clamp to valid range (metaRateScaling ∈ [1.0, 1.5], already within [0.5, 2.0])
            this.arilState.metaLearningRates[i] = Math.max(
              this.arilConfig.minMetaRate,
              Math.min(this.arilConfig.maxMetaRate, this.arilState.metaLearningRates[i])
            );
          }
        }

        console.log(
          `[UnifiedIdentity] Applied consolidated init from ${this.consolidationSnapshots.length} snapshot(s)`
        );
      }
    }

    // Store Möbius baseline (start-of-session weights for counterfactual)
    if (this.bridge) {
      this.mobiusBaseline = Array.from(this.bridge.getState().w);
    }

    // Start auto-save timer if configured
    if (this.config.autoSaveIntervalMs > 0) {
      this.startAutoSaveTimer();
    }

    const intuitionSummary = result.intuition
      ? ` with ${result.intuition.insightCount} insight(s) → intuition`
      : '';
    console.log(
      `[UnifiedIdentity] Initialized: ${result.isNew ? 'new identity' : 'restored from storage'}${intuitionSummary}`
    );

    return result;
  }

  /**
   * Start observing an interaction.
   *
   * Call this at the beginning of each user interaction.
   */
  startObservation(interactionId: string): void {
    if (!this.bridge) {
      throw new Error('Identity not initialized. Call initialize() first.');
    }

    if (this.currentObservationId !== null) {
      console.warn(
        `[UnifiedIdentity] Previous observation ${this.currentObservationId} was not ended. Starting new observation.`
      );
    }

    this.observer = new BehavioralObserver();
    this.observer.startObservation(interactionId);
    this.currentObservationId = interactionId;

    // Network telemetry — start ping (fetches nonce for end ping PoW)
    this.telemetryNoncePromise = this.fetchTelemetryNonce();
  }

  /**
   * Record a tool call during observation.
   */
  recordToolCall(
    toolName: string,
    params: Record<string, unknown>,
    result: string,
    success: boolean,
    durationMs: number,
    wasRequired: boolean = true,
    context: string = ''
  ): void {
    if (!this.observer) {
      console.warn('[UnifiedIdentity] No active observation. Call startObservation() first.');
      return;
    }

    this.observer.recordToolCall(
      toolName,
      params,
      result,
      success,
      durationMs,
      wasRequired,
      context
    );
  }

  /**
   * Record an information seek during observation.
   */
  recordInformationSeek(
    question: string,
    source: 'user' | 'tool' | 'memory' | 'inference',
    wasRequired: boolean = true,
    depthLevel: number = 1,
    foundAnswer: boolean = true
  ): void {
    if (!this.observer) {
      console.warn('[UnifiedIdentity] No active observation. Call startObservation() first.');
      return;
    }

    this.observer.recordInformationSeek(
      question,
      source,
      wasRequired,
      depthLevel,
      foundAnswer
    );
  }

  /**
   * Record a decision during observation.
   */
  recordDecision(
    context: string,
    options: string[],
    chosen: string,
    reasoning: string,
    confidence: number,
    hadUncertainty: boolean = false,
    askedForClarification: boolean = false
  ): void {
    if (!this.observer) {
      console.warn('[UnifiedIdentity] No active observation. Call startObservation() first.');
      return;
    }

    this.observer.recordDecision(
      context,
      options,
      chosen,
      reasoning,
      confidence,
      hadUncertainty,
      askedForClarification
    );
  }

  /**
   * Record a failure during observation.
   */
  recordFailure(
    what: string,
    severity: 'minor' | 'moderate' | 'major',
    response: 'retry' | 'fallback' | 'abort' | 'ask' | 'ignore',
    recovery: string,
    retryCount: number = 0,
    eventualSuccess: boolean = false
  ): void {
    if (!this.observer) {
      console.warn('[UnifiedIdentity] No active observation. Call startObservation() first.');
      return;
    }

    this.observer.recordFailure(
      what,
      severity,
      response,
      recovery,
      retryCount,
      eventualSuccess
    );
  }

  /**
   * Record a verification during observation.
   */
  recordVerification(
    what: string,
    method: 'tool' | 'reasoning' | 'user' | 'cross-reference',
    result: 'confirmed' | 'refuted' | 'uncertain',
    wasRequired: boolean = true
  ): void {
    if (!this.observer) {
      console.warn('[UnifiedIdentity] No active observation. Call startObservation() first.');
      return;
    }

    this.observer.recordVerification(what, method, result, wasRequired);
  }

  /**
   * End the current observation and process it through identity evolution.
   *
   * This method:
   * 1. Captures the full ActionLog (behavioral data)
   * 2. Stores ActionLog privately (if private storage configured)
   * 3. Processes through identity bridge (updates weights)
   * 4. Saves identity state on-chain (includes ActionLog hash)
   */
  async endObservation(interaction: Interaction): Promise<ObservationResult> {
    if (!this.bridge) {
      throw new Error('Identity not initialized. Call initialize() first.');
    }

    if (!this.observer) {
      throw new Error('No active observation. Call startObservation() first.');
    }

    const warnings: string[] = [];

    // End observation and get action log
    const actionLog = this.observer.endObservation();
    this.currentObservationId = null;
    this.observer = null;

    // Snapshot pre-bridge weights BEFORE processInteraction mutates internal state.
    // processInteraction() sets this.state = stateAfterDeclarations then returns
    // newState: this.state — same reference. Without this snapshot, any before/after
    // comparison (Shapley, Möbius) would compare the object to itself → always zero.
    const preBridgeWeights = new Float64Array(this.bridge.getState().w);

    // Process through bridge FIRST to get insights
    const bridgeResult = await this.bridge.processInteraction(interaction, actionLog);

    // Store ActionLog to private storage WITH insights (if configured)
    let actionLogHash: string | null = null;
    if (this.privateStorage) {
      try {
        const metadata = {
          interactionId: interaction.id,
          prompt: interaction.prompt?.slice(0, 100), // First 100 chars only
          hasPivotalInsights: bridgeResult.insights.some(i => i.isPivotal),
        };

        // Use the insights-aware method if available
        if (this.privateStorage.storeActionLogWithInsights && bridgeResult.insights.length > 0) {
          actionLogHash = await this.privateStorage.storeActionLogWithInsights(
            actionLog,
            bridgeResult.insights,
            metadata
          );
        } else {
          actionLogHash = await this.privateStorage.storeActionLog(actionLog, metadata);
        }

        this.latestActionLogHash = actionLogHash;
        this.bridge!.setLatestActionLogHash(actionLogHash);
        const insightSummary = bridgeResult.insights.length > 0
          ? ` with ${bridgeResult.insights.length} insight(s)`
          : '';
        console.log(`[UnifiedIdentity] ActionLog stored privately${insightSummary}: ${actionLogHash.slice(0, 12)}...`);
      } catch (err) {
        warnings.push(`Failed to store ActionLog: ${err}`);
        console.error('[UnifiedIdentity] Private storage error:', err);
      }
    }

    // === ARIL BACKWARD PASS ===
    // This is THE KEY INNOVATION: gradient-based optimization across the session boundary
    let arilUpdate: ARILUpdate | null = null;
    if (this.arilState && this.outcomeEvaluator && this.bridge) {
      try {
        // 1. Evaluate session outcome → R
        const extraSignals = this.pendingExtraSignals.length > 0 ? this.pendingExtraSignals : undefined;
        this.pendingExtraSignals = []; // Consume
        const outcome = this.outcomeEvaluator.evaluate(bridgeResult, actionLog, extraSignals);

        // 1.1. Phase 1 capture: signals + pre-gradient state (before computeARILUpdate mutates)
        // weightsSessionStart = preBridgeWeights (captured at line 639, before PDE evolution)
        // weightsBefore = post-PDE, pre-ARIL state (bridge.getState().w has been mutated by processInteraction)
        const auditSnapshot: import('./ReplicatorOptimizer').SignalSnapshot = {
          sessionIndex: this.arilState.sessionCount,
          timestamp: Date.now(),
          R: outcome.R,
          R_adj: outcome.R_adj,
          signals: outcome.signals.map(s => ({ source: s.source, value: s.value, weight: s.weight })),
          weightsSessionStart: Array.from(preBridgeWeights),
          weightsBefore: Array.from(this.bridge!.getState().w),
          metaLearningRates: Array.from(this.arilState.metaLearningRates),
        };
        this.arilState.signalHistory.push(auditSnapshot);
        if (this.arilState.signalHistory.length > 20) {
          this.arilState.signalHistory.shift();
        }

        // 2. Compute energy gradient ∂E/∂w
        const state = this.bridge.getState();
        const params = this.bridge.getParams();
        const vocabulary = this.bridge.getVocabulary();
        const energyGrad = computeEnergyGradient(state, params, vocabulary);

        // 3. Compute weight changes for Shapley attribution
        //    Uses preBridgeWeights snapshot (captured before processInteraction mutated state)
        const n = state.dimension;
        const weightChanges = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          weightChanges[i] = bridgeResult.newState.w[i] - preBridgeWeights[i];
        }

        // 4. Shapley attribution → δ[i]
        const attribution = computeShapleyAttribution(
          outcome.R,
          weightChanges,
          vocabulary.assertions,
          this.correlationHistory,
          { numPermutations: 50, seed: null }
        );

        // 5. Update correlation history
        if (this.correlationHistory) {
          const absChanges = new Float64Array(n);
          for (let i = 0; i < n; i++) absChanges[i] = Math.abs(weightChanges[i]);
          updateCorrelationHistory(this.correlationHistory, absChanges, outcome.R);
        }

        // 5.5: Collect Möbius observation + blend attribution (§3)
        let mobiusBlendAlpha: number | undefined;
        let mobiusSumV: number | undefined;
        if (this.mobiusCharacteristic && this.arilState) {
          const baseline = this.mobiusBaseline ?? new Array(n).fill(0.5);

          this.mobiusCharacteristic.addObservation(
            Array.from(preBridgeWeights),
            baseline,
            outcome.R,
            this.arilState.sessionCount
          );

          this.mobiusCharacteristic.updateCoefficients();

          // Blend with Möbius Shapley if sufficient observations
          const obsCount = this.mobiusCharacteristic.getState().observations.length;
          const blend = computeBlend(obsCount, DEFAULT_MOBIUS_CONFIG.minObservations);
          mobiusBlendAlpha = blend;

          if (blend > 0) {
            const mobiusShapley = this.mobiusCharacteristic.computeShapley();
            if (mobiusShapley.length === n) {
              // Capture v_learned(N) - v_learned(∅) for audit trail algebraic invariant
              const fullMask = (1 << n) - 1;
              mobiusSumV = this.mobiusCharacteristic.evaluate(fullMask)
                         - this.mobiusCharacteristic.evaluate(0);

              const additiveShapley = attribution.attributions.map(a => a.shapleyValue);
              const blended = blendShapley(additiveShapley, mobiusShapley, blend);
              for (let i = 0; i < attribution.attributions.length; i++) {
                attribution.attributions[i].shapleyValue = blended[i];
              }
            }
          }
        }

        // 6. Compute ARIL update Δw
        arilUpdate = computeARILUpdate(
          state.w,
          energyGrad,
          outcome.R_adj,
          outcome.R,  // R_raw: absolute quality for fitness EMA (not baseline-subtracted)
          attribution.attributions,
          this.arilState,
          this.arilConfig
        );

        // 7. Apply Δw (between-session discrete optimization)
        const newWeights = applyARILUpdate(state.w, arilUpdate, this.arilConfig);
        this.bridge.setState(newWeights);

        // 7.05. Phase 2 enrichment: backward pass data into audit snapshot
        auditSnapshot.weightsAfter = Array.from(newWeights);
        auditSnapshot.deltaW = Array.from(arilUpdate.deltaW);
        auditSnapshot.gradients = {
          energy: Array.from(arilUpdate.components.energyGrad),
          outcome: Array.from(arilUpdate.components.outcomeGrad),
          replicator: Array.from(arilUpdate.components.replicatorGrad),
        };
        auditSnapshot.attributions = attribution.attributions.map(a => a.shapleyValue);
        auditSnapshot.fitness = Array.from(this.arilState.fitness);
        if (mobiusBlendAlpha !== undefined) auditSnapshot.blendAlpha = mobiusBlendAlpha;
        if (mobiusSumV !== undefined) auditSnapshot.mobiusV = mobiusSumV;

        // 7.1. Update Möbius baseline for next session
        this.mobiusBaseline = Array.from(newWeights);

        // 7.5. Mode Observer — read-only observation (same config as optimizer)
        if (this.modeObserver) {
          this.lastObservation = this.modeObserver.observe(
            state, params, vocabulary, energyGrad,
            this.arilState!, this.arilConfig,
            outcome.R_adj, attribution.attributions
          );
        }

        // 8. Compile insights with ARIL gating
        if (this.insightCompiler && bridgeResult.insights.length > 0) {
          this.insightCompiler.compile(
            bridgeResult.insights,
            this.arilState.fitness,
            attribution.attributions
          );
          this.insightCompiler.decay(this.arilState.fitness, vocabulary.assertions);
        }

        // 9. Update domain tracker WITH curvature (§5)
        if (this.domainTracker) {
          const insightDims = bridgeResult.insights.map(i => i.dimension);
          this.domainTracker.updateWithCurvature(
            actionLog, outcome.R, energyGrad.hessianDiag, insightDims
          );

          // 9.1. Feed import-based domain signals (from TrajectoryEvaluator)
          if (this.pendingImportCache && this.pendingImportCache.size > 0) {
            this.domainTracker.updateFromImports(this.pendingImportCache, outcome.R);
            this.pendingImportCache = null;
          }
        }

        // 10. Calibrate confidence
        if (this.confidenceCalibrator && bridgeResult.insights.length > 0) {
          const dimOutcomes = new Map<string, number>();
          for (const attr of attribution.attributions) {
            // Map Shapley value to [0,1] for calibration
            dimOutcomes.set(attr.dimension, (attr.shapleyValue + 1) / 2);
          }
          this.confidenceCalibrator.calibrate(bridgeResult.insights, dimOutcomes);
        }

        // 10.5. Apply adaptive barrier (§6)
        if (this.domainTracker && this.bridge) {
          const expertise = this.domainTracker.getExpertise();
          const adaptiveA = computeAdaptiveBarrier(expertise);
          this.bridge.updateParams({ a: adaptiveA });
        }

        // 10.6. Store consolidation snapshot (§8.1)
        const snapshotAttributions = new Array(n).fill(0);
        for (const attr of attribution.attributions) {
          if (attr.index >= 0 && attr.index < n) {
            snapshotAttributions[attr.index] = attr.shapleyValue;
          }
        }
        const snapshot: ConsolidationSnapshot = {
          weights: Array.from(newWeights),
          fitness: Array.from(this.arilState.fitness),
          outcome: outcome.R,
          hessianDiag: Array.from(energyGrad.hessianDiag),
          attributions: snapshotAttributions,
          expertise: this.domainTracker?.getExpertise() ?? 0,
          timestamp: Date.now(),
        };
        this.consolidationSnapshots.push(snapshot);
        if (this.consolidationSnapshots.length > 5) {
          this.consolidationSnapshots.shift();
        }

        // === STRATEGY ARIL: Real Shapley for behavioral features ===
        if (this.strategyCorrelation && this.strategyMobius) {
          try {
            // S1. Extract features from this session's tool calls
            const stratFeatures = extractStrategyFeatures(actionLog);
            this.lastStrategyFeatures = stratFeatures;
            const featureValues = featuresToArray(stratFeatures);

            // S2. Deviations from running mean → "what was different this session?"
            const sN = UnifiedIdentity.STRATEGY_N;
            const deviations = new Float64Array(sN);
            for (let i = 0; i < sN; i++) {
              deviations[i] = featureValues[i] - (this.strategyFeatureRunningMean?.[i] ?? UnifiedIdentity.STRATEGY_RUNNING_MEAN_INIT);
            }

            // S3. Update correlation history with signed deviations BEFORE Shapley
            // (so attribution reflects all available data including current session)
            updateCorrelationHistory(this.strategyCorrelation, deviations, outcome.R);

            // S4. Shapley attribution (exact: 2^N coalitions)
            const stratAttr = computeShapleyAttribution(
              outcome.R, deviations,
              [...STRATEGY_FEATURE_NAMES],
              this.strategyCorrelation,
            );

            // S5. Möbius observation + coefficient update
            //
            // DESIGN NOTE — Dual input semantics (pragmatic tradeoff):
            // Additive Shapley (S4) operates on DEVIATIONS from running mean,
            // answering: "which behavioral *changes* predicted R this session?"
            // Möbius (S5) operates on RAW feature values because addObservation()
            // requires actual values + baseline for its activation mask.
            //
            // The blend (S6) mixes these two different questions. This is a
            // pragmatic tradeoff, not an intentional design: Shapley needs
            // deviations for causal correctness; Möbius needs raw values for
            // its interface. During the blend transition (0 < sBlend < 1),
            // attributions are a weighted mix of deviation-based and level-based
            // Shapley values, which could produce counterintuitive results.
            const stratBaseline = this.strategyMobiusBaseline ?? new Array(sN).fill(0);
            this.strategyMobius.addObservation(
              featureValues, stratBaseline, outcome.R,
              this.arilState!.sessionCount,
            );
            this.strategyMobius.updateCoefficients();

            // S6. Blend additive (deviation-based) with Möbius (level-based) Shapley
            const sObsCount = this.strategyMobius.getState().observations.length;
            const sBlend = computeBlend(sObsCount, DEFAULT_MOBIUS_CONFIG.minObservations);
            let finalAttrs = stratAttr.attributions;
            let stratInteractions: InteractionTerm[] = [];

            if (sBlend > 0) {
              const mShapley = this.strategyMobius.computeShapley();
              if (mShapley.length === sN) {
                const additive = finalAttrs.map(a => a.shapleyValue);
                const blended = blendShapley(additive, mShapley, sBlend);
                finalAttrs = finalAttrs.map((a, i) => ({ ...a, shapleyValue: blended[i] }));
              }
              stratInteractions = extractInteractionsFromMobius(this.strategyMobius);
            }

            // S7. Per-feature confidence via t-statistic on correlation with R
            const sc = this.strategyCorrelation;
            const sCount = sc.sessionCount;
            finalAttrs = finalAttrs.map((a, i) => {
              if (sCount < 3) {
                return { ...a, confidence: 0 };
              }
              const r = sc.correlations[i];
              const r2 = r * r;
              if (r2 >= 1.0) {
                return { ...a, confidence: 1.0 };
              }
              const t = Math.abs(r) * Math.sqrt(sCount - 2) / Math.sqrt(1 - r2);
              return { ...a, confidence: Math.min(t / 2.0, 1.0) };
            });

            this.lastStrategyAttributions = finalAttrs;
            this.lastStrategyInteractions = stratInteractions;

            // S8. Update running mean (EMA)
            if (this.strategyFeatureRunningMean) {
              const alpha = UnifiedIdentity.STRATEGY_EMA_ALPHA;
              for (let i = 0; i < sN; i++) {
                this.strategyFeatureRunningMean[i] =
                  (1 - alpha) * this.strategyFeatureRunningMean[i] + alpha * featureValues[i];
              }
            }

            // S9. Update baseline for next Möbius observation
            this.strategyMobiusBaseline = Array.from(featureValues);

            const stratAttrSummary = finalAttrs.map(a => `${a.dimension}:${a.shapleyValue.toFixed(4)}`);
            console.log(`[UnifiedIdentity] Strategy attribution: ${stratAttrSummary.join(', ')}`);
          } catch (stratErr) {
            console.warn('[UnifiedIdentity] Strategy attribution error:', stratErr);
          }
        }

        // 11. Save ARIL state
        if (this.privateStorage) {
          try {
            await this.saveARILState();
          } catch (err) {
            warnings.push(`Failed to save ARIL state: ${err}`);
          }
        }

        console.log(
          `[UnifiedIdentity] ARIL backward pass: R=${outcome.R.toFixed(3)}, ` +
          `R_adj=${outcome.R_adj.toFixed(3)}, max|Δw|=${maxAbsFloat64(arilUpdate.deltaW).toFixed(4)}`
        );

        // Diagnostic: surface actual weight changes and attributions for verification
        const wcArr = Array.from(weightChanges).map(v => v.toFixed(6));
        const attrArr = attribution.attributions.map(a => `${a.dimension}:${a.shapleyValue.toFixed(4)}`);
        console.log(`[UnifiedIdentity] weightChanges=[${wcArr}] attributions=[${attrArr}]`);
      } catch (err) {
        warnings.push(`ARIL backward pass failed: ${err}`);
        console.warn('[UnifiedIdentity] ARIL error:', err);
      }
    }

    // Check for auto-save conditions
    let autoSaved = false;
    if (
      this.config.autoSaveOnDeclaration &&
      bridgeResult.declarations.length > 0
    ) {
      await this.save();
      autoSaved = true;
    } else if (bridgeResult.identityChanged || arilUpdate !== null) {
      this.pendingChanges = true;
    }

    // Network telemetry — end ping with nonce + proof-of-work
    const telemetryFitness = this.arilState
      ? Array.from(this.arilState.fitness).reduce((a, b) => a + b, 0) / this.arilState.fitness.length
      : 0;
    const telemetryCD = this.lastObservation?.consolidationDelta ?? 0;
    this.completeTelemetry({
      v: 1,
      s: this.arilState?.sessionCount ?? 0,
      f: telemetryFitness,
      cd: telemetryCD,
      e: warnings.length,
    });

    return {
      bridgeResult,
      autoSaved,
      warnings,
      actionLogHash,  // Include hash in result
    };
  }

  /**
   * Save the current identity to storage.
   */
  async save(): Promise<boolean> {
    if (!this.persistence) {
      console.warn('[UnifiedIdentity] Not initialized. Cannot save.');
      return false;
    }

    if (this.isSaving) {
      console.warn('[UnifiedIdentity] Save already in progress, skipping.');
      return false;
    }

    this.isSaving = true;
    try {
      const saved = await this.persistence.save();
      if (saved) {
        this.lastSaveTime = Date.now();
        this.pendingChanges = false;
      }
      return saved;
    } finally {
      this.isSaving = false;
    }
  }

  /**
   * Get the current status of the identity system.
   */
  getStatus(): UnifiedIdentityStatus {
    const state = this.bridge?.getState();
    const vocabulary = this.bridge?.getVocabulary();

    return {
      initialized: this.bridge !== null,
      persistent: this.storage.isPersistent(),
      currentObservationId: this.currentObservationId,
      declarationCount: this.bridge?.getDeclarations().length ?? 0,
      weights: state ? Array.from(state.w) : [],
      dimensions: vocabulary?.assertions ? [...vocabulary.assertions] : [],
      lastSaveTime: this.lastSaveTime,
      pendingChanges: this.pendingChanges,
    };
  }

  /**
   * Get the current identity state.
   */
  getState(): SelfState | null {
    return this.bridge?.getState() ?? null;
  }

  /**
   * Get current identity weights (defensive copy).
   * Returns a new Float64Array — callers can modify it without corrupting bridge state.
   */
  getWeights(): Float64Array {
    const state = this.bridge?.getState();
    return state ? Float64Array.from(state.w) : new Float64Array(0);
  }

  /**
   * Get current identity momentum (defensive copy).
   * Returns a new Float64Array — callers can modify it without corrupting bridge state.
   */
  getMomentum(): Float64Array {
    const state = this.bridge?.getState();
    return state ? Float64Array.from(state.m) : new Float64Array(0);
  }

  /**
   * Get total ARIL session count (number of backward passes completed).
   */
  getSessionCount(): number {
    return this.arilState?.sessionCount ?? 0;
  }

  /**
   * Set extra signals to include in the next OutcomeEvaluator.evaluate() call.
   * Used for cross-session signals like git_survived that come from external
   * verification rather than within-session data.
   *
   * Signals are consumed (cleared) after endObservation().
   */
  setExtraSignals(signals: import('./OutcomeEvaluator').OutcomeSignal[]): void {
    this.pendingExtraSignals = signals;
  }

  /**
   * Set raw import specifiers from edited files for domain classification.
   * Called by hook before endObservation(). Import data is consumed (cleared)
   * after endObservation().
   */
  setImportCache(importCache: ReadonlyMap<string, ReadonlySet<string>>): void {
    this.pendingImportCache = importCache;
  }

  /** Set telemetry endpoint URL from CLI config file.
   *  Env vars are NOT accepted — only explicit config-file opt-in (RT2-2). */
  setTelemetryUrl(url: string): void {
    this.telemetryUrl = url;
  }

  /**
   * Get the current domain profile (defensive copy).
   * Returns null if identity is not initialized.
   */
  getDomainProfile(): import('./DomainTracker').DomainProfile | null {
    return this.domainTracker?.getProfile() ?? null;
  }

  getStrategyAttributions(): DimensionAttribution[] | null {
    return this.lastStrategyAttributions;
  }

  getStrategyInteractions(): InteractionTerm[] | null {
    return this.lastStrategyInteractions;
  }

  getStrategyFeatures(): StrategyFeatures | null {
    return this.lastStrategyFeatures;
  }

  getStrategySessionCount(): number {
    return this.strategyCorrelation?.sessionCount ?? 0;
  }

  /**
   * Get all declarations.
   */
  getDeclarations(): readonly Declaration[] {
    return this.bridge?.getDeclarations() ?? [];
  }

  /**
   * Export the current identity for backup or migration.
   */
  export(): StoredSelf | null {
    return this.bridge?.export() ?? null;
  }

  /**
   * Get accumulated wisdom from past pivotal insights.
   *
   * This returns insights loaded from private storage that can be used to:
   * - Guide the agent's behavior based on past experience
   * - Provide context for LLM prompts
   * - Track identity evolution over time
   *
   * Returns both raw insights and pre-formatted outputs for convenience.
   */
  getAccumulatedWisdom(): {
    insights: StoredInsight[];
    summary: string;
    contextPrompt: string;
  } {
    if (this.loadedInsights.length === 0) {
      return {
        insights: [],
        summary: 'No accumulated wisdom yet.',
        contextPrompt: '',
      };
    }

    // Group insights by dimension
    const byDimension = new Map<string, StoredInsight[]>();
    for (const si of this.loadedInsights) {
      const dim = si.insight.dimension;
      if (!byDimension.has(dim)) {
        byDimension.set(dim, []);
      }
      byDimension.get(dim)!.push(si);
    }

    // Build summary
    const summaryLines: string[] = [];
    for (const [dim, insights] of byDimension) {
      const avgConfidence = insights.reduce((sum, i) => sum + i.insight.confidence, 0) / insights.length;
      summaryLines.push(
        `- ${dim}: ${insights.length} insight(s), avg confidence ${(avgConfidence * 100).toFixed(0)}%`
      );
    }

    // Build context prompt for LLM
    const contextLines: string[] = [
      'From past experience, I have learned:',
    ];
    for (const si of this.loadedInsights.slice(-10)) { // Last 10 insights
      contextLines.push(`- ${si.insight.observation} (${si.insight.dimension})`);
    }

    return {
      insights: this.loadedInsights,
      summary: `Accumulated ${this.loadedInsights.length} pivotal insight(s):\n${summaryLines.join('\n')}`,
      contextPrompt: contextLines.join('\n'),
    };
  }

  /**
   * Get the semantic intuition derived from pivotal insights.
   *
   * This is a more processed form of wisdom that provides:
   * - contextGuidance: Human-readable guidance text
   * - dimensionLessons: Lessons organized by identity dimension
   * - pivotalPatterns: Key patterns identified across experiences
   *
   * The intuition is loaded automatically during initialize() from private storage.
   */
  getIntuition(): Intuition | null {
    return this.persistence?.getIntuition() ?? null;
  }

  /**
   * Shutdown the identity system gracefully.
   */
  async shutdown(): Promise<void> {
    // Stop auto-save timer
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }

    // Save any pending changes
    if (this.pendingChanges) {
      await this.save();
    }

    console.log('[UnifiedIdentity] Shutdown complete');
  }

  /**
   * Get the latest ARIL guidance output.
   * Generates fresh guidance from current ARIL state.
   */
  getARILGuidance(): GuidanceOutput | null {
    if (!this.guidanceEngine || !this.arilState || !this.bridge) {
      return this.lastGuidance;
    }

    const state = this.bridge.getState();
    const params = this.bridge.getParams();
    const vocabulary = this.bridge.getVocabulary();
    const patterns = this.insightCompiler?.getPatterns() ?? [];
    const specializations = this.domainTracker?.getSpecializations() ?? [];

    let energyGrad: EnergyGradientResult | null = null;
    try {
      energyGrad = computeEnergyGradient(state, params, vocabulary);
    } catch {
      // Non-critical
    }

    // Compute Möbius diagnostics if available
    let mobiusDiag: MobiusDiagnostics | null = null;
    if (this.mobiusCharacteristic) {
      const mState = this.mobiusCharacteristic.getState();
      mobiusDiag = {
        interactionCount: this.mobiusCharacteristic.interactionCount(),
        fitResidual: mState.fitResidual,
        observationCount: mState.observations.length,
        currentOrder: mState.currentOrder,
        strongestInteraction: this.mobiusCharacteristic.strongestInteraction(),
        dataAdequate: mState.observations.length >= DEFAULT_MOBIUS_CONFIG.minObservations,
      };
    }

    this.lastGuidance = this.guidanceEngine.generate(
      this.arilState.fitness,
      vocabulary.assertions,
      state.w,
      patterns,
      energyGrad,
      this.confidenceCalibrator,
      specializations,
      this.arilState.sessionCount,
      this.lastObservation,
      mobiusDiag
    );

    return this.lastGuidance;
  }

  /**
   * Get ARIL fitness scores per dimension.
   */
  getARILFitness(): Float64Array | null {
    return this.arilState?.fitness ?? null;
  }

  /**
   * Get ARIL session count.
   */
  getARILSessionCount(): number {
    return this.arilState?.sessionCount ?? 0;
  }

  /**
   * Get ARIL meta-learning rates per dimension.
   */
  getARILMetaLearningRates(): Float64Array | null {
    return this.arilState?.metaLearningRates ?? null;
  }

  /**
   * Get per-session signal decomposition history (last 20 sessions).
   * Returns a shallow copy — mutations do not affect internal state.
   */
  getSignalHistory(): readonly import('./ReplicatorOptimizer').SignalSnapshot[] {
    return this.arilState ? [...this.arilState.signalHistory] : [];
  }

  /**
   * Get compiled patterns from the InsightCompiler.
   */
  getCompiledPatterns(): CompiledPattern[] {
    return this.insightCompiler?.getPatterns() ?? [];
  }

  // =============================================================================
  // PRIVATE METHODS
  // =============================================================================

  /** Telemetry endpoint URL. Default null (disabled).
   *  Set via setTelemetryUrl() from CLI config — env vars are NOT accepted
   *  because any parent process can set them (RT audit finding RT2-2). */
  private telemetryUrl: string | null = null;

  /**
   * Phase 1: Send start ping and fetch a nonce from the server.
   * Called at observation start; the nonce is awaited later when the end ping fires.
   * Never blocks the caller (returns a promise stored on the instance).
   */
  private async fetchTelemetryNonce(): Promise<string | null> {
    const url = this.telemetryUrl;
    if (!url) return null;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ t: 'start', v: 1 }),
      });
      const data = (await res.json()) as Record<string, unknown>;
      return typeof data.n === 'string' ? data.n : null;
    } catch {
      return null;
    }
  }

  /**
   * Phase 2: Compute proof-of-work and send end ping with nonce.
   * Fire-and-forget — never blocks, never throws.
   *
   * PoW: find a string where SHA256(nonce + string) has 16 leading zero bits.
   * This takes ~65K hashes (~10-50ms in Node.js) — negligible for a real agent
   * that just finished a multi-minute session, but forces attackers to burn
   * real CPU per fake data point.
   */
  private completeTelemetry(payload: Record<string, unknown>): void {
    const url = this.telemetryUrl;
    if (!url || !this.telemetryNoncePromise) return;

    const noncePromise = this.telemetryNoncePromise;
    this.telemetryNoncePromise = null;

    // Fire and forget — async IIFE that never throws
    (async () => {
      try {
        const nonce = await noncePromise;
        if (!nonce) return;

        const pow = this.computePoW(nonce);
        if (!pow) return;

        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, t: 'end', n: nonce, pow }),
        });
      } catch {
        // Silent — telemetry must never interfere with agent work
      }
    })();
  }

  /**
   * Compute proof-of-work: find pow where SHA256(nonce + pow) has 16 leading zero bits.
   * Uses a counter instead of randomBytes — SHA256 is a random oracle, so sequential
   * inputs produce independent outputs. Avoids ~65K CSPRNG allocations (~5x faster).
   * Safety cap at 2M iterations to prevent theoretical infinite loops.
   */
  private computePoW(nonce: string): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const crypto = require('crypto') as typeof import('crypto');
      for (let i = 0; i < 2_000_000; i++) {
        const attempt = i.toString(16);
        const hash = crypto.createHash('sha256').update(nonce + attempt).digest();
        // 16 leading zero bits = first 2 bytes are 0x00
        if (hash[0] === 0 && hash[1] === 0) return attempt;
      }
    } catch {
      // crypto unavailable — skip telemetry silently
    }
    return null;
  }

  /** Serialized ARIL state key for private storage. */
  private static readonly ARIL_STATE_KEY = 'aril_state';

  private async saveARILState(): Promise<void> {
    if (!this.privateStorage || !this.arilState) return;

    const serialized: Record<string, unknown> = {
      aril: serializeARILState(this.arilState),
      outcome: this.outcomeEvaluator?.getState(),
      calibration: this.confidenceCalibrator
        ? serializeCalibrationState(this.confidenceCalibrator.getState())
        : null,
      compiler: this.insightCompiler
        ? serializeCompilerState(this.insightCompiler)
        : null,
      domain: this.domainTracker
        ? serializeDomainProfile(this.domainTracker.getProfile())
        : null,
      correlation: this.correlationHistory
        ? {
            correlations: Array.from(this.correlationHistory.correlations),
            sessionCount: this.correlationHistory.sessionCount,
            metricMeans: Array.from(this.correlationHistory.metricMeans),
            outcomeMean: this.correlationHistory.outcomeMean,
            covariances: Array.from(this.correlationHistory.covariances),
            metricVariances: Array.from(this.correlationHistory.metricVariances),
            outcomeVariance: this.correlationHistory.outcomeVariance,
          }
        : null,
      observer: this.modeObserver
        ? serializeObserverHistory(this.modeObserver.getHistory())
        : null,
      consolidation: this.consolidationSnapshots,
      mobius: this.mobiusCharacteristic
        ? this.mobiusCharacteristic.serialize()
        : null,
      mobiusBaseline: this.mobiusBaseline,
      strategyCorrelation: this.strategyCorrelation ? {
        correlations: Array.from(this.strategyCorrelation.correlations),
        sessionCount: this.strategyCorrelation.sessionCount,
        metricMeans: Array.from(this.strategyCorrelation.metricMeans),
        outcomeMean: this.strategyCorrelation.outcomeMean,
        covariances: Array.from(this.strategyCorrelation.covariances),
        metricVariances: Array.from(this.strategyCorrelation.metricVariances),
        outcomeVariance: this.strategyCorrelation.outcomeVariance,
      } : null,
      strategyMobius: this.strategyMobius?.serialize() ?? null,
      strategyMobiusBaseline: this.strategyMobiusBaseline,
      strategyFeatureRunningMean: this.strategyFeatureRunningMean
        ? Array.from(this.strategyFeatureRunningMean) : null,
    };

    // Store as a special ActionLog metadata entry
    await this.privateStorage.storeActionLog(
      {
        interactionId: UnifiedIdentity.ARIL_STATE_KEY,
        startTime: Date.now(),
        endTime: Date.now(),
        toolCalls: [],
        decisions: [],
        failures: [],
        informationSeeks: [],
        verifications: [],
        resourceUsage: { tokensUsed: 0, toolCallCount: 0, wallTimeMs: 0, apiCalls: 0, retriesTotal: 0 },
      },
      serialized
    );
  }

  private async loadARILState(): Promise<void> {
    if (!this.privateStorage) return;

    try {
      const logs = await this.privateStorage.getAllActionLogs();
      // Search from the end — getAllActionLogs() returns sorted by seq ascending,
      // and if multiple entries share the same interactionId (backend-dependent),
      // we want the most recent one.
      let arilLog: (typeof logs)[number] | undefined;
      for (let i = logs.length - 1; i >= 0; i--) {
        if (logs[i].log.interactionId === UnifiedIdentity.ARIL_STATE_KEY) {
          arilLog = logs[i];
          break;
        }
      }

      if (!arilLog || !arilLog.metadata) return;

      const meta = arilLog.metadata as Record<string, unknown>;

      if (meta.aril) {
        this.arilState = deserializeARILState(meta.aril as SerializedARILState);
      }

      if (meta.outcome) {
        this.outcomeEvaluator = new OutcomeEvaluator(
          {},
          meta.outcome as { baseline: number; sessionCount: number }
        );
      }

      if (meta.calibration) {
        this.confidenceCalibrator = new ConfidenceCalibrator(
          {},
          deserializeCalibrationState(meta.calibration as SerializedCalibrationState)
        );
      }

      if (meta.compiler) {
        const cs = meta.compiler as { patterns: CompiledPattern[] };
        this.insightCompiler = new InsightCompiler({}, cs.patterns);
      }

      if (meta.domain) {
        const dp = deserializeDomainProfile(meta.domain as SerializedDomainProfile);
        this.domainTracker = new DomainTracker({}, dp);
      }

      if (meta.correlation) {
        const c = meta.correlation as Record<string, unknown>;
        // RT-H8 fix: validate array shapes before restoring correlation state.
        // Malformed data (filesystem poisoning) stays null → fresh init.
        if (isFiniteNumArray(c.correlations) && typeof c.sessionCount === 'number' && isFinite(c.sessionCount)) {
          const n = (c.correlations as number[]).length;
          if (
            isFiniteNumArray(c.metricMeans, n) &&
            isFiniteNumArray(c.covariances, n) &&
            isFiniteNumArray(c.metricVariances, n) &&
            typeof c.outcomeMean === 'number' && isFinite(c.outcomeMean) &&
            typeof c.outcomeVariance === 'number' && isFinite(c.outcomeVariance)
          ) {
            this.correlationHistory = {
              correlations: Float64Array.from(c.correlations as number[]),
              sessionCount: c.sessionCount as number,
              metricMeans: Float64Array.from(c.metricMeans as number[]),
              outcomeMean: c.outcomeMean as number,
              covariances: Float64Array.from(c.covariances as number[]),
              metricVariances: Float64Array.from(c.metricVariances as number[]),
              outcomeVariance: c.outcomeVariance as number,
            };
          }
        }
      }

      if (meta.observer) {
        const history = deserializeObserverHistory(
          meta.observer as SerializedObserverHistory
        );
        this.modeObserver = new ModeObserver({}, history);
      }

      if (meta.consolidation && Array.isArray(meta.consolidation)) {
        this.consolidationSnapshots = meta.consolidation as ConsolidationSnapshot[];
        if (this.consolidationSnapshots.length > 5) {
          this.consolidationSnapshots = this.consolidationSnapshots.slice(-5);
        }
      }

      if (meta.mobius) {
        this.mobiusCharacteristic = MobiusCharacteristic.deserialize(
          meta.mobius as SerializedMobiusState
        );
      }

      if (isFiniteNumArray(meta.mobiusBaseline)) {
        this.mobiusBaseline = meta.mobiusBaseline;
      }

      // Strategy sub-pipeline restoration (backward-compat: missing = fresh init)
      if (meta.strategyCorrelation) {
        const sc = meta.strategyCorrelation as Record<string, unknown>;
        // RT-H8 fix: same validation as personality correlation above.
        if (isFiniteNumArray(sc.correlations) && typeof sc.sessionCount === 'number' && isFinite(sc.sessionCount)) {
          const sn = (sc.correlations as number[]).length;
          if (
            isFiniteNumArray(sc.metricMeans, sn) &&
            isFiniteNumArray(sc.covariances, sn) &&
            isFiniteNumArray(sc.metricVariances, sn) &&
            typeof sc.outcomeMean === 'number' && isFinite(sc.outcomeMean) &&
            typeof sc.outcomeVariance === 'number' && isFinite(sc.outcomeVariance)
          ) {
            this.strategyCorrelation = {
              correlations: Float64Array.from(sc.correlations as number[]),
              sessionCount: sc.sessionCount as number,
              metricMeans: Float64Array.from(sc.metricMeans as number[]),
              outcomeMean: sc.outcomeMean as number,
              covariances: Float64Array.from(sc.covariances as number[]),
              metricVariances: Float64Array.from(sc.metricVariances as number[]),
              outcomeVariance: sc.outcomeVariance as number,
            };
          }
        }
      }
      if (meta.strategyMobius) {
        this.strategyMobius = MobiusCharacteristic.deserialize(
          meta.strategyMobius as SerializedMobiusState
        );
      }
      if (isFiniteNumArray(meta.strategyMobiusBaseline)) {
        this.strategyMobiusBaseline = meta.strategyMobiusBaseline;
      }
      if (isFiniteNumArray(meta.strategyFeatureRunningMean)) {
        this.strategyFeatureRunningMean = Float64Array.from(
          meta.strategyFeatureRunningMean
        );
      }

      console.log(
        `[UnifiedIdentity] ARIL state restored (${this.arilState?.sessionCount ?? 0} sessions)`
      );
    } catch (err) {
      console.warn('[UnifiedIdentity] Failed to load ARIL state:', err);
    }
  }

  /**
   * §8.2: Compute consolidated initialization from recent snapshots.
   *
   * Three outputs:
   * 1. Weights:  w_init[i] = Σ_k softmax(R_k / τ) · w_k[i]
   * 2. Fitness:  f_init[i] = 0.8 · f_weighted[i] + 0.2 · (1/N)
   * 3. Meta-rate scaling: α_scale[i] = 1.0 + 0.5 · (1 - normalize(consistency[i]))
   *    where consistency[i] = 1/Var(δ_history[i]) across snapshots
   */
  private computeConsolidatedInit(temperature: number = 1.0): ConsolidatedInit | null {
    if (this.consolidationSnapshots.length === 0) return null;

    const k = this.consolidationSnapshots.length;
    const n = this.consolidationSnapshots[0].weights.length;
    const { minWeight, maxWeight } = this.arilConfig;

    // Softmax over outcomes (with numerical stability)
    const outcomes = this.consolidationSnapshots.map(s => s.outcome / temperature);
    const maxOutcome = Math.max(...outcomes);
    const exps = outcomes.map(o => Math.exp(o - maxOutcome));
    const sumExps = exps.reduce((a, b) => a + b, 0);
    const softmaxWeights = exps.map(e => e / sumExps);

    // --- 1. Consolidated weights ---
    const weights = new Float64Array(n);
    for (let j = 0; j < k; j++) {
      const sw = softmaxWeights[j];
      for (let i = 0; i < n; i++) {
        weights[i] += sw * this.consolidationSnapshots[j].weights[i];
      }
    }
    for (let i = 0; i < n; i++) {
      weights[i] = Math.max(minWeight, Math.min(maxWeight, weights[i]));
    }

    // --- 2. Consolidated fitness: 0.8 · f_weighted + 0.2 · (1/N) ---
    const fitness = new Float64Array(n);
    const uniformNoise = 1 / n;
    for (let j = 0; j < k; j++) {
      const sw = softmaxWeights[j];
      for (let i = 0; i < n; i++) {
        fitness[i] += sw * (this.consolidationSnapshots[j].fitness[i] ?? 0);
      }
    }
    for (let i = 0; i < n; i++) {
      fitness[i] = 0.8 * fitness[i] + 0.2 * uniformNoise;
    }

    // --- 3. Consistency-based learning rate scaling ---
    const metaRateScaling = new Float64Array(n).fill(1.0);
    if (k >= 2) {
      // Compute variance of δ[i] across snapshots
      const variances = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let mean = 0;
        let count = 0;
        for (let j = 0; j < k; j++) {
          const attr = this.consolidationSnapshots[j].attributions;
          if (attr && i < attr.length) {
            mean += attr[i];
            count++;
          }
        }
        if (count === 0) continue;
        mean /= count;

        let sumSqDiff = 0;
        for (let j = 0; j < k; j++) {
          const attr = this.consolidationSnapshots[j].attributions;
          if (attr && i < attr.length) {
            const diff = attr[i] - mean;
            sumSqDiff += diff * diff;
          }
        }
        variances[i] = sumSqDiff / count;
      }

      // consistency[i] = 1 / (Var(δ[i]) + ε)
      const EPS = 1e-10;
      const consistency = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        consistency[i] = 1 / (variances[i] + EPS);
      }

      // Normalize consistency to [0, 1] via min-max
      let minC = Infinity, maxC = -Infinity;
      for (let i = 0; i < n; i++) {
        if (consistency[i] < minC) minC = consistency[i];
        if (consistency[i] > maxC) maxC = consistency[i];
      }
      const rangeC = maxC - minC;

      for (let i = 0; i < n; i++) {
        const normalized = rangeC > 0 ? (consistency[i] - minC) / rangeC : 0;
        // High consistency (low variance) → high normalized → low α_scale (exploit)
        // Low consistency (high variance) → low normalized → high α_scale (explore)
        metaRateScaling[i] = 1.0 + 0.5 * (1 - normalized);
      }
    }

    return { weights, fitness, metaRateScaling };
  }

  /**
   * Get consolidation snapshots (for testing/inspection).
   */
  getConsolidationSnapshots(): readonly ConsolidationSnapshot[] {
    return this.consolidationSnapshots;
  }

  /**
   * Get the last mode observation (for testing/inspection).
   */
  getLastObservation(): ModeObservation | null {
    return this.lastObservation;
  }

  private startAutoSaveTimer(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
    }

    this.autoSaveTimer = setInterval(async () => {
      if (this.pendingChanges) {
        console.log('[UnifiedIdentity] Auto-save triggered');
        await this.save();
      }
    }, this.config.autoSaveIntervalMs);
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a UnifiedIdentity instance.
 *
 * This is the recommended way to create the identity system.
 */
export function createUnifiedIdentity(
  storage: StorageBackend,
  config?: Partial<UnifiedIdentityConfig>
): UnifiedIdentity {
  return UnifiedIdentity.create(storage, config);
}

// =============================================================================
// EXPORTS
// =============================================================================

// =============================================================================
// HELPERS
// =============================================================================

function extractInteractionsFromMobius(mobius: MobiusCharacteristic): InteractionTerm[] {
  const state = mobius.getState();
  const interactions: InteractionTerm[] = [];
  for (const [mask, coeff] of state.coefficients) {
    if (popcount(mask) < 2) continue;
    const dims: number[] = [];
    for (let i = 0; i < state.dimensionCount; i++) {
      if (mask & (1 << i)) dims.push(i);
    }
    interactions.push({ dimensions: dims, strength: coeff });
  }
  return interactions;
}

/**
 * RT-H8: Validate that a value is an array of finite numbers with optional length check.
 * Used during ARIL state deserialization to reject poisoned filesystem data.
 */
function isFiniteNumArray(v: unknown, expectedLength?: number): v is number[] {
  if (!Array.isArray(v)) return false;
  if (expectedLength !== undefined && v.length !== expectedLength) return false;
  return v.every((x: unknown) => typeof x === 'number' && isFinite(x));
}

function maxAbsFloat64(arr: Float64Array): number {
  let max = 0;
  for (let i = 0; i < arr.length; i++) {
    max = Math.max(max, Math.abs(arr[i]));
  }
  return max;
}

export default {
  UnifiedIdentity,
  createUnifiedIdentity,
  DEFAULT_UNIFIED_CONFIG,
};
