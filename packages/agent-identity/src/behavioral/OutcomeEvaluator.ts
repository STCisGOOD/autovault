/**
 * OutcomeEvaluator.ts
 *
 * Computes session quality signal R ∈ [-1, 1] from observable session data.
 *
 * This is the "loss function" of ARIL — it measures how well a session went
 * by aggregating multiple observable signals:
 *   - Energy delta (did the identity landscape improve?)
 *   - Tool success rate (did tools work?)
 *   - Error rate (how many failures occurred?)
 *   - User signals (pivotal experiences, corrections)
 *   - Declaration quality (did declarations reduce energy?)
 *   - Coherence improvement (did w approach m?)
 *
 * Includes REINFORCE-style baseline subtraction for variance reduction:
 *   R_adj = R - R̄    where R̄ = EMA(R) over recent sessions
 */

import type { ActionLog } from './BehavioralObserver';
import type { BridgeResult } from './IdentityBridge';
import { safeClamp, safeFinite, safeDivide } from './math';
import { isTestCommand, DEFAULT_STRATEGY_FEATURE_CONFIG } from './StrategyFeatureExtractor';

// =============================================================================
// TYPES
// =============================================================================

export interface OutcomeSignal {
  source: 'energy' | 'tool_success' | 'error_rate' | 'user_signal' | 'pivotal' | 'declaration' | 'test_result' | 'session_arc' | 'git_survived' | 'trajectory';
  /** Signal value in [-1, 1] */
  value: number;
  /** Signal importance weight */
  weight: number;
}

export interface SessionOutcome {
  /** Overall quality signal [-1, 1] */
  R: number;
  /** Baseline-subtracted outcome (for REINFORCE gradient) */
  R_adj: number;
  /** Individual contributing signals */
  signals: OutcomeSignal[];
  /** E_before - E_after (positive = energy decreased = improvement) */
  energyDelta: number;
  /** ‖w-m‖ change (negative = coherence improved) */
  coherenceDelta: number;
}

export interface OutcomeEvaluatorState {
  /** Running EMA of session outcomes (baseline) */
  baseline: number;
  /** Number of sessions evaluated */
  sessionCount: number;
}

export interface OutcomeEvaluatorConfig {
  /** EMA decay rate for baseline (default: 0.05) */
  baselineDecay: number;
  /** Signal weights */
  weights: {
    energy: number;
    toolSuccess: number;
    errorRate: number;
    userSignal: number;
    pivotal: number;
    declaration: number;
    testResult: number;
    sessionArc: number;
    gitSurvived: number;
  };
}

export const DEFAULT_OUTCOME_CONFIG: OutcomeEvaluatorConfig = {
  baselineDecay: 0.05,
  weights: {
    energy: 0.15,
    toolSuccess: 0.15,
    errorRate: 0.10,
    userSignal: 0.15,
    pivotal: 0.05,
    declaration: 0.00,
    testResult: 0.30,
    sessionArc: 0.15,
    gitSurvived: 0.10,
  },
};

// =============================================================================
// TOOL CLASSIFICATION (shared across signals)
// =============================================================================

/** Tools that explore/read code. */
const EXPLORE_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Task',
]);

/** Tools that modify code. */
const IMPLEMENT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

/**
 * Additional patterns beyond test commands that count as "verification" for
 * session arc detection. Lint and build/type-check commands produce objective
 * pass/fail signals, qualifying them as verification activity.
 *
 * Test command patterns are imported from StrategyFeatureExtractor
 * (DEFAULT_STRATEGY_FEATURE_CONFIG.testPatterns) — single source of truth.
 */
const LINT_BUILD_PATTERNS: readonly RegExp[] = [
  // Lint commands
  /\bnpm\s+run\s+lint\b/,
  /\bnpx\s+eslint\b/,
  /\bpylint\b/,
  /\bruff\b/,
  /\bcargo\s+clippy\b/,
  // Build/type-check commands
  /\bnpm\s+run\s+build\b/,
  /\bnpx\s+tsc\b/,
  /\btsc\b/,       // bare tsc (also matches end-of-string, unlike \btsc\s)
  /\bcargo\s+build\b/,
  /\bgo\s+build\b/,
  /\bmake\s+build\b/,
];

/**
 * Checks if a Bash tool call matches test/lint/build patterns.
 * Used by extractSessionArcSignal for arc phase detection.
 *
 * Delegates to StrategyFeatureExtractor.isTestCommand for test patterns
 * (DRY), then checks lint/build patterns locally.
 */
export function isVerifyCommand(args: Record<string, unknown>): boolean {
  // Test patterns from single source of truth
  if (isTestCommand(args, DEFAULT_STRATEGY_FEATURE_CONFIG.testPatterns)) return true;
  // Additional lint/build patterns
  const command = args.command;
  if (typeof command !== 'string') return false;
  return LINT_BUILD_PATTERNS.some(p => p.test(command));
}

// =============================================================================
// SESSION ARC SIGNAL
// =============================================================================

/**
 * Detects the explore → implement → verify arc from tool-call sequences.
 *
 * A complete arc (read code → edit code → run tests) is the strongest
 * structural indicator of a productive session. Scores:
 *   explore + implement + verify → 1.0
 *   implement + verify           → 0.8
 *   explore + verify             → 0.7
 *   verify only                  → 0.6
 *   explore + implement          → 0.5
 *   implement only               → 0.3
 *   explore only                 → 0.1
 *
 * No temporal ordering constraint — "what phases occurred" not "when".
 */
export function extractSessionArcSignal(actionLog: ActionLog): OutcomeSignal {
  const toolCalls = actionLog.toolCalls ?? [];

  if (toolCalls.length === 0) {
    return { source: 'session_arc', value: 0, weight: 0 };
  }

  let hasExplore = false;
  let hasImplement = false;
  let hasVerify = false;

  for (const tc of toolCalls) {
    if (EXPLORE_TOOLS.has(tc.tool)) {
      hasExplore = true;
    }
    if (IMPLEMENT_TOOLS.has(tc.tool)) {
      hasImplement = true;
    }
    if (tc.tool === 'Bash') {
      const args = (tc.args && typeof tc.args === 'object') ? tc.args as Record<string, unknown> : {};
      if (isVerifyCommand(args)) {
        hasVerify = true;
      }
    }
  }

  let score: number;

  if (hasExplore && hasImplement && hasVerify) {
    score = 1.0;
  } else if (!hasExplore && hasImplement && hasVerify) {
    score = 0.8;
  } else if (hasExplore && !hasImplement && hasVerify) {
    score = 0.7;
  } else if (!hasExplore && !hasImplement && hasVerify) {
    score = 0.6;
  } else if (hasExplore && hasImplement && !hasVerify) {
    score = 0.5;
  } else if (!hasExplore && hasImplement && !hasVerify) {
    score = 0.3;
  } else {
    // explore only, or no recognized tools
    score = 0.1;
  }

  return {
    source: 'session_arc',
    value: score,
    weight: DEFAULT_OUTCOME_CONFIG.weights.sessionArc,
  };
}

// =============================================================================
// TEST RESULT SIGNAL
// =============================================================================

/**
 * Extract a test result signal from an ActionLog by scanning Bash tool call
 * results for test framework output patterns (Jest, Pytest, Mocha, generic).
 *
 * This is the strongest ground truth signal for code-focused sessions:
 * "npm test" printing "Tests: 368 passed, 0 failed" is an objective measure
 * of code quality that doesn't depend on identity self-reference.
 *
 * Returns weight=0 when no tests are detected, causing the signal to drop
 * out and other weights to renormalize — non-test sessions use the old formula
 * unchanged.
 */
export function extractTestSignal(actionLog: ActionLog): OutcomeSignal {
  const toolCalls = actionLog.toolCalls ?? [];
  const bashResults: string[] = [];

  for (const tc of toolCalls) {
    // Only scan Bash tool calls (where test commands run)
    if (tc.tool === 'Bash' && typeof tc.result === 'string') {
      bashResults.push(tc.result);
    }
  }

  if (bashResults.length === 0) {
    return { source: 'test_result', value: 0, weight: 0 };
  }

  // Collect all test result matches across all Bash outputs
  const testRuns: Array<{ passed: number; failed: number; index: number }> = [];

  for (let i = 0; i < bashResults.length; i++) {
    const text = bashResults[i];

    // Jest: "Tests:  X skipped, Y passed, Z total" or "Tests:  Y passed, Z total"
    const jestTests = /Tests:\s+(?:\d+\s+\w+,\s+)*?(\d+)\s+passed(?:,\s+(\d+)\s+failed)?/g;
    let m;
    while ((m = jestTests.exec(text)) !== null) {
      testRuns.push({ passed: parseInt(m[1], 10), failed: parseInt(m[2] || '0', 10), index: i });
    }

    // Jest suites: "Test Suites: X passed, Y total"
    const jestSuites = /Test Suites:\s+(?:(\d+)\s+failed,\s+)?(\d+)\s+passed/g;
    while ((m = jestSuites.exec(text)) !== null) {
      const failed = parseInt(m[1] || '0', 10);
      const passed = parseInt(m[2], 10);
      testRuns.push({ passed, failed, index: i });
    }

    // Pytest: "X passed" or "X passed, Y failed"
    const pytest = /(\d+)\s+passed(?:,\s+(\d+)\s+failed)?/g;
    // Only match if it looks like a pytest summary line (not random text)
    if (text.includes('===') || text.includes('pytest') || text.includes('PASSED')) {
      while ((m = pytest.exec(text)) !== null) {
        testRuns.push({ passed: parseInt(m[1], 10), failed: parseInt(m[2] || '0', 10), index: i });
      }
    }

    // Mocha: "X passing" (and optionally "Y failing")
    const mochaPass = /(\d+)\s+passing/;
    const mochaFail = /(\d+)\s+failing/;
    const mPass = mochaPass.exec(text);
    if (mPass) {
      const mFail = mochaFail.exec(text);
      testRuns.push({
        passed: parseInt(mPass[1], 10),
        failed: mFail ? parseInt(mFail[1], 10) : 0,
        index: i,
      });
    }
  }

  if (testRuns.length === 0) {
    return { source: 'test_result', value: 0, weight: 0 };
  }

  // Compute per-run signal
  const signals = testRuns.map(r => {
    const total = r.passed + r.failed;
    if (total === 0) return 0;
    return (r.passed - r.failed) / total;
  });

  // Base value: average of all test run signals
  let value = signals.reduce((a, b) => a + b, 0) / signals.length;

  // Last-run weighting: if early runs fail but last run passes, boost.
  // This rewards the debug → fix → verify cycle.
  const lastRun = testRuns[testRuns.length - 1];
  const lastRunSignal = lastRun.failed === 0 && lastRun.passed > 0 ? 1.0 : signals[signals.length - 1];
  if (signals.length > 1 && signals[0] < 0.5 && lastRunSignal > 0.8) {
    value = Math.max(value, 0.7);
  }

  return {
    source: 'test_result',
    value: safeClamp(value, -1, 1, 0),
    weight: DEFAULT_OUTCOME_CONFIG.weights.testResult,
  };
}

// =============================================================================
// EVALUATOR
// =============================================================================

export class OutcomeEvaluator {
  private state: OutcomeEvaluatorState;
  private readonly config: OutcomeEvaluatorConfig;

  constructor(
    config: Partial<OutcomeEvaluatorConfig> = {},
    initialState?: OutcomeEvaluatorState
  ) {
    this.config = {
      ...DEFAULT_OUTCOME_CONFIG,
      ...config,
      weights: { ...DEFAULT_OUTCOME_CONFIG.weights, ...config.weights },
    };
    this.state = initialState ?? { baseline: 0, sessionCount: 0 };
  }

  /**
   * Evaluate a session's outcome from the bridge result and action log.
   *
   * @param extraSignals - Optional additional signals (e.g. git_survived from
   *   cross-session verification). These are added to the weighted average
   *   alongside computed signals.
   */
  evaluate(bridgeResult: BridgeResult, actionLog: ActionLog, extraSignals?: OutcomeSignal[]): SessionOutcome {
    const signals: OutcomeSignal[] = [];

    // Safely extract arrays with null guards
    const toolCalls = actionLog.toolCalls ?? [];
    const failures = actionLog.failures ?? [];
    const decisions = actionLog.decisions ?? [];
    const insights = bridgeResult.insights ?? [];
    const declarations = bridgeResult.declarations ?? [];

    // 1. Energy delta: E_before - E_after (positive = improvement)
    const eBefore = safeFinite(bridgeResult.energyBefore, 0);
    const eAfter = safeFinite(bridgeResult.energyAfter, 0);
    const energyDelta = eBefore - eAfter;
    const energySignal = safeClamp(energyDelta * 10, -1, 1, 0);
    signals.push({
      source: 'energy',
      value: energySignal,
      weight: this.config.weights.energy,
    });

    // 2. Tool success rate
    const totalTools = toolCalls.length;
    const successfulTools = toolCalls.filter(t => t.success).length;
    const toolSuccessRate = totalTools > 0 ? safeDivide(successfulTools, totalTools, 0.5) : 0.5;
    const toolSignal = toolSuccessRate * 2 - 1; // Map [0,1] to [-1,1]
    signals.push({
      source: 'tool_success',
      value: toolSignal,
      weight: this.config.weights.toolSuccess,
    });

    // 3. Error rate (inverse — fewer errors = better)
    const failureCount = failures.length;
    const totalActions = totalTools + decisions.length;
    const errorRate = totalActions > 0 ? safeDivide(failureCount, totalActions, 0) : 0;
    const errorSignal = 1 - 2 * Math.min(errorRate, 1); // 0 errors = +1, all errors = -1
    signals.push({
      source: 'error_rate',
      value: errorSignal,
      weight: this.config.weights.errorRate,
    });

    // 4. User signals: pivotal insights are strong positive
    const pivotalInsights = insights.filter(i => i.isPivotal);
    const userSignal = pivotalInsights.length > 0
      ? Math.min(pivotalInsights.length * 0.4, 1.0)
      : 0;
    signals.push({
      source: 'user_signal',
      value: userSignal,
      weight: this.config.weights.userSignal,
    });

    // 5. Declaration quality — did declarations happen?
    // (Pivotal signal merged into user_signal above to avoid double-counting)
    const declarationSignal = declarations.length > 0 ? 0.5 : 0;
    signals.push({
      source: 'declaration',
      value: declarationSignal,
      weight: this.config.weights.declaration + this.config.weights.pivotal,
    });

    // 6. Test result signal — strongest objective signal when present
    const testSignal = extractTestSignal(actionLog);
    signals.push(testSignal);

    // 7. Session arc signal — explore → implement → verify completeness
    const arcSignal = extractSessionArcSignal(actionLog);
    signals.push(arcSignal);

    // 8. Extra signals (e.g. git_survived from cross-session verification)
    if (extraSignals) {
      for (const extra of extraSignals) {
        signals.push(extra);
      }
    }

    // Compute weighted average R.
    // When testResult has weight=0 (no tests detected), it drops out and
    // other weights renormalize to sum to 1.0 — non-test sessions use the
    // old formula unchanged. Same auto-normalization applies to session_arc
    // and git_survived.
    let weightSum = 0;
    let R = 0;
    for (const signal of signals) {
      R += signal.value * signal.weight;
      weightSum += signal.weight;
    }
    R = weightSum > 0 ? safeClamp(safeDivide(R, weightSum, 0), -1, 1, 0) : 0;

    // DESIGN DECISION: No multiplicative exploration de-weighting.
    //
    // Exploration-only sessions score R ≈ 0.6 due to high tool success and
    // low error rate. This is NOT dampened for two reasons:
    //
    // 1. session_arc (additive signal above) already penalizes incomplete
    //    arcs: pure exploration scores 0.1 (weight 0.15), pulling R down
    //    from ~0.74 to ~0.61. Double-counting via a multiplicative dampener
    //    was removed because it biased fitness EMA toward zero during
    //    exploration stretches — fitness decayed at the normal rate (1-γ)
    //    but received almost no new information, eroding valid knowledge.
    //
    // 2. The two downstream consumers of R are naturally protected:
    //    - REINFORCE gradient (uses R_adj = R - baseline): If R ≈ 0.61
    //      for consecutive exploration sessions, baseline converges to
    //      0.61, making R_adj ≈ 0. The outcome gradient (αO · R_adj · φ)
    //      self-dampens to near-zero. No external dampener needed.
    //    - Fitness EMA (uses R_raw directly): Exploration sessions with
    //      R ≈ 0.61 DO update fitness, but this is correct — they teach
    //      the system which dimensions are consistently active during
    //      moderate-quality sessions. The session_arc additive signal
    //      ensures R is 18% lower for exploration (0.61) than for full
    //      implementation+test sessions (0.74), providing proportional
    //      fitness differentiation.
    //
    // The removed dampener was a crude approximation of what probabilistic
    // confidence modeling does properly: scaling observation influence by
    // estimated reliability (cf. SASR, Ma et al. ICLR 2025, which uses
    // Beta posteriors to derive self-adaptive success rates). The
    // principled future path is per-session confidence via Bayesian
    // posterior tracking (Beta-distribution or Kalman filter), not
    // multiplicative heuristics on R. The additive session_arc signal
    // provides sufficient differentiation for the current system.

    // Baseline subtraction (REINFORCE variance reduction)
    const R_adj = R - this.state.baseline;

    // Update baseline EMA — guard against NaN poisoning the baseline
    const beta = safeFinite(this.config.baselineDecay, 0.05);
    this.state.baseline = safeFinite(
      (1 - beta) * this.state.baseline + beta * R,
      this.state.baseline
    );
    this.state.sessionCount++;

    // Coherence delta: negative = coherence improved (energy decreased)
    const coherenceDelta = eAfter - eBefore;

    return {
      R,
      R_adj,
      signals,
      energyDelta,
      coherenceDelta,
    };
  }

  /**
   * Get the current evaluator state (for serialization).
   */
  getState(): OutcomeEvaluatorState {
    return { ...this.state };
  }

  /**
   * Get the current baseline value.
   */
  getBaseline(): number {
    return this.state.baseline;
  }
}

// (clamp replaced by safeClamp from ./math)
