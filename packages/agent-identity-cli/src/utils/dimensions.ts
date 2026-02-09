/**
 * Shared dimension detection for the CLI.
 *
 * Replaces duplicate copies in learn.ts, hook.ts, and AgentIdentity.ts
 * with a single canonical implementation.
 */

// =============================================================================
// DIMENSION DETECTION
// =============================================================================

/**
 * Auto-detect behavioral dimension from insight/observation text.
 *
 * Uses keyword matching to identify the most relevant dimension.
 * Returns 'general' if no dimension-specific keywords are found.
 */
export function detectDimension(text: string): string {
  const lower = text.toLowerCase();

  // Curiosity patterns — exploration, learning, research
  if (/\b(explor|investigat|dig|search|read.*file|look.*into|discover|learn|understand|context|research|found)\b/.test(lower)) {
    return 'curiosity';
  }

  // Precision patterns — verification, testing, correctness
  if (/\b(test|verif|check|confirm|build|lint|type.*error|bug|fix|correct|accura|validat|error|stack)\b/.test(lower)) {
    return 'precision';
  }

  // Persistence patterns — retry, alternative approaches
  if (/\b(retry|persist|alternat|try.*again|fail.*then|attempt|keep.*trying|workaround|eventually|finally)\b/.test(lower)) {
    return 'persistence';
  }

  // Empathy patterns — user understanding, communication
  if (/\b(user|clarif|explain|prefer|adapt|question|understand.*need|communicat|style|want|need)\b/.test(lower)) {
    return 'empathy';
  }

  return 'general';
}

export default detectDimension;
