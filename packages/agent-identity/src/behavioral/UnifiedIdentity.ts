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
  private autoSaveTimer: ReturnType<typeof setInterval> | null = null;
  private latestActionLogHash: string | null = null;
  private loadedInsights: StoredInsight[] = [];

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
        const insightSummary = bridgeResult.insights.length > 0
          ? ` with ${bridgeResult.insights.length} insight(s)`
          : '';
        console.log(`[UnifiedIdentity] ActionLog stored privately${insightSummary}: ${actionLogHash.slice(0, 12)}...`);
      } catch (err) {
        warnings.push(`Failed to store ActionLog: ${err}`);
        console.error('[UnifiedIdentity] Private storage error:', err);
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
    } else if (bridgeResult.identityChanged) {
      // Check if weight change is significant enough
      const state = this.bridge.getState();
      let maxChange = 0;
      for (let i = 0; i < state.dimension; i++) {
        maxChange = Math.max(maxChange, Math.abs(bridgeResult.newState.w[i] - state.w[i]));
      }
      if (maxChange >= this.config.minWeightChangeForSave) {
        this.pendingChanges = true;
      }
    }

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

    const saved = await this.persistence.save();
    if (saved) {
      this.lastSaveTime = Date.now();
      this.pendingChanges = false;
    }
    return saved;
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

  // =============================================================================
  // PRIVATE METHODS
  // =============================================================================

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

export default {
  UnifiedIdentity,
  createUnifiedIdentity,
  DEFAULT_UNIFIED_CONFIG,
};
