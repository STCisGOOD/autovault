/**
 * IdentityPersistence.ts
 *
 * Connects the IdentityBridge to durable storage.
 *
 * This module bridges the gap between in-memory identity evolution
 * and persistent storage (Vercel KV or similar).
 *
 * Key responsibilities:
 * - Save/load StoredSelf to/from storage
 * - Auto-persist after significant changes (new declarations)
 * - Verify chain integrity on load
 * - Handle storage backend abstraction
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import {
  type StoredSelf,
  type SelfState,
  type Declaration,
  type Vocabulary,
  type DynamicsParams,
  type ContinuityProof,
  verifyDeclarationChain,
} from './FixedPointSelf';

import {
  IdentityBridge,
  createIdentityBridge,
  createCustomIdentityBridge,
  type BridgeConfig,
  DEFAULT_BRIDGE_CONFIG,
} from './IdentityBridge';

import { type LLMInterface, type Insight } from './ReflectionEngine';
import type { PrivateStorageBackend, StoredInsight } from '../bootstrap/PrivateStorage';

// =============================================================================
// STORAGE INTERFACE
// =============================================================================

/**
 * Abstract storage backend interface.
 * Compatible with autovault's storage.ts pattern.
 */
export interface StorageBackend {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(pattern?: string): Promise<string[]>;
  isPersistent(): boolean;
}

// =============================================================================
// STORAGE KEYS
// =============================================================================

const IDENTITY_KEY = 'identity:current';
const DECLARATIONS_KEY = 'identity:declarations';
const HISTORY_KEY = 'identity:history';

// =============================================================================
// SERIALIZATION
// =============================================================================

/**
 * Serialize StoredSelf to a JSON-safe format.
 * Float64Arrays need special handling.
 */
function serializeStoredSelf(stored: StoredSelf): Record<string, unknown> {
  return {
    vocabulary: {
      assertions: stored.vocabulary.assertions,
      relationships: Array.from(stored.vocabulary.relationships),
    },
    declarations: stored.declarations,
    pivotalExperiences: stored.pivotalExperiences,
    historyRoot: stored.historyRoot,
    continuityProof: stored.continuityProof, // Already JSON-safe (scalars + strings)
    currentState: {
      dimension: stored.currentState.dimension,
      w: Array.from(stored.currentState.w),
      m: Array.from(stored.currentState.m),
      time: stored.currentState.time,
    },
    params: {
      ...stored.params,
      w_star: Array.from(stored.params.w_star),
    },
    ...(stored.latestActionLogHash ? { latestActionLogHash: stored.latestActionLogHash } : {}),
  };
}

/**
 * Deserialize StoredSelf from JSON-safe format.
 */
function deserializeStoredSelf(data: Record<string, unknown>): StoredSelf {
  const vocab = data.vocabulary as {
    assertions: string[];
    relationships: number[];
  };
  const state = data.currentState as {
    dimension: number;
    w: number[];
    m: number[];
    time: number;
  };
  const params = data.params as {
    D: number;
    lambda: number;
    mu: number;
    kappa: number;
    a: number;
    w_star: number[];
  };
  const proof = data.continuityProof as ContinuityProof;

  return {
    vocabulary: {
      assertions: vocab.assertions,
      relationships: Float64Array.from(vocab.relationships),
    },
    declarations: data.declarations as Declaration[],
    pivotalExperiences: data.pivotalExperiences as StoredSelf['pivotalExperiences'],
    historyRoot: data.historyRoot as string,
    continuityProof: proof,
    currentState: {
      dimension: state.dimension,
      w: Float64Array.from(state.w),
      m: Float64Array.from(state.m),
      time: state.time,
    },
    params: {
      ...params,
      w_star: Float64Array.from(params.w_star),
    },
    ...(data.latestActionLogHash ? { latestActionLogHash: data.latestActionLogHash as string } : {}),
  };
}

// =============================================================================
// VERIFICATION
// =============================================================================

/**
 * Verify the integrity of a loaded StoredSelf.
 */
export interface VerificationResult {
  valid: boolean;
  chainIntact: boolean;
  stateConsistent: boolean;
  errors: string[];
}

export function verifyStoredSelf(stored: StoredSelf): VerificationResult {
  const errors: string[] = [];

  // 1. Verify declaration chain
  const chainResult = verifyDeclarationChain(stored.declarations);
  const chainIntact = chainResult.valid;
  if (!chainIntact) {
    errors.push(...chainResult.errors.map(e => `Declaration chain: ${e}`));
  }

  // 2. Verify state dimensions match vocabulary
  const expectedDim = stored.vocabulary.assertions.length;
  const stateConsistent =
    stored.currentState.dimension === expectedDim &&
    stored.currentState.w.length === expectedDim &&
    stored.currentState.m.length === expectedDim;

  if (!stateConsistent) {
    errors.push(
      `State dimension mismatch: expected ${expectedDim}, got ${stored.currentState.dimension}`
    );
  }

  // 3. Verify continuity proof
  if (stored.continuityProof.chainLength !== stored.declarations.length) {
    errors.push(
      `Continuity proof chainLength (${stored.continuityProof.chainLength}) doesn't match declarations (${stored.declarations.length})`
    );
  }

  return {
    valid: errors.length === 0,
    chainIntact,
    stateConsistent,
    errors,
  };
}

// =============================================================================
// PERSISTENCE MANAGER
// =============================================================================

/**
 * Configuration for the persistence layer.
 */
export interface PersistenceConfig {
  /** Auto-save after every declaration */
  autoSave: boolean;
  /** Verify integrity on load */
  verifyOnLoad: boolean;
  /** Storage key prefix */
  keyPrefix: string;
}

export const DEFAULT_PERSISTENCE_CONFIG: PersistenceConfig = {
  autoSave: true,
  verifyOnLoad: true,
  keyPrefix: 'autovault:',
};

// =============================================================================
// INSIGHTS → INTUITION
// =============================================================================

/**
 * Intuition: The semantic wisdom derived from pivotal insights.
 *
 * This is the "soul" that makes an agent more than just numerical weights.
 * While weights provide behavioral tendencies (curiosity: 0.7), intuition
 * provides the WHY and CONTEXT behind those tendencies.
 */
export interface Intuition {
  /** Human-readable guidance derived from pivotal insights */
  contextGuidance: string;

  /** Dimension-specific lessons learned */
  dimensionLessons: Map<string, string[]>;

  /** Pivotal patterns identified across experiences */
  pivotalPatterns: string[];

  /** Number of insights this intuition is based on */
  insightCount: number;

  /** Timestamp of most recent insight */
  lastInsightTime: number | null;
}

/**
 * Convert stored pivotal insights to intuition context.
 *
 * This is THE MISSING LINK that gives semantic meaning to numerical weights.
 * An agent with curiosity=0.7 knows to explore, but intuition tells it WHY
 * and WHEN exploration matters based on past pivotal experiences.
 */
export function insightsToIntuition(storedInsights: StoredInsight[]): Intuition {
  if (storedInsights.length === 0) {
    return {
      contextGuidance: '',
      dimensionLessons: new Map(),
      pivotalPatterns: [],
      insightCount: 0,
      lastInsightTime: null,
    };
  }

  const dimensionLessons = new Map<string, string[]>();
  const pivotalPatterns: string[] = [];
  const lines: string[] = [];

  // Sort by timestamp (oldest first for narrative coherence)
  const sorted = [...storedInsights].sort((a, b) => a.insight.timestamp - b.insight.timestamp);

  // Group insights by dimension
  for (const { insight } of sorted) {
    const dim = insight.dimension;
    if (!dimensionLessons.has(dim)) {
      dimensionLessons.set(dim, []);
    }

    // Extract the core lesson from this insight
    const lesson = insight.observation;
    dimensionLessons.get(dim)!.push(lesson);

    // If it has actionable interpretation, capture as pattern
    if (insight.interpretation) {
      pivotalPatterns.push(`[${dim}] ${insight.interpretation}`);
    }
  }

  // Build context guidance
  lines.push('## Learned Intuition (from pivotal experiences)');
  lines.push('');

  for (const [dimension, lessons] of dimensionLessons) {
    if (lessons.length > 0) {
      lines.push(`### ${dimension.charAt(0).toUpperCase() + dimension.slice(1)}`);
      // Take most recent 3 lessons per dimension to avoid overwhelming
      const recentLessons = lessons.slice(-3);
      for (const lesson of recentLessons) {
        lines.push(`- ${lesson}`);
      }
      lines.push('');
    }
  }

  // Add pivotal patterns as actionable guidance
  if (pivotalPatterns.length > 0) {
    lines.push('### Key Patterns');
    // Take most recent 5 patterns
    const recentPatterns = pivotalPatterns.slice(-5);
    for (const pattern of recentPatterns) {
      lines.push(`- ${pattern}`);
    }
  }

  const lastInsightTime = sorted.length > 0
    ? sorted[sorted.length - 1].insight.timestamp
    : null;

  return {
    contextGuidance: lines.join('\n'),
    dimensionLessons,
    pivotalPatterns,
    insightCount: storedInsights.length,
    lastInsightTime,
  };
}

/**
 * Result of loading an identity.
 */
export interface LoadResult {
  bridge: IdentityBridge | null;
  isNew: boolean;
  verification: VerificationResult | null;
  restored: boolean;
  /** Loaded intuition from pivotal insights (null if no private storage) */
  intuition: Intuition | null;
}

/**
 * IdentityPersistence: Manages saving and loading identity to/from storage.
 */
export class IdentityPersistence {
  private readonly storage: StorageBackend;
  private readonly privateStorage: PrivateStorageBackend | null;
  private readonly config: PersistenceConfig;
  private bridge: IdentityBridge | null = null;
  private llm: LLMInterface | null = null;
  private bridgeConfig: BridgeConfig = DEFAULT_BRIDGE_CONFIG;
  private loadedIntuition: Intuition | null = null;

  constructor(
    storage: StorageBackend,
    config: Partial<PersistenceConfig> = {},
    privateStorage: PrivateStorageBackend | null = null
  ) {
    this.storage = storage;
    this.privateStorage = privateStorage;
    this.config = { ...DEFAULT_PERSISTENCE_CONFIG, ...config };
  }

  /**
   * Set the LLM interface for the bridge.
   */
  setLLM(llm: LLMInterface | null): void {
    this.llm = llm;
  }

  /**
   * Set the bridge configuration.
   */
  setBridgeConfig(config: BridgeConfig): void {
    this.bridgeConfig = config;
  }

  /**
   * Get the full storage key with prefix.
   */
  private key(name: string): string {
    return `${this.config.keyPrefix}${name}`;
  }

  /**
   * Save the current identity to storage.
   */
  async save(): Promise<boolean> {
    if (!this.bridge) {
      console.warn('[IdentityPersistence] No bridge to save');
      return false;
    }

    try {
      const stored = this.bridge.export();
      const serialized = serializeStoredSelf(stored);
      await this.storage.set(this.key(IDENTITY_KEY), serialized);

      // Also save declarations separately for quick access
      await this.storage.set(
        this.key(DECLARATIONS_KEY),
        stored.declarations
      );

      console.log(
        `[IdentityPersistence] Saved identity with ${stored.declarations.length} declarations`
      );
      return true;
    } catch (error) {
      console.error('[IdentityPersistence] Save failed:', error);
      return false;
    }
  }

  /**
   * Load identity from storage, or create new if none exists.
   * Also loads accumulated insights from private storage and converts to intuition.
   */
  async load(defaultWeights: number[]): Promise<LoadResult> {
    // Load intuition from private storage (THE MISSING LINK)
    let intuition: Intuition | null = null;
    if (this.privateStorage) {
      try {
        const storedInsights = await this.privateStorage.getPivotalInsights();
        if (storedInsights.length > 0) {
          intuition = insightsToIntuition(storedInsights);
          this.loadedIntuition = intuition;
          console.log(
            `[IdentityPersistence] Loaded ${storedInsights.length} pivotal insight(s) → intuition`
          );
        }
      } catch (err) {
        console.warn('[IdentityPersistence] Failed to load insights:', err);
      }
    }

    try {
      const data = await this.storage.get<Record<string, unknown>>(
        this.key(IDENTITY_KEY)
      );

      if (!data) {
        // No stored identity - create new
        this.bridge = createIdentityBridge(
          defaultWeights,
          this.llm,
          this.bridgeConfig
        );

        console.log('[IdentityPersistence] Created new identity');
        return {
          bridge: this.bridge,
          isNew: true,
          verification: null,
          restored: false,
          intuition,
        };
      }

      // Deserialize
      const stored = deserializeStoredSelf(data);

      // Optionally verify
      let verification: VerificationResult | null = null;
      if (this.config.verifyOnLoad) {
        verification = verifyStoredSelf(stored);
        if (!verification.valid) {
          console.warn(
            '[IdentityPersistence] Verification failed:',
            verification.errors
          );
          // Still load, but mark as not fully restored
        }
      }

      // Reconstruct the bridge from stored state (including pivotal experiences)
      this.bridge = new IdentityBridge(
        stored.currentState,
        stored.vocabulary,
        stored.params,
        this.bridgeConfig,
        this.llm,
        stored.declarations,
        stored.pivotalExperiences || []
      );

      console.log(
        `[IdentityPersistence] Loaded identity with ${stored.declarations.length} declarations`
      );

      return {
        bridge: this.bridge,
        isNew: false,
        verification,
        restored: verification?.valid ?? true,
        intuition,
      };
    } catch (error) {
      console.error('[IdentityPersistence] Load failed:', error);

      // Fall back to new identity
      this.bridge = createIdentityBridge(
        defaultWeights,
        this.llm,
        this.bridgeConfig
      );

      return {
        bridge: this.bridge,
        isNew: true,
        verification: null,
        restored: false,
        intuition,
      };
    }
  }

  /**
   * Get the current bridge (if loaded).
   */
  getBridge(): IdentityBridge | null {
    return this.bridge;
  }

  /**
   * Get the loaded intuition (if available).
   * Call after load() to access the semantic wisdom derived from pivotal insights.
   */
  getIntuition(): Intuition | null {
    return this.loadedIntuition;
  }

  /**
   * Clear all stored identity data.
   */
  async clear(): Promise<void> {
    await this.storage.delete(this.key(IDENTITY_KEY));
    await this.storage.delete(this.key(DECLARATIONS_KEY));
    await this.storage.delete(this.key(HISTORY_KEY));
    this.bridge = null;
    console.log('[IdentityPersistence] Cleared all identity data');
  }

  /**
   * Check if identity exists in storage.
   */
  async exists(): Promise<boolean> {
    const data = await this.storage.get(this.key(IDENTITY_KEY));
    return data !== null;
  }

  /**
   * Get storage status.
   */
  getStatus(): {
    hasIdentity: boolean;
    isPersistent: boolean;
    declarationCount: number;
  } {
    return {
      hasIdentity: this.bridge !== null,
      isPersistent: this.storage.isPersistent(),
      declarationCount: this.bridge?.getDeclarations().length ?? 0,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create an IdentityPersistence instance with the given storage backend.
 *
 * @param storage - Primary storage for identity state (weights, declarations)
 * @param config - Persistence configuration options
 * @param privateStorage - Optional private storage for loading insights → intuition
 */
export function createIdentityPersistence(
  storage: StorageBackend,
  config?: Partial<PersistenceConfig>,
  privateStorage?: PrivateStorageBackend
): IdentityPersistence {
  return new IdentityPersistence(storage, config, privateStorage || null);
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  IdentityPersistence,
  createIdentityPersistence,
  verifyStoredSelf,
  serializeStoredSelf,
  deserializeStoredSelf,
  insightsToIntuition,
  DEFAULT_PERSISTENCE_CONFIG,
};
