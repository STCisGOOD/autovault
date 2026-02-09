/**
 * StrategyFeatureExtractor.ts
 *
 * Computes measurable behavioral strategy features from ActionLog tool-call
 * sequences. These replace the hardcoded personality dimensions (curiosity,
 * precision, persistence, empathy) with objective, tool-call-derived metrics.
 *
 * Each feature is:
 *   - Directly measurable from existing ActionLog data
 *   - Objectively attributable via Shapley values
 *   - Translatable to procedural+example output for .aril/strategies.md
 *
 * Part of ARIL v2 (Strategy-Atom Architecture).
 */

import type { ActionLog, ToolCall } from './BehavioralObserver';

// =============================================================================
// TYPES
// =============================================================================

/**
 * The 5 starter strategy features computed from tool-call sequences.
 * All values are in [0, 1] for compatibility with Möbius/Shapley/ARIL math.
 */
export interface StrategyFeatures {
  /** Writes with prior Read to same file / total writes. [0,1] */
  readonly readBeforeEdit: number;
  /** Edits followed by a test command within N calls / total edits. [0,1] */
  readonly testAfterChange: number;
  /** (Grep+Glob+Read) / total calls in the first session third. [0,1] */
  readonly contextGathering: number;
  /** Read-after-Write cycles / total writes. [0,1] */
  readonly outputVerification: number;
  /** Normalized error recovery speed. 1 = fast (1 call), 0 = slow/never. [0,1] */
  readonly errorRecoverySpeed: number;
}

/**
 * Ordered feature names matching the Möbius/Shapley dimension indices.
 * Index 0 = readBeforeEdit, 1 = testAfterChange, etc.
 */
export const STRATEGY_FEATURE_NAMES = [
  'read_before_edit',
  'test_after_change',
  'context_gathering',
  'output_verification',
  'error_recovery_speed',
] as const;

export type StrategyFeatureName = typeof STRATEGY_FEATURE_NAMES[number];

/** Configuration for feature extraction. */
export interface StrategyFeatureConfig {
  /** How many calls ahead to look for a test command after an edit. Default: 5. */
  readonly testLookAhead: number;
  /** Regex patterns to detect test commands in Bash args.command. */
  readonly testPatterns: readonly RegExp[];
  /** Cap for error recovery speed normalization. Calls beyond this → 0. Default: 20. */
  readonly recoverySpeedCap: number;
}

export const DEFAULT_STRATEGY_FEATURE_CONFIG: Readonly<StrategyFeatureConfig> = Object.freeze({
  testLookAhead: 5,
  testPatterns: Object.freeze([
    /\bnpm\s+test\b/,
    /\bnpm\s+run\s+test\b/,
    /\bnpx\s+(jest|vitest|mocha)\b/,
    /\bjest\b/,
    /\bpytest\b/,
    /\bmocha\b/,
    /\bvitest\b/,
    /\bcargo\s+test\b/,
    /\bgo\s+test\b/,
    /\bmake\s+test\b/,
    /\bdotnet\s+test\b/,
  ]),
  recoverySpeedCap: 20,
});

// =============================================================================
// PATH NORMALIZATION
// =============================================================================

/**
 * Normalizes a file path for comparison.
 * Handles: backslash→forward slash, leading ./, trailing slash, case (Windows).
 */
export function normalizePath(p: string): string {
  let normalized = p
    .replace(/\\/g, '/')        // backslash → forward slash
    .replace(/^\.\//, '')        // strip leading ./
    .replace(/\/+$/, '');        // strip trailing slashes
  // Collapse consecutive slashes
  normalized = normalized.replace(/\/+/g, '/');
  return normalized;
}

/**
 * Extracts a file path from tool call args, if present.
 * Returns normalized path or null.
 */
export function extractFilePath(tool: string, args: Record<string, unknown>): string | null {
  // Read, Write, Edit all use file_path
  if (args.file_path && typeof args.file_path === 'string') {
    return normalizePath(args.file_path);
  }
  // Glob uses pattern (not a file path per se, skip)
  // Grep uses path (directory, not specific file)
  // Bash has no file_path
  return null;
}

// =============================================================================
// TEST DETECTION
// =============================================================================

/** Tools that modify files (writes/edits). */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

/** Tools that read files. */
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

/** Tools that are context-gathering (exploration). */
const CONTEXT_TOOLS = new Set(['Read', 'Grep', 'Glob']);

/**
 * Checks if a Bash tool call is running a test command.
 */
export function isTestCommand(args: Record<string, unknown>, patterns: readonly RegExp[]): boolean {
  const command = args.command;
  if (typeof command !== 'string') return false;
  return patterns.some(p => p.test(command));
}

// =============================================================================
// FEATURE EXTRACTION
// =============================================================================

/**
 * Computes the 5 strategy features from an ActionLog.
 *
 * Each feature measures a specific behavioral pattern in the tool-call sequence:
 *
 * 1. **read_before_edit**: Did the agent read a file before modifying it?
 *    Measures: information-gathering discipline.
 *
 * 2. **test_after_change**: Did the agent run tests after making changes?
 *    Measures: verification discipline.
 *
 * 3. **context_gathering**: How much of the early session was exploration?
 *    Measures: upfront context building vs. diving in blind.
 *
 * 4. **output_verification**: Did the agent read files after writing them?
 *    Measures: output validation discipline.
 *
 * 5. **error_recovery_speed**: How quickly does the agent recover from errors?
 *    Measures: debugging efficiency.
 */
export function extractStrategyFeatures(
  actionLog: ActionLog,
  config: StrategyFeatureConfig = DEFAULT_STRATEGY_FEATURE_CONFIG,
): StrategyFeatures {
  const calls = actionLog.toolCalls;

  return {
    readBeforeEdit: computeReadBeforeEdit(calls),
    testAfterChange: computeTestAfterChange(calls, config),
    contextGathering: computeContextGathering(calls),
    outputVerification: computeOutputVerification(calls),
    errorRecoverySpeed: computeErrorRecoverySpeed(calls, config),
  };
}

/**
 * Converts StrategyFeatures to an array ordered by STRATEGY_FEATURE_NAMES.
 * Index 0 = readBeforeEdit, 1 = testAfterChange, etc.
 */
export function featuresToArray(features: StrategyFeatures): number[] {
  return [
    features.readBeforeEdit,
    features.testAfterChange,
    features.contextGathering,
    features.outputVerification,
    features.errorRecoverySpeed,
  ];
}

/**
 * Converts an array (ordered by STRATEGY_FEATURE_NAMES) back to StrategyFeatures.
 */
export function arrayToFeatures(arr: number[]): StrategyFeatures {
  if (arr.length < 5) {
    throw new Error(`Expected at least 5 feature values, got ${arr.length}`);
  }
  return {
    readBeforeEdit: arr[0],
    testAfterChange: arr[1],
    contextGathering: arr[2],
    outputVerification: arr[3],
    errorRecoverySpeed: arr[4],
  };
}

// =============================================================================
// INDIVIDUAL FEATURE COMPUTATIONS
// =============================================================================

/**
 * read_before_edit: For each Write/Edit call, was there a prior Read to the same file?
 *
 * Ratio: edits-with-prior-read / total-edits
 * If no edits in session → 0 (neutral).
 */
export function computeReadBeforeEdit(calls: readonly ToolCall[]): number {
  // Track all files that have been Read during this session
  const readFiles = new Set<string>();
  let edits = 0;
  let editsWithPriorRead = 0;

  for (const call of calls) {
    if (READ_TOOLS.has(call.tool)) {
      const path = extractFilePath(call.tool, call.args);
      if (path) readFiles.add(path);
    }

    if (EDIT_TOOLS.has(call.tool)) {
      edits++;
      const path = extractFilePath(call.tool, call.args);
      if (path && readFiles.has(path)) {
        editsWithPriorRead++;
      }
    }
  }

  return edits === 0 ? 0 : editsWithPriorRead / edits;
}

/**
 * test_after_change: For each Write/Edit call, is there a Bash test command
 * within the next `testLookAhead` calls?
 *
 * Ratio: edits-followed-by-test / total-edits
 * If no edits → 0 (neutral).
 */
export function computeTestAfterChange(
  calls: readonly ToolCall[],
  config: StrategyFeatureConfig = DEFAULT_STRATEGY_FEATURE_CONFIG,
): number {
  let edits = 0;
  let editsFollowedByTest = 0;

  for (let i = 0; i < calls.length; i++) {
    if (!EDIT_TOOLS.has(calls[i].tool)) continue;
    edits++;

    // Look ahead up to testLookAhead calls for a test command
    const lookEnd = Math.min(i + config.testLookAhead + 1, calls.length);
    for (let j = i + 1; j < lookEnd; j++) {
      if (calls[j].tool === 'Bash' && isTestCommand(calls[j].args, config.testPatterns)) {
        editsFollowedByTest++;
        break; // Don't double-count
      }
    }
  }

  return edits === 0 ? 0 : editsFollowedByTest / edits;
}

/**
 * context_gathering: Proportion of context-gathering tool calls (Read, Grep, Glob)
 * in the first third of the session.
 *
 * Ratio: context-calls-in-first-third / total-calls-in-first-third
 * If no calls in first third → 0.
 */
export function computeContextGathering(calls: readonly ToolCall[]): number {
  if (calls.length === 0) return 0;

  const firstThirdEnd = Math.ceil(calls.length / 3);
  let contextCalls = 0;

  for (let i = 0; i < firstThirdEnd; i++) {
    if (CONTEXT_TOOLS.has(calls[i].tool)) {
      contextCalls++;
    }
  }

  return contextCalls / firstThirdEnd;
}

/**
 * output_verification: For each Write call, is there a subsequent Read to the same file?
 *
 * Ratio: writes-followed-by-read / total-writes
 * If no writes → 0 (neutral).
 *
 * Note: Only counts Write (not Edit), since Edit is an in-place modification
 * where re-reading is less meaningful than verifying a newly created file.
 */
export function computeOutputVerification(calls: readonly ToolCall[]): number {
  let writes = 0;
  let writesFollowedByRead = 0;

  // Build a map of files that are Read after each position
  // For efficiency, work backward to build "files read after position i"
  const readAfter = new Set<string>();
  const readAfterSets: Set<string>[] = new Array(calls.length);

  // Build from the end
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].tool === 'Read') {
      const path = extractFilePath(calls[i].tool, calls[i].args);
      if (path) readAfter.add(path);
    }
    readAfterSets[i] = new Set(readAfter);
  }

  for (let i = 0; i < calls.length; i++) {
    if (calls[i].tool !== 'Write') continue;
    writes++;
    const path = extractFilePath(calls[i].tool, calls[i].args);
    if (path && i + 1 < calls.length && readAfterSets[i + 1].has(path)) {
      writesFollowedByRead++;
    }
  }

  return writes === 0 ? 0 : writesFollowedByRead / writes;
}

/**
 * error_recovery_speed: Mean number of tool calls between a Bash failure
 * and the next Bash success.
 *
 * Raw value: mean calls to recovery ∈ [1, ∞)
 * Normalized to [0, 1] via: 1 / mean_calls (capped at recoverySpeedCap).
 *
 * If no Bash failures → 1.0 (no errors to recover from = perfect).
 * If failures with no subsequent success → 0 (never recovered).
 */
export function computeErrorRecoverySpeed(
  calls: readonly ToolCall[],
  config: StrategyFeatureConfig = DEFAULT_STRATEGY_FEATURE_CONFIG,
): number {
  const recoveries: number[] = [];
  let seekingRecovery = false;
  let callsSinceFailure = 0;

  for (const call of calls) {
    if (seekingRecovery) {
      callsSinceFailure++;
      if (call.tool === 'Bash' && call.success) {
        recoveries.push(callsSinceFailure);
        seekingRecovery = false;
      }
    }

    // A new Bash failure starts (or restarts) a recovery search
    if (call.tool === 'Bash' && !call.success) {
      if (seekingRecovery) {
        // Previous failure never recovered — record as cap
        recoveries.push(config.recoverySpeedCap);
      }
      seekingRecovery = true;
      callsSinceFailure = 0;
    }
  }

  // If still seeking at end of session, failure was never recovered
  if (seekingRecovery) {
    recoveries.push(config.recoverySpeedCap);
  }

  // No failures → perfect score
  if (recoveries.length === 0) return 1.0;

  const mean = recoveries.reduce((a, b) => a + b, 0) / recoveries.length;
  // Normalize: 1/mean maps [1, ∞) → (0, 1], cap ensures minimum is 1/cap
  return Math.min(1, 1 / mean);
}
