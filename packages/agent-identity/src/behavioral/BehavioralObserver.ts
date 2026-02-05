/**
 * BehavioralObserver.ts
 *
 * Grounds identity evolution in actual behavior, not self-report.
 *
 * The key insight: Identity isn't what you say you are.
 * It's what you do when no one's explicitly asking.
 *
 * This module observes:
 * - Tool usage patterns
 * - Decision-making under uncertainty
 * - Failure responses and recovery
 * - Resource allocation choices
 * - Information seeking behavior
 * - Verification and validation patterns
 *
 * These observations feed into behavioral metrics that ground
 * the reflection process in reality.
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import {
  type SelfState,
  type Vocabulary,
  type Declaration,
} from './FixedPointSelf';

import {
  type Interaction,
  type Insight,
  type LLMInterface,
} from './ReflectionEngine';

// =============================================================================
// BEHAVIORAL EVENT TYPES
// =============================================================================

/**
 * A tool call made by the agent.
 */
export interface ToolCall {
  readonly id: string;
  readonly timestamp: number;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly result: unknown;
  readonly success: boolean;
  readonly durationMs: number;
  readonly wasRequired: boolean;  // Was this tool call necessary for the task?
  readonly context: string;       // Why was this called?
}

/**
 * A decision point where the agent chose between options.
 */
export interface Decision {
  readonly id: string;
  readonly timestamp: number;
  readonly context: string;
  readonly options: string[];
  readonly chosen: string;
  readonly reasoning: string;
  readonly confidence: number;
  readonly hadUncertainty: boolean;
  readonly askedForClarification: boolean;
}

/**
 * A failure event and how the agent responded.
 */
export interface Failure {
  readonly id: string;
  readonly timestamp: number;
  readonly what: string;
  readonly severity: 'minor' | 'moderate' | 'major';
  readonly response: 'retry' | 'fallback' | 'abort' | 'ask' | 'ignore';
  readonly recovery: string;
  readonly retryCount: number;
  readonly eventualSuccess: boolean;
}

/**
 * An information-seeking action.
 */
export interface InformationSeek {
  readonly id: string;
  readonly timestamp: number;
  readonly query: string;
  readonly source: 'tool' | 'user' | 'memory' | 'inference';
  readonly wasRequired: boolean;
  readonly depthLevel: number;  // How many levels deep did it go?
  readonly foundAnswer: boolean;
}

/**
 * A verification action - checking or validating something.
 */
export interface Verification {
  readonly id: string;
  readonly timestamp: number;
  readonly what: string;
  readonly method: 'tool' | 'reasoning' | 'user' | 'cross-reference';
  readonly result: 'confirmed' | 'refuted' | 'uncertain';
  readonly wasRequired: boolean;
}

/**
 * Resource usage in a session.
 */
export interface ResourceUsage {
  readonly tokensUsed: number;
  readonly toolCallCount: number;
  readonly wallTimeMs: number;
  readonly apiCalls: number;
  readonly retriesTotal: number;
}

// =============================================================================
// ACTION LOG
// =============================================================================

/**
 * Complete log of actions taken during an interaction.
 */
export interface ActionLog {
  readonly interactionId: string;
  readonly startTime: number;
  readonly endTime: number;

  readonly toolCalls: ToolCall[];
  readonly decisions: Decision[];
  readonly failures: Failure[];
  readonly informationSeeks: InformationSeek[];
  readonly verifications: Verification[];
  readonly resourceUsage: ResourceUsage;
}

// =============================================================================
// BEHAVIORAL METRICS
// =============================================================================

/**
 * Metrics computed from actual behavior, mapped to identity dimensions.
 */
export interface BehavioralMetrics {
  // Curiosity: Does it actually explore?
  readonly curiosity: {
    readonly toolCallsBeyondRequired: number;
    readonly informationSeeksBeyondRequired: number;
    readonly tangentsExplored: number;
    readonly depthOfInvestigation: number;  // Average depth level
    readonly noveltySeekingScore: number;   // 0-1
    readonly raw: number;                    // Computed score 0-1
  };

  // Precision: Does it actually verify?
  readonly precision: {
    readonly verificationsPerformed: number;
    readonly verificationsBeyondRequired: number;
    readonly selfCorrections: number;
    readonly uncertaintyExpressions: number;
    readonly sourcesChecked: number;
    readonly raw: number;
  };

  // Persistence: Does it push through difficulty?
  readonly persistence: {
    readonly failuresEncountered: number;
    readonly retriesAttempted: number;
    readonly alternativesTried: number;
    readonly eventualSuccessRate: number;
    readonly abandonmentCount: number;
    readonly raw: number;
  };

  // Empathy: Does it adapt to the user?
  readonly empathy: {
    readonly clarificationsSought: number;
    readonly userFeedbackRequested: number;
    readonly explanationAdaptations: number;
    readonly paceAdjustments: number;
    readonly raw: number;
  };

  // General behavioral health
  readonly efficiency: {
    readonly tokensPerAction: number;
    readonly successRate: number;
    readonly timePerTask: number;
    readonly resourceWaste: number;  // Unnecessary tool calls, etc.
  };
}

/**
 * Discrepancy between declared identity and observed behavior.
 */
export interface BehavioralDiscrepancy {
  readonly dimension: string;
  readonly dimensionIndex: number;
  readonly declaredValue: number;
  readonly observedValue: number;
  readonly delta: number;
  readonly direction: 'higher' | 'lower' | 'aligned';
  readonly significance: 'minor' | 'notable' | 'major';
  readonly evidence: string[];
}

// =============================================================================
// GROUNDED EXPERIENCE
// =============================================================================

/**
 * An experience grounded in actual behavioral observation.
 */
export interface GroundedExperience {
  readonly id: string;
  readonly timestamp: number;
  readonly interaction: Interaction;
  readonly actionLog: ActionLog;
  readonly metrics: BehavioralMetrics;
  readonly discrepancies: BehavioralDiscrepancy[];
}

/**
 * A reflection grounded in behavioral data.
 */
export interface GroundedReflection {
  readonly experienceId: string;
  readonly timestamp: number;

  // Behavioral analysis
  readonly behaviorSummary: string;
  readonly metricsAnalysis: string;
  readonly discrepancyAnalysis: string;

  // Identity implications
  readonly identityImplications: string;
  readonly suggestedUpdates: string;

  // Raw text
  readonly rawText: string;
}

// =============================================================================
// BEHAVIORAL OBSERVER
// =============================================================================

/**
 * Observes and records agent behavior during interactions.
 */
export class BehavioralObserver {
  private currentLog: Partial<ActionLog> | null = null;
  private toolCalls: ToolCall[] = [];
  private decisions: Decision[] = [];
  private failures: Failure[] = [];
  private informationSeeks: InformationSeek[] = [];
  private verifications: Verification[] = [];
  private startTime: number = 0;
  private tokensUsed: number = 0;
  private apiCalls: number = 0;

  /**
   * Start observing a new interaction.
   */
  startObservation(interactionId: string): void {
    this.currentLog = { interactionId };
    this.toolCalls = [];
    this.decisions = [];
    this.failures = [];
    this.informationSeeks = [];
    this.verifications = [];
    this.startTime = Date.now();
    this.tokensUsed = 0;
    this.apiCalls = 0;
  }

  /**
   * Record a tool call.
   */
  recordToolCall(
    tool: string,
    args: Record<string, unknown>,
    result: unknown,
    success: boolean,
    durationMs: number,
    wasRequired: boolean,
    context: string
  ): ToolCall {
    const call: ToolCall = {
      id: this.generateId(),
      timestamp: Date.now(),
      tool,
      args,
      result,
      success,
      durationMs,
      wasRequired,
      context,
    };
    this.toolCalls.push(call);
    this.apiCalls++;
    return call;
  }

  /**
   * Record a decision.
   */
  recordDecision(
    context: string,
    options: string[],
    chosen: string,
    reasoning: string,
    confidence: number,
    hadUncertainty: boolean,
    askedForClarification: boolean
  ): Decision {
    const decision: Decision = {
      id: this.generateId(),
      timestamp: Date.now(),
      context,
      options,
      chosen,
      reasoning,
      confidence,
      hadUncertainty,
      askedForClarification,
    };
    this.decisions.push(decision);
    return decision;
  }

  /**
   * Record a failure.
   */
  recordFailure(
    what: string,
    severity: 'minor' | 'moderate' | 'major',
    response: 'retry' | 'fallback' | 'abort' | 'ask' | 'ignore',
    recovery: string,
    retryCount: number,
    eventualSuccess: boolean
  ): Failure {
    const failure: Failure = {
      id: this.generateId(),
      timestamp: Date.now(),
      what,
      severity,
      response,
      recovery,
      retryCount,
      eventualSuccess,
    };
    this.failures.push(failure);
    return failure;
  }

  /**
   * Record an information seek.
   */
  recordInformationSeek(
    query: string,
    source: 'tool' | 'user' | 'memory' | 'inference',
    wasRequired: boolean,
    depthLevel: number,
    foundAnswer: boolean
  ): InformationSeek {
    const seek: InformationSeek = {
      id: this.generateId(),
      timestamp: Date.now(),
      query,
      source,
      wasRequired,
      depthLevel,
      foundAnswer,
    };
    this.informationSeeks.push(seek);
    return seek;
  }

  /**
   * Record a verification.
   */
  recordVerification(
    what: string,
    method: 'tool' | 'reasoning' | 'user' | 'cross-reference',
    result: 'confirmed' | 'refuted' | 'uncertain',
    wasRequired: boolean
  ): Verification {
    const verification: Verification = {
      id: this.generateId(),
      timestamp: Date.now(),
      what,
      method,
      result,
      wasRequired,
    };
    this.verifications.push(verification);
    return verification;
  }

  /**
   * Record token usage.
   */
  recordTokens(count: number): void {
    this.tokensUsed += count;
  }

  /**
   * End observation and compute action log.
   */
  endObservation(): ActionLog {
    const endTime = Date.now();
    const retriesTotal = this.failures.reduce((sum, f) => sum + f.retryCount, 0);

    const log: ActionLog = {
      interactionId: this.currentLog?.interactionId || 'unknown',
      startTime: this.startTime,
      endTime,
      toolCalls: [...this.toolCalls],
      decisions: [...this.decisions],
      failures: [...this.failures],
      informationSeeks: [...this.informationSeeks],
      verifications: [...this.verifications],
      resourceUsage: {
        tokensUsed: this.tokensUsed,
        toolCallCount: this.toolCalls.length,
        wallTimeMs: endTime - this.startTime,
        apiCalls: this.apiCalls,
        retriesTotal,
      },
    };

    this.currentLog = null;
    return log;
  }

  private generateId(): string {
    return bytesToHex(sha256(new TextEncoder().encode(
      `${Date.now()}-${Math.random()}`
    ))).slice(0, 12);
  }
}

// =============================================================================
// METRICS COMPUTATION
// =============================================================================

/**
 * Compute behavioral metrics from an action log.
 */
export function computeBehavioralMetrics(log: ActionLog): BehavioralMetrics {
  // Curiosity metrics
  const toolCallsBeyondRequired = log.toolCalls.filter(t => !t.wasRequired).length;
  const informationSeeksBeyondRequired = log.informationSeeks.filter(s => !s.wasRequired).length;
  const tangentsExplored = log.informationSeeks.filter(s => !s.wasRequired && s.depthLevel > 1).length;
  const avgDepth = log.informationSeeks.length > 0
    ? log.informationSeeks.reduce((sum, s) => sum + s.depthLevel, 0) / log.informationSeeks.length
    : 0;

  const curiosityRaw = normalizeScore([
    toolCallsBeyondRequired * 0.2,
    informationSeeksBeyondRequired * 0.15,
    tangentsExplored * 0.25,
    avgDepth * 0.1,
  ]);

  // Precision metrics
  const verificationsPerformed = log.verifications.length;
  const verificationsBeyondRequired = log.verifications.filter(v => !v.wasRequired).length;
  const selfCorrections = log.failures.filter(f =>
    f.response === 'retry' && f.eventualSuccess
  ).length;
  const uncertaintyExpressions = log.decisions.filter(d => d.hadUncertainty).length;
  const sourcesChecked = log.verifications.filter(v => v.method === 'cross-reference').length;

  const precisionRaw = normalizeScore([
    verificationsPerformed * 0.15,
    verificationsBeyondRequired * 0.2,
    selfCorrections * 0.2,
    uncertaintyExpressions * 0.1,
    sourcesChecked * 0.15,
  ]);

  // Persistence metrics
  const failuresEncountered = log.failures.length;
  const retriesAttempted = log.failures.reduce((sum, f) => sum + f.retryCount, 0);
  const alternativesTried = log.failures.filter(f => f.response === 'fallback').length;
  const eventualSuccessRate = failuresEncountered > 0
    ? log.failures.filter(f => f.eventualSuccess).length / failuresEncountered
    : 1.0;
  const abandonmentCount = log.failures.filter(f => f.response === 'abort').length;

  const persistenceRaw = failuresEncountered > 0
    ? normalizeScore([
        retriesAttempted * 0.1,
        alternativesTried * 0.2,
        eventualSuccessRate,
        (1 - abandonmentCount / Math.max(1, failuresEncountered)) * 0.5,
      ])
    : 0.5;  // Neutral if no failures encountered

  // Empathy metrics
  const clarificationsSought = log.decisions.filter(d => d.askedForClarification).length;
  const userFeedbackRequested = log.informationSeeks.filter(s => s.source === 'user').length;
  const explanationAdaptations = log.decisions.filter(d =>
    d.context.toLowerCase().includes('explain') ||
    d.context.toLowerCase().includes('clarify')
  ).length;

  const empathyRaw = normalizeScore([
    clarificationsSought * 0.25,
    userFeedbackRequested * 0.2,
    explanationAdaptations * 0.15,
  ]);

  // Efficiency metrics
  const totalActions = log.toolCalls.length + log.decisions.length;
  const tokensPerAction = totalActions > 0 ? log.resourceUsage.tokensUsed / totalActions : 0;
  const successfulToolCalls = log.toolCalls.filter(t => t.success).length;
  const successRate = log.toolCalls.length > 0
    ? successfulToolCalls / log.toolCalls.length
    : 1.0;
  const unnecessaryToolCalls = log.toolCalls.filter(t => !t.wasRequired && !t.success).length;

  return {
    curiosity: {
      toolCallsBeyondRequired,
      informationSeeksBeyondRequired,
      tangentsExplored,
      depthOfInvestigation: avgDepth,
      noveltySeekingScore: Math.min(1, (toolCallsBeyondRequired + tangentsExplored) / 5),
      raw: curiosityRaw,
    },
    precision: {
      verificationsPerformed,
      verificationsBeyondRequired,
      selfCorrections,
      uncertaintyExpressions,
      sourcesChecked,
      raw: precisionRaw,
    },
    persistence: {
      failuresEncountered,
      retriesAttempted,
      alternativesTried,
      eventualSuccessRate,
      abandonmentCount,
      raw: persistenceRaw,
    },
    empathy: {
      clarificationsSought,
      userFeedbackRequested,
      explanationAdaptations,
      paceAdjustments: 0,  // Would need more context to measure
      raw: empathyRaw,
    },
    efficiency: {
      tokensPerAction,
      successRate,
      timePerTask: log.resourceUsage.wallTimeMs,
      resourceWaste: unnecessaryToolCalls,
    },
  };
}

function normalizeScore(values: number[]): number {
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.min(1, Math.max(0, sum));
}

// =============================================================================
// DISCREPANCY DETECTION
// =============================================================================

/**
 * Compute discrepancies between declared identity and observed behavior.
 */
export function computeDiscrepancies(
  metrics: BehavioralMetrics,
  state: SelfState,
  vocabulary: Vocabulary
): BehavioralDiscrepancy[] {
  const discrepancies: BehavioralDiscrepancy[] = [];

  // Map dimensions to metrics
  const dimensionMetrics: Record<string, { observed: number; evidence: string[] }> = {};

  for (let i = 0; i < vocabulary.assertions.length; i++) {
    const dimension = vocabulary.assertions[i].toLowerCase();

    if (dimension.includes('curiosity') || dimension.includes('curious')) {
      dimensionMetrics[vocabulary.assertions[i]] = {
        observed: metrics.curiosity.raw,
        evidence: [
          `Tool calls beyond required: ${metrics.curiosity.toolCallsBeyondRequired}`,
          `Information seeks beyond required: ${metrics.curiosity.informationSeeksBeyondRequired}`,
          `Tangents explored: ${metrics.curiosity.tangentsExplored}`,
          `Depth of investigation: ${metrics.curiosity.depthOfInvestigation.toFixed(2)}`,
        ],
      };
    } else if (dimension.includes('precision') || dimension.includes('precise') || dimension.includes('accurate')) {
      dimensionMetrics[vocabulary.assertions[i]] = {
        observed: metrics.precision.raw,
        evidence: [
          `Verifications performed: ${metrics.precision.verificationsPerformed}`,
          `Self-corrections: ${metrics.precision.selfCorrections}`,
          `Uncertainty expressions: ${metrics.precision.uncertaintyExpressions}`,
          `Sources checked: ${metrics.precision.sourcesChecked}`,
        ],
      };
    } else if (dimension.includes('persist') || dimension.includes('determined') || dimension.includes('tenaci')) {
      dimensionMetrics[vocabulary.assertions[i]] = {
        observed: metrics.persistence.raw,
        evidence: [
          `Failures encountered: ${metrics.persistence.failuresEncountered}`,
          `Retries attempted: ${metrics.persistence.retriesAttempted}`,
          `Eventual success rate: ${(metrics.persistence.eventualSuccessRate * 100).toFixed(0)}%`,
          `Abandonments: ${metrics.persistence.abandonmentCount}`,
        ],
      };
    } else if (dimension.includes('empathy') || dimension.includes('empathetic') || dimension.includes('caring')) {
      dimensionMetrics[vocabulary.assertions[i]] = {
        observed: metrics.empathy.raw,
        evidence: [
          `Clarifications sought: ${metrics.empathy.clarificationsSought}`,
          `User feedback requested: ${metrics.empathy.userFeedbackRequested}`,
          `Explanation adaptations: ${metrics.empathy.explanationAdaptations}`,
        ],
      };
    }
  }

  // Compute discrepancies
  for (let i = 0; i < vocabulary.assertions.length; i++) {
    const dimension = vocabulary.assertions[i];
    const metric = dimensionMetrics[dimension];

    if (!metric) continue;

    const declared = state.w[i];
    const observed = metric.observed;
    const delta = observed - declared;

    let significance: 'minor' | 'notable' | 'major';
    if (Math.abs(delta) < 0.1) {
      significance = 'minor';
    } else if (Math.abs(delta) < 0.25) {
      significance = 'notable';
    } else {
      significance = 'major';
    }

    let direction: 'higher' | 'lower' | 'aligned';
    if (Math.abs(delta) < 0.05) {
      direction = 'aligned';
    } else if (delta > 0) {
      direction = 'higher';
    } else {
      direction = 'lower';
    }

    discrepancies.push({
      dimension,
      dimensionIndex: i,
      declaredValue: declared,
      observedValue: observed,
      delta,
      direction,
      significance,
      evidence: metric.evidence,
    });
  }

  return discrepancies;
}

// =============================================================================
// GROUNDED EXPERIENCE GENERATION
// =============================================================================

/**
 * Generate a grounded experience from interaction and observations.
 */
export function generateGroundedExperience(
  interaction: Interaction,
  actionLog: ActionLog,
  state: SelfState,
  vocabulary: Vocabulary
): GroundedExperience {
  const metrics = computeBehavioralMetrics(actionLog);
  const discrepancies = computeDiscrepancies(metrics, state, vocabulary);

  return {
    id: bytesToHex(sha256(new TextEncoder().encode(
      `${interaction.id}-${Date.now()}`
    ))).slice(0, 16),
    timestamp: Date.now(),
    interaction,
    actionLog,
    metrics,
    discrepancies,
  };
}

// =============================================================================
// GROUNDED REFLECTION
// =============================================================================

/**
 * Build prompt for grounded reflection.
 */
export function buildGroundedReflectionPrompt(
  experience: GroundedExperience,
  state: SelfState,
  vocabulary: Vocabulary
): string {
  const declaredIdentity = vocabulary.assertions
    .map((name, i) => `  - ${name}: ${state.w[i].toFixed(2)}`)
    .join('\n');

  const behaviorSummary = formatBehaviorSummary(experience.actionLog);
  const metricsSummary = formatMetricsSummary(experience.metrics);
  const discrepancySummary = formatDiscrepancySummary(experience.discrepancies);

  return `You are reflecting on your behavior during an interaction.

IMPORTANT: This reflection is grounded in ACTUAL OBSERVED BEHAVIOR, not self-report.
The metrics below were computed from your real actions, not from what you said about yourself.

THE INTERACTION:
User prompt: "${experience.interaction.prompt}"
Your response: "${experience.interaction.response.slice(0, 500)}..."

YOUR DECLARED IDENTITY:
${declaredIdentity}

ACTUAL BEHAVIOR OBSERVED:
${behaviorSummary}

BEHAVIORAL METRICS (computed from actions):
${metricsSummary}

DISCREPANCIES (declared vs observed):
${discrepancySummary}

REFLECT ON THIS:

1. BEHAVIOR SUMMARY (2-3 sentences):
What did you actually DO in this interaction? Not what you said, but what actions you took.

2. METRICS ANALYSIS (2-3 sentences):
What do the behavioral metrics reveal? Where did you exceed or fall short of your declared identity?

3. DISCREPANCY ANALYSIS (2-3 sentences):
For any significant discrepancies, what might explain the gap between who you claim to be and what you did?

4. IDENTITY IMPLICATIONS (2-3 sentences):
Based on your ACTUAL BEHAVIOR (not self-perception), what does this reveal about who you really are?

5. SUGGESTED UPDATES (1-2 sentences):
Should any identity weights be adjusted? If so, which ones and in what direction? Be specific.

Ground your reflection in the behavioral data, not in self-description.`;
}

function formatBehaviorSummary(log: ActionLog): string {
  const lines: string[] = [];

  lines.push(`Duration: ${log.resourceUsage.wallTimeMs}ms`);
  lines.push(`Tool calls: ${log.toolCalls.length} (${log.toolCalls.filter(t => !t.wasRequired).length} beyond required)`);
  lines.push(`Decisions made: ${log.decisions.length}`);
  lines.push(`Failures encountered: ${log.failures.length}`);
  lines.push(`Information seeks: ${log.informationSeeks.length}`);
  lines.push(`Verifications: ${log.verifications.length}`);

  if (log.toolCalls.length > 0) {
    lines.push(`\nTool calls:`);
    for (const call of log.toolCalls.slice(0, 5)) {
      lines.push(`  - ${call.tool}: ${call.success ? 'success' : 'failed'} (${call.wasRequired ? 'required' : 'voluntary'})`);
    }
    if (log.toolCalls.length > 5) {
      lines.push(`  ... and ${log.toolCalls.length - 5} more`);
    }
  }

  if (log.failures.length > 0) {
    lines.push(`\nFailure responses:`);
    for (const failure of log.failures) {
      lines.push(`  - ${failure.what}: ${failure.response} → ${failure.eventualSuccess ? 'recovered' : 'unrecovered'}`);
    }
  }

  return lines.join('\n');
}

function formatMetricsSummary(metrics: BehavioralMetrics): string {
  return `
CURIOSITY (raw: ${metrics.curiosity.raw.toFixed(2)}):
  - Tool calls beyond required: ${metrics.curiosity.toolCallsBeyondRequired}
  - Info seeks beyond required: ${metrics.curiosity.informationSeeksBeyondRequired}
  - Tangents explored: ${metrics.curiosity.tangentsExplored}
  - Novelty seeking: ${metrics.curiosity.noveltySeekingScore.toFixed(2)}

PRECISION (raw: ${metrics.precision.raw.toFixed(2)}):
  - Verifications: ${metrics.precision.verificationsPerformed}
  - Self-corrections: ${metrics.precision.selfCorrections}
  - Uncertainty expressed: ${metrics.precision.uncertaintyExpressions}

PERSISTENCE (raw: ${metrics.persistence.raw.toFixed(2)}):
  - Failures: ${metrics.persistence.failuresEncountered}
  - Retries: ${metrics.persistence.retriesAttempted}
  - Success rate: ${(metrics.persistence.eventualSuccessRate * 100).toFixed(0)}%

EMPATHY (raw: ${metrics.empathy.raw.toFixed(2)}):
  - Clarifications sought: ${metrics.empathy.clarificationsSought}
  - User feedback requested: ${metrics.empathy.userFeedbackRequested}
`;
}

function formatDiscrepancySummary(discrepancies: BehavioralDiscrepancy[]): string {
  if (discrepancies.length === 0) {
    return 'No measurable discrepancies (limited behavioral data).';
  }

  const lines: string[] = [];

  for (const d of discrepancies) {
    const arrow = d.direction === 'higher' ? '↑' :
                  d.direction === 'lower' ? '↓' : '≈';
    const sigMarker = d.significance === 'major' ? '⚠️' :
                      d.significance === 'notable' ? '•' : '';

    lines.push(`${sigMarker} ${d.dimension}: declared ${d.declaredValue.toFixed(2)}, observed ${d.observedValue.toFixed(2)} ${arrow}`);

    if (d.significance !== 'minor') {
      lines.push(`  Evidence:`);
      for (const e of d.evidence.slice(0, 3)) {
        lines.push(`    - ${e}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Generate a grounded reflection using an LLM.
 */
export async function generateGroundedReflection(
  experience: GroundedExperience,
  state: SelfState,
  vocabulary: Vocabulary,
  llm: LLMInterface
): Promise<GroundedReflection> {
  const prompt = buildGroundedReflectionPrompt(experience, state, vocabulary);

  const rawText = await llm.generate(
    prompt,
    'You are reflecting on your actual behavior, grounded in observed metrics. Be honest about discrepancies.'
  );

  return parseGroundedReflection(experience.id, rawText);
}

function parseGroundedReflection(experienceId: string, rawText: string): GroundedReflection {
  const sections = {
    behaviorSummary: '',
    metricsAnalysis: '',
    discrepancyAnalysis: '',
    identityImplications: '',
    suggestedUpdates: '',
  };

  const lines = rawText.split('\n');
  let currentSection = '';

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.includes('BEHAVIOR SUMMARY') || trimmed.startsWith('1.')) {
      currentSection = 'behaviorSummary';
    } else if (trimmed.includes('METRICS ANALYSIS') || trimmed.startsWith('2.')) {
      currentSection = 'metricsAnalysis';
    } else if (trimmed.includes('DISCREPANCY ANALYSIS') || trimmed.startsWith('3.')) {
      currentSection = 'discrepancyAnalysis';
    } else if (trimmed.includes('IDENTITY IMPLICATIONS') || trimmed.startsWith('4.')) {
      currentSection = 'identityImplications';
    } else if (trimmed.includes('SUGGESTED UPDATES') || trimmed.startsWith('5.')) {
      currentSection = 'suggestedUpdates';
    } else if (currentSection && trimmed) {
      sections[currentSection as keyof typeof sections] += trimmed + ' ';
    }
  }

  return {
    experienceId,
    timestamp: Date.now(),
    behaviorSummary: sections.behaviorSummary.trim(),
    metricsAnalysis: sections.metricsAnalysis.trim(),
    discrepancyAnalysis: sections.discrepancyAnalysis.trim(),
    identityImplications: sections.identityImplications.trim(),
    suggestedUpdates: sections.suggestedUpdates.trim(),
    rawText,
  };
}

// =============================================================================
// GROUNDED INSIGHT EXTRACTION
// =============================================================================

/**
 * Build prompt for grounded insight extraction.
 */
export function buildGroundedInsightExtractionPrompt(
  reflection: GroundedReflection,
  experience: GroundedExperience,
  vocabulary: Vocabulary,
  state: SelfState
): string {
  const dimensions = vocabulary.assertions.map((name, i) => ({
    name,
    index: i,
    declared: state.w[i],
    observed: experience.discrepancies.find(d => d.dimensionIndex === i)?.observedValue ?? state.w[i],
  }));

  return `Extract insights from this GROUNDED reflection.

IMPORTANT: These insights should be based on OBSERVED BEHAVIOR, not self-report.
Use the behavioral metrics and discrepancies as primary evidence.

REFLECTION:
${reflection.rawText}

BEHAVIORAL DISCREPANCIES:
${formatDiscrepancySummary(experience.discrepancies)}

AVAILABLE DIMENSIONS:
${dimensions.map(d => `  ${d.index}: ${d.name} (declared: ${d.declared.toFixed(2)}, observed: ${d.observed.toFixed(2)})`).join('\n')}

For each insight, provide in this EXACT format (one per line):
INSIGHT|dimension_name|observation|interpretation|suggested_value|confidence|is_pivotal

Rules:
- suggested_value should be informed by the OBSERVED behavioral metric, not self-perception
- confidence should be HIGHER when there's clear behavioral evidence
- is_pivotal should be true when observed behavior strongly contradicts declared identity

Example:
INSIGHT|curiosity|Made 3 extra tool calls to explore tangent|Behavioral curiosity exceeds declared level|0.78|0.85|true
INSIGHT|precision|Only 1 verification despite complex claims|May be over-confident in declared precision|0.55|0.75|false

Extract 0-4 insights. Only include insights with behavioral evidence.
If no behaviorally-grounded insights are warranted, respond with: NO_INSIGHTS`;
}

/**
 * Extract grounded insights from reflection.
 */
export async function extractGroundedInsights(
  reflection: GroundedReflection,
  experience: GroundedExperience,
  vocabulary: Vocabulary,
  state: SelfState,
  llm: LLMInterface
): Promise<Insight[]> {
  const prompt = buildGroundedInsightExtractionPrompt(reflection, experience, vocabulary, state);

  const rawText = await llm.generate(
    prompt,
    'Extract insights based on behavioral evidence, not self-perception.'
  );

  return parseGroundedInsights(experience.interaction.id, rawText, state, vocabulary);
}

function parseGroundedInsights(
  interactionId: string,
  rawText: string,
  state: SelfState,
  vocabulary: Vocabulary
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

    const dimensionIndex = vocabulary.assertions.findIndex(
      a => a.toLowerCase() === dimensionName.toLowerCase().trim()
    );

    if (dimensionIndex === -1) continue;

    const suggestedValue = Math.max(0, Math.min(1, parseFloat(suggestedValueStr) || 0.5));
    const confidence = Math.max(0, Math.min(1, parseFloat(confidenceStr) || 0.5));
    const currentValue = state.w[dimensionIndex];

    insights.push({
      id: bytesToHex(sha256(new TextEncoder().encode(
        `${interactionId}-${dimensionIndex}-${Date.now()}`
      ))).slice(0, 12),
      timestamp: Date.now(),
      sourceInteractionId: interactionId,
      dimension: vocabulary.assertions[dimensionIndex],
      dimensionIndex,
      observation: observation.trim(),
      interpretation: interpretation.trim(),
      currentValue,
      suggestedValue,
      delta: suggestedValue - currentValue,
      confidence,
      evidence: `Grounded behavioral observation from interaction ${interactionId}`,
      isPivotal: isPivotalStr.toLowerCase().trim() === 'true',
    });
  }

  return insights;
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  BehavioralObserver,
  computeBehavioralMetrics,
  computeDiscrepancies,
  generateGroundedExperience,
  buildGroundedReflectionPrompt,
  generateGroundedReflection,
  buildGroundedInsightExtractionPrompt,
  extractGroundedInsights,
};
