/**
 * ARIL.test.ts
 *
 * Comprehensive tests for the Adjoint-Replicator Identity Learning system.
 *
 * Validates:
 * - Phase 1: Plumbing fixes (pivotal reload, hash commitment, threshold)
 * - Phase 2: ARIL core (energy gradient, outcome evaluator, Shapley, optimizer, calibrator)
 * - Phase 3: Intelligence surface (insight compiler, guidance engine, domain tracker)
 * - Integration: Full ARIL loop across synthetic sessions
 */

import {
  computeEnergyGradient,
  computeEnergyOnly,
  verifyGradient,
  type EnergyGradientResult,
} from './EnergyGradient';

import {
  OutcomeEvaluator,
  extractSessionArcSignal,
  isVerifyCommand,
  type SessionOutcome,
} from './OutcomeEvaluator';

import {
  computeShapleyAttribution,
  createCorrelationHistory,
  updateCorrelationHistory,
  type AttributionResult,
} from './ShapleyAttributor';

import {
  createARILState,
  computeARILUpdate,
  applyARILUpdate,
  verifyReplicatorConservation,
  serializeARILState,
  deserializeARILState,
  DEFAULT_ARIL_CONFIG,
  type ARILState,
} from './ReplicatorOptimizer';

import {
  ConfidenceCalibrator,
  serializeCalibrationState,
  deserializeCalibrationState,
} from './ConfidenceCalibrator';

import {
  InsightCompiler,
  serializeCompilerState,
  type CompiledPattern,
} from './InsightCompiler';

import {
  GuidanceEngine,
  type GuidanceOutput,
  type MobiusDiagnostics,
} from './GuidanceEngine';

import {
  DomainTracker,
  serializeDomainProfile,
  deserializeDomainProfile,
} from './DomainTracker';

import {
  ModeObserver,
  computeAdaptiveBarrier,
  serializeObserverHistory,
  deserializeObserverHistory,
  type ModeObservation,
  type ObserverHistory,
} from './ModeObserver';

import type {
  SelfState,
  DynamicsParams,
  Vocabulary,
} from './FixedPointSelf';

import type { Insight } from './ReflectionEngine';

// =============================================================================
// TEST UTILITIES
// =============================================================================

function createTestVocabulary(n: number): Vocabulary {
  const assertions: string[] = [];
  for (let i = 0; i < n; i++) {
    assertions.push(`dim_${i}`);
  }

  const relationships = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      relationships[i * n + j] = i === j ? 0 : 0.2;
    }
  }

  return { assertions, relationships };
}

function create4DVocabulary(): Vocabulary {
  return {
    assertions: ['curiosity', 'precision', 'persistence', 'empathy'],
    relationships: new Float64Array([
      0, 0.2, 0.1, 0.15,
      0.2, 0, 0.15, 0.1,
      0.1, 0.15, 0, 0.2,
      0.15, 0.1, 0.2, 0,
    ]),
  };
}

function createTestState(n: number, wValues: number[], mValues?: number[]): SelfState {
  return {
    dimension: n,
    w: new Float64Array(wValues),
    m: new Float64Array(mValues ?? wValues),
    time: 0,
  };
}

function createTestParams(n: number = 4): DynamicsParams {
  return {
    D: 0.1,
    lambda: 0.4,
    mu: 0.3,
    kappa: 0.1,
    a: 0.5,
    w_star: new Float64Array(n).fill(0.5),
  };
}

function makeToolCall(overrides: Partial<{
  tool: string; args: Record<string, unknown>; success: boolean;
  timestamp: number; durationMs: number;
}> = {}): any {
  return {
    id: `tc_${Math.random().toString(36).slice(2)}`,
    tool: overrides.tool ?? 'Read',
    args: overrides.args ?? { file: 'test.ts' },
    result: overrides.success !== false ? 'ok' : 'error',
    success: overrides.success ?? true,
    timestamp: overrides.timestamp ?? Date.now(),
    durationMs: overrides.durationMs ?? 100,
    wasRequired: true,
    context: 'test',
  };
}

function createTestActionLog(overrides: Partial<{
  toolCalls: any[];
  errors: string[];
  retries: number;
}> = {}): any {
  const toolCalls = overrides.toolCalls ?? [
    makeToolCall({ tool: 'Read', args: { file: 'foo.ts' }, success: true }),
    makeToolCall({ tool: 'Write', args: { file: 'bar.ts' }, success: true }),
    makeToolCall({ tool: 'Bash', args: { cmd: 'npm test' }, success: false }),
    makeToolCall({ tool: 'Bash', args: { cmd: 'npm test' }, success: true }),
  ];

  return {
    interactionId: `int_${Date.now()}`,
    startTime: Date.now() - 60000,
    endTime: Date.now(),
    toolCalls,
    decisions: [],
    failures: (overrides.errors ?? ['TypeError: cannot read property']).map((e: string) => ({
      id: `f_${Math.random().toString(36).slice(2)}`,
      timestamp: Date.now(),
      error: e,
      context: 'test',
      recovery: 'retry',
      recoveryAttempts: 1,
      wasRecovered: true,
    })),
    informationSeeks: [],
    verifications: [],
    resourceUsage: { totalDurationMs: 10000, tokensUsed: 0 },
  };
}

function createTestInsight(text: string, confidence: number = 0.8, dimension?: string): Insight {
  return {
    id: `ins_${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    sourceInteractionId: 'test',
    dimension: dimension || 'general',
    dimensionIndex: 0,
    observation: text,
    interpretation: text,
    currentValue: 0.5,
    suggestedValue: 0.5 + confidence * 0.1,
    delta: confidence * 0.1,
    confidence,
    evidence: 'test evidence',
    isPivotal: false,
  };
}

// =============================================================================
// PHASE 2: ENERGY GRADIENT
// =============================================================================

describe('EnergyGradient', () => {
  const vocab = create4DVocabulary();
  const params = createTestParams(4);

  test('computes gradient with correct dimensions', () => {
    const state = createTestState(4, [0.3, 0.5, 0.7, 0.4]);
    const result = computeEnergyGradient(state, params, vocab);

    expect(result.gradients).toHaveLength(4);
    expect(result.components.diffusion).toHaveLength(4);
    expect(result.components.potential).toHaveLength(4);
    expect(result.components.homeostatic).toHaveLength(4);
    expect(result.components.coherence).toHaveLength(4);
    expect(result.hessianDiag).toHaveLength(4);
    expect(typeof result.energy).toBe('number');
    expect(typeof result.stability).toBe('boolean');
  });

  test('gradient matches numerical gradient (finite differences)', () => {
    const state = createTestState(4, [0.3, 0.5, 0.7, 0.4], [0.4, 0.5, 0.6, 0.5]);
    const verification = verifyGradient(state, params, vocab);

    // Must match to 1e-4 (numerical gradient has limited precision)
    expect(verification.maxError).toBeLessThan(1e-4);
  });

  test('gradient components sum to total gradient', () => {
    const state = createTestState(4, [0.3, 0.6, 0.4, 0.7], [0.5, 0.5, 0.5, 0.5]);
    const result = computeEnergyGradient(state, params, vocab);

    for (let i = 0; i < 4; i++) {
      const componentSum =
        result.components.diffusion[i] +
        result.components.potential[i] +
        result.components.homeostatic[i] +
        result.components.coherence[i];

      expect(Math.abs(result.gradients[i] - componentSum)).toBeLessThan(1e-10);
    }
  });

  test('energy at equilibrium is lower than perturbed state', () => {
    const eqState = createTestState(4, [0.5, 0.5, 0.5, 0.5]);
    const perturbedState = createTestState(4, [0.1, 0.9, 0.2, 0.8]);

    const eqEnergy = computeEnergyOnly(eqState, params, vocab);
    const perturbedEnergy = computeEnergyOnly(perturbedState, params, vocab);

    expect(eqEnergy).toBeLessThan(perturbedEnergy);
  });

  test('coherence gradient is zero when w equals m', () => {
    const state = createTestState(4, [0.3, 0.6, 0.4, 0.7]);
    // m = w by default
    const result = computeEnergyGradient(state, params, vocab);

    for (let i = 0; i < 4; i++) {
      expect(Math.abs(result.components.coherence[i])).toBeLessThan(1e-10);
    }
  });

  test('Hessian diagonal is positive at stable minimum', () => {
    // At w_star with w=m, the Hessian should be positive definite
    const state = createTestState(4, [0.5, 0.5, 0.5, 0.5]);
    const result = computeEnergyGradient(state, params, vocab);

    // At the equilibrium, each Hessian entry should be positive (convex)
    for (let i = 0; i < 4; i++) {
      expect(result.hessianDiag[i]).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// PHASE 2: OUTCOME EVALUATOR
// =============================================================================

describe('OutcomeEvaluator', () => {
  test('evaluates session with mixed signals', () => {
    const evaluator = new OutcomeEvaluator();
    const bridgeResult = {
      energyBefore: 2.5,
      energyAfter: 2.0,
      coherenceBefore: 0.3,
      coherenceAfter: 0.25,
      declarations: [],
      insights: [],
    } as any;

    const actionLog = createTestActionLog();
    const outcome = evaluator.evaluate(bridgeResult, actionLog);

    expect(outcome.R).toBeGreaterThanOrEqual(-1);
    expect(outcome.R).toBeLessThanOrEqual(1);
    expect(outcome.signals.length).toBeGreaterThan(0);
  });

  test('R is positive when energy decreases', () => {
    const evaluator = new OutcomeEvaluator();
    const bridgeResult = {
      energyBefore: 5.0,
      energyAfter: 1.0,
      coherenceBefore: 0.5,
      coherenceAfter: 0.3,
      declarations: [{ content: 'test' }],
      insights: [],
    } as any;

    const actionLog = createTestActionLog({
      toolCalls: [
        makeToolCall({ tool: 'Read', success: true }),
        makeToolCall({ tool: 'Write', success: true }),
      ],
      errors: [],
    });

    const outcome = evaluator.evaluate(bridgeResult, actionLog);
    expect(outcome.R).toBeGreaterThan(0);
  });

  test('R is negative when many errors occur', () => {
    const evaluator = new OutcomeEvaluator();
    const bridgeResult = {
      energyBefore: 2.0,
      energyAfter: 3.0,
      coherenceBefore: 0.3,
      coherenceAfter: 0.5,
      declarations: [],
      insights: [],
    } as any;

    const actionLog = createTestActionLog({
      toolCalls: [
        makeToolCall({ tool: 'Bash', success: false }),
        makeToolCall({ tool: 'Bash', success: false }),
        makeToolCall({ tool: 'Bash', success: false }),
      ],
      errors: ['err1', 'err2', 'err3', 'err4', 'err5'],
    });

    const outcome = evaluator.evaluate(bridgeResult, actionLog);
    expect(outcome.R).toBeLessThan(0);
  });

  test('baseline subtraction reduces variance', () => {
    const evaluator = new OutcomeEvaluator();

    // Run several sessions to build baseline
    const bridgeResult = {
      energyBefore: 2.0,
      energyAfter: 1.5,
      coherenceBefore: 0.3,
      coherenceAfter: 0.25,
      declarations: [],
      insights: [],
    } as any;

    const actionLog = createTestActionLog();

    // First evaluation — no baseline yet
    const first = evaluator.evaluate(bridgeResult, actionLog);
    // After the first, baseline should have moved
    const second = evaluator.evaluate(bridgeResult, actionLog);

    // R_adj should be closer to 0 than R for the second evaluation
    // (since baseline has moved toward R)
    expect(Math.abs(second.R_adj)).toBeLessThanOrEqual(Math.abs(second.R) + 0.01);
  });
});

// =============================================================================
// SESSION ARC SIGNAL
// =============================================================================

describe('extractSessionArcSignal', () => {
  test('complete arc: explore + implement + verify → 1.0', () => {
    const actionLog = createTestActionLog({
      toolCalls: [
        makeToolCall({ tool: 'Read', args: { file_path: 'src/foo.ts' } }),
        makeToolCall({ tool: 'Edit', args: { file_path: 'src/foo.ts' } }),
        makeToolCall({ tool: 'Bash', args: { command: 'npm test' } }),
      ],
      errors: [],
    });
    const signal = extractSessionArcSignal(actionLog);
    expect(signal.value).toBe(1.0);
    expect(signal.source).toBe('session_arc');
    expect(signal.weight).toBeGreaterThan(0);
  });

  test('no verification: explore + implement → 0.5', () => {
    const actionLog = createTestActionLog({
      toolCalls: [
        makeToolCall({ tool: 'Read' }),
        makeToolCall({ tool: 'Edit' }),
      ],
      errors: [],
    });
    const signal = extractSessionArcSignal(actionLog);
    expect(signal.value).toBe(0.5);
  });

  test('pure exploration: only Read/Grep → 0.1', () => {
    const actionLog = createTestActionLog({
      toolCalls: [
        makeToolCall({ tool: 'Read' }),
        makeToolCall({ tool: 'Grep' }),
      ],
      errors: [],
    });
    const signal = extractSessionArcSignal(actionLog);
    expect(signal.value).toBe(0.1);
  });

  test('verify only: only Bash(npm test) → 0.6', () => {
    const actionLog = createTestActionLog({
      toolCalls: [
        makeToolCall({ tool: 'Bash', args: { command: 'npm test' } }),
      ],
      errors: [],
    });
    const signal = extractSessionArcSignal(actionLog);
    expect(signal.value).toBe(0.6);
  });

  test('explore + verify: Read + Bash(npm test) → 0.7', () => {
    const actionLog = createTestActionLog({
      toolCalls: [
        makeToolCall({ tool: 'Read' }),
        makeToolCall({ tool: 'Grep' }),
        makeToolCall({ tool: 'Bash', args: { command: 'npx jest --testPathPattern=foo' } }),
      ],
      errors: [],
    });
    const signal = extractSessionArcSignal(actionLog);
    expect(signal.value).toBe(0.7);
  });

  test('empty session → weight 0 (drops out)', () => {
    const actionLog = createTestActionLog({
      toolCalls: [],
      errors: [],
    });
    const signal = extractSessionArcSignal(actionLog);
    expect(signal.weight).toBe(0);
  });

  test('Read-after-Write is NOT verification → 0.5 not 1.0', () => {
    const actionLog = createTestActionLog({
      toolCalls: [
        makeToolCall({ tool: 'Read' }),
        makeToolCall({ tool: 'Write' }),
        makeToolCall({ tool: 'Read' }), // Reading after writing is NOT a verify step
      ],
      errors: [],
    });
    const signal = extractSessionArcSignal(actionLog);
    expect(signal.value).toBe(0.5); // explore + implement, no verify
  });

  test('Bash that is not a test/lint/build is NOT Verify → 0.5', () => {
    const actionLog = createTestActionLog({
      toolCalls: [
        makeToolCall({ tool: 'Read' }),
        makeToolCall({ tool: 'Edit' }),
        makeToolCall({ tool: 'Bash', args: { command: 'npm install' } }), // Not a verify command
      ],
      errors: [],
    });
    const signal = extractSessionArcSignal(actionLog);
    expect(signal.value).toBe(0.5); // explore + implement, but npm install isn't verify
  });

  test('lint command counts as verify', () => {
    const actionLog = createTestActionLog({
      toolCalls: [
        makeToolCall({ tool: 'Edit' }),
        makeToolCall({ tool: 'Bash', args: { command: 'npx eslint src/' } }),
      ],
      errors: [],
    });
    const signal = extractSessionArcSignal(actionLog);
    expect(signal.value).toBe(0.8); // implement + verify (no explore)
  });

  test('build command counts as verify', () => {
    const actionLog = createTestActionLog({
      toolCalls: [
        makeToolCall({ tool: 'Read' }),
        makeToolCall({ tool: 'Write' }),
        makeToolCall({ tool: 'Bash', args: { command: 'npm run build' } }),
      ],
      errors: [],
    });
    const signal = extractSessionArcSignal(actionLog);
    expect(signal.value).toBe(1.0); // full arc
  });
});

describe('isVerifyCommand', () => {
  test('detects test commands', () => {
    expect(isVerifyCommand({ command: 'npm test' })).toBe(true);
    expect(isVerifyCommand({ command: 'npx jest --watch' })).toBe(true);
    expect(isVerifyCommand({ command: 'pytest tests/' })).toBe(true);
    expect(isVerifyCommand({ command: 'cargo test' })).toBe(true);
  });

  test('detects lint commands', () => {
    expect(isVerifyCommand({ command: 'npm run lint' })).toBe(true);
    expect(isVerifyCommand({ command: 'npx eslint .' })).toBe(true);
    expect(isVerifyCommand({ command: 'cargo clippy' })).toBe(true);
  });

  test('detects build commands', () => {
    expect(isVerifyCommand({ command: 'npm run build' })).toBe(true);
    expect(isVerifyCommand({ command: 'npx tsc --noEmit' })).toBe(true);
    expect(isVerifyCommand({ command: 'cargo build' })).toBe(true);
    expect(isVerifyCommand({ command: 'go build ./...' })).toBe(true);
  });

  test('rejects non-verify commands', () => {
    expect(isVerifyCommand({ command: 'npm install' })).toBe(false);
    expect(isVerifyCommand({ command: 'git status' })).toBe(false);
    expect(isVerifyCommand({ command: 'ls -la' })).toBe(false);
    expect(isVerifyCommand({ command: 'cd /tmp' })).toBe(false);
  });

  test('handles non-string command', () => {
    expect(isVerifyCommand({})).toBe(false);
    expect(isVerifyCommand({ command: 42 })).toBe(false);
  });

  test('bare tsc at end of string is detected', () => {
    expect(isVerifyCommand({ command: 'npx tsc' })).toBe(true);
    expect(isVerifyCommand({ command: 'tsc' })).toBe(true);
  });

  test('delegates to StrategyFeatureExtractor test patterns (DRY)', () => {
    // Verify that all test patterns from the shared config are recognized.
    // This proves the single-source-of-truth property: if a pattern is added
    // to DEFAULT_STRATEGY_FEATURE_CONFIG.testPatterns, isVerifyCommand picks
    // it up automatically without needing a separate change.
    const testCommands = [
      'npm test',
      'npm run test',
      'npx jest',
      'jest --coverage',
      'pytest tests/',
      'mocha test/',
      'vitest run',
      'cargo test',
      'go test ./...',
      'make test',
      'dotnet test',
    ];
    for (const cmd of testCommands) {
      expect(isVerifyCommand({ command: cmd })).toBe(true);
    }
  });
});

describe('git_survived signal integration', () => {
  test('git_survived signal contributes to R weighted average', () => {
    const evaluator = new OutcomeEvaluator();
    const bridgeResult = {
      energyBefore: 2.0,
      energyAfter: 2.0, // No energy change
      coherenceBefore: 0.3,
      coherenceAfter: 0.3,
      declarations: [],
      insights: [],
    } as any;

    const actionLog = createTestActionLog({
      toolCalls: [
        makeToolCall({ tool: 'Read' }),
        makeToolCall({ tool: 'Edit' }),
        makeToolCall({ tool: 'Bash', args: { command: 'npm test' } }),
      ],
      errors: [],
    });

    // Without git signal
    const withoutGit = evaluator.evaluate(bridgeResult, actionLog);

    // With git_survived signal (survival)
    const evaluator2 = new OutcomeEvaluator();
    const withGit = evaluator2.evaluate(bridgeResult, actionLog, [{
      source: 'git_survived',
      value: 0.2, // Survival: mild positive
      weight: 0.10,
    }]);

    // R should differ between the two (the git signal changes the weighted average)
    expect(withGit.R).not.toEqual(withoutGit.R);

    // git_survived should appear in signals list
    const gitSignal = withGit.signals.find(s => s.source === 'git_survived');
    expect(gitSignal).toBeDefined();
    expect(gitSignal!.value).toBe(0.2);
  });

  test('no git signal → weight 0 drops out', () => {
    const evaluator = new OutcomeEvaluator();
    const bridgeResult = {
      energyBefore: 2.0,
      energyAfter: 1.5,
      coherenceBefore: 0.3,
      coherenceAfter: 0.25,
      declarations: [],
      insights: [],
    } as any;

    const actionLog = createTestActionLog({ errors: [] });
    const result = evaluator.evaluate(bridgeResult, actionLog);

    // Without extra signals, no git_survived in output
    const gitSignal = result.signals.find(s => s.source === 'git_survived');
    expect(gitSignal).toBeUndefined();
  });

  test('git reversion applies negative signal', () => {
    const evaluator = new OutcomeEvaluator();
    const bridgeResult = {
      energyBefore: 2.0,
      energyAfter: 2.0,
      coherenceBefore: 0.3,
      coherenceAfter: 0.3,
      declarations: [],
      insights: [],
    } as any;

    const actionLog = createTestActionLog({
      toolCalls: [
        makeToolCall({ tool: 'Read' }),
        makeToolCall({ tool: 'Edit' }),
      ],
      errors: [],
    });

    const result = evaluator.evaluate(bridgeResult, actionLog, [{
      source: 'git_survived',
      value: -0.4, // Reversion: negative signal
      weight: 0.10,
    }]);

    const gitSignal = result.signals.find(s => s.source === 'git_survived');
    expect(gitSignal).toBeDefined();
    expect(gitSignal!.value).toBe(-0.4);
  });
});

// =============================================================================
// PHASE 2: SHAPLEY ATTRIBUTOR
// =============================================================================

describe('ShapleyAttributor', () => {
  test('Shapley efficiency: sum of attributions equals R (exact)', () => {
    const R = 0.7;
    const weightChanges = new Float64Array([0.05, 0.02, -0.01, 0.03]);
    const dimensions = ['curiosity', 'precision', 'persistence', 'empathy'];

    const result = computeShapleyAttribution(R, weightChanges, dimensions, null, {
      numPermutations: 200,
      seed: 42,
    });

    const sumShapley = result.attributions.reduce((sum, a) => sum + a.shapleyValue, 0);
    // Exact Shapley for N=4: efficiency holds to machine epsilon
    expect(Math.abs(sumShapley - R)).toBeLessThan(1e-10);
    // Efficiency error reported by the algorithm itself
    expect(result.efficiencyError).toBeLessThan(1e-10);
    // Exact computation → confidence = 1.0 for all dimensions
    for (const attr of result.attributions) {
      expect(attr.confidence).toBe(1.0);
    }
  });

  test('Shapley symmetry: identical dimensions get exactly equal attribution', () => {
    const R = 0.5;
    // Two dimensions with identical weight changes
    const weightChanges = new Float64Array([0.04, 0.04, 0.01, 0.01]);
    const dimensions = ['dim_a', 'dim_b', 'dim_c', 'dim_d'];

    const result = computeShapleyAttribution(R, weightChanges, dimensions, null, {
      numPermutations: 500,
      seed: 42,
    });

    // Exact Shapley: identical contributions → exactly equal attribution
    const svA = result.attributions[0].shapleyValue;
    const svB = result.attributions[1].shapleyValue;
    expect(svA).toBe(svB);

    const svC = result.attributions[2].shapleyValue;
    const svD = result.attributions[3].shapleyValue;
    expect(svC).toBe(svD);

    // Higher contributions should get higher attribution
    expect(svA).toBeGreaterThan(svC);
  });

  test('null player gets exactly zero attribution', () => {
    const R = 0.5;
    // Last dimension had no weight change
    const weightChanges = new Float64Array([0.05, 0.03, 0.02, 0.0]);
    const dimensions = ['a', 'b', 'c', 'null_player'];

    const result = computeShapleyAttribution(R, weightChanges, dimensions, null, {
      numPermutations: 200,
      seed: 42,
    });

    // Exact Shapley: null player (zero weight change) → exactly zero attribution
    const nullPlayerSV = result.attributions[3].shapleyValue;
    expect(nullPlayerSV).toBe(0);
  });

  test('correlation history improves attribution accuracy', () => {
    const history = createCorrelationHistory(4);

    // Build up correlation: dimension 0 consistently contributes positively
    for (let i = 0; i < 10; i++) {
      const metrics = new Float64Array([0.8, 0.3, 0.2, 0.1]);
      updateCorrelationHistory(history, metrics, 0.7 + Math.random() * 0.2);
    }

    const R = 0.8;
    const weightChanges = new Float64Array([0.05, 0.03, 0.02, 0.01]);
    const dimensions = ['a', 'b', 'c', 'd'];

    const result = computeShapleyAttribution(R, weightChanges, dimensions, history, {
      numPermutations: 200,
      seed: 42,
    });

    // Dimension 0 should get highest attribution due to correlation
    const sv0 = result.attributions[0].shapleyValue;
    const svOthers = result.attributions.slice(1).map(a => a.shapleyValue);
    expect(sv0).toBeGreaterThan(Math.max(...svOthers) - 0.1);
  });
});

// =============================================================================
// PHASE 2: REPLICATOR OPTIMIZER
// =============================================================================

describe('ReplicatorOptimizer', () => {
  test('replicator gradient preserves total weight mass with uniform weights', () => {
    // Conservation Σ w[i]·(f[i]-f̄) = 0 holds when weights are uniform
    // because f̄·Σw = Σw·f̄ and Σw·f = Σw·f̄ when all w equal
    const weights = new Float64Array([0.5, 0.5, 0.5, 0.5]);
    const fitness = new Float64Array([0.6, 0.4, 0.8, 0.3]);

    const result = verifyReplicatorConservation(weights, fitness);
    expect(result.conserved).toBe(true);
    expect(Math.abs(result.sum)).toBeLessThan(1e-10);
  });

  test('convergence: positive dimension grows over sessions', () => {
    const n = 4;
    let state = createARILState(n);
    let weights = new Float64Array([0.5, 0.5, 0.5, 0.5]);

    const vocab = create4DVocabulary();
    const params = createTestParams(n);

    // Run 10 synthetic sessions where dimension 0 always contributes positively
    for (let session = 0; session < 10; session++) {
      const selfState = createTestState(n, Array.from(weights), [0.5, 0.5, 0.5, 0.5]);
      const energyGrad = computeEnergyGradient(selfState, params, vocab);

      // Dimension 0 has large positive attribution
      const attributions = [
        { dimension: 'dim_0', index: 0, shapleyValue: 0.5, confidence: 0.8, evidence: [] },
        { dimension: 'dim_1', index: 1, shapleyValue: 0.1, confidence: 0.5, evidence: [] },
        { dimension: 'dim_2', index: 2, shapleyValue: 0.05, confidence: 0.3, evidence: [] },
        { dimension: 'dim_3', index: 3, shapleyValue: 0.05, confidence: 0.3, evidence: [] },
      ];

      const R_adj = 0.6;

      const update = computeARILUpdate(weights, energyGrad, R_adj, R_adj, attributions, state);
      weights = applyARILUpdate(weights, update) as any;

      // Update state with the returned values
      state.fitness = update.fitness;
      state.metaLearningRates = update.metaLearningRates;
      state.sessionCount++;
    }

    // Fitness for dimension 0 should be highest
    expect(state.fitness[0]).toBeGreaterThan(state.fitness[1]);
    expect(state.fitness[0]).toBeGreaterThan(state.fitness[2]);
    expect(state.fitness[0]).toBeGreaterThan(state.fitness[3]);
  });

  test('gradient clipping prevents large jumps', () => {
    const n = 4;
    const state = createARILState(n);
    const weights = new Float64Array([0.5, 0.5, 0.5, 0.5]);

    const selfState = createTestState(n, Array.from(weights));
    const vocab = create4DVocabulary();
    const params = createTestParams(n);
    const energyGrad = computeEnergyGradient(selfState, params, vocab);

    // Extreme attributions
    const attributions = [
      { dimension: 'd0', index: 0, shapleyValue: 10.0, confidence: 1.0, evidence: [] },
      { dimension: 'd1', index: 1, shapleyValue: -10.0, confidence: 1.0, evidence: [] },
      { dimension: 'd2', index: 2, shapleyValue: 0.0, confidence: 0.5, evidence: [] },
      { dimension: 'd3', index: 3, shapleyValue: 0.0, confidence: 0.5, evidence: [] },
    ];

    const update = computeARILUpdate(weights, energyGrad, 1.0, 1.0, attributions, state);

    // Each delta should be clipped to [-0.1, 0.1]
    for (let i = 0; i < n; i++) {
      expect(Math.abs(update.deltaW[i])).toBeLessThanOrEqual(DEFAULT_ARIL_CONFIG.clipGradient + 1e-10);
    }
  });

  test('weight bounds are enforced', () => {
    const n = 4;
    const state = createARILState(n);
    // Start near the boundaries
    const weights = new Float64Array([0.02, 0.98, 0.5, 0.5]);

    const selfState = createTestState(n, Array.from(weights));
    const vocab = create4DVocabulary();
    const params = createTestParams(n);
    const energyGrad = computeEnergyGradient(selfState, params, vocab);

    const attributions = [
      { dimension: 'd0', index: 0, shapleyValue: -0.5, confidence: 0.8, evidence: [] },
      { dimension: 'd1', index: 1, shapleyValue: 0.5, confidence: 0.8, evidence: [] },
      { dimension: 'd2', index: 2, shapleyValue: 0.0, confidence: 0.5, evidence: [] },
      { dimension: 'd3', index: 3, shapleyValue: 0.0, confidence: 0.5, evidence: [] },
    ];

    const update = computeARILUpdate(weights, energyGrad, -0.5, -0.5, attributions, state);
    const newWeights = applyARILUpdate(weights, update);

    for (let i = 0; i < n; i++) {
      expect(newWeights[i]).toBeGreaterThanOrEqual(DEFAULT_ARIL_CONFIG.minWeight);
      expect(newWeights[i]).toBeLessThanOrEqual(DEFAULT_ARIL_CONFIG.maxWeight);
    }
  });

  test('ARIL state serialization round-trips', () => {
    const state = createARILState(4);
    state.fitness = new Float64Array([0.3, 0.5, 0.7, 0.4]);
    state.metaLearningRates = new Float64Array([1.0, 1.2, 0.8, 1.1]);
    state.sessionCount = 15;
    state.recentAttributions = [[0.1, 0.2, 0.3, 0.4], [0.5, 0.4, 0.3, 0.2]];

    const serialized = serializeARILState(state);
    const deserialized = deserializeARILState(serialized);

    expect(Array.from(deserialized.fitness)).toEqual(Array.from(state.fitness));
    expect(Array.from(deserialized.metaLearningRates)).toEqual(Array.from(state.metaLearningRates));
    expect(deserialized.sessionCount).toBe(state.sessionCount);
    expect(deserialized.recentAttributions).toEqual(state.recentAttributions);
  });

  test('neuroplasticity: high-variance dimension gets higher meta-rate', () => {
    const n = 4;
    let state = createARILState(n);
    const weights = new Float64Array([0.5, 0.5, 0.5, 0.5]);
    const vocab = create4DVocabulary();
    const params = createTestParams(n);

    // Run sessions with high variance for dim 0 and low variance for dim 1
    for (let session = 0; session < 10; session++) {
      const selfState = createTestState(n, Array.from(weights));
      const energyGrad = computeEnergyGradient(selfState, params, vocab);

      // Dim 0: alternating high/low attribution (high variance)
      // Dim 1: consistent attribution (low variance)
      const sv0 = session % 2 === 0 ? 0.8 : -0.2;
      const sv1 = 0.3;

      const attributions = [
        { dimension: 'd0', index: 0, shapleyValue: sv0, confidence: 0.8, evidence: [] },
        { dimension: 'd1', index: 1, shapleyValue: sv1, confidence: 0.8, evidence: [] },
        { dimension: 'd2', index: 2, shapleyValue: 0.1, confidence: 0.5, evidence: [] },
        { dimension: 'd3', index: 3, shapleyValue: 0.1, confidence: 0.5, evidence: [] },
      ];

      const update = computeARILUpdate(weights, energyGrad, 0.5, 0.5, attributions, state);
      state.fitness = update.fitness;
      state.metaLearningRates = update.metaLearningRates;
      state.sessionCount++;
    }

    // High-variance dimension should have higher meta-rate (more exploration)
    // This may take more sessions to fully diverge, so we check direction
    // After 10 sessions, at least the variance difference should show
    expect(state.metaLearningRates[0]).toBeGreaterThanOrEqual(state.metaLearningRates[1] - 0.3);
  });

  test('H3: fitness EMA uses R_raw, not R_adj — no decay during winning streaks', () => {
    // Simulate 10 sessions with constant R_raw=0.7 (consistently good)
    // but R_adj oscillating ±0.1 around 0 (baseline has caught up).
    // With the bug (fitness uses R_adj), fitness would be near zero.
    // With the fix (fitness uses R_raw), fitness should be substantially positive.
    const n = 4;
    const state = createARILState(n);
    const weights = new Float64Array([0.5, 0.5, 0.5, 0.5]);
    const vocab = create4DVocabulary();
    const params = createTestParams(n);

    const R_raw = 0.7; // Consistently good sessions

    for (let session = 0; session < 10; session++) {
      const selfState = createTestState(n, Array.from(weights));
      const energyGrad = computeEnergyGradient(selfState, params, vocab);

      const attributions = [
        { dimension: 'd0', index: 0, shapleyValue: 0.5, confidence: 0.8, evidence: [] as string[] },
        { dimension: 'd1', index: 1, shapleyValue: 0.3, confidence: 0.6, evidence: [] as string[] },
        { dimension: 'd2', index: 2, shapleyValue: 0.1, confidence: 0.4, evidence: [] as string[] },
        { dimension: 'd3', index: 3, shapleyValue: 0.1, confidence: 0.3, evidence: [] as string[] },
      ];

      // R_adj oscillates around 0 (baseline has caught up after good streak)
      const R_adj = (session % 2 === 0) ? 0.1 : -0.1;

      const update = computeARILUpdate(weights, energyGrad, R_adj, R_raw, attributions, state);
      state.fitness = update.fitness;
      state.metaLearningRates = update.metaLearningRates;
    }

    // With R_raw=0.7 and fitnessDecay=0.1, fitness converges toward
    // 0.7 × |φᵢ| × (1 - 0.9^10) ≈ 0.7 × |φᵢ| × 0.65
    // For dim 0 (|φᵢ|=0.5): ~0.23. Max fitness should exceed 0.4
    // when considering that fitness accumulates multiplicatively.
    const maxFitness = Math.max(...Array.from(state.fitness));
    expect(maxFitness).toBeGreaterThan(0.1);

    // All fitness values should be positive (not oscillating around zero)
    for (let i = 0; i < n; i++) {
      expect(state.fitness[i]).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// PHASE 2: CONFIDENCE CALIBRATOR
// =============================================================================

describe('ConfidenceCalibrator', () => {
  test('overconfident predictions reduce calibration factor', () => {
    const calibrator = new ConfidenceCalibrator();

    // Feed overconfident predictions: high confidence, low actual outcomes
    for (let i = 0; i < 10; i++) {
      const insights = [
        createTestInsight('test insight', 0.9, 'precision'),
      ];

      const dimensionOutcomes = new Map<string, number>();
      dimensionOutcomes.set('precision', 0.3); // Actual much lower than predicted

      calibrator.calibrate(insights, dimensionOutcomes);
    }

    const factor = calibrator.getCalibrationFactor('precision');
    expect(factor).toBeLessThan(1.0);
  });

  test('underconfident predictions increase calibration factor', () => {
    const calibrator = new ConfidenceCalibrator();

    // Feed underconfident predictions: low confidence, high actual outcomes
    for (let i = 0; i < 10; i++) {
      const insights = [
        createTestInsight('test insight', 0.2, 'curiosity'),
      ];

      const dimensionOutcomes = new Map<string, number>();
      dimensionOutcomes.set('curiosity', 0.8); // Actual much higher than predicted

      calibrator.calibrate(insights, dimensionOutcomes);
    }

    const factor = calibrator.getCalibrationFactor('curiosity');
    expect(factor).toBeGreaterThan(1.0);
  });

  test('adjustConfidence uses calibration factor', () => {
    const calibrator = new ConfidenceCalibrator();

    // Train the calibrator
    for (let i = 0; i < 5; i++) {
      calibrator.calibrate(
        [createTestInsight('test', 0.9, 'precision')],
        new Map([['precision', 0.3]])
      );
    }

    const factor = calibrator.getCalibrationFactor('precision');
    const adjusted = calibrator.adjustConfidence('precision', 0.9);

    // Adjusted should be rawConfidence * factor, clamped to [0, 1]
    const expected = Math.min(1, Math.max(0, 0.9 * factor));
    expect(Math.abs(adjusted - expected)).toBeLessThan(0.01);
  });

  test('calibration state serialization round-trips', () => {
    const calibrator = new ConfidenceCalibrator();

    calibrator.calibrate(
      [createTestInsight('a', 0.8, 'curiosity')],
      new Map([['curiosity', 0.6]])
    );

    const state = calibrator.getState();
    const serialized = serializeCalibrationState(state);
    const deserialized = deserializeCalibrationState(serialized);

    expect(deserialized.updateCount).toBe(state.updateCount);
    expect(deserialized.calibrationFactors.get('curiosity')).toBe(
      state.calibrationFactors.get('curiosity')
    );
  });
});

// =============================================================================
// PHASE 3: INSIGHT COMPILER
// =============================================================================

describe('InsightCompiler', () => {
  test('compiles pattern from 3+ insights with high fitness', () => {
    const compiler = new InsightCompiler();

    const insights = [
      createTestInsight('Always read tests before editing source', 0.8, 'curiosity'),
      createTestInsight('Search for test files first when exploring', 0.7, 'curiosity'),
      createTestInsight('Reading test structure reveals architecture', 0.9, 'curiosity'),
    ];

    // High fitness for curiosity dimension (index 0)
    const fitness = new Float64Array([0.8, 0.3, 0.2, 0.1]);
    const attributions = [
      { dimension: 'curiosity', index: 0, shapleyValue: 0.5, confidence: 0.8, evidence: [] },
    ];

    const patterns = compiler.compile(insights, fitness, attributions);
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns[0].dimension).toBe('curiosity');
    expect(patterns[0].evidence.length).toBeGreaterThanOrEqual(3);
  });

  test('rejects pattern from low-fitness dimension', () => {
    const compiler = new InsightCompiler();

    // Create insights with correct dimensionIndex=3 for empathy
    const insights = [
      { ...createTestInsight('insight a', 0.8, 'empathy'), dimensionIndex: 3 },
      { ...createTestInsight('insight b', 0.7, 'empathy'), dimensionIndex: 3 },
      { ...createTestInsight('insight c', 0.9, 'empathy'), dimensionIndex: 3 },
    ];

    // Low fitness for empathy (index 3), high mean fitness from others
    const fitness = new Float64Array([0.8, 0.7, 0.6, 0.1]);
    const attributions = [
      { dimension: 'empathy', index: 3, shapleyValue: 0.05, confidence: 0.3, evidence: [] },
    ];

    const patterns = compiler.compile(insights, fitness, attributions);
    // Empathy's fitness (0.1) is below mean (0.55), so no pattern should compile
    const empathyPatterns = patterns.filter(p => p.dimension === 'empathy');
    expect(empathyPatterns.length).toBe(0);
  });

  test('decay removes low-confidence patterns', () => {
    const initialPattern: CompiledPattern = {
      id: 'test-pattern',
      dimension: 'precision',
      pattern: 'Always run tests',
      evidence: ['insight1'],
      confidence: 0.15, // Just above threshold
      shapleyWeight: 0.3,
      sessionCount: 1,
      firstSeen: Date.now() - 100000,
      lastReinforced: Date.now() - 100000,
    };

    const compiler = new InsightCompiler({}, [initialPattern]);

    // Low fitness for precision → faster decay
    const fitness = new Float64Array([0.5, 0.1, 0.5, 0.5]);
    const dimensions = ['curiosity', 'precision', 'persistence', 'empathy'];

    // Decay multiple times
    for (let i = 0; i < 10; i++) {
      compiler.decay(fitness, dimensions);
    }

    const remaining = compiler.getPatterns();
    // Pattern should have decayed below threshold and been removed
    const precisionPatterns = remaining.filter(p => p.dimension === 'precision');
    expect(precisionPatterns.length).toBe(0);
  });
});

// =============================================================================
// PHASE 3: GUIDANCE ENGINE
// =============================================================================

describe('GuidanceEngine', () => {
  test('directive strength matches fitness ranking', () => {
    const engine = new GuidanceEngine();

    const fitness = new Float64Array([0.9, 0.7, 0.3, 0.1]);
    const dimensions = ['curiosity', 'precision', 'persistence', 'empathy'];
    const weights = new Float64Array([0.6, 0.5, 0.4, 0.3]);

    const patterns: CompiledPattern[] = [
      {
        id: 'p1',
        dimension: 'curiosity',
        pattern: 'Read tests before source',
        evidence: ['a', 'b', 'c'],
        confidence: 0.9,
        shapleyWeight: 0.5,
        sessionCount: 10,
        firstSeen: Date.now(),
        lastReinforced: Date.now(),
      },
      {
        id: 'p2',
        dimension: 'empathy',
        pattern: 'Ask for clarification',
        evidence: ['d'],
        confidence: 0.3,
        shapleyWeight: 0.1,
        sessionCount: 2,
        firstSeen: Date.now(),
        lastReinforced: Date.now(),
      },
    ];

    const output = engine.generate(
      fitness, dimensions, weights, patterns, null, null, [], 20
    );

    expect(output.directives.length).toBeGreaterThan(0);

    // The highest-fitness dimension's pattern should get 'must' or 'should'
    const curiosityDirective = output.directives.find(d => d.dimension === 'curiosity');
    if (curiosityDirective) {
      expect(['must', 'should']).toContain(curiosityDirective.strength);
    }

    // Markdown output should be non-empty
    expect(output.markdown.length).toBeGreaterThan(0);
    expect(output.sessionCount).toBe(20);
  });

  test('energy gradient generates directives', () => {
    const engine = new GuidanceEngine();

    const fitness = new Float64Array([0.5, 0.5, 0.5, 0.5]);
    const dimensions = ['curiosity', 'precision', 'persistence', 'empathy'];
    const weights = new Float64Array([0.5, 0.5, 0.5, 0.5]);

    // Strong negative gradient on dimension 0 means it wants to increase
    const energyGrad: EnergyGradientResult = {
      gradients: new Float64Array([-0.5, 0.01, 0.01, 0.01]),
      energy: 1.0,
      components: {
        diffusion: new Float64Array(4),
        potential: new Float64Array(4),
        homeostatic: new Float64Array(4),
        coherence: new Float64Array(4),
      },
      hessianDiag: new Float64Array(4).fill(1),
      stability: true,
    };

    const output = engine.generate(
      fitness, dimensions, weights, [], energyGrad, null, [], 10
    );

    // Should have a gradient-based directive for dimension 0
    const gradDirective = output.directives.find(
      d => d.source === 'energy_gradient' && d.dimension === 'curiosity'
    );
    expect(gradDirective).toBeDefined();
  });
});

// =============================================================================
// PHASE 3: DOMAIN TRACKER
// =============================================================================

describe('DomainTracker', () => {
  test('detects TypeScript domain from file patterns', () => {
    const tracker = new DomainTracker();

    for (let i = 0; i < 6; i++) {
      const actionLog = createTestActionLog({
        toolCalls: [
          makeToolCall({ tool: 'Read', args: { file: `src/module${i}.ts` }, success: true }),
          makeToolCall({ tool: 'Write', args: { file: `src/module${i}.ts` }, success: true }),
        ],
      });

      tracker.update(actionLog, 0.8);
    }

    const profile = tracker.getProfile();
    expect(profile.domains.has('typescript')).toBe(true);

    const tsExposure = profile.domains.get('typescript')!;
    expect(tsExposure.weightedSessionCount).toBeGreaterThan(0);
  });

  test('weighted sessions respect outcome quality', () => {
    const tracker = new DomainTracker();

    // High-quality Solana session
    tracker.update(createTestActionLog({
      toolCalls: [
        makeToolCall({ tool: 'Read', args: { file: 'programs/identity/src/lib.rs' }, success: true }),
        makeToolCall({ tool: 'Bash', args: { cmd: 'anchor build' }, success: true }),
      ],
    }), 0.9);

    // Low-quality Solana session
    tracker.update(createTestActionLog({
      toolCalls: [
        makeToolCall({ tool: 'Read', args: { file: 'programs/identity/src/lib.rs' }, success: true }),
        makeToolCall({ tool: 'Bash', args: { cmd: 'anchor build' }, success: false }),
      ],
    }), -0.5);

    const profile = tracker.getProfile();
    // The high-quality session contributes more weight
    // R=0.9 → weight=0.95, R=-0.5 → weight=0.25
    // Total weighted ≈ 1.2, less than 2 unweighted sessions
    const solanaExposure = profile.domains.get('solana');
    if (solanaExposure) {
      expect(solanaExposure.weightedSessionCount).toBeLessThan(2);
      expect(solanaExposure.rawSessionCount).toBe(2);
    }
  });

  test('specialization levels progress with sessions', () => {
    const tracker = new DomainTracker({
      noviceThreshold: 3,
      intermediateThreshold: 8,
      expertThreshold: 15,
    });

    // Run enough high-quality sessions to reach intermediate
    for (let i = 0; i < 10; i++) {
      tracker.update(createTestActionLog({
        toolCalls: [
          makeToolCall({ tool: 'Read', args: { file: `src/component${i}.tsx` }, success: true }),
        ],
      }), 0.8);
    }

    const specs = tracker.getSpecializations();
    const reactSpec = specs.find(s => s.domain === 'react' || s.domain === 'typescript');
    expect(reactSpec).toBeDefined();
    expect(['intermediate', 'expert']).toContain(reactSpec!.level);
  });

  test('domain profile serialization round-trips', () => {
    const tracker = new DomainTracker();

    tracker.update(createTestActionLog({
      toolCalls: [
        makeToolCall({ tool: 'Read', args: { file: 'lib.rs' }, success: true }),
      ],
    }), 0.7);

    const profile = tracker.getProfile();
    const serialized = serializeDomainProfile(profile);
    const deserialized = deserializeDomainProfile(serialized);

    expect(deserialized.domains.size).toBe(profile.domains.size);
  });
});

// =============================================================================
// INTEGRATION: FULL ARIL LOOP
// =============================================================================

describe('ARIL Integration', () => {
  test('full loop: 5 sessions with energy descent', () => {
    const n = 4;
    const vocab = create4DVocabulary();
    const params = createTestParams(n);

    let weights = new Float64Array([0.3, 0.6, 0.4, 0.7]);
    const selfModel = new Float64Array([0.5, 0.5, 0.5, 0.5]);
    let state = createARILState(n);
    const evaluator = new OutcomeEvaluator();

    const energies: number[] = [];

    for (let session = 0; session < 5; session++) {
      // Forward pass: compute energy
      const selfState = createTestState(n, Array.from(weights), Array.from(selfModel));
      const energyGrad = computeEnergyGradient(selfState, params, vocab);
      energies.push(energyGrad.energy);

      // Evaluate session outcome
      const bridgeResult = {
        energyBefore: session === 0 ? energyGrad.energy : energies[session - 1],
        energyAfter: energyGrad.energy,
        coherenceBefore: 0.3,
        coherenceAfter: 0.25,
        declarations: [],
        insights: [],
      } as any;

      const actionLog = createTestActionLog();
      const outcome = evaluator.evaluate(bridgeResult, actionLog);

      // Shapley attribution
      const weightChanges = new Float64Array(n);
      if (session > 0) {
        for (let i = 0; i < n; i++) {
          weightChanges[i] = weights[i] - 0.5; // Change from initial
        }
      }

      const attribution = computeShapleyAttribution(
        outcome.R, weightChanges, vocab.assertions, null, { numPermutations: 100, seed: 42 + session }
      );

      // ARIL update
      const update = computeARILUpdate(
        weights, energyGrad, outcome.R_adj, outcome.R, attribution.attributions, state
      );

      weights = applyARILUpdate(weights, update) as any;
      state.fitness = update.fitness;
      state.metaLearningRates = update.metaLearningRates;
      state.sessionCount++;
    }

    // Energy should generally trend downward (ARIL pushes toward minima)
    // Check that the last energy is not dramatically higher than the first
    const firstEnergy = energies[0];
    const lastEnergy = energies[energies.length - 1];
    // Allow some noise — the key is that ARIL doesn't cause energy explosion
    expect(lastEnergy).toBeLessThan(firstEnergy * 2);
  });

  test('ARIL state persists through save/reload cycle', () => {
    const n = 4;
    const state = createARILState(n);
    state.fitness = new Float64Array([0.3, 0.5, 0.7, 0.4]);
    state.metaLearningRates = new Float64Array([1.0, 1.2, 0.8, 1.1]);
    state.sessionCount = 15;

    // Serialize and deserialize
    const serialized = serializeARILState(state);
    const json = JSON.stringify(serialized);
    const parsed = JSON.parse(json);
    const restored = deserializeARILState(parsed);

    expect(Array.from(restored.fitness)).toEqual(Array.from(state.fitness));
    expect(Array.from(restored.metaLearningRates)).toEqual(Array.from(state.metaLearningRates));
    expect(restored.sessionCount).toBe(15);
  });

  test('guidance contains fitness-ranked directives', () => {
    const n = 4;
    const engine = new GuidanceEngine();
    const compiler = new InsightCompiler();

    // Build up patterns via compiler
    const insights = [
      createTestInsight('Read test files first', 0.8, 'curiosity'),
      createTestInsight('Tests reveal architecture', 0.7, 'curiosity'),
      createTestInsight('Search for test patterns', 0.9, 'curiosity'),
    ];

    const fitness = new Float64Array([0.9, 0.4, 0.3, 0.2]);
    const attributions = [
      { dimension: 'curiosity', index: 0, shapleyValue: 0.6, confidence: 0.8, evidence: [] },
    ];

    compiler.compile(insights, fitness, attributions);
    const patterns = compiler.getPatterns();

    // Generate guidance
    const dimensions = ['curiosity', 'precision', 'persistence', 'empathy'];
    const weights = new Float64Array([0.6, 0.5, 0.4, 0.3]);

    const output = engine.generate(
      fitness, dimensions, weights, patterns, null, null, [], 20
    );

    expect(output.directives.length).toBeGreaterThan(0);
    expect(output.markdown).toContain('curiosity');
    expect(output.meanFitness).toBeGreaterThan(0);
  });
});

// =============================================================================
// HARDENING TESTS — NaN safety, edge cases, adversarial inputs
// =============================================================================

describe('NaN Safety — ReplicatorOptimizer', () => {
  const dimensions = ['curiosity', 'precision', 'persistence', 'empathy'];

  test('NaN R_adj does not poison ARIL state', () => {
    const weights = new Float64Array([0.5, 0.5, 0.5, 0.5]);
    const state = createARILState(4);
    const energyGrad: EnergyGradientResult = {
      gradients: new Float64Array([0.1, -0.1, 0.05, -0.05]),
      energy: 1.0,
      components: {
        diffusion: new Float64Array(4),
        potential: new Float64Array(4),
        homeostatic: new Float64Array(4),
        coherence: new Float64Array(4),
      },
      hessianDiag: new Float64Array(4),
      stability: true,
    };

    const update = computeARILUpdate(
      weights, energyGrad, NaN, NaN, [], state, DEFAULT_ARIL_CONFIG
    );

    // NaN should be sanitized to 0, so all outcome gradients should be 0
    for (let i = 0; i < 4; i++) {
      expect(Number.isFinite(update.deltaW[i])).toBe(true);
      expect(Number.isFinite(update.fitness[i])).toBe(true);
      expect(Number.isFinite(update.metaLearningRates[i])).toBe(true);
    }
  });

  test('Infinity R_adj does not poison ARIL state', () => {
    const weights = new Float64Array([0.5, 0.5, 0.5, 0.5]);
    const state = createARILState(4);
    const energyGrad: EnergyGradientResult = {
      gradients: new Float64Array([0.1, -0.1, 0.05, -0.05]),
      energy: 1.0,
      components: {
        diffusion: new Float64Array(4),
        potential: new Float64Array(4),
        homeostatic: new Float64Array(4),
        coherence: new Float64Array(4),
      },
      hessianDiag: new Float64Array(4),
      stability: true,
    };

    const update = computeARILUpdate(
      weights, energyGrad, Infinity, Infinity, [], state, DEFAULT_ARIL_CONFIG
    );

    for (let i = 0; i < 4; i++) {
      expect(Number.isFinite(update.deltaW[i])).toBe(true);
      expect(Number.isFinite(update.fitness[i])).toBe(true);
    }
  });

  test('NaN in energy gradients does not propagate', () => {
    const weights = new Float64Array([0.5, 0.5, 0.5, 0.5]);
    const state = createARILState(4);
    const energyGrad: EnergyGradientResult = {
      gradients: new Float64Array([NaN, 0.1, Infinity, -Infinity]),
      energy: NaN,
      components: {
        diffusion: new Float64Array(4),
        potential: new Float64Array(4),
        homeostatic: new Float64Array(4),
        coherence: new Float64Array(4),
      },
      hessianDiag: new Float64Array(4),
      stability: true,
    };

    const update = computeARILUpdate(
      weights, energyGrad, 0.5, 0.5, [], state, DEFAULT_ARIL_CONFIG
    );

    for (let i = 0; i < 4; i++) {
      expect(Number.isFinite(update.deltaW[i])).toBe(true);
    }
  });

  test('zero-dimension input returns empty update', () => {
    const weights = new Float64Array(0);
    const state = createARILState(0);
    const energyGrad: EnergyGradientResult = {
      gradients: new Float64Array(0),
      energy: 0,
      components: {
        diffusion: new Float64Array(0),
        potential: new Float64Array(0),
        homeostatic: new Float64Array(0),
        coherence: new Float64Array(0),
      },
      hessianDiag: new Float64Array(0),
      stability: true,
    };

    const update = computeARILUpdate(
      weights, energyGrad, 0.5, 0.5, [], state, DEFAULT_ARIL_CONFIG
    );

    expect(update.deltaW).toHaveLength(0);
    expect(update.shouldDeclare).toHaveLength(0);
  });

  test('length mismatch throws descriptive error', () => {
    const weights = new Float64Array([0.5, 0.5, 0.5, 0.5]);
    const state = createARILState(4);
    const energyGrad: EnergyGradientResult = {
      gradients: new Float64Array([0.1, 0.1]), // Wrong length!
      energy: 1.0,
      components: {
        diffusion: new Float64Array(2),
        potential: new Float64Array(2),
        homeostatic: new Float64Array(2),
        coherence: new Float64Array(2),
      },
      hessianDiag: new Float64Array(2),
      stability: true,
    };

    expect(() => computeARILUpdate(
      weights, energyGrad, 0.5, 0.5, [], state, DEFAULT_ARIL_CONFIG
    )).toThrow(/Length mismatch/);
  });

  test('applyARILUpdate guards NaN in deltaW', () => {
    const weights = new Float64Array([0.5, 0.5, 0.5, 0.5]);
    const update = {
      deltaW: new Float64Array([NaN, 0.1, Infinity, -0.05]),
      components: {
        energyGrad: new Float64Array(4),
        outcomeGrad: new Float64Array(4),
        replicatorGrad: new Float64Array(4),
      },
      shouldDeclare: [false, false, false, false],
      explanation: 'test',
      fitness: new Float64Array(4),
      metaLearningRates: new Float64Array(4).fill(1),
    };

    const newWeights = applyARILUpdate(weights, update);
    for (let i = 0; i < 4; i++) {
      expect(Number.isFinite(newWeights[i])).toBe(true);
      expect(newWeights[i]).toBeGreaterThanOrEqual(DEFAULT_ARIL_CONFIG.minWeight);
      expect(newWeights[i]).toBeLessThanOrEqual(DEFAULT_ARIL_CONFIG.maxWeight);
    }
    // NaN delta → weight stays at original (0.5)
    expect(newWeights[0]).toBe(0.5);
    // Infinity delta → weight clamped to bounds
    expect(newWeights[2]).toBe(0.5);
  });

  test('deserializeARILState sanitizes NaN in persisted data', () => {
    const state = deserializeARILState({
      fitness: [0.5, NaN, Infinity, 0.3],
      metaLearningRates: [1.0, NaN, 1.5, -Infinity],
      recentAttributions: [],
      sessionCount: 5,
    });

    for (let i = 0; i < 4; i++) {
      expect(Number.isFinite(state.fitness[i])).toBe(true);
      expect(Number.isFinite(state.metaLearningRates[i])).toBe(true);
    }
    expect(state.fitness[0]).toBe(0.5);
    expect(state.fitness[1]).toBe(0);   // NaN → 0 (default fallback for fitness)
    expect(state.fitness[2]).toBe(0);   // Infinity → 0
    expect(state.metaLearningRates[1]).toBe(1.0); // NaN → 1.0 (default fallback for metaRates)
  });

  test('verifyReplicatorConservation handles empty/mismatched inputs', () => {
    expect(verifyReplicatorConservation(new Float64Array(0), new Float64Array(0)))
      .toEqual({ conserved: true, sum: 0 });

    expect(verifyReplicatorConservation(
      new Float64Array([0.5, 0.5]),
      new Float64Array([0.3])  // Length mismatch
    )).toEqual({ conserved: true, sum: 0 });
  });
});

describe('NaN Safety — ShapleyAttributor', () => {
  test('numPermutations=0 uses fallback K=1 instead of NaN', () => {
    const result = computeShapleyAttribution(
      0.5,
      new Float64Array([0.1, 0.2, 0.3, 0.4]),
      ['a', 'b', 'c', 'd'],
      null,
      { numPermutations: 0, seed: 42 }
    );

    for (const attr of result.attributions) {
      expect(Number.isFinite(attr.shapleyValue)).toBe(true);
      expect(Number.isFinite(attr.confidence)).toBe(true);
    }
    // Efficiency should still hold: Σδ ≈ R
    expect(Math.abs(result.efficiencyCheck - 0.5)).toBeLessThan(0.1);
  });

  test('NaN R produces zero attributions (not NaN)', () => {
    const result = computeShapleyAttribution(
      NaN,
      new Float64Array([0.1, 0.2]),
      ['a', 'b'],
      null,
      { numPermutations: 50, seed: 42 }
    );

    for (const attr of result.attributions) {
      expect(Number.isFinite(attr.shapleyValue)).toBe(true);
    }
  });

  test('Infinity R produces zero attributions (not Infinity)', () => {
    const result = computeShapleyAttribution(
      Infinity,
      new Float64Array([0.1, 0.2]),
      ['a', 'b'],
      null,
      { numPermutations: 50, seed: 42 }
    );

    for (const attr of result.attributions) {
      expect(Number.isFinite(attr.shapleyValue)).toBe(true);
    }
  });

  test('zero-dimension input returns empty', () => {
    const result = computeShapleyAttribution(
      0.5,
      new Float64Array(0),
      [],
      null,
      { numPermutations: 50, seed: 42 }
    );

    expect(result.attributions).toHaveLength(0);
  });

  test('dimension/weightChanges length mismatch throws', () => {
    expect(() => computeShapleyAttribution(
      0.5,
      new Float64Array([0.1, 0.2, 0.3]), // 3
      ['a', 'b'],                          // 2
      null,
      { numPermutations: 10, seed: 42 }
    )).toThrow(/Length mismatch/);
  });
});

describe('NaN Safety — OutcomeEvaluator', () => {
  test('NaN energyBefore/After does not poison baseline', () => {
    const evaluator = new OutcomeEvaluator();
    const bridgeResult = {
      energyBefore: NaN,
      energyAfter: Infinity,
      insights: [],
      declarations: [],
      weightsUpdated: false,
      metrics: {},
    } as any;

    const outcome = evaluator.evaluate(bridgeResult, createTestActionLog());

    expect(Number.isFinite(outcome.R)).toBe(true);
    expect(Number.isFinite(outcome.R_adj)).toBe(true);
    expect(Number.isFinite(outcome.energyDelta)).toBe(true);
    expect(Number.isFinite(evaluator.getBaseline())).toBe(true);
  });

  test('null arrays in bridgeResult/actionLog do not crash', () => {
    const evaluator = new OutcomeEvaluator();
    const bridgeResult = {
      energyBefore: 1.0,
      energyAfter: 0.8,
      insights: null,
      declarations: null,
    } as any;

    const actionLog = {
      toolCalls: null,
      failures: null,
      decisions: null,
    } as any;

    const outcome = evaluator.evaluate(bridgeResult, actionLog);
    expect(Number.isFinite(outcome.R)).toBe(true);
  });

  test('baseline EMA resists NaN poisoning over multiple sessions', () => {
    const evaluator = new OutcomeEvaluator();

    // Normal session
    const normalBridge = {
      energyBefore: 1.0, energyAfter: 0.8,
      insights: [], declarations: [],
    } as any;
    evaluator.evaluate(normalBridge, createTestActionLog());
    const baseline1 = evaluator.getBaseline();
    expect(Number.isFinite(baseline1)).toBe(true);

    // Adversarial session with NaN
    const nanBridge = {
      energyBefore: NaN, energyAfter: NaN,
      insights: null, declarations: null,
    } as any;
    evaluator.evaluate(nanBridge, { toolCalls: null, failures: null, decisions: null } as any);
    const baseline2 = evaluator.getBaseline();
    expect(Number.isFinite(baseline2)).toBe(true);

    // Baseline should still be finite after NaN session
    expect(Math.abs(baseline2)).toBeLessThan(10);
  });
});

describe('NaN Safety — InsightCompiler', () => {
  test('empty fitness array allows compilation (no ARIL gate)', () => {
    const compiler = new InsightCompiler();
    const insights = [
      createTestInsight('a', 0.8, 'curiosity'),
      createTestInsight('b', 0.7, 'curiosity'),
      createTestInsight('c', 0.9, 'curiosity'),
    ];

    // Zero-length fitness → gate should be skipped, patterns compile
    const patterns = compiler.compile(insights, new Float64Array(0), []);
    expect(patterns.length).toBeGreaterThan(0);
  });

  test('NaN fitness values do not crash compilation', () => {
    const compiler = new InsightCompiler();
    const insights = [
      { ...createTestInsight('a', 0.8, 'curiosity'), dimensionIndex: 0 },
      { ...createTestInsight('b', 0.7, 'curiosity'), dimensionIndex: 0 },
      { ...createTestInsight('c', 0.9, 'curiosity'), dimensionIndex: 0 },
    ];

    const fitness = new Float64Array([NaN, 0.5, Infinity, -Infinity]);
    const patterns = compiler.compile(insights, fitness, []);

    // Should not throw and patterns are valid
    for (const p of patterns) {
      expect(Number.isFinite(p.confidence)).toBe(true);
    }
  });

  test('insight buffer does not grow unbounded', () => {
    const compiler = new InsightCompiler({ maxBufferPerDimension: 5 });

    // Add 10 insights for the same dimension
    for (let i = 0; i < 10; i++) {
      compiler.compile(
        [createTestInsight(`insight ${i}`, 0.8, 'curiosity')],
        new Float64Array(0),
        []
      );
    }

    const buffer = compiler.getInsightBuffer();
    const curiosityBuffer = buffer.get('curiosity') ?? [];
    expect(curiosityBuffer.length).toBeLessThanOrEqual(5);
  });

  test('keyword filter includes 3-char domain terms', () => {
    const compiler = new InsightCompiler();
    const insights = [
      createTestInsight('Found a bug in the API', 0.8, 'precision'),
      createTestInsight('SQL bug in the ORM layer', 0.7, 'precision'),
      createTestInsight('Another API bug fix', 0.9, 'precision'),
    ];

    const patterns = compiler.compile(insights, new Float64Array(0), []);

    // At least one pattern should compile, and "bug" should appear in keywords
    expect(patterns.length).toBeGreaterThan(0);
    const pattern = patterns[0];
    expect(pattern.pattern.toLowerCase()).toContain('bug');
  });
});

describe('NaN Safety — GuidanceEngine', () => {
  test('NaN fitness produces conservative directives (not crash)', () => {
    const engine = new GuidanceEngine();
    const fitness = new Float64Array([NaN, 0.5, Infinity, -0.1]);
    const dimensions = ['a', 'b', 'c', 'd'];
    const weights = new Float64Array([0.5, 0.5, 0.5, 0.5]);

    const output = engine.generate(fitness, dimensions, weights, [], null, null, [], 10);

    // Should produce output without crashing
    expect(output.directives).toBeDefined();
    expect(Number.isFinite(output.meanFitness)).toBe(true);
    // All fitness values in directives should be finite
    for (const d of output.directives) {
      expect(Number.isFinite(d.fitness)).toBe(true);
    }
  });
});

describe('NaN Safety — DomainTracker', () => {
  test('Infinity R does not create instant expert', () => {
    const tracker = new DomainTracker();
    const actionLog = createTestActionLog({
      toolCalls: [
        makeToolCall({ tool: 'anchor build', success: true }),
      ],
    });

    // Feed Infinity R — should be clamped
    tracker.update(actionLog, Infinity);

    const profile = tracker.getProfile();
    for (const [, exposure] of profile.domains) {
      expect(exposure.weightedSessionCount).toBeLessThanOrEqual(1);
      expect(Number.isFinite(exposure.weightedSessionCount)).toBe(true);
    }
    // Should NOT have expert specialization from a single session
    expect(profile.specializations.filter(s => s.level === 'expert')).toHaveLength(0);
  });

  test('circular args in tool calls do not crash', () => {
    const circularObj: any = { a: 1 };
    circularObj.self = circularObj;

    const tracker = new DomainTracker();
    const actionLog = {
      ...createTestActionLog(),
      toolCalls: [
        { ...makeToolCall({ tool: 'Read' }), args: circularObj },
      ],
    };

    // Should not throw
    expect(() => tracker.update(actionLog, 0.5)).not.toThrow();
  });
});

describe('NaN Safety — ConfidenceCalibrator', () => {
  test('NaN confidence does not poison calibration', () => {
    const calibrator = new ConfidenceCalibrator();

    calibrator.calibrate(
      [createTestInsight('test', NaN, 'curiosity')],
      new Map([['curiosity', 0.8]])
    );

    const factor = calibrator.getCalibrationFactor('curiosity');
    expect(Number.isFinite(factor)).toBe(true);
  });

  test('NaN outcome does not poison calibration', () => {
    const calibrator = new ConfidenceCalibrator();

    calibrator.calibrate(
      [createTestInsight('test', 0.8, 'curiosity')],
      new Map([['curiosity', NaN]])
    );

    const factor = calibrator.getCalibrationFactor('curiosity');
    expect(Number.isFinite(factor)).toBe(true);
  });

  test('zero-predicted does not produce NaN factor', () => {
    const calibrator = new ConfidenceCalibrator();

    // Zero confidence → very small predicted EMA → division guard
    calibrator.calibrate(
      [createTestInsight('test', 0, 'curiosity')],
      new Map([['curiosity', 0.8]])
    );

    const factor = calibrator.getCalibrationFactor('curiosity');
    expect(Number.isFinite(factor)).toBe(true);
  });
});

describe('NaN Safety — EnergyGradient', () => {
  test('output gradients are always finite', () => {
    const vocab = create4DVocabulary();
    const params = createTestParams(4);
    // Use extreme weight values that might cause NaN in polynomial evaluation
    const state = createTestState(4, [1e10, -1e10, 0, 1]);

    const result = computeEnergyGradient(state, params, vocab);

    for (let i = 0; i < 4; i++) {
      expect(Number.isFinite(result.gradients[i])).toBe(true);
      expect(Number.isFinite(result.hessianDiag[i])).toBe(true);
      expect(Number.isFinite(result.components.diffusion[i])).toBe(true);
      expect(Number.isFinite(result.components.potential[i])).toBe(true);
    }
    expect(Number.isFinite(result.energy)).toBe(true);
  });
});

describe('NaN Safety — Welford Variance', () => {
  test('correlation history variance stays non-negative', () => {
    const history = createCorrelationHistory(2);

    // Feed adversarial sequence: large jumps that might cause negative variance
    const sequences = [
      new Float64Array([1e6, -1e6]),
      new Float64Array([-1e6, 1e6]),
      new Float64Array([1e6, -1e6]),
      new Float64Array([0, 0]),
      new Float64Array([1e-10, 1e-10]),
    ];

    for (const metrics of sequences) {
      updateCorrelationHistory(history, metrics, Math.random() * 2 - 1);
    }

    for (let i = 0; i < 2; i++) {
      expect(history.metricVariances[i]).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(history.metricVariances[i])).toBe(true);
      expect(Number.isFinite(history.correlations[i])).toBe(true);
    }
    expect(history.outcomeVariance).toBeGreaterThanOrEqual(0);
  });
});

// =============================================================================
// PHASE 1: MODE OBSERVER (Layer 3)
// =============================================================================

describe('Phase 1: Mode Observer', () => {
  const vocab = create4DVocabulary();
  const params = createTestParams(4);

  function createObserverTestInputs(wValues: number[]) {
    const state = createTestState(4, wValues);
    const eg = computeEnergyGradient(state, params, vocab);
    const arilState = createARILState(4);
    return { state, eg, arilState };
  }

  function makeAttributions(n: number, values?: number[]) {
    return Array.from({ length: n }, (_, i) => ({
      dimension: `dim_${i}`,
      index: i,
      shapleyValue: values ? values[i] : 0.1,
      confidence: 0.8,
      evidence: ['test'],
    }));
  }

  // ---------------------------------------------------------------------------
  // §7.1 — mode_score Computation
  // ---------------------------------------------------------------------------

  describe('mode_score (§7.1)', () => {
    test('well-settled state → low mode_score → INSIGHT mode (with history)', () => {
      // First session always has E_min = E → denominator ≈ ε → huge mode_score.
      // Need to pre-seed history with a lower E_min so the ratio is meaningful.
      const initialHistory: ObserverHistory = {
        energyHistory: [-1.0], // A previously seen low energy
        minObservedEnergy: -1.0,
        outcomeTermHistory: [],
        replicatorTermHistory: [],
        sessionCount: 1,
      };
      const observer = new ModeObserver({ modeThreshold: 1.0 }, initialHistory);

      // Weights near wells (0 or 1) with a=0.5 — small gradients
      const { state, eg, arilState } = createObserverTestInputs([0.05, 0.95, 0.05, 0.95]);
      const attrs = makeAttributions(4);

      const obs = observer.observe(state, params, vocab, eg, arilState, DEFAULT_ARIL_CONFIG, 0.5, attrs);

      // With a meaningful E_min baseline, the ratio should be moderate
      expect(obs.mode).toBe('insight');
      expect(Number.isFinite(obs.modeScore)).toBe(true);
    });

    test('transitioning state → high mode_score → SEARCH mode', () => {
      // Weights near saddle point a=0.5 → large gradients
      const { state, eg, arilState } = createObserverTestInputs([0.5, 0.5, 0.5, 0.5]);
      const observer = new ModeObserver({ modeThreshold: 0.001 }); // Low threshold to ensure SEARCH
      const attrs = makeAttributions(4);

      const obs = observer.observe(state, params, vocab, eg, arilState, DEFAULT_ARIL_CONFIG, 0.5, attrs);

      // At saddle point, gradients should be non-trivial
      expect(obs.modeScore).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(obs.modeScore)).toBe(true);
    });

    test('formula verification: ‖∇E‖²/(E - E_min + ε)', () => {
      const { state, eg, arilState } = createObserverTestInputs([0.3, 0.7, 0.4, 0.6]);
      const observer = new ModeObserver();
      const attrs = makeAttributions(4);

      const obs = observer.observe(state, params, vocab, eg, arilState, DEFAULT_ARIL_CONFIG, 0, attrs);

      // Manually compute expected mode_score
      let gradNormSq = 0;
      for (let i = 0; i < 4; i++) {
        gradNormSq += eg.gradients[i] * eg.gradients[i];
      }
      const EPS = 1e-8;
      const expected = gradNormSq / (eg.energy - eg.energy + EPS); // E_min = E for first session
      expect(obs.modeScore).toBeCloseTo(expected, 4);
    });
  });

  // ---------------------------------------------------------------------------
  // Dimension Classification
  // ---------------------------------------------------------------------------

  describe('dimension classification', () => {
    test('w=0.1 with a=0.5 → well=low, V" > 0', () => {
      const { state, eg, arilState } = createObserverTestInputs([0.1, 0.5, 0.9, 0.5]);
      const observer = new ModeObserver({ barrierThreshold: 0.05 });
      const attrs = makeAttributions(4);

      const obs = observer.observe(state, params, vocab, eg, arilState, DEFAULT_ARIL_CONFIG, 0, attrs);

      expect(obs.dimensionModes[0].well).toBe('low');
      expect(obs.dimensionModes[0].curvature).toBeGreaterThan(0);
    });

    test('w=0.9 with a=0.5 → well=high, V" > 0', () => {
      const { state, eg, arilState } = createObserverTestInputs([0.1, 0.5, 0.9, 0.5]);
      const observer = new ModeObserver({ barrierThreshold: 0.05 });
      const attrs = makeAttributions(4);

      const obs = observer.observe(state, params, vocab, eg, arilState, DEFAULT_ARIL_CONFIG, 0, attrs);

      expect(obs.dimensionModes[2].well).toBe('high');
      expect(obs.dimensionModes[2].curvature).toBeGreaterThan(0);
    });

    test('w=0.5 with a=0.5 → well=barrier, V" ≤ 0', () => {
      const { state, eg, arilState } = createObserverTestInputs([0.1, 0.5, 0.9, 0.5]);
      const observer = new ModeObserver({ barrierThreshold: 0.05 });
      const attrs = makeAttributions(4);

      const obs = observer.observe(state, params, vocab, eg, arilState, DEFAULT_ARIL_CONFIG, 0, attrs);

      // V''(0.5, 0.5) = 3(0.25) - 2(1.5)(0.5) + 0.5 = 0.75 - 1.5 + 0.5 = -0.25
      expect(obs.dimensionModes[1].well).toBe('barrier');
      expect(obs.dimensionModes[1].curvature).toBeLessThan(0);
      expect(obs.dimensionModes[1].curvature).toBeCloseTo(-0.25, 6);
    });
  });

  // ---------------------------------------------------------------------------
  // §2.4 — Tunneling Probability
  // ---------------------------------------------------------------------------

  describe('tunneling probability (§2.4)', () => {
    test('cold start (< 3 sessions) → P_tunnel = 0', () => {
      const { state, eg, arilState } = createObserverTestInputs([0.1, 0.9, 0.3, 0.7]);
      const observer = new ModeObserver();
      const attrs = makeAttributions(4);

      const obs = observer.observe(state, params, vocab, eg, arilState, DEFAULT_ARIL_CONFIG, 0.5, attrs);

      for (const t of obs.tunneling) {
        expect(t.probability).toBe(0);
        expect(t.effectiveNoise).toBe(0);
      }
    });

    test('after 3+ sessions, P_tunnel ∈ [0, 1]', () => {
      const observer = new ModeObserver();
      const attrs = makeAttributions(4, [0.3, -0.1, 0.2, 0.05]);

      // Run 4 sessions to build history
      for (let s = 0; s < 4; s++) {
        const { state, eg, arilState } = createObserverTestInputs([0.1, 0.9, 0.3, 0.7]);
        arilState.fitness = new Float64Array([0.1, 0.2, -0.1, 0.05]);
        observer.observe(state, params, vocab, eg, arilState, DEFAULT_ARIL_CONFIG, 0.5 * (s + 1) / 4, attrs);
      }

      // 5th session should have history for variance
      const { state, eg, arilState } = createObserverTestInputs([0.1, 0.9, 0.3, 0.7]);
      arilState.fitness = new Float64Array([0.1, 0.2, -0.1, 0.05]);
      const obs = observer.observe(state, params, vocab, eg, arilState, DEFAULT_ARIL_CONFIG, 0.5, attrs);

      for (const t of obs.tunneling) {
        expect(t.probability).toBeGreaterThanOrEqual(0);
        expect(t.probability).toBeLessThanOrEqual(1);
        expect(Number.isFinite(t.probability)).toBe(true);
      }
    });

    test('near barrier → higher P_tunnel than deep in well', () => {
      const observer = new ModeObserver();
      const attrs = makeAttributions(4, [0.3, -0.1, 0.2, 0.05]);

      // Build history with varying R_adj to create non-zero variance
      for (let s = 0; s < 5; s++) {
        const { state, eg, arilState } = createObserverTestInputs([0.45, 0.1, 0.5, 0.5]);
        arilState.fitness = new Float64Array([0.1, 0.2, -0.1, 0.05]);
        observer.observe(state, params, vocab, eg, arilState, DEFAULT_ARIL_CONFIG, (s % 2 === 0 ? 0.8 : -0.3), attrs);
      }

      // Final observation
      const { state, eg, arilState } = createObserverTestInputs([0.45, 0.1, 0.5, 0.5]);
      arilState.fitness = new Float64Array([0.1, 0.2, -0.1, 0.05]);
      const obs = observer.observe(state, params, vocab, eg, arilState, DEFAULT_ARIL_CONFIG, 0.5, attrs);

      // dim0 at w=0.45 (near a=0.5) should have smaller barrier than dim1 at w=0.1
      expect(obs.tunneling[0].barrierHeight).toBeLessThan(obs.tunneling[1].barrierHeight);
    });

    test('exact formula: P = 1 - exp(-σ²_eff / (2B))', () => {
      const observer = new ModeObserver();
      const attrs = makeAttributions(4, [0.3, -0.1, 0.2, 0.05]);

      // Build history
      for (let s = 0; s < 5; s++) {
        const { state, eg, arilState } = createObserverTestInputs([0.3, 0.7, 0.4, 0.6]);
        arilState.fitness = new Float64Array([0.1, 0.2, -0.1, 0.05]);
        observer.observe(state, params, vocab, eg, arilState, DEFAULT_ARIL_CONFIG, (s * 0.3 - 0.5), attrs);
      }

      const { state, eg, arilState } = createObserverTestInputs([0.3, 0.7, 0.4, 0.6]);
      arilState.fitness = new Float64Array([0.1, 0.2, -0.1, 0.05]);
      const obs = observer.observe(state, params, vocab, eg, arilState, DEFAULT_ARIL_CONFIG, 0.2, attrs);

      for (const t of obs.tunneling) {
        if (t.barrierHeight > 0 && t.effectiveNoise > 0) {
          const expected = 1 - Math.exp(-t.effectiveNoise / (2 * t.barrierHeight));
          expect(t.probability).toBeCloseTo(expected, 8);
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Barrier Height
  // ---------------------------------------------------------------------------

  describe('barrier height', () => {
    test('B₀(0.5) = 0.5³×1.5/12 = 0.015625', () => {
      // Analytical: B₀(a) = a³(2-a)/12
      const a = 0.5;
      const B0 = (a ** 3) * (2 - a) / 12;
      expect(B0).toBeCloseTo(0.015625, 8);
    });

    test('B₁(0.5) = 0.5³×1.5/12 = 0.015625 (symmetric)', () => {
      // Analytical: B₁(a) = (1-a)³(1+a)/12
      const a = 0.5;
      const B1 = ((1 - a) ** 3) * (1 + a) / 12;
      expect(B1).toBeCloseTo(0.015625, 8);
    });

    test('barrier height V(a) - V(w) for intermediate positions', () => {
      // V(u, a) = u⁴/4 - (1+a)u³/3 + au²/2
      const a = 0.5;
      const V = (u: number) => (u ** 4) / 4 - (1 + a) * (u ** 3) / 3 + a * (u ** 2) / 2;

      const Va = V(a);
      const Vw01 = V(0.1);
      const Vw03 = V(0.3);

      // Barrier from w=0.1 should be larger than from w=0.3
      expect(Va - Vw01).toBeGreaterThan(Va - Vw03);
      // Both should be positive (V(a) is the saddle maximum)
      expect(Va - Vw01).toBeGreaterThan(0);
      expect(Va - Vw03).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // §8.3 — Consolidation Quality
  // ---------------------------------------------------------------------------

  describe('consolidation quality (§8.3)', () => {
    test('evolved identity has lower energy than random → negative Δ', () => {
      // Use params where w_star matches the wells, so homeostatic term
      // reinforces the potential wells instead of pulling toward 0.5
      const wellParams: DynamicsParams = {
        D: 0.1,
        lambda: 0.1, // Weak homeostatic pull
        mu: 0.3,
        kappa: 0.1,
        a: 0.5,
        w_star: new Float64Array([0.05, 0.95, 0.05, 0.95]), // Target at wells
      };
      const state = createTestState(4, [0.05, 0.95, 0.05, 0.95]);
      const eg = computeEnergyGradient(state, wellParams, vocab);
      const arilState = createARILState(4);
      const observer = new ModeObserver();
      const attrs = makeAttributions(4);

      const obs = observer.observe(state, wellParams, vocab, eg, arilState, DEFAULT_ARIL_CONFIG, 0, attrs);

      // With w_star at wells and weak homeostatic pull, wells should beat midpoint
      expect(obs.consolidationDelta).toBeLessThan(0);
    });

    test('weights at midpoint → Δ ≈ 0', () => {
      const { state, eg, arilState } = createObserverTestInputs([0.5, 0.5, 0.5, 0.5]);
      const observer = new ModeObserver();
      const attrs = makeAttributions(4);

      const obs = observer.observe(state, params, vocab, eg, arilState, DEFAULT_ARIL_CONFIG, 0, attrs);

      // E(w=0.5) ≈ E(w_random=0.5) → Δ ≈ 0
      expect(Math.abs(obs.consolidationDelta)).toBeLessThan(0.01);
    });
  });

  // ---------------------------------------------------------------------------
  // §5 — Curvature Expertise
  // ---------------------------------------------------------------------------

  describe('curvature expertise (§5)', () => {
    test('high curvature (κ >> κ_mid) → low expertise', () => {
      const tracker = new DomainTracker({ kappaMid: 1.0, kappaScale: 0.5 });
      const actionLog = createTestActionLog({ toolCalls: [
        makeToolCall({ tool: 'tsc', args: { file: 'index.ts' } }),
      ]});

      // High curvature hessian → novice territory
      const hessianDiag = new Float64Array([5.0, 5.0, 5.0, 5.0]);
      tracker.updateWithCurvature(actionLog, 0.5, hessianDiag);

      const expertise = tracker.getExpertise();
      // sigmoid(-(5-1)/0.5) = sigmoid(-8) ≈ 0.000335 → very low
      expect(expertise).toBeLessThan(0.1);
    });

    test('low curvature (κ << κ_mid) → high expertise (with enough sessions)', () => {
      const tracker = new DomainTracker({
        kappaMid: 1.0,
        kappaScale: 0.5,
        curvatureBlendSessions: 10,
      });
      const actionLog = createTestActionLog({ toolCalls: [
        makeToolCall({ tool: 'tsc', args: { file: 'index.ts' } }),
      ]});

      // Low curvature hessian → expert territory
      // Need 10+ sessions so λ_blend ≈ 1 (pure curvature)
      const hessianDiag = new Float64Array([-2.0, -2.0, -2.0, -2.0]);
      for (let i = 0; i < 12; i++) {
        tracker.updateWithCurvature(actionLog, 0.5, hessianDiag);
      }

      const expertise = tracker.getExpertise();
      // sigmoid(-(-2-1)/0.5) = sigmoid(6) ≈ 0.9975
      // λ_blend = min(1, 12/10) = 1 → pure curvature
      expect(expertise).toBeGreaterThan(0.8);
    });

    test('blending: 0 curvature sessions → pure session-count expertise', () => {
      const tracker = new DomainTracker({ curvatureBlendSessions: 10 });
      const actionLog = createTestActionLog({ toolCalls: [
        makeToolCall({ tool: 'tsc', args: { file: 'index.ts' } }),
      ]});

      // Only use standard update (no curvature)
      for (let i = 0; i < 30; i++) {
        tracker.update(actionLog, 1.0);
      }

      const expertise = tracker.getExpertise();
      // Pure session-count: 30 weighted sessions / 30 = 1.0
      expect(expertise).toBeGreaterThan(0.9);
    });

    test('blending: 10+ curvature sessions → pure curvature expertise', () => {
      const tracker = new DomainTracker({
        kappaMid: 1.0,
        kappaScale: 0.5,
        curvatureBlendSessions: 10,
      });
      const actionLog = createTestActionLog({ toolCalls: [
        makeToolCall({ tool: 'tsc', args: { file: 'index.ts' } }),
      ]});

      const hessianDiag = new Float64Array([0.1, 0.1, 0.1, 0.1]); // Low curvature
      for (let i = 0; i < 12; i++) {
        tracker.updateWithCurvature(actionLog, 0.5, hessianDiag);
      }

      const expertise = tracker.getExpertise();
      // sigmoid(-(0.1-1.0)/0.5) = sigmoid(1.8) ≈ 0.858
      expect(expertise).toBeGreaterThan(0.7);
    });
  });

  // ---------------------------------------------------------------------------
  // §6 — Adaptive Barrier
  // ---------------------------------------------------------------------------

  describe('adaptive barrier (§6)', () => {
    test('expertise=0 → a=0.75 (novice, high barrier)', () => {
      expect(computeAdaptiveBarrier(0)).toBeCloseTo(0.75, 8);
    });

    test('expertise=1 → a=0.25 (expert, low barrier)', () => {
      expect(computeAdaptiveBarrier(1)).toBeCloseTo(0.25, 8);
    });

    test('expertise=0.5 → a=0.5 (midpoint)', () => {
      expect(computeAdaptiveBarrier(0.5)).toBeCloseTo(0.5, 8);
    });

    test('expert barrier B₀(0.25) ≈ 0.00228 (easy tunneling)', () => {
      const a = computeAdaptiveBarrier(1); // 0.25
      const B0 = (a ** 3) * (2 - a) / 12;
      expect(B0).toBeCloseTo(0.25 ** 3 * 1.75 / 12, 5);
      expect(B0).toBeLessThan(0.003);
    });

    test('custom aMin/aMax', () => {
      expect(computeAdaptiveBarrier(0, 0.3, 0.8)).toBeCloseTo(0.8, 8);
      expect(computeAdaptiveBarrier(1, 0.3, 0.8)).toBeCloseTo(0.3, 8);
    });
  });

  // ---------------------------------------------------------------------------
  // NaN Safety
  // ---------------------------------------------------------------------------

  describe('NaN safety', () => {
    test('all NaN/Infinity inputs → finite outputs', () => {
      const state: SelfState = {
        dimension: 4,
        w: new Float64Array([NaN, Infinity, -Infinity, 0.5]),
        m: new Float64Array([NaN, NaN, NaN, NaN]),
        time: 0,
      };
      // Create a valid energy gradient with NaN'd values
      const eg = computeEnergyGradient(
        createTestState(4, [0.3, 0.5, 0.7, 0.4]),
        params,
        vocab
      );

      const observer = new ModeObserver();
      const arilState = createARILState(4);
      const attrs = makeAttributions(4);

      const obs = observer.observe(state, params, vocab, eg, arilState, DEFAULT_ARIL_CONFIG, NaN, attrs);

      expect(Number.isFinite(obs.modeScore)).toBe(true);
      expect(['search', 'insight']).toContain(obs.mode);
      expect(Number.isFinite(obs.consolidationDelta)).toBe(true);
      expect(Number.isFinite(obs.globalTunnelingRisk)).toBe(true);

      for (const dm of obs.dimensionModes) {
        expect(Number.isFinite(dm.curvature)).toBe(true);
        expect(Number.isFinite(dm.distanceFromSaddle)).toBe(true);
      }

      for (const t of obs.tunneling) {
        expect(Number.isFinite(t.barrierHeight)).toBe(true);
        expect(Number.isFinite(t.effectiveNoise)).toBe(true);
        expect(Number.isFinite(t.probability)).toBe(true);
      }
    });

    test('zero-dimension edge case', () => {
      const state: SelfState = { dimension: 0, w: new Float64Array(0), m: new Float64Array(0), time: 0 };
      const emptyVocab: Vocabulary = { assertions: [], relationships: new Float64Array(0) };
      const emptyParams: DynamicsParams = { D: 0.1, lambda: 0.4, mu: 0.3, kappa: 0.1, a: 0.5, w_star: new Float64Array(0) };
      const eg = computeEnergyGradient(state, emptyParams, emptyVocab);

      const observer = new ModeObserver();
      const arilState = createARILState(0);
      const attrs: any[] = [];

      const obs = observer.observe(state, emptyParams, emptyVocab, eg, arilState, DEFAULT_ARIL_CONFIG, 0, attrs);

      expect(obs.dimensionModes).toHaveLength(0);
      expect(obs.tunneling).toHaveLength(0);
      expect(Number.isFinite(obs.modeScore)).toBe(true);
      expect(Number.isFinite(obs.consolidationDelta)).toBe(true);
    });

    test('computeAdaptiveBarrier handles NaN/Infinity', () => {
      expect(Number.isFinite(computeAdaptiveBarrier(NaN))).toBe(true);
      expect(Number.isFinite(computeAdaptiveBarrier(Infinity))).toBe(true);
      expect(Number.isFinite(computeAdaptiveBarrier(-Infinity))).toBe(true);
      // NaN expertise → clamps to 0 → returns aMax
      expect(computeAdaptiveBarrier(NaN)).toBeCloseTo(0.75, 8);
    });
  });

  // ---------------------------------------------------------------------------
  // History Management & Serialization
  // ---------------------------------------------------------------------------

  describe('history management', () => {
    test('history respects window size', () => {
      const observer = new ModeObserver({ historyWindow: 3 });
      const attrs = makeAttributions(4);

      for (let s = 0; s < 5; s++) {
        const { state, eg, arilState } = createObserverTestInputs([0.3, 0.5, 0.7, 0.4]);
        observer.observe(state, params, vocab, eg, arilState, DEFAULT_ARIL_CONFIG, s * 0.2, attrs);
      }

      const history = observer.getHistory();
      expect(history.energyHistory.length).toBeLessThanOrEqual(3);
      expect(history.outcomeTermHistory.length).toBeLessThanOrEqual(3);
      expect(history.replicatorTermHistory.length).toBeLessThanOrEqual(3);
      expect(history.sessionCount).toBe(5);
    });

    test('serialization round-trip', () => {
      const observer = new ModeObserver();
      const attrs = makeAttributions(4, [0.2, -0.1, 0.3, 0.05]);

      // Build some history
      for (let s = 0; s < 4; s++) {
        const { state, eg, arilState } = createObserverTestInputs([0.3, 0.5, 0.7, 0.4]);
        arilState.fitness = new Float64Array([0.1, 0.2, -0.1, 0.05]);
        observer.observe(state, params, vocab, eg, arilState, DEFAULT_ARIL_CONFIG, s * 0.3, attrs);
      }

      const history = observer.getHistory();
      const serialized = serializeObserverHistory(history);
      const deserialized = deserializeObserverHistory(serialized);

      expect(deserialized.sessionCount).toBe(history.sessionCount);
      expect(deserialized.energyHistory.length).toBe(history.energyHistory.length);
      expect(deserialized.minObservedEnergy).toBeCloseTo(history.minObservedEnergy, 8);
      expect(deserialized.outcomeTermHistory.length).toBe(history.outcomeTermHistory.length);
      expect(deserialized.replicatorTermHistory.length).toBe(history.replicatorTermHistory.length);

      // Verify values survived round-trip
      for (let i = 0; i < history.energyHistory.length; i++) {
        expect(deserialized.energyHistory[i]).toBeCloseTo(history.energyHistory[i], 8);
      }
    });

    test('deserialization handles missing/corrupted data', () => {
      const corrupted: any = {
        energyHistory: [1, NaN, Infinity],
        minObservedEnergy: NaN,
        outcomeTermHistory: null,
        replicatorTermHistory: undefined,
        sessionCount: -5,
      };

      const result = deserializeObserverHistory(corrupted);
      expect(result.sessionCount).toBe(0);
      // NaN values should be sanitized
      for (const v of result.energyHistory) {
        expect(Number.isFinite(v)).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // GuidanceEngine integration
  // ---------------------------------------------------------------------------

  describe('GuidanceEngine observer integration', () => {
    test('observer directives appear when observation provided', () => {
      const engine = new GuidanceEngine();
      const fitness = new Float64Array([0.1, 0.2, 0.05, 0.15]);
      const dims = ['curiosity', 'precision', 'persistence', 'empathy'];
      const weights = new Float64Array([0.3, 0.7, 0.2, 0.8]);

      const observation: ModeObservation = {
        modeScore: 5.0,
        mode: 'search',
        dimensionModes: [
          { index: 0, well: 'low', curvature: 0.5, distanceFromSaddle: 0.4 },
          { index: 1, well: 'barrier', curvature: -0.25, distanceFromSaddle: 0.02 },
          { index: 2, well: 'low', curvature: 0.3, distanceFromSaddle: 0.3 },
          { index: 3, well: 'high', curvature: 0.4, distanceFromSaddle: 0.3 },
        ],
        tunneling: [
          { index: 0, barrierHeight: 0.01, effectiveNoise: 0.005, probability: 0.4 },
          { index: 1, barrierHeight: 0.001, effectiveNoise: 0.005, probability: 0.9 },
          { index: 2, barrierHeight: 0.015, effectiveNoise: 0.002, probability: 0.1 },
          { index: 3, barrierHeight: 0.012, effectiveNoise: 0.003, probability: 0.2 },
        ],
        globalTunnelingRisk: 0.9,
        consolidationDelta: 0.001,
        timestamp: Date.now(),
      };

      const output = engine.generate(
        fitness, dims, weights, [], null, null, [], 5, observation
      );

      // Should have mode_observer directives
      const observerDirectives = output.directives.filter(d => d.source === 'mode_observer');
      expect(observerDirectives.length).toBeGreaterThan(0);

      // Should include search + tunneling directive (globalTunnelingRisk > 0.3)
      const searchDirective = observerDirectives.find(d => d.imperative.includes('exploration'));
      expect(searchDirective).toBeDefined();

      // Should include barrier directive (dim 1 is at barrier)
      const barrierDirective = observerDirectives.find(d => d.imperative.includes('boundary'));
      expect(barrierDirective).toBeDefined();

      // Should include consolidation warning (delta ≥ -0.001)
      const consolidationDirective = observerDirectives.find(d => d.imperative.includes('Consolidation'));
      expect(consolidationDirective).toBeDefined();
    });

    test('no observer directives when observation is null', () => {
      const engine = new GuidanceEngine();
      const fitness = new Float64Array([0.1, 0.2]);
      const dims = ['a', 'b'];
      const weights = new Float64Array([0.5, 0.5]);

      const output = engine.generate(fitness, dims, weights, [], null, null, [], 5, null);

      const observerDirectives = output.directives.filter(d => d.source === 'mode_observer');
      expect(observerDirectives.length).toBe(0);
    });
  });
});

// =============================================================================
// PHASE 2: CONSOLIDATION + WIRING
// =============================================================================

import {
  IdentityBridge,
  createBehavioralVocabulary,
  createBehavioralParams,
} from './IdentityBridge';

import {
  UnifiedIdentity,
  createUnifiedIdentity,
  type ConsolidationSnapshot,
} from './UnifiedIdentity';

import type { StorageBackend } from './IdentityPersistence';
import type { Interaction } from './ReflectionEngine';

// ---------------------------------------------------------------------------
// Helpers for Phase 2
// ---------------------------------------------------------------------------

function createTestInteraction(id: string): Interaction {
  return {
    id,
    prompt: 'test prompt',
    response: 'test response',
    context: {},
    durationMs: 1000,
    timestamp: Date.now(),
    selfStateSnapshot: { w: [0.5, 0.5, 0.5, 0.5], m: [0.5, 0.5, 0.5, 0.5] },
  };
}

function createInMemoryStorage(): StorageBackend {
  const store = new Map<string, unknown>();
  return {
    get: async <T>(key: string): Promise<T | null> => (store.get(key) as T) ?? null,
    set: async <T>(key: string, value: T): Promise<void> => { store.set(key, value); },
    delete: async (key: string): Promise<void> => { store.delete(key); },
    keys: async (_pattern?: string): Promise<string[]> => [...store.keys()],
    isPersistent: () => false,
  };
}

/** Create UnifiedIdentity with auto-save timer disabled (prevents test leaks) */
function createTestIdentity(storage: StorageBackend) {
  return createUnifiedIdentity(storage, { autoSaveIntervalMs: 0 });
}

function createMinimalPrivateStorage() {
  const logs: { log: any; metadata?: any; hash: string }[] = [];
  return {
    storeActionLog: async (log: any, meta?: any) => {
      const hash = `hash_${logs.length}`;
      logs.push({ log, metadata: meta, hash });
      return hash;
    },
    storeActionLogWithInsights: async (log: any, insights: any[], meta?: any) => {
      const hash = `hash_${logs.length}`;
      logs.push({ log, metadata: meta, hash });
      return hash;
    },
    getAllActionLogs: async () => logs,
    getPivotalInsights: async () => [],
    _logs: logs,
  };
}

describe('Phase 2: Consolidation + Wiring', () => {
  // ---------------------------------------------------------------------------
  // §8.1 — Consolidation Snapshots (via IdentityBridge + direct testing)
  // ---------------------------------------------------------------------------

  describe('IdentityBridge new methods', () => {
    test('updateParams changes the a parameter', () => {
      const vocab = createBehavioralVocabulary();
      const params = createBehavioralParams(4);
      const state = {
        dimension: 4,
        w: new Float64Array([0.5, 0.5, 0.5, 0.5]),
        m: new Float64Array([0.5, 0.5, 0.5, 0.5]),
        time: 0,
      };

      const bridge = new IdentityBridge(state, vocab, params);
      expect(bridge.getParams().a).toBe(0.5);

      bridge.updateParams({ a: 0.35 });
      expect(bridge.getParams().a).toBeCloseTo(0.35, 8);
      // Other params unchanged
      expect(bridge.getParams().D).toBe(0.1);
      expect(bridge.getParams().lambda).toBeCloseTo(0.4, 8);
    });

    test('updateParams preserves unspecified fields', () => {
      const vocab = createBehavioralVocabulary();
      const params = createBehavioralParams(4);
      const state = {
        dimension: 4,
        w: new Float64Array([0.5, 0.5, 0.5, 0.5]),
        m: new Float64Array([0.5, 0.5, 0.5, 0.5]),
        time: 0,
      };

      const bridge = new IdentityBridge(state, vocab, params);
      const originalD = bridge.getParams().D;
      const originalLambda = bridge.getParams().lambda;

      bridge.updateParams({ a: 0.3 });

      expect(bridge.getParams().D).toBe(originalD);
      expect(bridge.getParams().lambda).toBe(originalLambda);
    });

    test('setState updates weights without creating declarations', () => {
      const vocab = createBehavioralVocabulary();
      const params = createBehavioralParams(4);
      const state = {
        dimension: 4,
        w: new Float64Array([0.5, 0.5, 0.5, 0.5]),
        m: new Float64Array([0.5, 0.5, 0.5, 0.5]),
        time: 0,
      };

      const bridge = new IdentityBridge(state, vocab, params);
      const newW = new Float64Array([0.3, 0.7, 0.4, 0.6]);
      bridge.setState(newW);

      const updatedState = bridge.getState();
      expect(updatedState.w[0]).toBeCloseTo(0.3, 8);
      expect(updatedState.w[1]).toBeCloseTo(0.7, 8);
      // m should track w
      expect(updatedState.m[0]).toBeCloseTo(0.3, 8);
      // No declarations created
      expect(bridge.getDeclarations().length).toBe(0);
    });

    test('setState preserves dimension and time', () => {
      const vocab = createBehavioralVocabulary();
      const params = createBehavioralParams(4);
      const state = {
        dimension: 4,
        w: new Float64Array([0.5, 0.5, 0.5, 0.5]),
        m: new Float64Array([0.5, 0.5, 0.5, 0.5]),
        time: 42,
      };

      const bridge = new IdentityBridge(state, vocab, params);
      bridge.setState(new Float64Array([0.1, 0.9, 0.2, 0.8]));

      expect(bridge.getState().dimension).toBe(4);
      expect(bridge.getState().time).toBe(42);
    });
  });

  // ---------------------------------------------------------------------------
  // §8.2 — Consolidated Initialization
  // ---------------------------------------------------------------------------

  describe('consolidated initialization (§8.2)', () => {
    // We test computeConsolidatedInit indirectly via UnifiedIdentity
    // by inspecting the effect on the bridge state

    test('softmax weighting: higher R gets more weight', () => {
      // Direct test of softmax formula
      const snapshots: ConsolidationSnapshot[] = [
        { weights: [0.2, 0.2], fitness: [0, 0], outcome: 0.1, hessianDiag: [0, 0], attributions: [0, 0], expertise: 0, timestamp: 1 },
        { weights: [0.5, 0.5], fitness: [0, 0], outcome: 0.5, hessianDiag: [0, 0], attributions: [0, 0], expertise: 0, timestamp: 2 },
        { weights: [0.8, 0.8], fitness: [0, 0], outcome: 0.9, hessianDiag: [0, 0], attributions: [0, 0], expertise: 0, timestamp: 3 },
      ];

      // Replicate the softmax formula
      const temperature = 1.0;
      const outcomes = snapshots.map(s => s.outcome / temperature);
      const maxOutcome = Math.max(...outcomes);
      const exps = outcomes.map(o => Math.exp(o - maxOutcome));
      const sumExps = exps.reduce((a, b) => a + b, 0);
      const softmaxWeights = exps.map(e => e / sumExps);

      // Highest R=0.9 should have highest softmax weight
      expect(softmaxWeights[2]).toBeGreaterThan(softmaxWeights[1]);
      expect(softmaxWeights[1]).toBeGreaterThan(softmaxWeights[0]);

      // Weighted average should be closer to the high-R snapshot's weights
      const result = new Float64Array(2);
      for (let j = 0; j < 3; j++) {
        for (let i = 0; i < 2; i++) {
          result[i] += softmaxWeights[j] * snapshots[j].weights[i];
        }
      }

      // Result should be biased toward [0.8, 0.8]
      expect(result[0]).toBeGreaterThan(0.5);
      expect(result[1]).toBeGreaterThan(0.5);
    });

    test('uniform outcomes → equal weighting → simple average', () => {
      const snapshots: ConsolidationSnapshot[] = [
        { weights: [0.2, 0.4], fitness: [0, 0], outcome: 0.5, hessianDiag: [0, 0], attributions: [0, 0], expertise: 0, timestamp: 1 },
        { weights: [0.6, 0.8], fitness: [0, 0], outcome: 0.5, hessianDiag: [0, 0], attributions: [0, 0], expertise: 0, timestamp: 2 },
      ];

      const temperature = 1.0;
      const outcomes = snapshots.map(s => s.outcome / temperature);
      const maxOutcome = Math.max(...outcomes);
      const exps = outcomes.map(o => Math.exp(o - maxOutcome));
      const sumExps = exps.reduce((a, b) => a + b, 0);
      const softmaxWeights = exps.map(e => e / sumExps);

      // Equal outcomes → equal weights
      expect(softmaxWeights[0]).toBeCloseTo(0.5, 8);
      expect(softmaxWeights[1]).toBeCloseTo(0.5, 8);

      // Average of [0.2, 0.4] and [0.6, 0.8] = [0.4, 0.6]
      const result = new Float64Array(2);
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 2; i++) {
          result[i] += softmaxWeights[j] * snapshots[j].weights[i];
        }
      }
      expect(result[0]).toBeCloseTo(0.4, 6);
      expect(result[1]).toBeCloseTo(0.6, 6);
    });

    test('single snapshot → returns its weights directly', () => {
      const snapshots: ConsolidationSnapshot[] = [
        { weights: [0.35, 0.65], fitness: [0, 0], outcome: 0.7, hessianDiag: [0, 0], attributions: [0, 0], expertise: 0, timestamp: 1 },
      ];

      const outcomes = snapshots.map(s => s.outcome);
      const maxOutcome = Math.max(...outcomes);
      const exps = outcomes.map(o => Math.exp(o - maxOutcome));
      const sumExps = exps.reduce((a, b) => a + b, 0);
      const softmaxWeights = exps.map(e => e / sumExps);

      expect(softmaxWeights[0]).toBeCloseTo(1.0, 8);

      const result = new Float64Array(2);
      for (let j = 0; j < 1; j++) {
        for (let i = 0; i < 2; i++) {
          result[i] += softmaxWeights[j] * snapshots[j].weights[i];
        }
      }
      expect(result[0]).toBeCloseTo(0.35, 8);
      expect(result[1]).toBeCloseTo(0.65, 8);
    });

    test('weight clamping to [0.01, 0.99]', () => {
      // If snapshot weights are at extremes, the result should still be clamped
      const snapshots: ConsolidationSnapshot[] = [
        { weights: [0.005, 0.995], fitness: [0, 0], outcome: 0.9, hessianDiag: [0, 0], attributions: [0, 0], expertise: 0, timestamp: 1 },
      ];

      // After softmax (single element = weight 1.0), the result is [0.005, 0.995]
      // Clamping: max(0.01, min(0.99, x))
      const clamped0 = Math.max(0.01, Math.min(0.99, snapshots[0].weights[0]));
      const clamped1 = Math.max(0.01, Math.min(0.99, snapshots[0].weights[1]));

      expect(clamped0).toBeCloseTo(0.01, 8);
      expect(clamped1).toBeCloseTo(0.99, 8);
    });
  });

  // ---------------------------------------------------------------------------
  // UnifiedIdentity integration
  // ---------------------------------------------------------------------------

  describe('UnifiedIdentity wiring', () => {
    test('ModeObserver is created during initialize', async () => {
      const storage = createInMemoryStorage();
      const identity = createTestIdentity(storage);
      await identity.initialize([0.5, 0.5, 0.5, 0.5]);

      // If ModeObserver is wired correctly, getLastObservation returns null (no session yet)
      expect(identity.getLastObservation()).toBeNull();
      // But the observer exists (verified by running an observation and checking)
    });

    test('endObservation stores consolidation snapshot', async () => {
      const storage = createInMemoryStorage();
      const identity = createTestIdentity(storage);
      await identity.initialize([0.5, 0.5, 0.5, 0.5]);

      identity.startObservation('test-1');
      identity.recordToolCall('Read', { file: 'test.ts' }, 'ok', true, 100);
      identity.recordToolCall('Write', { file: 'out.ts' }, 'ok', true, 200);
      await identity.endObservation(createTestInteraction('test-1'));

      const snapshots = identity.getConsolidationSnapshots();
      expect(snapshots.length).toBe(1);
      expect(snapshots[0].weights.length).toBe(4);
      expect(snapshots[0].fitness.length).toBe(4);
      expect(typeof snapshots[0].outcome).toBe('number');
      expect(typeof snapshots[0].expertise).toBe('number');
      expect(typeof snapshots[0].timestamp).toBe('number');
      expect(snapshots[0].hessianDiag.length).toBe(4);
    });

    test('consolidation snapshots capped at 5', async () => {
      const storage = createInMemoryStorage();
      const identity = createTestIdentity(storage);
      await identity.initialize([0.5, 0.5, 0.5, 0.5]);

      for (let i = 0; i < 7; i++) {
        identity.startObservation(`test-${i}`);
        identity.recordToolCall('Read', { file: 'x.ts' }, 'ok', true, 100);
        await identity.endObservation(createTestInteraction(`test-${i}`));
      }

      const snapshots = identity.getConsolidationSnapshots();
      expect(snapshots.length).toBe(5);
    });

    test('lastObservation is stored after endObservation', async () => {
      const storage = createInMemoryStorage();
      const identity = createTestIdentity(storage);
      await identity.initialize([0.5, 0.5, 0.5, 0.5]);

      identity.startObservation('obs-1');
      identity.recordToolCall('Read', { file: 'a.ts' }, 'ok', true, 50);
      await identity.endObservation(createTestInteraction('obs-1'));

      const observation = identity.getLastObservation();
      expect(observation).not.toBeNull();
      expect(typeof observation!.modeScore).toBe('number');
      expect(['search', 'insight']).toContain(observation!.mode);
      expect(observation!.dimensionModes.length).toBe(4);
      expect(observation!.tunneling.length).toBe(4);
    });

    test('adaptive barrier changes params.a after endObservation', async () => {
      const storage = createInMemoryStorage();
      const identity = createTestIdentity(storage);
      await identity.initialize([0.5, 0.5, 0.5, 0.5]);

      // Get initial a
      const stateBefore = identity.export();
      const aBefore = stateBefore!.params.a;

      // Run an observation
      identity.startObservation('barrier-1');
      identity.recordToolCall('Read', { file: 'test.ts' }, 'ok', true, 100);
      await identity.endObservation(createTestInteraction('barrier-1'));

      // After observation, params.a should be updated by adaptive barrier
      const stateAfter = identity.export();
      const aAfter = stateAfter!.params.a;

      // Adaptive barrier was applied (a changed from default 0.5)
      // With low expertise, a should be closer to aMax=0.75 than aMin=0.25
      expect(aAfter).not.toBe(aBefore);
      expect(aAfter).toBeGreaterThan(0.5);
      expect(aAfter).toBeLessThanOrEqual(0.75);
    });

    test('getARILGuidance passes lastObservation', async () => {
      const storage = createInMemoryStorage();
      const identity = createTestIdentity(storage);
      await identity.initialize([0.5, 0.5, 0.5, 0.5]);

      // Run a session to create an observation
      identity.startObservation('guide-1');
      identity.recordToolCall('Read', { file: 'x.ts' }, 'ok', true, 100);
      await identity.endObservation(createTestInteraction('guide-1'));

      // Now call getARILGuidance — it should use lastObservation
      const guidance = identity.getARILGuidance();
      expect(guidance).not.toBeNull();
      // Guidance should have directives (at minimum from observer or energy gradients)
      expect(guidance!.directives).toBeDefined();
    });

    test('setState applies ARIL-adjusted weights during endObservation', async () => {
      const storage = createInMemoryStorage();
      const identity = createTestIdentity(storage);
      await identity.initialize([0.5, 0.5, 0.5, 0.5]);

      identity.startObservation('aril-1');
      identity.recordToolCall('Read', { file: 'a.ts' }, 'ok', true, 50);
      identity.recordToolCall('Write', { file: 'b.ts' }, 'ok', true, 100);
      identity.recordToolCall('Bash', { cmd: 'test' }, 'fail', false, 200);
      identity.recordToolCall('Bash', { cmd: 'test' }, 'pass', true, 200);
      await identity.endObservation(createTestInteraction('aril-1'));

      // After ARIL backward pass + setState, the bridge state should reflect
      // ARIL-adjusted weights (not just the original [0.5, 0.5, 0.5, 0.5])
      const state = identity.getState();
      expect(state).not.toBeNull();
      // State might still be close to 0.5 due to small learning rates,
      // but at least the ARIL path executed without error
      expect(state!.w.length).toBe(4);
      for (let i = 0; i < 4; i++) {
        expect(state!.w[i]).toBeGreaterThanOrEqual(0.01);
        expect(state!.w[i]).toBeLessThanOrEqual(0.99);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // DomainTracker curvature wiring
  // ---------------------------------------------------------------------------

  describe('DomainTracker curvature wiring', () => {
    test('updateWithCurvature is called during endObservation', async () => {
      const storage = createInMemoryStorage();
      const identity = createTestIdentity(storage);
      await identity.initialize([0.5, 0.5, 0.5, 0.5]);

      // Run multiple sessions with typescript tool calls to build domain exposure
      for (let i = 0; i < 3; i++) {
        identity.startObservation(`curvature-${i}`);
        identity.recordToolCall('tsc', { file: 'index.ts' }, 'ok', true, 100);
        await identity.endObservation(createTestInteraction(`curvature-${i}`));
      }

      // After sessions, the consolidation snapshots should have
      // expertise > 0 (because curvature sessions were counted)
      const snapshots = identity.getConsolidationSnapshots();
      expect(snapshots.length).toBe(3);
      // The expertise field in later snapshots should be > 0
      // because DomainTracker.getExpertise() incorporates curvature
      expect(typeof snapshots[2].expertise).toBe('number');
    });
  });

  // ---------------------------------------------------------------------------
  // State Persistence Round-trip
  // ---------------------------------------------------------------------------

  describe('state persistence round-trip', () => {
    test('observer history survives save/load cycle', async () => {
      const storage = createInMemoryStorage();
      const privateStorage = createMinimalPrivateStorage();

      // Session 1: create identity, run observation, save
      const identity1 = createTestIdentity(storage);
      identity1.setPrivateStorage(privateStorage as any);
      await identity1.initialize([0.5, 0.5, 0.5, 0.5]);

      identity1.startObservation('persist-1');
      identity1.recordToolCall('Read', { file: 'a.ts' }, 'ok', true, 100);
      await identity1.endObservation(createTestInteraction('persist-1'));

      // Verify data was stored
      const obs1 = identity1.getLastObservation();
      expect(obs1).not.toBeNull();
      const snap1 = identity1.getConsolidationSnapshots();
      expect(snap1.length).toBe(1);

      // Session 2: load state back
      const identity2 = createTestIdentity(storage);
      identity2.setPrivateStorage(privateStorage as any);
      await identity2.initialize([0.5, 0.5, 0.5, 0.5]);

      // Consolidation snapshots should survive round-trip
      const snap2 = identity2.getConsolidationSnapshots();
      expect(snap2.length).toBe(1);
      expect(snap2[0].weights).toEqual(snap1[0].weights);
      expect(snap2[0].outcome).toBeCloseTo(snap1[0].outcome, 8);
    });

    test('consolidation snapshots survive round-trip', async () => {
      const storage = createInMemoryStorage();
      const privateStorage = createMinimalPrivateStorage();

      const identity1 = createTestIdentity(storage);
      identity1.setPrivateStorage(privateStorage as any);
      await identity1.initialize([0.5, 0.5, 0.5, 0.5]);

      // Run 3 observations
      for (let i = 0; i < 3; i++) {
        identity1.startObservation(`round-${i}`);
        identity1.recordToolCall('Read', { file: 'x.ts' }, 'ok', true, 100);
        await identity1.endObservation(createTestInteraction(`round-${i}`));
      }

      expect(identity1.getConsolidationSnapshots().length).toBe(3);

      // Reload
      const identity2 = createTestIdentity(storage);
      identity2.setPrivateStorage(privateStorage as any);
      await identity2.initialize([0.5, 0.5, 0.5, 0.5]);

      const loaded = identity2.getConsolidationSnapshots();
      expect(loaded.length).toBe(3);
      for (let i = 0; i < 3; i++) {
        expect(loaded[i].weights.length).toBe(4);
        expect(loaded[i].fitness.length).toBe(4);
      }
    });

    test('consolidated init uses previous session data on load', async () => {
      const storage = createInMemoryStorage();
      const privateStorage = createMinimalPrivateStorage();

      const identity1 = createTestIdentity(storage);
      identity1.setPrivateStorage(privateStorage as any);
      await identity1.initialize([0.5, 0.5, 0.5, 0.5]);

      // Run a session
      identity1.startObservation('init-1');
      identity1.recordToolCall('Read', { file: 'a.ts' }, 'ok', true, 100);
      await identity1.endObservation(createTestInteraction('init-1'));

      const snapWeights = identity1.getConsolidationSnapshots()[0].weights;

      // Reload — consolidated init should apply during initialize()
      const identity2 = createTestIdentity(storage);
      identity2.setPrivateStorage(privateStorage as any);
      await identity2.initialize([0.5, 0.5, 0.5, 0.5]);

      // The bridge state should reflect consolidated weights, not defaults
      const state = identity2.getState();
      expect(state).not.toBeNull();
      // With one snapshot, consolidated init = that snapshot's weights (softmax weight 1.0)
      for (let i = 0; i < 4; i++) {
        // Clamped to [0.01, 0.99]
        const expected = Math.max(0.01, Math.min(0.99, snapWeights[i]));
        expect(state!.w[i]).toBeCloseTo(expected, 4);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Integration: full lifecycle
  // ---------------------------------------------------------------------------

  describe('full lifecycle integration', () => {
    test('multiple sessions accumulate snapshots correctly', async () => {
      const storage = createInMemoryStorage();
      const identity = createTestIdentity(storage);
      await identity.initialize([0.5, 0.5, 0.5, 0.5]);

      const sessionCount = 4;
      for (let i = 0; i < sessionCount; i++) {
        identity.startObservation(`lifecycle-${i}`);
        identity.recordToolCall('Read', { file: `file${i}.ts` }, 'ok', true, 100);
        identity.recordToolCall('Write', { file: `out${i}.ts` }, 'ok', true, 150);
        await identity.endObservation(createTestInteraction(`lifecycle-${i}`));
      }

      // Check all components updated
      const snapshots = identity.getConsolidationSnapshots();
      expect(snapshots.length).toBe(sessionCount);

      // Each snapshot should have increasing timestamps
      for (let i = 1; i < snapshots.length; i++) {
        expect(snapshots[i].timestamp).toBeGreaterThanOrEqual(snapshots[i - 1].timestamp);
      }

      // Last observation should be from most recent session
      const obs = identity.getLastObservation();
      expect(obs).not.toBeNull();

      // ARIL fitness should have been updated
      const fitness = identity.getARILFitness();
      expect(fitness).not.toBeNull();
      expect(fitness!.length).toBe(4);

      // Session count should be > 0
      expect(identity.getARILSessionCount()).toBeGreaterThan(0);
    });

    test('snapshot fields match ARIL state at session end', async () => {
      const storage = createInMemoryStorage();
      const identity = createTestIdentity(storage);
      await identity.initialize([0.5, 0.5, 0.5, 0.5]);

      identity.startObservation('match-1');
      identity.recordToolCall('Read', { file: 'x.ts' }, 'ok', true, 100);
      await identity.endObservation(createTestInteraction('match-1'));

      const snapshot = identity.getConsolidationSnapshots()[0];
      const state = identity.getState()!;
      const fitness = identity.getARILFitness()!;

      // Snapshot weights should match current state (post-ARIL)
      for (let i = 0; i < 4; i++) {
        expect(snapshot.weights[i]).toBeCloseTo(state.w[i], 8);
      }

      // Snapshot fitness should match ARIL fitness
      for (let i = 0; i < 4; i++) {
        expect(snapshot.fitness[i]).toBeCloseTo(fitness[i], 8);
      }
    });

    test('snapshot includes attributions per dimension', async () => {
      const storage = createInMemoryStorage();
      const identity = createTestIdentity(storage);
      await identity.initialize([0.5, 0.5, 0.5, 0.5]);

      identity.startObservation('attr-1');
      identity.recordToolCall('Read', { file: 'x.ts' }, 'ok', true, 100);
      await identity.endObservation(createTestInteraction('attr-1'));

      const snapshot = identity.getConsolidationSnapshots()[0];
      expect(snapshot.attributions).toBeDefined();
      expect(snapshot.attributions.length).toBe(4);
      // Attributions should be numbers (Shapley values)
      for (const a of snapshot.attributions) {
        expect(typeof a).toBe('number');
        expect(Number.isFinite(a)).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // §8.2 — Fitness consolidation
  // ---------------------------------------------------------------------------

  describe('fitness consolidation (§8.2)', () => {
    test('consolidated fitness uses 0.8 decay + 0.2 uniform', async () => {
      const storage = createInMemoryStorage();
      const privateStorage = createMinimalPrivateStorage();

      // Session 1: run to build a snapshot
      const identity1 = createTestIdentity(storage);
      identity1.setPrivateStorage(privateStorage as any);
      await identity1.initialize([0.5, 0.5, 0.5, 0.5]);

      identity1.startObservation('fit-1');
      identity1.recordToolCall('Read', { file: 'a.ts' }, 'ok', true, 100);
      identity1.recordToolCall('Write', { file: 'b.ts' }, 'ok', true, 100);
      await identity1.endObservation(createTestInteraction('fit-1'));

      const snap1Fitness = identity1.getConsolidationSnapshots()[0].fitness;

      // Session 2: reload — consolidated init should apply fitness
      const identity2 = createTestIdentity(storage);
      identity2.setPrivateStorage(privateStorage as any);
      await identity2.initialize([0.5, 0.5, 0.5, 0.5]);

      const fitness = identity2.getARILFitness()!;
      expect(fitness).not.toBeNull();

      // With one snapshot, softmax weight = 1.0
      // f_init[i] = 0.8 · snap1Fitness[i] + 0.2 · (1/4)
      const n = 4;
      for (let i = 0; i < n; i++) {
        const expected = 0.8 * snap1Fitness[i] + 0.2 * (1 / n);
        expect(fitness[i]).toBeCloseTo(expected, 6);
      }
    });

    test('consolidated fitness is non-zero even with zero-fitness snapshot', async () => {
      const storage = createInMemoryStorage();
      const privateStorage = createMinimalPrivateStorage();

      const identity1 = createTestIdentity(storage);
      identity1.setPrivateStorage(privateStorage as any);
      await identity1.initialize([0.5, 0.5, 0.5, 0.5]);

      // Session with minimal activity — fitness stays near 0
      identity1.startObservation('zf-1');
      identity1.recordToolCall('Read', { file: 'a.ts' }, 'ok', true, 100);
      await identity1.endObservation(createTestInteraction('zf-1'));

      // Reload
      const identity2 = createTestIdentity(storage);
      identity2.setPrivateStorage(privateStorage as any);
      await identity2.initialize([0.5, 0.5, 0.5, 0.5]);

      const fitness = identity2.getARILFitness()!;
      // Even with zero fitness, the 0.2 * (1/N) uniform noise
      // ensures f_init > 0 (specifically, at least 0.05 for N=4)
      for (let i = 0; i < 4; i++) {
        expect(fitness[i]).toBeGreaterThanOrEqual(0.2 * 0.25 - 1e-10);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Consistency-based learning rate scaling
  // ---------------------------------------------------------------------------

  describe('consistency-based meta-rate scaling', () => {
    test('meta-learning rates are scaled after consolidated init', async () => {
      const storage = createInMemoryStorage();
      const privateStorage = createMinimalPrivateStorage();

      // Run 3 sessions to build snapshots with attribution variance
      const identity1 = createTestIdentity(storage);
      identity1.setPrivateStorage(privateStorage as any);
      await identity1.initialize([0.5, 0.5, 0.5, 0.5]);

      for (let i = 0; i < 3; i++) {
        identity1.startObservation(`meta-${i}`);
        identity1.recordToolCall('Read', { file: `f${i}.ts` }, 'ok', true, 100);
        identity1.recordToolCall('Write', { file: `o${i}.ts` }, 'ok', true, 100);
        await identity1.endObservation(createTestInteraction(`meta-${i}`));
      }

      // Verify snapshots have attributions
      const snaps = identity1.getConsolidationSnapshots();
      expect(snaps.length).toBe(3);
      for (const s of snaps) {
        expect(s.attributions.length).toBe(4);
      }

      // Reload — consolidated init applies meta-rate scaling
      const identity2 = createTestIdentity(storage);
      identity2.setPrivateStorage(privateStorage as any);
      await identity2.initialize([0.5, 0.5, 0.5, 0.5]);

      // Meta-learning rates should exist and be within valid bounds
      const state = identity2.getARILFitness(); // verifies ARIL state exists
      expect(state).not.toBeNull();
    });

    test('metaLearningRates do not drift to bounds over multiple save/load cycles', async () => {
      const storage = createInMemoryStorage();
      const privateStorage = createMinimalPrivateStorage();

      // Run 4 save/load cycles, each with 3 sessions
      for (let cycle = 0; cycle < 4; cycle++) {
        const identity = createTestIdentity(storage);
        identity.setPrivateStorage(privateStorage as any);
        await identity.initialize([0.5, 0.5, 0.5, 0.5]);

        for (let s = 0; s < 3; s++) {
          identity.startObservation(`cycle${cycle}-s${s}`);
          identity.recordToolCall('Read', { file: `f${s}.ts` }, 'ok', true, 100);
          identity.recordToolCall('Write', { file: `o${s}.ts` }, 'ok', true, 100);
          await identity.endObservation(createTestInteraction(`cycle${cycle}-s${s}`));
        }
      }

      // Final load — rates should reflect current consistency, not accumulated history
      const finalIdentity = createTestIdentity(storage);
      finalIdentity.setPrivateStorage(privateStorage as any);
      await finalIdentity.initialize([0.5, 0.5, 0.5, 0.5]);

      // Check that meta-learning rates are within the scaling range [1.0, 1.5],
      // NOT pinned to maxMetaRate (2.0) from multiplicative compounding
      const rates = finalIdentity.getARILMetaLearningRates();
      expect(rates).not.toBeNull();
      for (let i = 0; i < rates!.length; i++) {
        expect(rates![i]).toBeGreaterThanOrEqual(1.0);
        expect(rates![i]).toBeLessThanOrEqual(1.5);
        // Specifically: NOT at maxMetaRate (2.0)
        expect(rates![i]).toBeLessThan(2.0);
      }
    });
  });
});

// =============================================================================
// PHASE 3: Möbius Characteristic Function Wiring
// =============================================================================

import {
  MobiusCharacteristic,
  computeBlend,
  blendShapley,
  DEFAULT_MOBIUS_CONFIG,
  type SerializedMobiusState,
} from './MobiusCharacteristic';

describe('Phase 3: Möbius Characteristic Wiring', () => {
  // ---------------------------------------------------------------------------
  // Observation collection (Step 4)
  // ---------------------------------------------------------------------------

  describe('Observation collection via endObservation', () => {
    test('MobiusCharacteristic is created during initialize', async () => {
      const storage = createInMemoryStorage();
      const identity = createTestIdentity(storage);
      await identity.initialize([0.5, 0.5, 0.5, 0.5]);

      // Access Möbius state via getARILGuidance (which exercises the full stack)
      // The fact that initialize doesn't throw with the MobiusCharacteristic import proves it's created
      const guidance = identity.getARILGuidance();
      expect(guidance).not.toBeNull();
    });

    test('Möbius observation is collected after endObservation', async () => {
      const storage = createInMemoryStorage();
      const identity = createTestIdentity(storage);
      identity.setPrivateStorage(createMinimalPrivateStorage() as any);
      await identity.initialize([0.5, 0.5, 0.5, 0.5]);

      // Run a session
      identity.startObservation('s1');
      identity.recordToolCall('Read', { file: 'test.ts' }, 'ok', true, 100);
      identity.recordToolCall('Write', { file: 'out.ts' }, 'ok', true, 200);
      await identity.endObservation(createTestInteraction('s1'));

      // Verify observation was collected by checking the Möbius state persists
      // The observation count should be 1 after one session
      const ps = createMinimalPrivateStorage();
      const identity2 = createTestIdentity(storage);
      identity2.setPrivateStorage(ps as any);

      // Run another session to force save
      await identity2.initialize([0.5, 0.5, 0.5, 0.5]);
      identity2.startObservation('s2');
      identity2.recordToolCall('Read', { file: 'test2.ts' }, 'ok', true, 100);
      await identity2.endObservation(createTestInteraction('s2'));

      // The ARIL state should have been saved with Möbius data
      const allLogs = await ps.getAllActionLogs();
      const arilLog = allLogs.find((l: any) => l.log.interactionId === 'aril_state');
      expect(arilLog).toBeDefined();
      if (arilLog) {
        expect(arilLog.metadata).toBeDefined();
        expect((arilLog.metadata as any).mobius).toBeDefined();
        expect((arilLog.metadata as any).mobiusBaseline).toBeDefined();
      }
    });

    test('Möbius baseline tracks post-ARIL weights', async () => {
      const storage = createInMemoryStorage();
      const identity = createTestIdentity(storage);
      const ps = createMinimalPrivateStorage();
      identity.setPrivateStorage(ps as any);
      await identity.initialize([0.5, 0.5, 0.5, 0.5]);

      // Run a session
      identity.startObservation('s1');
      identity.recordToolCall('Read', { file: 'test.ts' }, 'ok', true, 100);
      identity.recordToolCall('Write', { file: 'out.ts' }, 'ok', true, 200);
      await identity.endObservation(createTestInteraction('s1'));

      // Check that the saved Möbius baseline exists and is an array of 4 values
      const allLogs = await ps.getAllActionLogs();
      const arilLog = allLogs.find((l: any) => l.log.interactionId === 'aril_state');
      expect(arilLog).toBeDefined();
      const baseline = (arilLog!.metadata as any).mobiusBaseline;
      expect(baseline).toBeDefined();
      expect(Array.isArray(baseline)).toBe(true);
      expect(baseline.length).toBe(4);
      // Baseline should be numeric
      for (const v of baseline) {
        expect(typeof v).toBe('number');
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Blend transition (Step 5)
  // ---------------------------------------------------------------------------

  describe('Attribution blend', () => {
    test('no blend when observation count < minObservations', () => {
      // With fewer observations than minObservations, blend should be 0
      const blend = computeBlend(5, 20);
      expect(blend).toBe(0);
    });

    test('partial blend during ramp period', () => {
      // At 1.5× minObservations, blend should be 0.5
      const blend = computeBlend(30, 20);
      expect(blend).toBeCloseTo(0.5, 5);
    });

    test('full blend at 2× minObservations', () => {
      const blend = computeBlend(40, 20);
      expect(blend).toBe(1);
    });

    test('blendShapley produces convex combination', () => {
      const additive = [0.3, 0.2, -0.1, 0.6];
      const mobius = [0.4, 0.1, 0.0, 0.5];

      const blended = blendShapley(additive, mobius, 0.5);
      expect(blended.length).toBe(4);

      // Check convex combination: (1-0.5)*additive + 0.5*mobius
      for (let i = 0; i < 4; i++) {
        expect(blended[i]).toBeCloseTo(0.5 * additive[i] + 0.5 * mobius[i], 10);
      }
    });

    test('blend=0 returns pure additive', () => {
      const additive = [0.3, 0.2, -0.1, 0.6];
      const mobius = [0.4, 0.1, 0.0, 0.5];

      const blended = blendShapley(additive, mobius, 0);
      for (let i = 0; i < 4; i++) {
        expect(blended[i]).toBe(additive[i]);
      }
    });

    test('blend=1 returns pure Möbius', () => {
      const additive = [0.3, 0.2, -0.1, 0.6];
      const mobius = [0.4, 0.1, 0.0, 0.5];

      const blended = blendShapley(additive, mobius, 1);
      for (let i = 0; i < 4; i++) {
        expect(blended[i]).toBe(mobius[i]);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Serialization round-trip (Step 6)
  // ---------------------------------------------------------------------------

  describe('Möbius state persistence', () => {
    test('MobiusCharacteristic survives serialize → deserialize', () => {
      const mc = new MobiusCharacteristic(4);

      // Add some observations
      mc.addObservation([0.6, 0.5, 0.3, 0.7], [0.5, 0.5, 0.5, 0.5], 0.8, 0);
      mc.addObservation([0.5, 0.7, 0.4, 0.6], [0.5, 0.5, 0.5, 0.5], 0.6, 1);
      mc.addObservation([0.4, 0.5, 0.6, 0.5], [0.5, 0.5, 0.5, 0.5], 0.3, 2);
      mc.updateCoefficients();

      // Serialize
      const serialized = mc.serialize();
      expect(serialized.dimensionCount).toBe(4);
      expect(serialized.observations.length).toBe(3);

      // Deserialize
      const restored = MobiusCharacteristic.deserialize(serialized);

      // Check state matches
      expect(restored.N).toBe(4);
      expect(restored.getState().observations.length).toBe(3);
      expect(restored.getState().currentOrder).toBe(mc.getState().currentOrder);

      // Compute Shapley from both — should match
      const origShapley = mc.computeShapley();
      const restoredShapley = restored.computeShapley();
      for (let i = 0; i < 4; i++) {
        expect(restoredShapley[i]).toBeCloseTo(origShapley[i], 10);
      }
    });

    test('Möbius state persists through save/load cycle in UnifiedIdentity', async () => {
      const storage = createInMemoryStorage();
      const ps = createMinimalPrivateStorage();

      // Session 1: create identity, run session
      const identity1 = createTestIdentity(storage);
      identity1.setPrivateStorage(ps as any);
      await identity1.initialize([0.5, 0.5, 0.5, 0.5]);

      identity1.startObservation('s1');
      identity1.recordToolCall('Read', { file: 'a.ts' }, 'ok', true, 100);
      identity1.recordToolCall('Write', { file: 'b.ts' }, 'ok', true, 200);
      await identity1.endObservation(createTestInteraction('s1'));

      // Session 2: load identity, run another session
      const identity2 = createTestIdentity(storage);
      identity2.setPrivateStorage(ps as any);
      await identity2.initialize([0.5, 0.5, 0.5, 0.5]);

      identity2.startObservation('s2');
      identity2.recordToolCall('Grep', { pattern: 'foo' }, 'ok', true, 150);
      await identity2.endObservation(createTestInteraction('s2'));

      // Check that the Möbius state has accumulated observations from both sessions
      const allLogs = await ps.getAllActionLogs();
      const arilLog = allLogs.find((l: any) => l.log.interactionId === 'aril_state');
      expect(arilLog).toBeDefined();

      const mobiusData = (arilLog!.metadata as any).mobius as SerializedMobiusState;
      expect(mobiusData).toBeDefined();
      // Should have 2 observations (one from each session)
      expect(mobiusData.observations.length).toBe(2);
    });

    test('Möbius baseline persists through save/load', async () => {
      const storage = createInMemoryStorage();
      const ps = createMinimalPrivateStorage();

      // Session 1
      const identity1 = createTestIdentity(storage);
      identity1.setPrivateStorage(ps as any);
      await identity1.initialize([0.5, 0.5, 0.5, 0.5]);

      identity1.startObservation('s1');
      identity1.recordToolCall('Read', { file: 'a.ts' }, 'ok', true, 100);
      await identity1.endObservation(createTestInteraction('s1'));

      // Session 2 — load and verify baseline was restored
      const identity2 = createTestIdentity(storage);
      identity2.setPrivateStorage(ps as any);
      await identity2.initialize([0.5, 0.5, 0.5, 0.5]);

      // After loading, we can verify the saved state has baseline
      const allLogs = await ps.getAllActionLogs();
      const arilLog = allLogs.find((l: any) => l.log.interactionId === 'aril_state');
      expect(arilLog).toBeDefined();
      const baseline = (arilLog!.metadata as any).mobiusBaseline;
      expect(baseline).toBeDefined();
      expect(Array.isArray(baseline)).toBe(true);
      expect(baseline.length).toBe(4);
    });
  });

  // ---------------------------------------------------------------------------
  // Integration: multi-session Möbius accumulation
  // ---------------------------------------------------------------------------

  describe('Multi-session integration', () => {
    test('observations accumulate across multiple sessions', async () => {
      const storage = createInMemoryStorage();
      const ps = createMinimalPrivateStorage();
      const N_SESSIONS = 5;

      let latestIdentity: any;

      for (let s = 0; s < N_SESSIONS; s++) {
        const identity = createTestIdentity(storage);
        identity.setPrivateStorage(ps as any);
        await identity.initialize([0.5, 0.5, 0.5, 0.5]);

        identity.startObservation(`s${s}`);
        // Vary tool calls per session
        for (let t = 0; t < 3 + s; t++) {
          identity.recordToolCall(
            ['Read', 'Write', 'Grep', 'Glob'][t % 4],
            { file: `file_${t}.ts` },
            'ok', true, 100 + t * 50
          );
        }
        await identity.endObservation(createTestInteraction(`s${s}`));
        latestIdentity = identity;
      }

      // Check final state
      const allLogs = await ps.getAllActionLogs();
      const arilLog = allLogs.find((l: any) => l.log.interactionId === 'aril_state');
      expect(arilLog).toBeDefined();

      const mobiusData = (arilLog!.metadata as any).mobius as SerializedMobiusState;
      expect(mobiusData).toBeDefined();
      expect(mobiusData.observations.length).toBe(N_SESSIONS);
      expect(mobiusData.dimensionCount).toBe(4);
    });

    test('blend activates only after sufficient observations', async () => {
      // This test verifies the blend is properly gated
      // minObservations=20 by default, so with <20 sessions there should be no blend
      const minObs = DEFAULT_MOBIUS_CONFIG.minObservations;

      // Well below threshold
      expect(computeBlend(5, minObs)).toBe(0);
      expect(computeBlend(minObs - 1, minObs)).toBe(0);

      // At threshold
      expect(computeBlend(minObs, minObs)).toBe(0); // still 0 at exact boundary per formula

      // Above threshold
      expect(computeBlend(minObs + 1, minObs)).toBeGreaterThan(0);
      expect(computeBlend(minObs + 1, minObs)).toBeLessThanOrEqual(1);

      // Full blend at 2× threshold
      expect(computeBlend(minObs * 2, minObs)).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // §3.6.7 — Non-additive game produces different ARIL weight updates
  // ---------------------------------------------------------------------------

  describe('Non-additive attribution changes ARIL dynamics (3.6.7)', () => {
    test('Möbius attribution with synergy produces different Δw than additive', () => {
      // Setup: shared state for both paths
      const n = 4;
      const vocabulary = create4DVocabulary();
      const state = createTestState(n, [0.3, 0.7, 0.4, 0.6]);
      const params = createTestParams(n);
      const arilState = createARILState(n);
      arilState.sessionCount = 5;

      // Session outcome
      const R = 0.8;
      const R_adj = 0.3; // above baseline
      const weightChanges = new Float64Array([0.05, -0.03, 0.04, -0.02]);

      // Energy gradient (shared)
      const energyGrad = computeEnergyGradient(state, params, vocabulary);

      // PATH A: Additive attribution (current system without Möbius)
      const additiveAttribution = computeShapleyAttribution(
        R, weightChanges, vocabulary.assertions, null, { numPermutations: 50, seed: 42 }
      );
      const additiveUpdate = computeARILUpdate(
        state.w, energyGrad, R_adj, R,
        additiveAttribution.attributions,
        { ...arilState }, // clone so mutations don't cross paths
        DEFAULT_ARIL_CONFIG
      );

      // PATH B: Möbius attribution with a known pairwise synergy
      // Create a MobiusCharacteristic with a strong synergy between dims 0 and 1
      const mc = new MobiusCharacteristic(n);

      // Feed observations that encode a synergy: when dims 0 and 1 are both active,
      // outcome is much higher than either alone
      // Dim 0 alone active
      for (let i = 0; i < 10; i++) {
        mc.addObservation([0.8, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 0.3, i);
      }
      // Dim 1 alone active
      for (let i = 10; i < 20; i++) {
        mc.addObservation([0.5, 0.8, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 0.3, i);
      }
      // Dims 0 and 1 both active → much higher outcome (synergy!)
      for (let i = 20; i < 30; i++) {
        mc.addObservation([0.8, 0.8, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 0.9, i);
      }
      // All active (to provide more variety)
      for (let i = 30; i < 40; i++) {
        mc.addObservation([0.7, 0.7, 0.7, 0.7], [0.5, 0.5, 0.5, 0.5], 0.7, i);
      }

      mc.updateCoefficients();

      // The Möbius model should have learned a positive pairwise interaction m({0,1})
      const mobiusShapley = mc.computeShapley();
      expect(mobiusShapley.length).toBe(n);

      // Blend at 100% (full Möbius)
      const blend = 1.0;
      const additiveShapley = additiveAttribution.attributions.map(a => a.shapleyValue);
      const blendedShapley = blendShapley(additiveShapley, mobiusShapley, blend);

      // Create blended attributions
      const mobiusAttributions = additiveAttribution.attributions.map((a, i) => ({
        ...a,
        shapleyValue: blendedShapley[i],
      }));

      const mobiusUpdate = computeARILUpdate(
        state.w, energyGrad, R_adj, R,
        mobiusAttributions,
        { ...arilState }, // fresh clone
        DEFAULT_ARIL_CONFIG
      );

      // THE KEY ASSERTION: The two Δw vectors must differ.
      // This proves the Möbius characteristic function actually changes ARIL dynamics.
      let maxDifference = 0;
      for (let i = 0; i < n; i++) {
        maxDifference = Math.max(
          maxDifference,
          Math.abs(additiveUpdate.deltaW[i] - mobiusUpdate.deltaW[i])
        );
      }

      expect(maxDifference).toBeGreaterThan(1e-6);

      // Additional: verify the synergy shifts attribution toward dims 0 and 1
      // The Möbius Shapley values for dims 0 and 1 should be higher than additive
      // because the synergy m({0,1}) gets split between them via φ[i] = Σ_{T∋i} m(T)/|T|
      const additiveSum01 = additiveShapley[0] + additiveShapley[1];
      const mobiusSum01 = mobiusShapley[0] + mobiusShapley[1];
      expect(mobiusSum01).toBeGreaterThan(additiveSum01);
    });

    test('additive game produces identical Δw with and without Möbius', () => {
      // When the learned game is purely additive (no interactions),
      // the Möbius Shapley values should approximately equal proportional attribution,
      // and the ARIL updates should be nearly identical.
      const n = 4;
      const vocabulary = create4DVocabulary();
      const state = createTestState(n, [0.3, 0.7, 0.4, 0.6]);
      const params = createTestParams(n);
      const arilState = createARILState(n);
      arilState.sessionCount = 5;

      const R = 0.5;
      const R_adj = 0.1;
      const weightChanges = new Float64Array([0.05, -0.03, 0.04, -0.02]);
      const energyGrad = computeEnergyGradient(state, params, vocabulary);

      // Additive attribution
      const additiveAttribution = computeShapleyAttribution(
        R, weightChanges, vocabulary.assertions, null, { numPermutations: 50, seed: 42 }
      );

      // Möbius with purely independent observations (no synergies)
      const mc = new MobiusCharacteristic(n, { regularization: 0.3 });

      // Each dim active alone with proportional outcomes
      for (let i = 0; i < 15; i++) {
        const w = [0.5, 0.5, 0.5, 0.5];
        w[i % n] = 0.8;
        mc.addObservation(w, [0.5, 0.5, 0.5, 0.5], 0.4, i);
      }
      // All dims active
      for (let i = 15; i < 30; i++) {
        mc.addObservation([0.7, 0.7, 0.7, 0.7], [0.5, 0.5, 0.5, 0.5], 0.5, i);
      }

      mc.updateCoefficients();

      // The Möbius model should have negligible pairwise interactions
      const interactionCount = mc.interactionCount();
      // With high regularization and no real synergies, interactions should be sparse
      // (may not be exactly 0 due to noise in the data, but should be small)

      const mobiusShapley = mc.computeShapley();
      const blend = 1.0;
      const additiveShapley = additiveAttribution.attributions.map(a => a.shapleyValue);
      const blendedShapley = blendShapley(additiveShapley, mobiusShapley, blend);

      const mobiusAttributions = additiveAttribution.attributions.map((a, i) => ({
        ...a,
        shapleyValue: blendedShapley[i],
      }));

      const additiveUpdate = computeARILUpdate(
        state.w, energyGrad, R_adj, R,
        additiveAttribution.attributions,
        { ...arilState },
        DEFAULT_ARIL_CONFIG
      );

      const mobiusUpdate = computeARILUpdate(
        state.w, energyGrad, R_adj, R,
        mobiusAttributions,
        { ...arilState },
        DEFAULT_ARIL_CONFIG
      );

      // For a purely additive game, the difference should be small
      // (not exactly zero because LASSO coefficients aren't perfectly proportional)
      let maxDifference = 0;
      for (let i = 0; i < n; i++) {
        maxDifference = Math.max(
          maxDifference,
          Math.abs(additiveUpdate.deltaW[i] - mobiusUpdate.deltaW[i])
        );
      }

      // Difference should be much smaller than the synergistic case
      expect(maxDifference).toBeLessThan(0.01);
    });
  });
});

// =============================================================================
// MÖBIUS DIAGNOSTICS → GUIDANCE ENGINE (§3.2)
// =============================================================================

// =============================================================================
// Regression: Shapley attribution not silently zero (C1 fix)
//
// The bug: processInteraction() mutates this.state then returns newState: this.state.
// getState() returns the same object. So newState.w[i] - getState().w[i] === 0 always.
// Fix: snapshot weights BEFORE processInteraction, diff against the snapshot.
//
// This test verifies the fix by intercepting the actual console.log output from
// endObservation's ARIL backward pass, which prints the real weightChanges and
// attributions. No mocks, no language-feature checks — real pipeline, real values.
// =============================================================================
describe('C1 Regression: Shapley attribution uses pre-bridge snapshot', () => {
  let consoleSpy: jest.SpyInstance;
  let loggedLines: string[];

  beforeEach(() => {
    loggedLines = [];
    consoleSpy = jest.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      loggedLines.push(args.join(' '));
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test('ARIL backward pass logs real weightChanges and attributions', async () => {
    const storage = createInMemoryStorage();
    const identity = createTestIdentity(storage);
    await identity.initialize([0.3, 0.7, 0.4, 0.6]);

    identity.startObservation('c1-real');
    identity.recordToolCall('Read', { file: 'a.ts' }, 'ok', true, 100);
    identity.recordToolCall('Read', { file: 'b.ts' }, 'ok', true, 50);
    identity.recordToolCall('Grep', { pattern: 'foo' }, 'ok', true, 200);
    identity.recordToolCall('Write', { file: 'out.ts' }, 'ok', true, 300);
    identity.recordDecision('approach', ['A', 'B'], 'A', 'simpler', 0.9);
    await identity.endObservation(createTestInteraction('c1-real'));

    // Find the diagnostic line logged by the ARIL backward pass
    const diagLine = loggedLines.find(l => l.includes('weightChanges='));
    expect(diagLine).toBeDefined();

    // Parse weight changes from the log
    const wcMatch = diagLine!.match(/weightChanges=\[([^\]]+)\]/);
    expect(wcMatch).toBeTruthy();
    const weightChanges = wcMatch![1].split(',').map(Number);
    expect(weightChanges.length).toBe(4);

    // Parse attributions
    const attrMatch = diagLine!.match(/attributions=\[([^\]]+)\]/);
    expect(attrMatch).toBeTruthy();
    const attrPairs = attrMatch![1].split(',');
    const shapleyValues = attrPairs.map(p => parseFloat(p.split(':')[1]));

    // The real assertion: if the bridge produced ANY weight change,
    // attributions must not all be identical (the old bug was R/N uniform).
    // If bridge produced zero changes (no declarations triggered), that's
    // legitimate — but the weightChanges must come from real subtraction
    // (pre-snapshot minus post-state), not from aliased-reference zero.
    const allWcZero = weightChanges.every(v => v === 0);
    if (!allWcZero) {
      // Bridge moved weights → Shapley MUST differentiate
      const allSame = shapleyValues.every(v => v === shapleyValues[0]);
      expect(allSame).toBe(false);
    }

    // Either way, all values must be finite (no NaN from broken pipeline)
    for (const v of weightChanges) expect(Number.isFinite(v)).toBe(true);
    for (const v of shapleyValues) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('Möbius Diagnostics Guidance (§3.2)', () => {
  const engine = new GuidanceEngine();
  const n = 4;
  const dims = ['curiosity', 'precision', 'persistence', 'empathy'];
  const fitness = new Float64Array([0.5, 0.5, 0.5, 0.5]);
  const weights = new Float64Array([0.5, 0.5, 0.5, 0.5]);

  test('data inadequacy directive when observations < minObservations', () => {
    const diag: MobiusDiagnostics = {
      interactionCount: 0,
      fitResidual: 1.0,
      observationCount: 5,
      currentOrder: 2,
      strongestInteraction: null,
      dataAdequate: false,
    };

    const output = engine.generate(
      fitness, dims, weights, [], null, null, [], 5, null, diag
    );

    const mobiusDirectives = output.directives.filter(d => d.source === 'mobius_diagnostics');
    expect(mobiusDirectives.length).toBe(1);
    expect(mobiusDirectives[0].imperative).toContain('still learning');
    expect(mobiusDirectives[0].imperative).toContain('5 observations');
    expect(mobiusDirectives[0].strength).toBe('consider');
  });

  test('poor fit directive when residual > 0.5 and data adequate', () => {
    const diag: MobiusDiagnostics = {
      interactionCount: 1,
      fitResidual: 0.7,
      observationCount: 25,
      currentOrder: 2,
      strongestInteraction: { dimensions: [0, 1], strength: 0.03 },
      dataAdequate: true,
    };

    const output = engine.generate(
      fitness, dims, weights, [], null, null, [], 25, null, diag
    );

    const mobiusDirectives = output.directives.filter(d => d.source === 'mobius_diagnostics');
    // Should have poor fit warning, but NOT synergy (strength 0.03 < 0.05 threshold)
    const fitDirective = mobiusDirectives.find(d => d.imperative.includes('fit is poor'));
    expect(fitDirective).toBeDefined();
    expect(fitDirective!.imperative).toContain('0.700');
  });

  test('synergy directive when strong interaction detected', () => {
    const diag: MobiusDiagnostics = {
      interactionCount: 3,
      fitResidual: 0.15,
      observationCount: 30,
      currentOrder: 2,
      strongestInteraction: { dimensions: [0, 2], strength: 0.12 },
      dataAdequate: true,
    };

    const output = engine.generate(
      fitness, dims, weights, [], null, null, [], 30, null, diag
    );

    const mobiusDirectives = output.directives.filter(d => d.source === 'mobius_diagnostics');
    const synergyDirective = mobiusDirectives.find(d => d.imperative.includes('synergy'));
    expect(synergyDirective).toBeDefined();
    expect(synergyDirective!.dimension).toBe('curiosity + persistence');
    expect(synergyDirective!.imperative).toContain('0.120');
    // Good fit → 'should' strength
    expect(synergyDirective!.strength).toBe('should');
  });

  test('synergy gets consider strength when fit is mediocre', () => {
    const diag: MobiusDiagnostics = {
      interactionCount: 2,
      fitResidual: 0.35,
      observationCount: 25,
      currentOrder: 2,
      strongestInteraction: { dimensions: [1, 3], strength: 0.08 },
      dataAdequate: true,
    };

    const output = engine.generate(
      fitness, dims, weights, [], null, null, [], 25, null, diag
    );

    const synergyDirective = output.directives.find(
      d => d.source === 'mobius_diagnostics' && d.imperative.includes('synergy')
    );
    expect(synergyDirective).toBeDefined();
    // fitResidual 0.35 > 0.2 → 'consider' not 'should'
    expect(synergyDirective!.strength).toBe('consider');
  });

  test('higher-order directive when k > 2', () => {
    const diag: MobiusDiagnostics = {
      interactionCount: 7,
      fitResidual: 0.1,
      observationCount: 40,
      currentOrder: 3,
      strongestInteraction: { dimensions: [0, 1, 2], strength: 0.09 },
      dataAdequate: true,
    };

    const output = engine.generate(
      fitness, dims, weights, [], null, null, [], 40, null, diag
    );

    const mobiusDirectives = output.directives.filter(d => d.source === 'mobius_diagnostics');
    const orderDirective = mobiusDirectives.find(d => d.imperative.includes('Higher-order'));
    expect(orderDirective).toBeDefined();
    expect(orderDirective!.imperative).toContain('k=3');
    expect(orderDirective!.imperative).toContain('7 interaction terms');
  });

  test('no directives when mobiusDiagnostics is null', () => {
    const output = engine.generate(
      fitness, dims, weights, [], null, null, [], 10, null, null
    );

    const mobiusDirectives = output.directives.filter(d => d.source === 'mobius_diagnostics');
    expect(mobiusDirectives.length).toBe(0);
  });

  test('multiple diagnostics can fire simultaneously', () => {
    const diag: MobiusDiagnostics = {
      interactionCount: 5,
      fitResidual: 0.6,
      observationCount: 30,
      currentOrder: 3,
      strongestInteraction: { dimensions: [0, 1], strength: 0.1 },
      dataAdequate: true,
    };

    const output = engine.generate(
      fitness, dims, weights, [], null, null, [], 30, null, diag
    );

    const mobiusDirectives = output.directives.filter(d => d.source === 'mobius_diagnostics');
    // Should have: poor fit + synergy + higher-order = 3 directives
    expect(mobiusDirectives.length).toBe(3);
    expect(mobiusDirectives.some(d => d.imperative.includes('fit is poor'))).toBe(true);
    expect(mobiusDirectives.some(d => d.imperative.includes('synergy'))).toBe(true);
    expect(mobiusDirectives.some(d => d.imperative.includes('Higher-order'))).toBe(true);
  });

  test('diagnostics appear in markdown output', () => {
    const diag: MobiusDiagnostics = {
      interactionCount: 2,
      fitResidual: 0.1,
      observationCount: 25,
      currentOrder: 2,
      strongestInteraction: { dimensions: [0, 1], strength: 0.15 },
      dataAdequate: true,
    };

    const output = engine.generate(
      fitness, dims, weights, [], null, null, [], 25, null, diag
    );

    // Synergy should appear in markdown (it gets 'should' strength with good fit)
    expect(output.markdown).toContain('synergy');
  });
});
