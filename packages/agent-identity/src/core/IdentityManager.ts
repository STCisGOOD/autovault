/**
 * IdentityManager.ts
 *
 * The session lifecycle manager that WIRES UP the behavioral system.
 *
 * This class bridges the gap between:
 * - Agent runtime (external)
 * - ActionLog collection
 * - Experience mapping
 * - PDE evolution
 * - Filter application
 * - Storage persistence
 *
 * Before this, the code had:
 * - PDEs that evolve on nothing
 * - Filters that are never applied
 * - Weights that don't affect anything
 *
 * Now it has:
 * - ActionLog → Experience → PDE evolution
 * - Weights → Context modifier → Agent behavior
 * - Filter → Experience interpretation
 */

import type { ActionLog } from '../behavioral/BehavioralObserver';
import type { StorageBackend } from '../behavioral/IdentityPersistence';
import type { SelfState, Vocabulary, DynamicsParams, Declaration } from '../behavioral/FixedPointSelf';
import { evolveState, deriveFilter, applyFilter, computeEnergy } from '../behavioral/FixedPointSelf';
import { createBehavioralVocabulary, createBehavioralParams } from '../behavioral/IdentityBridge';

import type {
  AgentRuntime,
  ContextModifier,
  IdentityLifecycle,
  IdentityUpdateResult,
} from './AgentRuntime';

import {
  actionLogToExperience,
  weightsToContextModifier,
} from './ExperienceMapping';

import type { PrivateStorageBackend } from '../bootstrap/PrivateStorage';

// =============================================================================
// CONFIGURATION
// =============================================================================

export interface IdentityManagerConfig {
  /** Time step for PDE evolution (smaller = more gradual) */
  evolutionTimeStep: number;

  /** Minimum weight change to trigger persistence */
  minWeightChangeForSave: number;

  /** Auto-save after each session */
  autoSave: boolean;

  /** Verbose logging */
  verbose: boolean;
}

const DEFAULT_CONFIG: IdentityManagerConfig = {
  evolutionTimeStep: 0.05,
  minWeightChangeForSave: 0.01,
  autoSave: true,
  verbose: true,
};

// =============================================================================
// IDENTITY MANAGER
// =============================================================================

export class IdentityManager implements IdentityLifecycle {
  private readonly config: IdentityManagerConfig;
  private readonly storage: StorageBackend;
  private readonly privateStorage: PrivateStorageBackend | null;

  private state: SelfState;
  private vocabulary: Vocabulary;
  private params: DynamicsParams;
  private declarations: Declaration[] = [];
  private runtime: AgentRuntime | null = null;

  private activeSessions: Map<string, { startTime: number }> = new Map();

  constructor(
    storage: StorageBackend,
    privateStorage: PrivateStorageBackend | null = null,
    config: Partial<IdentityManagerConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.storage = storage;
    this.privateStorage = privateStorage;

    // Initialize with default vocabulary
    this.vocabulary = createBehavioralVocabulary();
    this.params = createBehavioralParams(this.vocabulary.assertions.length);

    // Initialize neutral state
    const n = this.vocabulary.assertions.length;
    this.state = {
      dimension: n,
      w: new Float64Array(n).fill(0.5),
      m: new Float64Array(n).fill(0.5),
      time: 0,
    };
  }

  // ===========================================================================
  // LIFECYCLE IMPLEMENTATION
  // ===========================================================================

  /**
   * Called when agent session starts.
   *
   * Returns a context modifier derived from current weights.
   * The agent decides how to apply this (system prompt, etc.)
   */
  async onSessionStart(sessionId: string): Promise<ContextModifier> {
    this.log(`Session start: ${sessionId}`);

    // Track active session
    this.activeSessions.set(sessionId, { startTime: Date.now() });

    // Apply interpretive filter to generate weighted context
    const filter = deriveFilter(this.state.m);

    // Generate context modifier from current weights
    const contextMod = weightsToContextModifier(this.state.w, this.vocabulary);

    this.log(`Context modifier generated with ${contextMod.promptAdditions.length} additions`);

    return contextMod;
  }

  /**
   * Called when agent session ends.
   *
   * This is where the MAGIC happens:
   * 1. ActionLog → Experience vector
   * 2. Experience → PDE evolution
   * 3. Filter → Experience interpretation
   * 4. Weights → Next context modifier
   * 5. Persist everything
   */
  async onSessionEnd(
    sessionId: string,
    actionLog: ActionLog
  ): Promise<IdentityUpdateResult> {
    this.log(`Session end: ${sessionId}`);

    const session = this.activeSessions.get(sessionId);
    if (!session) {
      this.log(`Warning: Unknown session ${sessionId}`);
    }
    this.activeSessions.delete(sessionId);

    const warnings: string[] = [];
    const stateBefore = this.cloneState(this.state);

    // 1. Convert ActionLog to experience vector
    const rawExperience = actionLogToExperience(actionLog, this.vocabulary);
    this.log(`Raw experience: [${Array.from(rawExperience).map(x => x.toFixed(3)).join(', ')}]`);

    // 2. Apply interpretive filter to experience
    const filter = deriveFilter(this.state.m);
    const filteredExperience = applyFilter(filter, rawExperience);
    this.log(`Filtered experience: [${Array.from(filteredExperience).map(x => x.toFixed(3)).join(', ')}]`);

    // 3. Evolve neuroplastic state via PDEs
    const evolutionResult = evolveState(
      this.state,
      filteredExperience,
      this.params,
      this.vocabulary,
      this.config.evolutionTimeStep
    );

    this.state = evolutionResult.newState;
    this.log(`Energy: ${evolutionResult.energyBefore.toFixed(4)} → ${evolutionResult.energyAfter.toFixed(4)}`);

    // 4. Compute weight changes
    let maxChange = 0;
    for (let i = 0; i < this.state.dimension; i++) {
      maxChange = Math.max(maxChange, Math.abs(this.state.w[i] - stateBefore.w[i]));
    }
    const identityChanged = maxChange >= this.config.minWeightChangeForSave;
    this.log(`Max weight change: ${maxChange.toFixed(4)} (${identityChanged ? 'significant' : 'minor'})`);

    // 5. Store ActionLog privately (if configured)
    let actionLogHash: string | null = null;
    if (this.privateStorage) {
      try {
        actionLogHash = await this.privateStorage.storeActionLog(actionLog, {
          sessionId,
          weightsBefore: Array.from(stateBefore.w),
          weightsAfter: Array.from(this.state.w),
        });
        this.log(`ActionLog stored: ${actionLogHash.slice(0, 12)}...`);
      } catch (err) {
        warnings.push(`Failed to store ActionLog: ${err}`);
      }
    }

    // 6. Persist identity state (if significant change or autoSave)
    if (identityChanged || this.config.autoSave) {
      await this.save();
    }

    // 7. Generate next context modifier
    const nextContextModifier = weightsToContextModifier(this.state.w, this.vocabulary);

    // 8. Build summary
    const summary = this.buildSummary(stateBefore, this.state, maxChange);

    return {
      identityChanged,
      nextContextModifier,
      summary,
      actionLogHash,
      warnings,
    };
  }

  /**
   * Periodic checkpoint during long sessions.
   */
  async onCheckpoint(sessionId: string, actionLog: ActionLog): Promise<void> {
    this.log(`Checkpoint: ${sessionId} with ${actionLog.toolCalls.length} calls`);

    // Evolve with current data but don't persist heavily
    const experience = actionLogToExperience(actionLog, this.vocabulary);
    const filter = deriveFilter(this.state.m);
    const filtered = applyFilter(filter, experience);

    const result = evolveState(
      this.state,
      filtered,
      this.params,
      this.vocabulary,
      this.config.evolutionTimeStep / 2 // Smaller step for checkpoints
    );

    this.state = result.newState;
  }

  // ===========================================================================
  // RUNTIME ATTACHMENT
  // ===========================================================================

  /**
   * Attach to an agent runtime.
   */
  attach(runtime: AgentRuntime): void {
    this.runtime = runtime;
    this.log(`Attached to runtime: ${runtime.agentId}`);
  }

  /**
   * Detach from current runtime.
   */
  detach(): void {
    if (this.runtime) {
      this.log(`Detached from runtime: ${this.runtime.agentId}`);
      this.runtime = null;
    }
  }

  // ===========================================================================
  // PERSISTENCE
  // ===========================================================================

  /**
   * Load identity from storage.
   */
  async load(): Promise<boolean> {
    try {
      const stored = await this.storage.get<{
        state: SelfState;
        vocabulary: Vocabulary;
        params: DynamicsParams;
        declarations: Declaration[];
      }>('identity_manager_state');

      if (stored) {
        // Restore Float64Arrays
        this.state = {
          ...stored.state,
          w: Float64Array.from(stored.state.w as unknown as number[]),
          m: Float64Array.from(stored.state.m as unknown as number[]),
        };
        this.vocabulary = stored.vocabulary;
        this.params = {
          ...stored.params,
          w_star: Float64Array.from(stored.params.w_star as unknown as number[]),
        };
        this.declarations = stored.declarations;

        this.log('Loaded identity from storage');
        return true;
      }

      this.log('No stored identity found, using defaults');
      return false;
    } catch (err) {
      this.log(`Failed to load: ${err}`);
      return false;
    }
  }

  /**
   * Save identity to storage.
   */
  async save(): Promise<boolean> {
    try {
      await this.storage.set('identity_manager_state', {
        state: {
          ...this.state,
          w: Array.from(this.state.w),
          m: Array.from(this.state.m),
        },
        vocabulary: this.vocabulary,
        params: {
          ...this.params,
          w_star: Array.from(this.params.w_star),
        },
        declarations: this.declarations,
      });

      this.log('Saved identity to storage');
      return true;
    } catch (err) {
      this.log(`Failed to save: ${err}`);
      return false;
    }
  }

  // ===========================================================================
  // ACCESSORS
  // ===========================================================================

  getState(): SelfState {
    return this.state;
  }

  getVocabulary(): Vocabulary {
    return this.vocabulary;
  }

  getCurrentWeights(): number[] {
    return Array.from(this.state.w);
  }

  getContextModifier(): ContextModifier {
    return weightsToContextModifier(this.state.w, this.vocabulary);
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private log(message: string): void {
    if (this.config.verbose) {
      console.log(`[IdentityManager] ${message}`);
    }
  }

  private cloneState(state: SelfState): SelfState {
    return {
      dimension: state.dimension,
      w: Float64Array.from(state.w),
      m: Float64Array.from(state.m),
      time: state.time,
    };
  }

  private buildSummary(before: SelfState, after: SelfState, maxChange: number): string {
    const lines: string[] = [];

    lines.push(`Weight evolution (max Δ: ${maxChange.toFixed(4)}):`);

    for (let i = 0; i < this.vocabulary.assertions.length; i++) {
      const dim = this.vocabulary.assertions[i];
      const delta = after.w[i] - before.w[i];
      if (Math.abs(delta) > 0.001) {
        const arrow = delta > 0 ? '↑' : '↓';
        lines.push(`  ${dim}: ${before.w[i].toFixed(3)} → ${after.w[i].toFixed(3)} ${arrow}`);
      }
    }

    // Compute Laplacian from vocabulary relationships for energy calculation
    const n = this.vocabulary.assertions.length;
    const L = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      let degree = 0;
      for (let j = 0; j < n; j++) {
        if (i !== j) {
          const coupling = this.vocabulary.relationships[i * n + j];
          L[i * n + j] = -coupling;
          degree += coupling;
        }
      }
      L[i * n + i] = degree;
    }

    const energyBefore = computeEnergy(before, this.params, L);
    const energyAfter = computeEnergy(after, this.params, L);
    lines.push(`Energy: ${energyBefore.toFixed(4)} → ${energyAfter.toFixed(4)}`);

    return lines.join('\n');
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createIdentityManager(
  storage: StorageBackend,
  privateStorage?: PrivateStorageBackend,
  config?: Partial<IdentityManagerConfig>
): IdentityManager {
  return new IdentityManager(storage, privateStorage || null, config);
}

export default IdentityManager;
