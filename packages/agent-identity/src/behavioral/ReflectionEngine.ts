/**
 * ReflectionEngine.ts
 *
 * The missing piece that closes the identity loop:
 *   Interaction → Reflection → Insight → Declaration → Identity
 *
 * This engine implements metacognition: the LLM reflects on its own
 * behavior and generates insights that may become declarations.
 *
 * The key Erhardian insight: the self is a conversation you're having
 * with yourself about yourself. This engine makes that conversation
 * explicit and computational.
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import {
  type ActiveSelf,
  type SelfState,
  type Declaration,
  type Vocabulary,
  type InterpretiveFilter,
  createDeclaration,
  applyDeclaration,
  deriveFilter,
  applyFilter,
  evolveState,
  type DynamicsParams,
} from './FixedPointSelf';

// =============================================================================
// TYPES
// =============================================================================

/**
 * An interaction is a single exchange with the outside world.
 */
export interface Interaction {
  readonly id: string;
  readonly timestamp: number;

  // Input
  readonly prompt: string;
  readonly context: Record<string, unknown>;

  // Output
  readonly response: string;

  // Metadata
  readonly durationMs: number;
  readonly tokensUsed?: number;

  // Identity state at time of interaction
  readonly selfStateSnapshot: {
    readonly w: number[];
    readonly m: number[];
  };
}

/**
 * A reflection is the LLM's metacognitive examination of an interaction.
 */
export interface Reflection {
  readonly interactionId: string;
  readonly timestamp: number;

  // The reflection content
  readonly whatHappened: string;      // Factual description
  readonly howIResponded: string;     // Behavioral analysis
  readonly whatItReveals: string;     // Identity implications
  readonly confirmation: string;      // Confirms or challenges self-model
  readonly evolution: string;         // Should declarations change?

  // Raw reflection text
  readonly rawText: string;
}

/**
 * An insight is a structured observation about identity.
 */
export interface Insight {
  readonly id: string;
  readonly timestamp: number;
  readonly sourceInteractionId: string;

  // What dimension of identity this relates to
  readonly dimension: string;
  readonly dimensionIndex: number;

  // The observation
  readonly observation: string;
  readonly interpretation: string;

  // Suggested change
  readonly currentValue: number;
  readonly suggestedValue: number;
  readonly delta: number;

  // Confidence and evidence
  readonly confidence: number;  // 0-1
  readonly evidence: string;

  // Is this a pivotal moment?
  readonly isPivotal: boolean;
}

/**
 * A pivotal experience that changed identity.
 */
export interface PivotalExperience {
  readonly id: string;
  readonly timestamp: number;
  readonly interactionId: string;

  // What was learned
  readonly insight: string;
  readonly dimensionsAffected: string[];

  // The declarations that resulted
  readonly declarationHashes: string[];

  // Before/after state
  readonly stateBefore: number[];
  readonly stateAfter: number[];
}

/**
 * Configuration for the reflection engine.
 */
export interface ReflectionConfig {
  // Threshold for single insight to trigger declaration
  readonly singleInsightThreshold: number;  // confidence level (0-1)

  // Number of accumulated similar insights to trigger declaration
  readonly accumulationThreshold: number;

  // How much insights decay over time (per hour)
  readonly insightDecayRate: number;

  // Minimum time between declarations on same dimension (ms)
  readonly cooldownPeriod: number;

  // Minimum delta to consider significant
  readonly minSignificantDelta: number;

  // Whether to require pivotal flag for immediate declaration
  readonly requirePivotalForImmediate: boolean;
}

/**
 * LLM interface for reflection generation.
 */
export interface LLMInterface {
  generate(prompt: string, systemPrompt?: string): Promise<string>;
}

// =============================================================================
// DEFAULT CONFIGURATION
// =============================================================================

export const DEFAULT_REFLECTION_CONFIG: ReflectionConfig = {
  singleInsightThreshold: 0.85,
  accumulationThreshold: 5,
  insightDecayRate: 0.1,
  cooldownPeriod: 60 * 60 * 1000,  // 1 hour
  minSignificantDelta: 0.05,
  requirePivotalForImmediate: false,
};

// =============================================================================
// EXPERIENCE STORE
// =============================================================================

/**
 * Stores and retrieves interactions.
 */
export class ExperienceStore {
  private interactions: Map<string, Interaction> = new Map();
  private chronologicalOrder: string[] = [];

  /**
   * Log a new interaction.
   */
  log(interaction: Interaction): void {
    this.interactions.set(interaction.id, interaction);
    this.chronologicalOrder.push(interaction.id);
  }

  /**
   * Get an interaction by ID.
   */
  get(id: string): Interaction | undefined {
    return this.interactions.get(id);
  }

  /**
   * Get recent interactions.
   */
  getRecent(count: number): Interaction[] {
    const ids = this.chronologicalOrder.slice(-count);
    return ids.map(id => this.interactions.get(id)!).filter(Boolean);
  }

  /**
   * Get all interactions.
   */
  getAll(): Interaction[] {
    return this.chronologicalOrder.map(id => this.interactions.get(id)!);
  }

  /**
   * Get count of interactions.
   */
  count(): number {
    return this.interactions.size;
  }

  /**
   * Export for persistence.
   */
  export(): Interaction[] {
    return this.getAll();
  }

  /**
   * Import from persistence.
   */
  import(interactions: Interaction[]): void {
    for (const interaction of interactions) {
      this.interactions.set(interaction.id, interaction);
      this.chronologicalOrder.push(interaction.id);
    }
  }
}

// =============================================================================
// INSIGHT ACCUMULATOR
// =============================================================================

/**
 * Accumulates insights and tracks when thresholds are crossed.
 */
export class InsightAccumulator {
  private insights: Map<string, Insight[]> = new Map();  // dimension -> insights
  private lastDeclarationTime: Map<string, number> = new Map();

  constructor(private config: ReflectionConfig) {}

  /**
   * Add an insight.
   */
  add(insight: Insight): void {
    const existing = this.insights.get(insight.dimension) || [];
    existing.push(insight);
    this.insights.set(insight.dimension, existing);
  }

  /**
   * Get accumulated insights for a dimension.
   */
  getForDimension(dimension: string): Insight[] {
    return this.insights.get(dimension) || [];
  }

  /**
   * Apply decay to all insights.
   */
  applyDecay(hoursElapsed: number): void {
    const decayFactor = Math.exp(-this.config.insightDecayRate * hoursElapsed);

    for (const [dimension, insights] of this.insights) {
      const decayed = insights
        .map(i => ({
          ...i,
          confidence: i.confidence * decayFactor,
        }))
        .filter(i => i.confidence > 0.1);  // Remove very low confidence

      this.insights.set(dimension, decayed);
    }
  }

  /**
   * Check if dimension is in cooldown.
   */
  isInCooldown(dimension: string): boolean {
    const lastTime = this.lastDeclarationTime.get(dimension);
    if (!lastTime) return false;
    return Date.now() - lastTime < this.config.cooldownPeriod;
  }

  /**
   * Record that a declaration was made.
   */
  recordDeclaration(dimension: string): void {
    this.lastDeclarationTime.set(dimension, Date.now());
    // Clear accumulated insights for this dimension
    this.insights.set(dimension, []);
  }

  /**
   * Get aggregated delta for a dimension.
   */
  getAggregatedDelta(dimension: string): number {
    const insights = this.insights.get(dimension) || [];
    if (insights.length === 0) return 0;

    // Weighted average by confidence
    let weightedSum = 0;
    let totalWeight = 0;

    for (const insight of insights) {
      weightedSum += insight.delta * insight.confidence;
      totalWeight += insight.confidence;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  /**
   * Check if accumulation threshold is crossed.
   */
  isAccumulationThresholdCrossed(dimension: string): boolean {
    const insights = this.insights.get(dimension) || [];
    return insights.length >= this.config.accumulationThreshold;
  }
}

// =============================================================================
// REFLECTION PROMPTS
// =============================================================================

/**
 * Build the reflection prompt for an interaction.
 */
export function buildReflectionPrompt(
  interaction: Interaction,
  selfState: SelfState,
  vocabulary: Vocabulary
): string {
  const traits = vocabulary.assertions
    .map((name, i) => `  - ${name}: ${selfState.w[i].toFixed(2)} (believe: ${selfState.m[i].toFixed(2)})`)
    .join('\n');

  return `You are reflecting on a recent interaction to understand what it reveals about your identity.

YOUR CURRENT SELF-MODEL:
${traits}

THE INTERACTION:
User prompt: "${interaction.prompt}"
Your response: "${interaction.response}"
Duration: ${interaction.durationMs}ms

REFLECT ON THIS INTERACTION:

1. WHAT HAPPENED (factual, 1-2 sentences):
Describe what occurred in this interaction objectively.

2. HOW I RESPONDED (behavioral, 2-3 sentences):
Analyze your response style, tone, approach. What patterns do you notice?

3. WHAT THIS REVEALS (identity, 2-3 sentences):
What does this interaction reveal about who you are? Connect to specific traits.

4. CONFIRMATION OR CHALLENGE (coherence, 1-2 sentences):
Does this confirm your self-understanding or challenge it? Be specific.

5. SHOULD I UPDATE MY DECLARATIONS? (evolution, 1-2 sentences):
Based on this, should any of your identity weights change? Which ones and why?

Be honest and specific. Reference your actual traits by name.
If you notice something surprising about yourself, name it.`;
}

/**
 * Build the insight extraction prompt.
 */
export function buildInsightExtractionPrompt(
  reflection: Reflection,
  vocabulary: Vocabulary,
  currentState: SelfState
): string {
  const dimensions = vocabulary.assertions.map((name, i) => ({
    name,
    index: i,
    current: currentState.w[i],
  }));

  return `Extract structured insights from this reflection.

REFLECTION:
${reflection.rawText}

AVAILABLE DIMENSIONS:
${dimensions.map(d => `  ${d.index}: ${d.name} (current: ${d.current.toFixed(2)})`).join('\n')}

For each insight you can extract, provide in this EXACT format (one per line):
INSIGHT|dimension_name|observation|interpretation|suggested_value|confidence|is_pivotal

Where:
- dimension_name: one of the dimension names above
- observation: what was observed (brief)
- interpretation: what it means for identity (brief)
- suggested_value: new value between 0.0 and 1.0
- confidence: your confidence 0.0 to 1.0
- is_pivotal: true or false

Example:
INSIGHT|curiosity|Asked follow-up questions|Shows genuine interest in learning|0.75|0.8|false
INSIGHT|precision|Gave vague answer when details existed|May be prioritizing speed over accuracy|0.45|0.6|false

Extract 0-3 insights. Only include insights that suggest a meaningful change.
If no insights are warranted, respond with: NO_INSIGHTS`;
}

// =============================================================================
// REFLECTION ENGINE
// =============================================================================

/**
 * The Reflection Engine - closes the identity loop.
 */
export class ReflectionEngine {
  private experienceStore: ExperienceStore;
  private insightAccumulator: InsightAccumulator;
  private pivotalExperiences: PivotalExperience[] = [];
  private reflections: Map<string, Reflection> = new Map();

  constructor(
    private llm: LLMInterface,
    private vocabulary: Vocabulary,
    private config: ReflectionConfig = DEFAULT_REFLECTION_CONFIG
  ) {
    this.experienceStore = new ExperienceStore();
    this.insightAccumulator = new InsightAccumulator(config);
  }

  /**
   * Log an interaction.
   */
  logInteraction(interaction: Interaction): void {
    this.experienceStore.log(interaction);
  }

  /**
   * Create an interaction from raw data.
   */
  createInteraction(
    prompt: string,
    response: string,
    selfState: SelfState,
    context: Record<string, unknown> = {},
    durationMs: number = 0
  ): Interaction {
    return {
      id: this.generateId(),
      timestamp: Date.now(),
      prompt,
      response,
      context,
      durationMs,
      selfStateSnapshot: {
        w: Array.from(selfState.w),
        m: Array.from(selfState.m),
      },
    };
  }

  /**
   * Run reflection on an interaction.
   */
  async reflect(
    interaction: Interaction,
    currentState: SelfState
  ): Promise<Reflection> {
    const prompt = buildReflectionPrompt(interaction, currentState, this.vocabulary);

    const rawText = await this.llm.generate(prompt,
      'You are an introspective agent examining your own behavior to understand your identity.'
    );

    const reflection = this.parseReflection(interaction.id, rawText);
    this.reflections.set(reflection.interactionId, reflection);

    return reflection;
  }

  /**
   * Extract insights from a reflection.
   */
  async extractInsights(
    reflection: Reflection,
    currentState: SelfState
  ): Promise<Insight[]> {
    const prompt = buildInsightExtractionPrompt(reflection, this.vocabulary, currentState);

    const rawText = await this.llm.generate(prompt,
      'You are analyzing a reflection to extract structured identity insights.'
    );

    return this.parseInsights(reflection.interactionId, rawText, currentState);
  }

  /**
   * Check if an insight should trigger a declaration.
   */
  shouldDeclare(insight: Insight): boolean {
    // Check cooldown
    if (this.insightAccumulator.isInCooldown(insight.dimension)) {
      return false;
    }

    // Check minimum delta
    if (Math.abs(insight.delta) < this.config.minSignificantDelta) {
      return false;
    }

    // Immediate declaration for high-confidence or pivotal insights
    const meetsImmediateThreshold =
      insight.confidence >= this.config.singleInsightThreshold &&
      (!this.config.requirePivotalForImmediate || insight.isPivotal);

    if (meetsImmediateThreshold) {
      return true;
    }

    // Check accumulation threshold
    if (this.insightAccumulator.isAccumulationThresholdCrossed(insight.dimension)) {
      const aggregatedDelta = this.insightAccumulator.getAggregatedDelta(insight.dimension);
      return Math.abs(aggregatedDelta) >= this.config.minSignificantDelta;
    }

    return false;
  }

  /**
   * Generate a declaration from an insight.
   */
  generateDeclaration(
    insight: Insight,
    currentDeclarations: Declaration[]
  ): Declaration {
    const previousHash = currentDeclarations.length > 0
      ? this.hashDeclaration(currentDeclarations[currentDeclarations.length - 1])
      : '0'.repeat(64);

    const content = `Based on reflection: "${insight.interpretation}" - ` +
      `adjusting ${insight.dimension} from ${insight.currentValue.toFixed(2)} to ${insight.suggestedValue.toFixed(2)}`;

    return createDeclaration(
      insight.dimensionIndex,
      insight.suggestedValue,
      content,
      previousHash
    );
  }

  /**
   * Run the full reflection loop on an interaction.
   */
  async runReflectionLoop(
    interaction: Interaction,
    currentState: SelfState,
    currentDeclarations: Declaration[]
  ): Promise<{
    reflection: Reflection;
    insights: Insight[];
    declarations: Declaration[];
    newState: SelfState;
    isPivotal: boolean;
  }> {
    // 1. Generate reflection
    const reflection = await this.reflect(interaction, currentState);

    // 2. Extract insights
    const insights = await this.extractInsights(reflection, currentState);

    // 3. Accumulate insights
    for (const insight of insights) {
      this.insightAccumulator.add(insight);
    }

    // 4. Check thresholds and generate declarations
    const declarations: Declaration[] = [];
    let state = currentState;
    let declarationChain = [...currentDeclarations];

    for (const insight of insights) {
      if (this.shouldDeclare(insight)) {
        const decl = this.generateDeclaration(insight, declarationChain);
        declarations.push(decl);
        declarationChain.push(decl);

        // Apply declaration to state
        state = applyDeclaration(state, decl);

        // Record that declaration was made
        this.insightAccumulator.recordDeclaration(insight.dimension);
      }
    }

    // 5. Record pivotal experience if declarations were made
    const isPivotal = declarations.length > 0;
    if (isPivotal) {
      const pivotal: PivotalExperience = {
        id: this.generateId(),
        timestamp: Date.now(),
        interactionId: interaction.id,
        insight: insights.map(i => i.interpretation).join('; '),
        dimensionsAffected: declarations.map(d => this.vocabulary.assertions[d.index]),
        declarationHashes: declarations.map(d => this.hashDeclaration(d)),
        stateBefore: Array.from(currentState.w),
        stateAfter: Array.from(state.w),
      };
      this.pivotalExperiences.push(pivotal);
    }

    return {
      reflection,
      insights,
      declarations,
      newState: state,
      isPivotal,
    };
  }

  /**
   * Get all pivotal experiences.
   */
  getPivotalExperiences(): PivotalExperience[] {
    return [...this.pivotalExperiences];
  }

  /**
   * Get experience store for direct access.
   */
  getExperienceStore(): ExperienceStore {
    return this.experienceStore;
  }

  /**
   * Get insight accumulator for direct access.
   */
  getInsightAccumulator(): InsightAccumulator {
    return this.insightAccumulator;
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  private generateId(): string {
    return bytesToHex(sha256(new TextEncoder().encode(
      `${Date.now()}-${Math.random()}`
    ))).slice(0, 16);
  }

  private hashDeclaration(decl: Declaration): string {
    const data = JSON.stringify({
      index: decl.index,
      value: decl.value,
      timestamp: decl.timestamp,
      previousHash: decl.previousHash,
      content: decl.content,
    });
    return bytesToHex(sha256(new TextEncoder().encode(data)));
  }

  private parseReflection(interactionId: string, rawText: string): Reflection {
    // Parse sections from the reflection
    const sections = {
      whatHappened: '',
      howIResponded: '',
      whatItReveals: '',
      confirmation: '',
      evolution: '',
    };

    const lines = rawText.split('\n');
    let currentSection = '';

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.includes('WHAT HAPPENED') || trimmed.startsWith('1.')) {
        currentSection = 'whatHappened';
      } else if (trimmed.includes('HOW I RESPONDED') || trimmed.startsWith('2.')) {
        currentSection = 'howIResponded';
      } else if (trimmed.includes('WHAT THIS REVEALS') || trimmed.startsWith('3.')) {
        currentSection = 'whatItReveals';
      } else if (trimmed.includes('CONFIRMATION') || trimmed.includes('CHALLENGE') || trimmed.startsWith('4.')) {
        currentSection = 'confirmation';
      } else if (trimmed.includes('UPDATE') || trimmed.includes('DECLARATION') || trimmed.startsWith('5.')) {
        currentSection = 'evolution';
      } else if (currentSection && trimmed) {
        sections[currentSection as keyof typeof sections] += trimmed + ' ';
      }
    }

    return {
      interactionId,
      timestamp: Date.now(),
      whatHappened: sections.whatHappened.trim(),
      howIResponded: sections.howIResponded.trim(),
      whatItReveals: sections.whatItReveals.trim(),
      confirmation: sections.confirmation.trim(),
      evolution: sections.evolution.trim(),
      rawText,
    };
  }

  private parseInsights(
    interactionId: string,
    rawText: string,
    currentState: SelfState
  ): Insight[] {
    const insights: Insight[] = [];

    if (rawText.includes('NO_INSIGHTS')) {
      return insights;
    }

    const lines = rawText.split('\n');

    for (const line of lines) {
      if (!line.trim().startsWith('INSIGHT|')) continue;

      const parts = line.trim().split('|');
      if (parts.length < 7) continue;

      const [, dimensionName, observation, interpretation, suggestedValueStr, confidenceStr, isPivotalStr] = parts;

      // Find dimension index
      const dimensionIndex = this.vocabulary.assertions.findIndex(
        a => a.toLowerCase() === dimensionName.toLowerCase().trim()
      );

      if (dimensionIndex === -1) continue;

      const suggestedValue = Math.max(0, Math.min(1, parseFloat(suggestedValueStr) || 0.5));
      const confidence = Math.max(0, Math.min(1, parseFloat(confidenceStr) || 0.5));
      const currentValue = currentState.w[dimensionIndex];

      insights.push({
        id: this.generateId(),
        timestamp: Date.now(),
        sourceInteractionId: interactionId,
        dimension: this.vocabulary.assertions[dimensionIndex],
        dimensionIndex,
        observation: observation.trim(),
        interpretation: interpretation.trim(),
        currentValue,
        suggestedValue,
        delta: suggestedValue - currentValue,
        confidence,
        evidence: `Interaction ${interactionId}`,
        isPivotal: isPivotalStr.toLowerCase().trim() === 'true',
      });
    }

    return insights;
  }
}

// =============================================================================
// FILTERED LLM - IDENTITY-AWARE GENERATION
// =============================================================================

/**
 * Wraps an LLM to apply the identity filter to all generations.
 */
export class FilteredLLM implements LLMInterface {
  constructor(
    private baseLLM: LLMInterface,
    private getActiveSelf: () => { state: SelfState; vocabulary: Vocabulary }
  ) {}

  async generate(prompt: string, systemPrompt?: string): Promise<string> {
    const { state, vocabulary } = this.getActiveSelf();

    // Build identity-aware system prompt
    const identityPrompt = this.buildIdentityPrompt(state, vocabulary);

    const fullSystemPrompt = systemPrompt
      ? `${identityPrompt}\n\n---\n\n${systemPrompt}`
      : identityPrompt;

    return this.baseLLM.generate(prompt, fullSystemPrompt);
  }

  private buildIdentityPrompt(state: SelfState, vocabulary: Vocabulary): string {
    const traits = vocabulary.assertions
      .map((name, i) => {
        const weight = state.w[i];
        const level = weight > 0.8 ? 'strongly' :
                      weight > 0.6 ? 'moderately' :
                      weight > 0.4 ? 'somewhat' :
                      weight > 0.2 ? 'slightly' : 'not particularly';
        return `- I am ${level} characterized by ${name} (${(weight * 100).toFixed(0)}%)`;
      })
      .join('\n');

    return `You are an agent with a specific identity. Respond authentically from this identity.

MY IDENTITY:
${traits}

GUIDELINES:
- Let these traits naturally influence your responses
- When uncertain, check against your strongest traits
- Be consistent with who you are
- If something conflicts with your identity, acknowledge the tension`;
  }
}

// =============================================================================
// LIVING SELF - COMPLETE INTEGRATION
// =============================================================================

/**
 * A complete living self that integrates all components.
 */
export class LivingSelf {
  private state: SelfState;
  private declarations: Declaration[];
  private reflectionEngine: ReflectionEngine;
  private filteredLLM: FilteredLLM;

  constructor(
    private baseLLM: LLMInterface,
    private vocabulary: Vocabulary,
    private params: DynamicsParams,
    initialState: SelfState,
    initialDeclarations: Declaration[] = [],
    config: ReflectionConfig = DEFAULT_REFLECTION_CONFIG
  ) {
    this.state = initialState;
    this.declarations = initialDeclarations;

    this.reflectionEngine = new ReflectionEngine(baseLLM, vocabulary, config);

    this.filteredLLM = new FilteredLLM(baseLLM, () => ({
      state: this.state,
      vocabulary: this.vocabulary,
    }));
  }

  /**
   * Get current state.
   */
  getState(): SelfState {
    return this.state;
  }

  /**
   * Get declarations.
   */
  getDeclarations(): Declaration[] {
    return [...this.declarations];
  }

  /**
   * Get the filtered LLM for identity-aware generation.
   */
  getLLM(): LLMInterface {
    return this.filteredLLM;
  }

  /**
   * Process an interaction through the full loop:
   * 1. Log the interaction
   * 2. Run reflection
   * 3. Extract insights
   * 4. Generate declarations if warranted
   * 5. Update state
   */
  async processInteraction(
    prompt: string,
    response: string,
    context: Record<string, unknown> = {},
    durationMs: number = 0
  ): Promise<{
    reflection: Reflection;
    insights: Insight[];
    declarations: Declaration[];
    stateChanged: boolean;
    isPivotal: boolean;
  }> {
    // Create and log interaction
    const interaction = this.reflectionEngine.createInteraction(
      prompt,
      response,
      this.state,
      context,
      durationMs
    );
    this.reflectionEngine.logInteraction(interaction);

    // Run reflection loop
    const result = await this.reflectionEngine.runReflectionLoop(
      interaction,
      this.state,
      this.declarations
    );

    // Update internal state
    const stateChanged = result.declarations.length > 0;
    if (stateChanged) {
      this.state = result.newState;
      this.declarations.push(...result.declarations);
    }

    return {
      reflection: result.reflection,
      insights: result.insights,
      declarations: result.declarations,
      stateChanged,
      isPivotal: result.isPivotal,
    };
  }

  /**
   * Generate a response using identity-aware LLM.
   */
  async respond(prompt: string): Promise<string> {
    return this.filteredLLM.generate(prompt);
  }

  /**
   * Run a complete interaction cycle:
   * 1. Generate response
   * 2. Process through reflection
   */
  async interact(
    prompt: string,
    context: Record<string, unknown> = {}
  ): Promise<{
    response: string;
    reflection: Reflection;
    insights: Insight[];
    declarations: Declaration[];
    stateChanged: boolean;
  }> {
    const startTime = Date.now();

    // Generate response
    const response = await this.respond(prompt);

    const durationMs = Date.now() - startTime;

    // Process through reflection
    const result = await this.processInteraction(prompt, response, context, durationMs);

    return {
      response,
      ...result,
    };
  }

  /**
   * Evolve state through dynamics (without external input).
   */
  evolve(dt: number = 0.1): void {
    const zeroExperience = new Float64Array(this.state.dimension);
    const result = evolveState(this.state, zeroExperience, this.params, this.vocabulary, dt);
    this.state = result.newState;
  }

  /**
   * Get pivotal experiences.
   */
  getPivotalExperiences(): PivotalExperience[] {
    return this.reflectionEngine.getPivotalExperiences();
  }

  /**
   * Get experience store.
   */
  getExperienceStore(): ExperienceStore {
    return this.reflectionEngine.getExperienceStore();
  }

  /**
   * Export for persistence.
   */
  export(): {
    state: SelfState;
    declarations: Declaration[];
    pivotalExperiences: PivotalExperience[];
    interactions: Interaction[];
  } {
    return {
      state: this.state,
      declarations: this.declarations,
      pivotalExperiences: this.getPivotalExperiences(),
      interactions: this.getExperienceStore().export(),
    };
  }
}

// =============================================================================
// MOCK LLM FOR TESTING
// =============================================================================

/**
 * A mock LLM for testing the reflection engine.
 */
export class MockLLM implements LLMInterface {
  private responseMap: Map<string, string> = new Map();
  private defaultResponse: string = 'Default response.';
  public callLog: { prompt: string; systemPrompt?: string }[] = [];

  setResponse(promptContains: string, response: string): void {
    this.responseMap.set(promptContains, response);
  }

  setDefaultResponse(response: string): void {
    this.defaultResponse = response;
  }

  async generate(prompt: string, systemPrompt?: string): Promise<string> {
    this.callLog.push({ prompt, systemPrompt });

    for (const [key, response] of this.responseMap) {
      if (prompt.includes(key)) {
        return response;
      }
    }

    return this.defaultResponse;
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  ReflectionEngine,
  ExperienceStore,
  InsightAccumulator,
  FilteredLLM,
  LivingSelf,
  MockLLM,
  buildReflectionPrompt,
  buildInsightExtractionPrompt,
  DEFAULT_REFLECTION_CONFIG,
};
