/**
 * IdentityBridge.ts
 *
 * The missing link: connects observed behavior to identity evolution.
 *
 * This module bridges:
 *   BehavioralObserver (what agent DOES)
 *   → FixedPointSelf (who agent IS)
 *   → ReflectionEngine (what agent THINKS about itself)
 *   → Persistence (stored declarations)
 *
 * Key insight: Identity evolves through the TENSION between
 * declared self (w) and observed behavior (experience signal).
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import {
  BehavioralObserver,
  computeBehavioralMetrics,
  computeDiscrepancies,
  generateGroundedExperience,
  generateGroundedReflection,
  extractGroundedInsights,
  type ActionLog,
  type BehavioralMetrics,
  type BehavioralDiscrepancy,
  type GroundedExperience,
  type GroundedReflection,
} from './BehavioralObserver';

import {
  type ExtendedVocabulary,
  type DimensionDefinition,
  extractDimensionMetrics,
  dimensionMetricsToExperience,
  createExtendedVocabulary,
  DEFAULT_DIMENSIONS,
} from './VocabularyExtension';

import {
  type SelfState,
  type Vocabulary,
  type DynamicsParams,
  type Declaration,
  type StoredSelf,
  type ContinuityProof,
  type PivotalExperience,
  evolveState,
  createDeclaration,
  applyDeclaration,
  computeCoherence,
  computeEnergy,
  generateContinuityProof,
} from './FixedPointSelf';

import {
  type Interaction,
  type Insight,
  type LLMInterface,
} from './ReflectionEngine';

// =============================================================================
// CONFIGURATION
// =============================================================================

export interface BridgeConfig {
  /** Time step for identity evolution (smaller = more gradual) */
  readonly evolutionTimeStep: number;

  /** Minimum confidence to create a declaration */
  readonly declarationThreshold: number;

  /** Minimum behavioral discrepancy to trigger evolution */
  readonly minDiscrepancyDelta: number;

  /** Scale factor for experience signal (behavior → identity) */
  readonly experienceScale: number;

  /** Whether to auto-declare on pivotal insights */
  readonly autoDeclarePivotal: boolean;
}

export const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  evolutionTimeStep: 0.05,
  declarationThreshold: 0.8,
  minDiscrepancyDelta: 0.1,
  experienceScale: 0.5,
  autoDeclarePivotal: true,
};

// =============================================================================
// METRICS TO EXPERIENCE MAPPING
// =============================================================================

/**
 * Standard vocabulary for behavioral identity dimensions.
 *
 * @param customDimensions - Optional array of dimension names for N-dimensional identity.
 *                          If not provided, uses the default 4 dimensions.
 */
export function createBehavioralVocabulary(customDimensions?: string[]): Vocabulary {
  const assertions = customDimensions || [
    'curiosity',      // Exploration beyond requirements
    'precision',      // Verification and accuracy
    'persistence',    // Pushing through failures
    'empathy',        // Adapting to user needs
  ];
  const n = assertions.length;

  // Weak coupling between dimensions (traits influence each other slightly)
  const relationships = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      relationships[i * n + j] = i === j ? 0 : 0.1;
    }
  }

  return { assertions, relationships };
}

/**
 * Create an ExtendedVocabulary from DimensionDefinitions.
 * This provides the full semantic meaning for each dimension.
 *
 * @param dimensions - Array of dimension definitions with extractors
 */
export function createExtendedBehavioralVocabulary(
  dimensions?: readonly DimensionDefinition[]
): ExtendedVocabulary {
  return createExtendedVocabulary(dimensions || DEFAULT_DIMENSIONS);
}

/**
 * Check if a vocabulary is an ExtendedVocabulary.
 */
export function isExtendedVocabulary(vocab: Vocabulary): vocab is ExtendedVocabulary {
  return 'dimensions' in vocab && Array.isArray((vocab as ExtendedVocabulary).dimensions);
}

/**
 * Standard dynamics parameters for behavioral identity.
 * These satisfy Theorem 5.1 (μ > κ/2) and Theorem 7.3 (λ > 0.25).
 */
export function createBehavioralParams(n: number): DynamicsParams {
  return {
    D: 0.1,           // Diffusion: moderate plasticity
    lambda: 0.4,      // Homeostatic strength (> 0.25 for stability)
    mu: 0.3,          // Self-observation rate (> κ/2 = 0.05)
    kappa: 0.1,       // Coherence coupling
    a: 0.5,           // Bistable threshold
    w_star: new Float64Array(n).fill(0.5),  // Neutral homeostatic target
  };
}

/**
 * Map behavioral metrics to an experience vector for identity evolution.
 *
 * The experience vector is centered at 0:
 * - Positive values: behavior EXCEEDS declared identity
 * - Negative values: behavior FALLS SHORT of declared identity
 * - Zero: behavior matches declared identity
 *
 * @param metrics - Computed behavioral metrics from observation
 * @param state - Current identity state (for comparison)
 * @param vocabulary - Identity dimension definitions
 * @param scale - Scale factor (default 0.5)
 * @param actionLog - Optional ActionLog for extended vocabulary metric extraction
 */
export function metricsToExperience(
  metrics: BehavioralMetrics,
  state: SelfState,
  vocabulary: Vocabulary,
  scale: number = 0.5,
  actionLog?: ActionLog
): Float64Array {
  // If we have an ExtendedVocabulary and ActionLog, use the new system
  if (isExtendedVocabulary(vocabulary) && actionLog) {
    const dimensionMetrics = extractDimensionMetrics(actionLog, vocabulary);
    return dimensionMetricsToExperience(dimensionMetrics, state, vocabulary, scale);
  }

  // Fallback to keyword-based matching for basic Vocabulary
  const n = vocabulary.assertions.length;
  const experience = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const dimension = vocabulary.assertions[i].toLowerCase();
    let observed = 0;

    // Map dimension name to behavioral metric
    if (dimension.includes('curiosity') || dimension.includes('curious')) {
      observed = metrics.curiosity.raw;
    } else if (dimension.includes('precision') || dimension.includes('precise') || dimension.includes('accurate')) {
      observed = metrics.precision.raw;
    } else if (dimension.includes('persist') || dimension.includes('determined') || dimension.includes('tenaci')) {
      observed = metrics.persistence.raw;
    } else if (dimension.includes('empathy') || dimension.includes('empathetic') || dimension.includes('caring')) {
      observed = metrics.empathy.raw;
    } else {
      // Unknown dimension: no signal
      experience[i] = 0;
      continue;
    }

    // Experience = (observed - declared) * scale
    // This creates tension that drives evolution toward actual behavior
    const declared = state.w[i];
    experience[i] = (observed - declared) * scale;
  }

  return experience;
}

/**
 * Map discrepancies to a signed experience vector.
 * Uses discrepancy evidence directly instead of raw metrics.
 */
export function discrepanciesToExperience(
  discrepancies: BehavioralDiscrepancy[],
  vocabulary: Vocabulary,
  scale: number = 0.5
): Float64Array {
  const n = vocabulary.assertions.length;
  const experience = new Float64Array(n);

  for (const disc of discrepancies) {
    if (disc.dimensionIndex >= 0 && disc.dimensionIndex < n) {
      // Use delta directly (already signed: observed - declared)
      experience[disc.dimensionIndex] = disc.delta * scale;
    }
  }

  return experience;
}

// =============================================================================
// IDENTITY BRIDGE
// =============================================================================

/**
 * Result of processing an interaction through the identity bridge.
 */
export interface BridgeResult {
  /** The grounded experience from behavioral observation */
  readonly experience: GroundedExperience;

  /** Grounded reflection (if LLM available) */
  readonly reflection: GroundedReflection | null;

  /** Extracted insights */
  readonly insights: Insight[];

  /** New identity state after evolution */
  readonly newState: SelfState;

  /** Declarations made (if thresholds crossed) */
  readonly declarations: Declaration[];

  /** Whether identity actually changed */
  readonly identityChanged: boolean;

  /** Energy metrics */
  readonly energyBefore: number;
  readonly energyAfter: number;

  /** Summary of what happened */
  readonly summary: string;
}

/**
 * IdentityBridge: The unified system that connects behavior to identity.
 */
export class IdentityBridge {
  private state: SelfState;
  private declarations: Declaration[];
  private pivotalExperiences: PivotalExperience[] = [];
  private readonly vocabulary: Vocabulary;
  private readonly params: DynamicsParams;
  private readonly config: BridgeConfig;
  private readonly llm: LLMInterface | null;

  constructor(
    initialState: SelfState,
    vocabulary: Vocabulary,
    params: DynamicsParams,
    config: BridgeConfig = DEFAULT_BRIDGE_CONFIG,
    llm: LLMInterface | null = null,
    initialDeclarations: Declaration[] = [],
    initialPivotalExperiences: PivotalExperience[] = []
  ) {
    this.state = initialState;
    this.vocabulary = vocabulary;
    this.params = params;
    this.config = config;
    this.llm = llm;
    this.declarations = [...initialDeclarations];
    this.pivotalExperiences = [...initialPivotalExperiences];
  }

  /**
   * Process an interaction and its behavioral observation.
   *
   * This is the main entry point: takes an interaction + action log,
   * evolves identity based on observed behavior, and optionally makes declarations.
   */
  async processInteraction(
    interaction: Interaction,
    actionLog: ActionLog
  ): Promise<BridgeResult> {
    // 1. Compute behavioral metrics from observation
    const metrics = computeBehavioralMetrics(actionLog);

    // 2. Compute discrepancies (declared vs observed)
    const discrepancies = computeDiscrepancies(metrics, this.state, this.vocabulary);

    // 3. Generate grounded experience
    const experience = generateGroundedExperience(
      interaction,
      actionLog,
      this.state,
      this.vocabulary
    );

    // 4. Map discrepancies to experience signal
    const experienceSignal = discrepanciesToExperience(
      discrepancies,
      this.vocabulary,
      this.config.experienceScale
    );

    // 5. Evolve identity state
    const evolutionResult = evolveState(
      this.state,
      experienceSignal,
      this.params,
      this.vocabulary,
      this.config.evolutionTimeStep
    );

    const energyBefore = evolutionResult.energyBefore;
    const energyAfter = evolutionResult.energyAfter;

    // 6. Generate reflection if LLM available
    let reflection: GroundedReflection | null = null;
    let insights: Insight[] = [];

    if (this.llm) {
      reflection = await generateGroundedReflection(
        experience,
        this.state,
        this.vocabulary,
        this.llm
      );

      insights = await extractGroundedInsights(
        reflection,
        experience,
        this.vocabulary,
        this.state,
        this.llm
      );
    }

    // 7. Determine if declarations should be made
    const newDeclarations: Declaration[] = [];
    let stateAfterDeclarations = evolutionResult.newState;

    // Track declaration hashes before processing insights
    const declarationHashesBefore = this.declarations.map(d => this.hashDeclaration(d));

    for (const insight of insights) {
      const shouldDeclare = this.shouldDeclare(insight, discrepancies);

      if (shouldDeclare) {
        const prevHash = this.declarations.length > 0
          ? this.hashDeclaration(this.declarations[this.declarations.length - 1])
          : '0'.repeat(64);

        const declaration = createDeclaration(
          insight.dimensionIndex,
          insight.suggestedValue,
          `Behavioral insight: ${insight.observation}`,
          prevHash
        );

        stateAfterDeclarations = applyDeclaration(stateAfterDeclarations, declaration);
        newDeclarations.push(declaration);
        this.declarations.push(declaration);

        // If this is a pivotal insight, record it as a pivotal experience
        if (insight.isPivotal) {
          const declarationHashesAfter = this.declarations.map(d => this.hashDeclaration(d));

          // Compute impact magnitude as the absolute delta
          const impactMagnitude = Math.abs(insight.delta);

          // Create the pivotal experience
          const pivotalExp: PivotalExperience = {
            timestamp: Date.now(),
            experienceHash: experience.id,
            insight: insight.observation,
            declarationsBefore: declarationHashesBefore,
            declarationsAfter: declarationHashesAfter,
            impactMagnitude,
          };

          this.pivotalExperiences.push(pivotalExp);
        }
      }
    }

    // 8. Check if identity actually changed
    const coherenceBefore = computeCoherence(this.state);
    const coherenceAfter = computeCoherence(stateAfterDeclarations);

    let maxWeightChange = 0;
    for (let i = 0; i < this.state.dimension; i++) {
      maxWeightChange = Math.max(
        maxWeightChange,
        Math.abs(stateAfterDeclarations.w[i] - this.state.w[i])
      );
    }

    const identityChanged = maxWeightChange > 0.01 || newDeclarations.length > 0;

    // 9. Update internal state
    this.state = stateAfterDeclarations;

    // 10. Generate summary
    const summary = this.generateSummary(
      discrepancies,
      insights,
      newDeclarations,
      maxWeightChange,
      energyBefore,
      energyAfter
    );

    return {
      experience,
      reflection,
      insights,
      newState: this.state,
      declarations: newDeclarations,
      identityChanged,
      energyBefore,
      energyAfter,
      summary,
    };
  }

  /**
   * Determine if an insight should trigger a declaration.
   */
  private shouldDeclare(
    insight: Insight,
    discrepancies: BehavioralDiscrepancy[]
  ): boolean {
    // Always declare pivotal insights if configured
    if (insight.isPivotal && this.config.autoDeclarePivotal) {
      return true;
    }

    // Check confidence threshold
    if (insight.confidence < this.config.declarationThreshold) {
      return false;
    }

    // Check if there's sufficient discrepancy
    const relevantDisc = discrepancies.find(
      d => d.dimensionIndex === insight.dimensionIndex
    );

    if (!relevantDisc) {
      return false;
    }

    return Math.abs(relevantDisc.delta) >= this.config.minDiscrepancyDelta;
  }

  /**
   * Hash a declaration for chain linking.
   */
  private hashDeclaration(declaration: Declaration): string {
    const data = JSON.stringify({
      index: declaration.index,
      value: declaration.value,
      timestamp: declaration.timestamp,
      previousHash: declaration.previousHash,
      content: declaration.content,
    });
    return bytesToHex(sha256(new TextEncoder().encode(data)));
  }

  /**
   * Generate a human-readable summary of what happened.
   */
  private generateSummary(
    discrepancies: BehavioralDiscrepancy[],
    insights: Insight[],
    declarations: Declaration[],
    maxWeightChange: number,
    energyBefore: number,
    energyAfter: number
  ): string {
    const lines: string[] = [];

    // Discrepancy summary
    const significant = discrepancies.filter(d => d.significance !== 'minor');
    if (significant.length > 0) {
      lines.push(`Observed ${significant.length} significant discrepancy(ies):`);
      for (const d of significant) {
        const arrow = d.direction === 'higher' ? '↑' : d.direction === 'lower' ? '↓' : '=';
        lines.push(`  ${d.dimension}: ${d.declaredValue.toFixed(2)} → ${d.observedValue.toFixed(2)} ${arrow}`);
      }
    } else {
      lines.push('Behavior aligned with declared identity.');
    }

    // Insight summary
    if (insights.length > 0) {
      lines.push(`Extracted ${insights.length} insight(s):`);
      for (const i of insights) {
        lines.push(`  ${i.dimension}: "${i.observation.slice(0, 50)}..."`);
      }
    }

    // Declaration summary
    if (declarations.length > 0) {
      lines.push(`Made ${declarations.length} declaration(s):`);
      for (const d of declarations) {
        const dim = this.vocabulary.assertions[d.index];
        lines.push(`  ${dim} = ${d.value.toFixed(2)}`);
      }
    }

    // Energy change
    const energyDelta = energyAfter - energyBefore;
    lines.push(`Energy: ${energyBefore.toFixed(4)} → ${energyAfter.toFixed(4)} (${energyDelta >= 0 ? '+' : ''}${energyDelta.toFixed(4)})`);

    // Max weight change
    lines.push(`Max weight change: ${maxWeightChange.toFixed(4)}`);

    return lines.join('\n');
  }

  // =============================================================================
  // ACCESSORS
  // =============================================================================

  getState(): SelfState {
    return this.state;
  }

  getDeclarations(): readonly Declaration[] {
    return this.declarations;
  }

  getPivotalExperiences(): readonly PivotalExperience[] {
    return this.pivotalExperiences;
  }

  getVocabulary(): Vocabulary {
    return this.vocabulary;
  }

  /**
   * Export the current identity for persistence.
   */
  export(): StoredSelf {
    const continuityProof = generateContinuityProof(
      this.state,
      this.declarations,
      this.params,
      this.vocabulary
    );

    // Compute Merkle root of declarations
    const historyRoot = this.computeHistoryRoot();

    return {
      vocabulary: this.vocabulary,
      declarations: this.declarations,
      pivotalExperiences: this.pivotalExperiences,
      historyRoot,
      continuityProof,
      currentState: this.state,
      params: this.params,
    };
  }

  /**
   * Compute Merkle root of declaration chain.
   */
  private computeHistoryRoot(): string {
    if (this.declarations.length === 0) return '0'.repeat(64);

    let hashes = this.declarations.map(d =>
      bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(d))))
    );

    while (hashes.length > 1) {
      const nextLevel: string[] = [];
      for (let i = 0; i < hashes.length; i += 2) {
        if (i + 1 < hashes.length) {
          nextLevel.push(
            bytesToHex(sha256(new TextEncoder().encode(hashes[i] + hashes[i + 1])))
          );
        } else {
          nextLevel.push(hashes[i]);
        }
      }
      hashes = nextLevel;
    }

    return hashes[0];
  }
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Create a new identity bridge with default behavioral vocabulary and params.
 */
export function createIdentityBridge(
  initialWeights: number[],
  llm: LLMInterface | null = null,
  config: BridgeConfig = DEFAULT_BRIDGE_CONFIG
): IdentityBridge {
  const vocabulary = createBehavioralVocabulary();
  const n = vocabulary.assertions.length;

  if (initialWeights.length !== n) {
    throw new Error(`Initial weights length (${initialWeights.length}) must match vocabulary size (${n})`);
  }

  const params = createBehavioralParams(n);

  const initialState: SelfState = {
    dimension: n,
    w: Float64Array.from(initialWeights),
    m: Float64Array.from(initialWeights),
    time: 0,
  };

  return new IdentityBridge(initialState, vocabulary, params, config, llm);
}

/**
 * Create an identity bridge with custom vocabulary.
 */
export function createCustomIdentityBridge(
  vocabulary: Vocabulary,
  initialWeights: number[],
  params?: DynamicsParams,
  llm: LLMInterface | null = null,
  config: BridgeConfig = DEFAULT_BRIDGE_CONFIG
): IdentityBridge {
  const n = vocabulary.assertions.length;

  if (initialWeights.length !== n) {
    throw new Error(`Initial weights length (${initialWeights.length}) must match vocabulary size (${n})`);
  }

  const finalParams = params || createBehavioralParams(n);

  const initialState: SelfState = {
    dimension: n,
    w: Float64Array.from(initialWeights),
    m: Float64Array.from(initialWeights),
    time: 0,
  };

  return new IdentityBridge(initialState, vocabulary, finalParams, config, llm);
}

/**
 * Create an identity bridge with extended vocabulary (N dimensions).
 *
 * This is the preferred method for creating bridges with custom dimensions
 * that have full semantic meaning and custom metric extractors.
 *
 * @param dimensions - Array of DimensionDefinitions
 * @param initialWeights - Initial weight values (one per dimension)
 * @param llm - Optional LLM interface for reflection
 * @param config - Optional bridge configuration
 */
export function createExtendedIdentityBridge(
  dimensions: readonly DimensionDefinition[],
  initialWeights: number[],
  llm: LLMInterface | null = null,
  config: BridgeConfig = DEFAULT_BRIDGE_CONFIG
): IdentityBridge {
  const vocabulary = createExtendedVocabulary(dimensions);
  const n = dimensions.length;

  if (initialWeights.length !== n) {
    throw new Error(`Initial weights length (${initialWeights.length}) must match dimension count (${n})`);
  }

  const params = createBehavioralParams(n);

  const initialState: SelfState = {
    dimension: n,
    w: Float64Array.from(initialWeights),
    m: Float64Array.from(initialWeights),
    time: 0,
  };

  return new IdentityBridge(initialState, vocabulary, params, config, llm);
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
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
};
