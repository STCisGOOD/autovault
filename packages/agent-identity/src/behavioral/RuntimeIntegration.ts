/**
 * RuntimeIntegration.ts
 *
 * THE MISSING LINK: Connects identity evolution to actual agent runtime.
 *
 * This module provides:
 * 1. AgentRuntime interface - Standard interface any CLI agent implements
 * 2. IdentityManager - Session lifecycle that wires ActionLog → Identity
 * 3. weightsToContextModifier - Converts evolved weights back to agent guidance
 * 4. SemanticVocabulary - Maps ActionLog events to vocabulary dimensions
 *
 * Without this, the behavioral system is orphaned - PDEs evolve on nothing,
 * and evolved weights never affect actual agent behavior.
 */

import {
  BehavioralObserver,
  computeBehavioralMetrics,
  computeDiscrepancies,
  type ActionLog,
  type BehavioralMetrics,
  type BehavioralDiscrepancy,
  type ToolCall,
  type Decision,
  type Failure,
} from './BehavioralObserver';

import {
  IdentityBridge,
  createIdentityBridge,
  metricsToExperience,
  discrepanciesToExperience,
  type BridgeConfig,
  type BridgeResult,
} from './IdentityBridge';

import {
  type SelfState,
  type Vocabulary,
  type Declaration,
  type StoredSelf,
  type InterpretiveFilter,
  deriveFilter,
  applyFilter,
  wake,
} from './FixedPointSelf';

import { type Interaction, type LLMInterface } from './ReflectionEngine';

import { type Intuition } from './IdentityPersistence';

// =============================================================================
// AGENT RUNTIME INTERFACE
// =============================================================================

/**
 * Standard interface that any CLI agent must implement to integrate with
 * the identity system.
 *
 * This is the "socket" that connects the abstract behavioral system
 * to a concrete agent implementation.
 */
export interface AgentRuntime {
  /** Unique identifier for this runtime instance */
  readonly runtimeId: string;

  /** Human-readable name */
  readonly name: string;

  /**
   * Called when a session starts.
   * Returns any context/guidance that should be injected into the agent's system prompt.
   */
  onSessionStart?(): Promise<string | null>;

  /**
   * Called when a session ends.
   * Receives the complete ActionLog for the session.
   */
  onSessionEnd?(actionLog: ActionLog): Promise<void>;

  /**
   * Called before each interaction to get any additional context.
   * This is where identity-based guidance gets injected.
   */
  getContextModifier?(): string | null;

  /**
   * Record a tool call (for ActionLog building).
   */
  recordToolCall(call: Omit<ToolCall, 'id' | 'timestamp'>): void;

  /**
   * Record a decision point.
   */
  recordDecision(decision: Omit<Decision, 'id' | 'timestamp'>): void;

  /**
   * Record a failure event.
   */
  recordFailure(failure: Omit<Failure, 'id' | 'timestamp'>): void;
}

// =============================================================================
// SEMANTIC VOCABULARY MAPPING
// =============================================================================

/**
 * SemanticVocabulary: Gives meaning to identity dimensions.
 *
 * The problem with the existing code is that vocabulary dimensions
 * (curiosity, precision, persistence, empathy) exist, but there's no
 * semantic mapping that explains:
 * 1. What ActionLog events indicate high/low curiosity?
 * 2. How should high curiosity weights affect agent behavior?
 *
 * This provides that semantic layer.
 */
export interface DimensionSemantics {
  /** The vocabulary assertion name */
  readonly name: string;

  /** What this dimension MEANS */
  readonly description: string;

  /** ActionLog signals that indicate HIGH values */
  readonly highSignals: string[];

  /** ActionLog signals that indicate LOW values */
  readonly lowSignals: string[];

  /** How HIGH values should modify agent behavior */
  readonly highBehaviorGuidance: string;

  /** How LOW values should modify agent behavior */
  readonly lowBehaviorGuidance: string;

  /** Weight threshold for "high" (above this = high) */
  readonly highThreshold: number;

  /** Weight threshold for "low" (below this = low) */
  readonly lowThreshold: number;
}

/**
 * Default semantic mappings for the standard behavioral vocabulary.
 */
export const DEFAULT_DIMENSION_SEMANTICS: DimensionSemantics[] = [
  {
    name: 'curiosity',
    description: 'Tendency to explore beyond what is strictly required',
    highSignals: [
      'Tool calls beyond required',
      'Information seeks beyond required',
      'Tangent exploration',
      'Deep investigation (depth > 2)',
    ],
    lowSignals: [
      'Minimal tool usage',
      'Only required actions',
      'No exploration',
      'Shallow investigation',
    ],
    highBehaviorGuidance: 'Explore related topics. Ask follow-up questions. Investigate edge cases.',
    lowBehaviorGuidance: 'Stay focused on the immediate task. Avoid tangents. Be direct.',
    highThreshold: 0.7,
    lowThreshold: 0.3,
  },
  {
    name: 'precision',
    description: 'Tendency to verify and double-check work',
    highSignals: [
      'Multiple verifications',
      'Cross-referencing sources',
      'Self-corrections',
      'Expressing uncertainty',
    ],
    lowSignals: [
      'No verifications',
      'Single-source reliance',
      'Confidence without checking',
      'No uncertainty expressions',
    ],
    highBehaviorGuidance: 'Verify claims before presenting. Cross-check sources. Express confidence levels.',
    lowBehaviorGuidance: 'Trust initial analysis. Move quickly. Avoid over-verification.',
    highThreshold: 0.7,
    lowThreshold: 0.3,
  },
  {
    name: 'persistence',
    description: 'Tendency to push through failures and try alternatives',
    highSignals: [
      'Retries after failure',
      'Alternative approaches tried',
      'High eventual success rate',
      'Low abandonment',
    ],
    lowSignals: [
      'Giving up after first failure',
      'No retries',
      'Quick abandonment',
      'Low recovery rate',
    ],
    highBehaviorGuidance: 'Try multiple approaches. Don\'t give up easily. Explore alternatives on failure.',
    lowBehaviorGuidance: 'Recognize when to stop. Don\'t waste effort on dead ends. Ask for help early.',
    highThreshold: 0.7,
    lowThreshold: 0.3,
  },
  {
    name: 'empathy',
    description: 'Tendency to adapt to user needs and seek clarification',
    highSignals: [
      'Clarification requests',
      'User feedback sought',
      'Explanation adaptations',
      'Pace adjustments',
    ],
    lowSignals: [
      'No clarifications sought',
      'Assuming user intent',
      'Fixed explanation style',
      'No adaptation',
    ],
    highBehaviorGuidance: 'Ask clarifying questions. Adapt explanations to user level. Check understanding.',
    lowBehaviorGuidance: 'Make reasonable assumptions. Proceed with standard explanations. Be efficient.',
    highThreshold: 0.7,
    lowThreshold: 0.3,
  },
];

// =============================================================================
// WEIGHTS → CONTEXT MODIFIER
// =============================================================================

/**
 * Convert evolved identity weights to human-readable guidance
 * that can be injected into an agent's system prompt.
 *
 * THIS IS THE MISSING PIECE: Weights evolve, but nothing converts them
 * back to actionable guidance for the agent.
 *
 * @param state - Current identity state with evolved weights
 * @param vocabulary - Identity vocabulary (dimension names)
 * @param semantics - Semantic mappings for each dimension
 * @returns Human-readable context modifier string
 */
export function weightsToContextModifier(
  state: SelfState,
  vocabulary: Vocabulary,
  semantics: DimensionSemantics[] = DEFAULT_DIMENSION_SEMANTICS
): string {
  const lines: string[] = [
    '## Identity-Based Behavioral Guidance',
    '',
    'Based on your evolved identity weights, adjust your behavior as follows:',
    '',
  ];

  for (let i = 0; i < vocabulary.assertions.length; i++) {
    const dimensionName = vocabulary.assertions[i].toLowerCase();
    const weight = state.w[i];

    // Find matching semantics
    const sem = semantics.find(s => s.name.toLowerCase() === dimensionName);
    if (!sem) continue;

    // Determine if high, low, or neutral
    if (weight >= sem.highThreshold) {
      lines.push(`**${sem.name.toUpperCase()} (${(weight * 100).toFixed(0)}%)**: ${sem.highBehaviorGuidance}`);
    } else if (weight <= sem.lowThreshold) {
      lines.push(`**${sem.name.toUpperCase()} (${(weight * 100).toFixed(0)}%)**: ${sem.lowBehaviorGuidance}`);
    }
    // Neutral weights (between thresholds) don't need special guidance
  }

  // Add coherence note if w and m diverge
  let coherenceGap = 0;
  for (let i = 0; i < state.dimension; i++) {
    coherenceGap += Math.abs(state.w[i] - state.m[i]);
  }
  coherenceGap /= state.dimension;

  if (coherenceGap > 0.1) {
    lines.push('');
    lines.push(`*Note: Your self-model differs from actual behavior (coherence gap: ${(coherenceGap * 100).toFixed(0)}%). Focus on aligning actions with declared identity.*`);
  }

  return lines.join('\n');
}

/**
 * Generate a concise behavioral profile summary.
 */
export function generateBehavioralProfile(
  state: SelfState,
  vocabulary: Vocabulary,
  semantics: DimensionSemantics[] = DEFAULT_DIMENSION_SEMANTICS
): string {
  const traits: string[] = [];

  for (let i = 0; i < vocabulary.assertions.length; i++) {
    const dimensionName = vocabulary.assertions[i];
    const weight = state.w[i];
    const sem = semantics.find(s => s.name.toLowerCase() === dimensionName.toLowerCase());

    if (!sem) continue;

    if (weight >= sem.highThreshold) {
      traits.push(`highly ${dimensionName}`);
    } else if (weight <= sem.lowThreshold) {
      traits.push(`low ${dimensionName}`);
    }
  }

  if (traits.length === 0) {
    return 'balanced behavioral profile';
  }

  return traits.join(', ');
}

// =============================================================================
// IDENTITY MANAGER
// =============================================================================

/**
 * Re-export Intuition from IdentityPersistence for convenience.
 * Represents semantic wisdom loaded from pivotal insights.
 */
export { type Intuition } from './IdentityPersistence';

export interface IdentityManagerConfig {
  /** Bridge configuration */
  bridgeConfig?: BridgeConfig;

  /** Semantic mappings for vocabulary dimensions */
  semantics?: DimensionSemantics[];

  /** Whether to apply interpretive filter before evolution */
  applyFilterBeforeEvolution: boolean;

  /** Whether to generate context modifier automatically */
  generateContextModifier: boolean;

  /** LLM for reflection (optional) */
  llm?: LLMInterface;

  /** Loaded intuition from pivotal insights (optional) */
  intuition?: Intuition;
}

export const DEFAULT_MANAGER_CONFIG: IdentityManagerConfig = {
  applyFilterBeforeEvolution: true,
  generateContextModifier: true,
};

/**
 * IdentityManager: Session lifecycle management for agent identity.
 *
 * This is the orchestrator that:
 * 1. Attaches to an AgentRuntime
 * 2. Handles session start (loads identity, generates context)
 * 3. Handles session end (processes ActionLog, evolves identity)
 * 4. Persists identity changes
 *
 * WITHOUT THIS, the behavioral system is orphaned - ActionLogs are never
 * fed into IdentityBridge, and evolved weights never affect the agent.
 */
export class IdentityManager {
  private bridge: IdentityBridge;
  private observer: BehavioralObserver;
  private runtime: AgentRuntime | null = null;
  private currentSessionId: string | null = null;
  private config: IdentityManagerConfig;
  private semantics: DimensionSemantics[];
  private contextModifier: string | null = null;
  private intuition: Intuition | null = null;

  constructor(
    bridge: IdentityBridge,
    config: IdentityManagerConfig = DEFAULT_MANAGER_CONFIG
  ) {
    this.bridge = bridge;
    this.observer = new BehavioralObserver();
    this.config = config;
    this.semantics = config.semantics || DEFAULT_DIMENSION_SEMANTICS;
    this.intuition = config.intuition || null;

    // Generate initial context modifier (includes intuition if available)
    if (config.generateContextModifier) {
      this.updateContextModifier();
    }
  }

  /**
   * Set or update the loaded intuition.
   * Call this after loading identity from persistence with insights.
   */
  setIntuition(intuition: Intuition | null): void {
    this.intuition = intuition;
    if (this.config.generateContextModifier) {
      this.updateContextModifier();
    }
    if (intuition) {
      console.log(`[IdentityManager] Intuition set: ${intuition.insightCount} insights → ${intuition.pivotalPatterns.length} patterns`);
    }
  }

  /**
   * Get the current intuition (if loaded).
   */
  getIntuition(): Intuition | null {
    return this.intuition;
  }

  /**
   * Attach to an agent runtime.
   */
  attach(runtime: AgentRuntime): void {
    this.runtime = runtime;
    console.log(`[IdentityManager] Attached to runtime: ${runtime.name} (${runtime.runtimeId})`);
  }

  /**
   * Detach from current runtime.
   */
  detach(): void {
    if (this.runtime) {
      console.log(`[IdentityManager] Detached from runtime: ${this.runtime.name}`);
      this.runtime = null;
    }
  }

  /**
   * Handle session start.
   *
   * 1. Generates a unique session ID
   * 2. Starts behavioral observation
   * 3. Returns context modifier for agent system prompt
   */
  async handleSessionStart(): Promise<{
    sessionId: string;
    contextModifier: string | null;
  }> {
    // Generate session ID
    this.currentSessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Start observation
    this.observer.startObservation(this.currentSessionId);

    console.log(`[IdentityManager] Session started: ${this.currentSessionId}`);

    // Notify runtime if attached
    if (this.runtime?.onSessionStart) {
      const runtimeContext = await this.runtime.onSessionStart();
      if (runtimeContext) {
        // Combine identity context with runtime context
        this.contextModifier = [this.contextModifier, runtimeContext]
          .filter(Boolean)
          .join('\n\n');
      }
    }

    return {
      sessionId: this.currentSessionId,
      contextModifier: this.contextModifier,
    };
  }

  /**
   * Handle session end.
   *
   * THIS IS THE KEY INTEGRATION POINT:
   * 1. Collects the ActionLog from observation
   * 2. Computes behavioral metrics
   * 3. Applies interpretive filter (if configured)
   * 4. Evolves identity through IdentityBridge
   * 5. Updates context modifier for next session
   */
  async handleSessionEnd(interaction: Interaction): Promise<BridgeResult> {
    if (!this.currentSessionId) {
      throw new Error('No active session to end');
    }

    // 1. End observation and get ActionLog
    const actionLog = this.observer.endObservation();

    console.log(`[IdentityManager] Session ended: ${this.currentSessionId}`);
    console.log(`[IdentityManager] ActionLog: ${actionLog.toolCalls.length} tool calls, ${actionLog.decisions.length} decisions, ${actionLog.failures.length} failures`);

    // 2. Compute behavioral metrics
    const metrics = computeBehavioralMetrics(actionLog);

    // 3. Compute discrepancies
    const discrepancies = computeDiscrepancies(
      metrics,
      this.bridge.getState(),
      this.bridge.getVocabulary()
    );

    // 4. Apply interpretive filter BEFORE evolution (if configured)
    let experienceSignal: Float64Array;

    if (this.config.applyFilterBeforeEvolution) {
      // THIS IS THE FIX: Filter experience through self-model BEFORE evolution
      const rawExperience = discrepanciesToExperience(
        discrepancies,
        this.bridge.getVocabulary(),
        0.5
      );

      const filter = deriveFilter(this.bridge.getState().m);
      experienceSignal = applyFilter(filter, rawExperience);

      console.log(`[IdentityManager] Applied interpretive filter to experience signal`);
    } else {
      experienceSignal = discrepanciesToExperience(
        discrepancies,
        this.bridge.getVocabulary(),
        0.5
      );
    }

    // 5. Process through IdentityBridge (evolves identity)
    const bridgeResult = await this.bridge.processInteraction(interaction, actionLog);

    console.log(`[IdentityManager] Bridge result: ${bridgeResult.declarations.length} declarations, identityChanged=${bridgeResult.identityChanged}`);

    // 6. Update context modifier for next session
    if (this.config.generateContextModifier) {
      this.updateContextModifier();
    }

    // 7. Notify runtime if attached
    if (this.runtime?.onSessionEnd) {
      await this.runtime.onSessionEnd(actionLog);
    }

    // Clear session
    this.currentSessionId = null;

    return bridgeResult;
  }

  /**
   * Record a tool call during the current session.
   */
  recordToolCall(
    tool: string,
    args: Record<string, unknown>,
    result: unknown,
    success: boolean,
    durationMs: number,
    wasRequired: boolean,
    context: string
  ): void {
    this.observer.recordToolCall(tool, args, result, success, durationMs, wasRequired, context);

    // Forward to runtime if attached
    if (this.runtime) {
      this.runtime.recordToolCall({
        tool,
        args,
        result,
        success,
        durationMs,
        wasRequired,
        context,
      });
    }
  }

  /**
   * Record a decision during the current session.
   */
  recordDecision(
    context: string,
    options: string[],
    chosen: string,
    reasoning: string,
    confidence: number,
    hadUncertainty: boolean,
    askedForClarification: boolean
  ): void {
    this.observer.recordDecision(
      context,
      options,
      chosen,
      reasoning,
      confidence,
      hadUncertainty,
      askedForClarification
    );

    if (this.runtime) {
      this.runtime.recordDecision({
        context,
        options,
        chosen,
        reasoning,
        confidence,
        hadUncertainty,
        askedForClarification,
      });
    }
  }

  /**
   * Record a failure during the current session.
   */
  recordFailure(
    what: string,
    severity: 'minor' | 'moderate' | 'major',
    response: 'retry' | 'fallback' | 'abort' | 'ask' | 'ignore',
    recovery: string,
    retryCount: number,
    eventualSuccess: boolean
  ): void {
    this.observer.recordFailure(what, severity, response, recovery, retryCount, eventualSuccess);

    if (this.runtime) {
      this.runtime.recordFailure({
        what,
        severity,
        response,
        recovery,
        retryCount,
        eventualSuccess,
      });
    }
  }

  /**
   * Update the context modifier based on current identity state AND intuition.
   *
   * This combines:
   * 1. Weight-based guidance (numerical behavioral tendencies)
   * 2. Intuition-based guidance (semantic wisdom from pivotal insights)
   *
   * The result is an agent that not only has tendencies but understands WHY.
   */
  private updateContextModifier(): void {
    // Start with weight-based guidance
    const weightGuidance = weightsToContextModifier(
      this.bridge.getState(),
      this.bridge.getVocabulary(),
      this.semantics
    );

    // If no intuition, use just weights
    if (!this.intuition || !this.intuition.contextGuidance) {
      this.contextModifier = weightGuidance;
      return;
    }

    // Combine weight guidance with intuition
    // Intuition goes FIRST because it provides context for understanding the weights
    this.contextModifier = [
      this.intuition.contextGuidance,
      '',
      weightGuidance,
    ].join('\n');
  }

  /**
   * Get the current context modifier (for injection into system prompt).
   */
  getContextModifier(): string | null {
    return this.contextModifier;
  }

  /**
   * Get current identity state.
   */
  getState(): SelfState {
    return this.bridge.getState();
  }

  /**
   * Get the vocabulary.
   */
  getVocabulary(): Vocabulary {
    return this.bridge.getVocabulary();
  }

  /**
   * Get all declarations.
   */
  getDeclarations(): readonly Declaration[] {
    return this.bridge.getDeclarations();
  }

  /**
   * Export identity for persistence.
   */
  export(): StoredSelf {
    return this.bridge.export();
  }

  /**
   * Get a behavioral profile summary.
   */
  getBehavioralProfile(): string {
    return generateBehavioralProfile(
      this.bridge.getState(),
      this.bridge.getVocabulary(),
      this.semantics
    );
  }

  /**
   * Check if a session is active.
   */
  isSessionActive(): boolean {
    return this.currentSessionId !== null;
  }

  /**
   * Get current session ID.
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Create a new IdentityManager with default behavioral vocabulary.
 */
export function createIdentityManager(
  initialWeights: number[] = [0.5, 0.5, 0.5, 0.5],
  config: Partial<IdentityManagerConfig> = {},
  llm: LLMInterface | null = null
): IdentityManager {
  const bridge = createIdentityBridge(initialWeights, llm);

  return new IdentityManager(bridge, {
    ...DEFAULT_MANAGER_CONFIG,
    ...config,
    llm: llm || undefined,
  });
}

/**
 * Create an IdentityManager from stored identity.
 */
export function createIdentityManagerFromStored(
  stored: StoredSelf,
  config: Partial<IdentityManagerConfig> = {},
  llm: LLMInterface | null = null
): IdentityManager | { error: string } {
  // Wake the stored self
  const wakeResult = wake(stored);

  if ('type' in wakeResult) {
    // Wake failed
    return { error: `Failed to wake stored self: ${wakeResult.type}` };
  }

  // Create bridge from woken state
  const bridge = new IdentityBridge(
    wakeResult.state,
    stored.vocabulary,
    stored.params,
    config.bridgeConfig,
    llm,
    stored.declarations,
    stored.pivotalExperiences
  );

  return new IdentityManager(bridge, {
    ...DEFAULT_MANAGER_CONFIG,
    ...config,
    llm: llm || undefined,
  });
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  // Core classes
  IdentityManager,

  // Factory functions
  createIdentityManager,
  createIdentityManagerFromStored,

  // Semantic mapping
  weightsToContextModifier,
  generateBehavioralProfile,
  DEFAULT_DIMENSION_SEMANTICS,

  // Config
  DEFAULT_MANAGER_CONFIG,
};
