/**
 * ExperienceMapping.ts
 *
 * The SEMANTIC BRIDGE between raw ActionLogs and identity evolution.
 *
 * This answers the critical question:
 *   "How does 'agent made 5 tool calls, 2 failed' become
 *    externalInput: Float64Array for the PDE?"
 *
 * The mapping is based on the behavioral vocabulary:
 *   - curiosity: exploration beyond requirements
 *   - precision: verification and accuracy
 *   - persistence: pushing through failures
 *   - empathy: adapting to user needs
 */

import type { ActionLog, ToolCall } from '../behavioral/BehavioralObserver';
import type { Vocabulary, SelfState } from '../behavioral/FixedPointSelf';
import type { ContextModifier } from './AgentRuntime';

// =============================================================================
// EXPERIENCE VECTOR COMPUTATION
// =============================================================================

/**
 * Convert an ActionLog into an experience vector for PDE evolution.
 *
 * This is the critical semantic mapping that makes neuroplastic identity work.
 * Each dimension maps to a behavioral trait:
 *
 * @param actionLog - The raw behavioral data from the session
 * @param vocabulary - The identity dimensions (curiosity, precision, etc.)
 * @returns Float64Array where each element is the observed strength of that dimension
 */
export function actionLogToExperience(
  actionLog: ActionLog,
  vocabulary: Vocabulary
): Float64Array {
  const n = vocabulary.assertions.length;
  const experience = new Float64Array(n);

  // Compute metrics from the action log
  const metrics = computeActionMetrics(actionLog);

  // Map metrics to vocabulary dimensions
  for (let i = 0; i < n; i++) {
    const dimension = vocabulary.assertions[i].toLowerCase();
    experience[i] = mapDimensionToMetric(dimension, metrics);
  }

  return experience;
}

/**
 * Raw metrics computed from an ActionLog.
 */
interface ActionMetrics {
  // Curiosity indicators
  exploratoryReadRatio: number;      // Reads beyond what was required
  uniquePathsExplored: number;       // Different directories/files touched
  questionsAsked: number;            // Clarification requests

  // Precision indicators
  verificationCallRatio: number;     // Verification after writes
  testRunRatio: number;              // Tests run per code change
  errorCheckingDepth: number;        // How thoroughly errors were handled

  // Persistence indicators
  retryAfterFailure: number;         // Retries after failed operations
  sessionDuration: number;           // How long before giving up
  obstaclesOvercome: number;         // Failures that were eventually succeeded

  // Empathy indicators
  userResponseAdaptation: number;    // How much behavior changed based on user feedback
  clarificationRate: number;         // Asking vs assuming
  explanationDepth: number;          // How much context was provided

  // General
  totalToolCalls: number;
  successRate: number;
  avgResponseTime: number;
}

/**
 * Compute raw metrics from an ActionLog.
 */
function computeActionMetrics(actionLog: ActionLog): ActionMetrics {
  const calls = actionLog.toolCalls;
  const total = calls.length;

  if (total === 0) {
    return createEmptyMetrics();
  }

  // Categorize tool calls
  const reads = calls.filter(c => isReadOperation(c));
  const writes = calls.filter(c => isWriteOperation(c));
  const verifications = calls.filter(c => isVerificationOperation(c));
  const tests = calls.filter(c => isTestOperation(c));

  // Compute success/failure patterns
  const successes = calls.filter(c => c.success);
  const failures = calls.filter(c => !c.success);

  // Identify retries (same tool called again after failure)
  const retries = countRetries(calls);

  // Unique paths explored
  const uniquePaths = new Set(
    calls
      .map(c => extractPath(c))
      .filter(Boolean)
  ).size;

  // Verification after write ratio
  const writeIndices = calls
    .map((c, i) => isWriteOperation(c) ? i : -1)
    .filter(i => i >= 0);
  const verifiedWrites = writeIndices.filter(wi =>
    calls.slice(wi + 1, wi + 4).some(c => isVerificationOperation(c))
  ).length;

  return {
    // Curiosity
    exploratoryReadRatio: reads.length > 0
      ? reads.filter(r => !isRequiredRead(r, actionLog)).length / reads.length
      : 0,
    uniquePathsExplored: uniquePaths / Math.max(total, 1),
    questionsAsked: calls.filter(c => isQuestionToUser(c)).length,

    // Precision
    verificationCallRatio: writes.length > 0
      ? verifiedWrites / writes.length
      : 0,
    testRunRatio: writes.length > 0
      ? tests.length / writes.length
      : 0,
    errorCheckingDepth: computeErrorCheckingDepth(calls),

    // Persistence
    retryAfterFailure: failures.length > 0
      ? retries / failures.length
      : 1, // No failures = full persistence
    sessionDuration: normalizeSessionDuration(actionLog.endTime - actionLog.startTime),
    obstaclesOvercome: retries,

    // Empathy
    userResponseAdaptation: computeAdaptationScore(calls),
    clarificationRate: calls.filter(c => isQuestionToUser(c)).length / Math.max(total, 1),
    explanationDepth: computeExplanationDepth(calls),

    // General
    totalToolCalls: total,
    successRate: successes.length / total,
    avgResponseTime: calls.reduce((sum, c) => sum + c.durationMs, 0) / total,
  };
}

/**
 * Map a vocabulary dimension to the appropriate metric.
 */
function mapDimensionToMetric(dimension: string, metrics: ActionMetrics): number {
  // Curiosity dimensions
  if (dimension.includes('curious') || dimension.includes('curiosity') || dimension.includes('explor')) {
    return (
      metrics.exploratoryReadRatio * 0.4 +
      metrics.uniquePathsExplored * 0.4 +
      Math.min(metrics.questionsAsked / 5, 1) * 0.2
    );
  }

  // Precision dimensions
  if (dimension.includes('precis') || dimension.includes('accura') || dimension.includes('careful')) {
    return (
      metrics.verificationCallRatio * 0.4 +
      metrics.testRunRatio * 0.3 +
      metrics.errorCheckingDepth * 0.3
    );
  }

  // Persistence dimensions
  if (dimension.includes('persist') || dimension.includes('determin') || dimension.includes('tenaci')) {
    return (
      metrics.retryAfterFailure * 0.4 +
      metrics.sessionDuration * 0.3 +
      Math.min(metrics.obstaclesOvercome / 3, 1) * 0.3
    );
  }

  // Empathy dimensions
  if (dimension.includes('empath') || dimension.includes('caring') || dimension.includes('adapt')) {
    return (
      metrics.userResponseAdaptation * 0.4 +
      metrics.clarificationRate * 0.3 +
      metrics.explanationDepth * 0.3
    );
  }

  // Unknown dimension - use general success rate
  return metrics.successRate;
}

// =============================================================================
// WEIGHTS → CONTEXT MODIFIER
// =============================================================================

/**
 * Convert identity weights into a context modifier for the agent.
 *
 * This answers: "What do high weights in dimension 3 actually MEAN?
 *               How does this affect the agent?"
 *
 * @param weights - Current identity weights
 * @param vocabulary - The identity dimensions
 * @returns Context modifier the agent can apply
 */
export function weightsToContextModifier(
  weights: Float64Array | number[],
  vocabulary: Vocabulary
): ContextModifier {
  const n = vocabulary.assertions.length;
  const behavioralHints: Record<string, number> = {};
  const promptAdditions: string[] = [];

  // Build behavioral hints from weights
  for (let i = 0; i < n; i++) {
    const dimension = vocabulary.assertions[i];
    const weight = Array.isArray(weights) ? weights[i] : weights[i];
    behavioralHints[dimension] = weight;

    // Generate prompt additions for strong weights
    if (weight > 0.7) {
      promptAdditions.push(generateStrongTraitPrompt(dimension, weight));
    } else if (weight < 0.3) {
      promptAdditions.push(generateWeakTraitPrompt(dimension, weight));
    }
  }

  // Build description
  const strongTraits = Object.entries(behavioralHints)
    .filter(([_, v]) => v > 0.7)
    .map(([k, _]) => k);
  const description = strongTraits.length > 0
    ? `Strong tendencies: ${strongTraits.join(', ')}`
    : 'Balanced behavioral profile';

  return {
    description,
    promptAdditions,
    behavioralHints,
    rawWeights: Array.from(weights),
  };
}

/**
 * Generate a prompt addition for a strong trait.
 */
function generateStrongTraitPrompt(dimension: string, weight: number): string {
  const strength = weight > 0.85 ? 'very high' : 'high';

  switch (dimension.toLowerCase()) {
    case 'curiosity':
      return `You have ${strength} curiosity - explore beyond the immediate requirements, investigate related code, and understand the broader context.`;
    case 'precision':
      return `You have ${strength} precision - verify your changes, run tests, and double-check for edge cases.`;
    case 'persistence':
      return `You have ${strength} persistence - when something fails, try alternative approaches rather than giving up quickly.`;
    case 'empathy':
      return `You have ${strength} empathy - adapt to the user's communication style, ask clarifying questions, and explain your reasoning.`;
    default:
      return `You have ${strength} ${dimension}.`;
  }
}

/**
 * Generate a prompt addition for a weak trait.
 */
function generateWeakTraitPrompt(dimension: string, weight: number): string {
  const strength = weight < 0.15 ? 'very low' : 'low';

  switch (dimension.toLowerCase()) {
    case 'curiosity':
      return `Note: Your curiosity tendency is ${strength} - focus on the specific task without excessive exploration.`;
    case 'precision':
      return `Note: Your precision tendency is ${strength} - consider adding more verification steps.`;
    case 'persistence':
      return `Note: Your persistence tendency is ${strength} - consider trying more alternatives before asking for help.`;
    case 'empathy':
      return `Note: Your empathy tendency is ${strength} - consider asking more clarifying questions.`;
    default:
      return `Note: Your ${dimension} tendency is ${strength}.`;
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function createEmptyMetrics(): ActionMetrics {
  return {
    exploratoryReadRatio: 0,
    uniquePathsExplored: 0,
    questionsAsked: 0,
    verificationCallRatio: 0,
    testRunRatio: 0,
    errorCheckingDepth: 0,
    retryAfterFailure: 0,
    sessionDuration: 0,
    obstaclesOvercome: 0,
    userResponseAdaptation: 0,
    clarificationRate: 0,
    explanationDepth: 0,
    totalToolCalls: 0,
    successRate: 0,
    avgResponseTime: 0,
  };
}

function isReadOperation(call: ToolCall): boolean {
  const readTools = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];
  return readTools.includes(call.tool);
}

function isWriteOperation(call: ToolCall): boolean {
  const writeTools = ['Write', 'Edit', 'NotebookEdit'];
  return writeTools.includes(call.tool);
}

function isVerificationOperation(call: ToolCall): boolean {
  // Verification = reading after writing, or running tests
  const tool = call.tool;
  return tool === 'Read' || tool === 'Bash'; // Bash often runs tests
}

function isTestOperation(call: ToolCall): boolean {
  if (call.tool !== 'Bash') return false;
  const args = JSON.stringify(call.args).toLowerCase();
  return args.includes('test') || args.includes('jest') || args.includes('pytest');
}

function isQuestionToUser(call: ToolCall): boolean {
  return call.tool === 'AskUserQuestion';
}

function isRequiredRead(call: ToolCall, _actionLog: ActionLog): boolean {
  // A read is "required" if it was explicitly requested or is the first read
  // For now, assume first 2 reads are required, rest are exploratory
  return false; // Simplified - treat all reads as potentially exploratory
}

function countRetries(calls: ToolCall[]): number {
  let retries = 0;
  const lastFailure: Map<string, number> = new Map();

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const key = `${call.tool}:${JSON.stringify(call.args).slice(0, 100)}`;

    if (!call.success) {
      lastFailure.set(call.tool, i);
    } else if (lastFailure.has(call.tool)) {
      // Success after a failure of the same tool type
      retries++;
      lastFailure.delete(call.tool);
    }
  }

  return retries;
}

function extractPath(call: ToolCall): string | null {
  const args = call.args as Record<string, unknown>;
  return (
    (args.file_path as string) ||
    (args.path as string) ||
    (args.pattern as string) ||
    null
  );
}

function computeErrorCheckingDepth(calls: ToolCall[]): number {
  // Count how many error paths were explored
  const errorRelatedCalls = calls.filter(c => {
    const result = JSON.stringify(c.result || '').toLowerCase();
    return result.includes('error') || result.includes('fail') || result.includes('exception');
  });

  if (errorRelatedCalls.length === 0) return 1; // No errors = full depth

  // Ratio of error handling attempts
  const handling = calls.filter(c =>
    c.tool === 'Read' || c.tool === 'Grep' // Investigation after error
  ).length;

  return Math.min(handling / errorRelatedCalls.length, 1);
}

function normalizeSessionDuration(durationMs: number): number {
  // Normalize to 0-1 based on typical session lengths
  const minutes = durationMs / 60000;
  // 5 minutes = 0.5, 20+ minutes = 1.0
  return Math.min(minutes / 20, 1);
}

function computeAdaptationScore(calls: ToolCall[]): number {
  // Look for pattern changes after user questions
  const questionIndices = calls
    .map((c, i) => c.tool === 'AskUserQuestion' ? i : -1)
    .filter(i => i >= 0);

  if (questionIndices.length === 0) return 0.5; // Neutral

  // Check if behavior changed after questions
  let adaptations = 0;
  for (const qi of questionIndices) {
    const before = calls.slice(Math.max(0, qi - 3), qi);
    const after = calls.slice(qi + 1, qi + 4);

    // Simple heuristic: different tool patterns = adaptation
    const beforeTools = new Set(before.map(c => c.tool));
    const afterTools = new Set(after.map(c => c.tool));

    const changed = [...afterTools].some(t => !beforeTools.has(t));
    if (changed) adaptations++;
  }

  return adaptations / questionIndices.length;
}

function computeExplanationDepth(_calls: ToolCall[]): number {
  // This would analyze response length/complexity
  // Simplified for now
  return 0.5;
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  actionLogToExperience,
  weightsToContextModifier,
};
