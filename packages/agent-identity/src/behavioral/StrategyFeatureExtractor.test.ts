/**
 * StrategyFeatureExtractor.test.ts
 *
 * Tests for the v2 strategy feature extraction from tool-call sequences.
 */

import {
  extractStrategyFeatures,
  computeReadBeforeEdit,
  computeTestAfterChange,
  computeContextGathering,
  computeOutputVerification,
  computeErrorRecoverySpeed,
  featuresToArray,
  arrayToFeatures,
  normalizePath,
  extractFilePath,
  isTestCommand,
  DEFAULT_STRATEGY_FEATURE_CONFIG,
  STRATEGY_FEATURE_NAMES,
  type StrategyFeatures,
  type StrategyFeatureConfig,
} from './StrategyFeatureExtractor';
import type { ToolCall, ActionLog } from './BehavioralObserver';

// =============================================================================
// HELPERS
// =============================================================================

let callId = 0;

function makeCall(overrides: Partial<ToolCall> & { tool: string }): ToolCall {
  return {
    id: `call-${callId++}`,
    timestamp: Date.now(),
    tool: overrides.tool,
    args: overrides.args ?? {},
    result: overrides.result ?? '',
    success: overrides.success ?? true,
    durationMs: overrides.durationMs ?? 100,
    wasRequired: overrides.wasRequired ?? true,
    context: overrides.context ?? '',
  };
}

function makeLog(calls: ToolCall[]): ActionLog {
  return {
    interactionId: `session-${Date.now()}`,
    startTime: Date.now() - 60000,
    endTime: Date.now(),
    toolCalls: calls,
    decisions: [],
    failures: [],
    informationSeeks: [],
    verifications: [],
    resourceUsage: {
      tokensUsed: 0,
      toolCallCount: calls.length,
      wallTimeMs: 60000,
      apiCalls: 0,
      retriesTotal: 0,
    },
  };
}

function read(filePath: string): ToolCall {
  return makeCall({ tool: 'Read', args: { file_path: filePath } });
}

function write(filePath: string): ToolCall {
  return makeCall({ tool: 'Write', args: { file_path: filePath } });
}

function edit(filePath: string): ToolCall {
  return makeCall({ tool: 'Edit', args: { file_path: filePath } });
}

function grep(pattern: string, path?: string): ToolCall {
  return makeCall({ tool: 'Grep', args: { pattern, ...(path ? { path } : {}) } });
}

function glob(pattern: string): ToolCall {
  return makeCall({ tool: 'Glob', args: { pattern } });
}

function bash(command: string, success = true): ToolCall {
  return makeCall({ tool: 'Bash', args: { command }, success });
}

// =============================================================================
// PATH NORMALIZATION
// =============================================================================

describe('normalizePath', () => {
  test('converts backslashes to forward slashes', () => {
    expect(normalizePath('C:\\Users\\foo\\bar.ts')).toBe('C:/Users/foo/bar.ts');
  });

  test('strips leading ./', () => {
    expect(normalizePath('./src/foo.ts')).toBe('src/foo.ts');
  });

  test('strips trailing slashes', () => {
    expect(normalizePath('src/foo/')).toBe('src/foo');
  });

  test('collapses consecutive slashes', () => {
    expect(normalizePath('src//foo///bar.ts')).toBe('src/foo/bar.ts');
  });

  test('handles already-normalized paths', () => {
    expect(normalizePath('src/foo.ts')).toBe('src/foo.ts');
  });
});

describe('extractFilePath', () => {
  test('extracts file_path from Read args', () => {
    expect(extractFilePath('Read', { file_path: './src/foo.ts' })).toBe('src/foo.ts');
  });

  test('extracts file_path from Write args', () => {
    expect(extractFilePath('Write', { file_path: 'C:\\src\\bar.ts' })).toBe('C:/src/bar.ts');
  });

  test('returns null for Glob (no file_path)', () => {
    expect(extractFilePath('Glob', { pattern: '**/*.ts' })).toBeNull();
  });

  test('returns null for Bash (no file_path)', () => {
    expect(extractFilePath('Bash', { command: 'npm test' })).toBeNull();
  });

  test('returns null when file_path is not a string', () => {
    expect(extractFilePath('Read', { file_path: 123 })).toBeNull();
  });
});

// =============================================================================
// TEST DETECTION
// =============================================================================

describe('isTestCommand', () => {
  const patterns = DEFAULT_STRATEGY_FEATURE_CONFIG.testPatterns;

  test.each([
    ['npm test', true],
    ['npm run test', true],
    ['npx jest', true],
    ['npx vitest', true],
    ['npx mocha', true],
    ['jest --coverage', true],
    ['pytest -v', true],
    ['cargo test', true],
    ['go test ./...', true],
    ['make test', true],
    ['dotnet test', true],
    ['npm run build', false],
    ['echo "test"', false],
    ['ls -la', false],
    ['git status', false],
  ])('"%s" → %s', (command, expected) => {
    expect(isTestCommand({ command }, patterns)).toBe(expected);
  });
});

// =============================================================================
// read_before_edit
// =============================================================================

describe('computeReadBeforeEdit', () => {
  test('returns 0 for empty session', () => {
    expect(computeReadBeforeEdit([])).toBe(0);
  });

  test('returns 0 when no edits', () => {
    const calls = [read('foo.ts'), grep('bar'), glob('*.ts')];
    expect(computeReadBeforeEdit(calls)).toBe(0);
  });

  test('returns 1.0 when all edits have prior reads', () => {
    const calls = [
      read('foo.ts'),
      edit('foo.ts'),
      read('bar.ts'),
      write('bar.ts'),
    ];
    expect(computeReadBeforeEdit(calls)).toBe(1.0);
  });

  test('returns 0 when no edits have prior reads', () => {
    const calls = [
      edit('foo.ts'),
      write('bar.ts'),
    ];
    expect(computeReadBeforeEdit(calls)).toBe(0);
  });

  test('returns correct ratio for mixed reads/no-reads', () => {
    const calls = [
      read('foo.ts'),
      edit('foo.ts'),  // has prior read
      write('bar.ts'), // no prior read
    ];
    expect(computeReadBeforeEdit(calls)).toBe(0.5);
  });

  test('handles path normalization (backslashes match forward slashes)', () => {
    const calls = [
      read('C:\\Users\\foo\\bar.ts'),
      edit('C:/Users/foo/bar.ts'),
    ];
    expect(computeReadBeforeEdit(calls)).toBe(1.0);
  });

  test('handles path normalization (leading ./)', () => {
    const calls = [
      read('./src/foo.ts'),
      edit('src/foo.ts'),
    ];
    expect(computeReadBeforeEdit(calls)).toBe(1.0);
  });

  test('Grep counts as a read for the same file path', () => {
    const calls = [
      makeCall({ tool: 'Grep', args: { pattern: 'foo', file_path: 'src/bar.ts' } }),
      edit('src/bar.ts'),
    ];
    // Grep has file_path in args (via extractFilePath), counts as reading that file
    expect(computeReadBeforeEdit(calls)).toBe(1.0);
  });

  test('read after edit does not count (order matters)', () => {
    const calls = [
      edit('foo.ts'),
      read('foo.ts'),
    ];
    expect(computeReadBeforeEdit(calls)).toBe(0);
  });

  test('one read covers multiple edits to the same file', () => {
    const calls = [
      read('foo.ts'),
      edit('foo.ts'),
      edit('foo.ts'),
      edit('foo.ts'),
    ];
    expect(computeReadBeforeEdit(calls)).toBe(1.0);
  });
});

// =============================================================================
// test_after_change
// =============================================================================

describe('computeTestAfterChange', () => {
  test('returns 0 for empty session', () => {
    expect(computeTestAfterChange([])).toBe(0);
  });

  test('returns 0 when no edits', () => {
    const calls = [read('foo.ts'), bash('npm test')];
    expect(computeTestAfterChange(calls)).toBe(0);
  });

  test('returns 1.0 when all edits are followed by tests', () => {
    const calls = [
      edit('foo.ts'),
      bash('npm test'),
      write('bar.ts'),
      bash('jest'),
    ];
    expect(computeTestAfterChange(calls)).toBe(1.0);
  });

  test('returns 0 when no edits are followed by tests', () => {
    const calls = [
      edit('foo.ts'),
      read('bar.ts'),
      write('baz.ts'),
      bash('git status'),
    ];
    expect(computeTestAfterChange(calls)).toBe(0);
  });

  test('test must be within lookAhead window', () => {
    const config: StrategyFeatureConfig = {
      ...DEFAULT_STRATEGY_FEATURE_CONFIG,
      testLookAhead: 2,
    };
    const calls = [
      edit('foo.ts'),
      read('a.ts'),
      read('b.ts'),
      bash('npm test'), // 3 calls after edit — outside window of 2
    ];
    expect(computeTestAfterChange(calls, config)).toBe(0);
  });

  test('test within lookAhead window counts', () => {
    const config: StrategyFeatureConfig = {
      ...DEFAULT_STRATEGY_FEATURE_CONFIG,
      testLookAhead: 3,
    };
    const calls = [
      edit('foo.ts'),
      read('a.ts'),
      read('b.ts'),
      bash('npm test'), // 3 calls after edit — within window of 3
    ];
    expect(computeTestAfterChange(calls, config)).toBe(1.0);
  });

  test('one test covers only the nearest preceding edit', () => {
    // Each edit is checked independently — the test at index 3
    // is within lookAhead of both edits (indices 0 and 2)
    const calls = [
      edit('foo.ts'),     // 0 — test is 3 calls away
      read('a.ts'),       // 1
      edit('bar.ts'),     // 2 — test is 1 call away
      bash('npm test'),   // 3
    ];
    // Default lookAhead=5, so both edits have a test within range
    expect(computeTestAfterChange(calls)).toBe(1.0);
  });

  test('mixed: some edits followed by test, some not', () => {
    const calls = [
      edit('foo.ts'),
      bash('npm test'),  // follows foo edit
      edit('bar.ts'),
      bash('git push'),  // not a test
    ];
    expect(computeTestAfterChange(calls)).toBe(0.5);
  });
});

// =============================================================================
// context_gathering
// =============================================================================

describe('computeContextGathering', () => {
  test('returns 0 for empty session', () => {
    expect(computeContextGathering([])).toBe(0);
  });

  test('returns 1.0 when first third is all context tools', () => {
    const calls = [
      read('foo.ts'),
      grep('bar'),
      glob('*.ts'),
      edit('foo.ts'),
      bash('npm test'),
      write('out.ts'),
    ];
    // First third = ceil(6/3) = 2 calls: [Read, Grep] — both are context tools
    expect(computeContextGathering(calls)).toBe(1.0);
  });

  test('returns 0 when first third has no context tools', () => {
    const calls = [
      edit('foo.ts'),
      bash('npm test'),
      write('bar.ts'),
      read('baz.ts'),
      grep('qux'),
      glob('*.ts'),
    ];
    // First third = 2 calls: [Edit, Bash] — neither is context
    expect(computeContextGathering(calls)).toBe(0);
  });

  test('returns correct ratio for mixed first third', () => {
    const calls = [
      read('foo.ts'),
      bash('ls'),
      glob('*.ts'),
      edit('foo.ts'),
      write('bar.ts'),
      bash('npm test'),
    ];
    // First third = 2: [Read, Bash] — 1/2 = 0.5
    expect(computeContextGathering(calls)).toBe(0.5);
  });

  test('single call session: first third = 1 call', () => {
    const calls = [read('foo.ts')];
    // ceil(1/3) = 1 call → Read = context → 1.0
    expect(computeContextGathering(calls)).toBe(1.0);
  });

  test('two call session: first third = 1 call', () => {
    const calls = [bash('ls'), read('foo.ts')];
    // ceil(2/3) = 1 → [Bash] → 0/1 = 0
    expect(computeContextGathering(calls)).toBe(0);
  });
});

// =============================================================================
// output_verification
// =============================================================================

describe('computeOutputVerification', () => {
  test('returns 0 for empty session', () => {
    expect(computeOutputVerification([])).toBe(0);
  });

  test('returns 0 when no writes', () => {
    const calls = [read('foo.ts'), edit('foo.ts'), bash('npm test')];
    expect(computeOutputVerification(calls)).toBe(0);
  });

  test('returns 1.0 when all writes are verified', () => {
    const calls = [
      write('foo.ts'),
      read('foo.ts'),
      write('bar.ts'),
      read('bar.ts'),
    ];
    expect(computeOutputVerification(calls)).toBe(1.0);
  });

  test('returns 0 when no writes are verified', () => {
    const calls = [
      write('foo.ts'),
      write('bar.ts'),
      bash('npm test'),
    ];
    expect(computeOutputVerification(calls)).toBe(0);
  });

  test('returns correct ratio for mixed verification', () => {
    const calls = [
      write('foo.ts'),
      read('foo.ts'),   // verifies foo
      write('bar.ts'),  // no read of bar after
    ];
    expect(computeOutputVerification(calls)).toBe(0.5);
  });

  test('only counts Write, not Edit', () => {
    const calls = [
      edit('foo.ts'),
      read('foo.ts'),
    ];
    // Edit is not counted for output_verification
    expect(computeOutputVerification(calls)).toBe(0);
  });

  test('path normalization works', () => {
    const calls = [
      write('C:\\foo\\bar.ts'),
      read('C:/foo/bar.ts'),
    ];
    expect(computeOutputVerification(calls)).toBe(1.0);
  });

  test('read before write does not count (order matters)', () => {
    const calls = [
      read('foo.ts'),
      write('foo.ts'),
    ];
    expect(computeOutputVerification(calls)).toBe(0);
  });

  test('read of different file does not count', () => {
    const calls = [
      write('foo.ts'),
      read('bar.ts'),
    ];
    expect(computeOutputVerification(calls)).toBe(0);
  });
});

// =============================================================================
// error_recovery_speed
// =============================================================================

describe('computeErrorRecoverySpeed', () => {
  test('returns 1.0 for no errors (perfect)', () => {
    const calls = [
      bash('npm test', true),
      bash('npm run build', true),
    ];
    expect(computeErrorRecoverySpeed(calls)).toBe(1.0);
  });

  test('returns 1.0 for empty session', () => {
    expect(computeErrorRecoverySpeed([])).toBe(1.0);
  });

  test('returns 1.0 for immediate recovery (1 call)', () => {
    const calls = [
      bash('npm test', false),
      bash('npm test', true),  // 1 call to recover
    ];
    expect(computeErrorRecoverySpeed(calls)).toBe(1.0);
  });

  test('returns 0.5 for 2-call recovery', () => {
    const calls = [
      bash('npm test', false),
      read('foo.ts'),          // 1
      bash('npm test', true),  // 2 calls to recover
    ];
    expect(computeErrorRecoverySpeed(calls)).toBe(0.5);
  });

  test('returns 0 for unrecovered failure', () => {
    const config = { ...DEFAULT_STRATEGY_FEATURE_CONFIG, recoverySpeedCap: 20 };
    const calls = [
      bash('npm test', false),
      read('foo.ts'),
      // Session ends — never recovered
    ];
    // Should record cap (20), then 1/20 = 0.05
    expect(computeErrorRecoverySpeed(calls, config)).toBeCloseTo(0.05, 5);
  });

  test('averages multiple recoveries', () => {
    const calls = [
      bash('fail1', false),
      bash('fix1', true),      // 1 call
      bash('fail2', false),
      read('a.ts'),
      edit('a.ts'),
      bash('fix2', true),      // 3 calls
    ];
    // Mean = (1 + 3) / 2 = 2 → 1/2 = 0.5
    expect(computeErrorRecoverySpeed(calls)).toBe(0.5);
  });

  test('consecutive failures: previous failure capped, new one starts fresh', () => {
    const config = { ...DEFAULT_STRATEGY_FEATURE_CONFIG, recoverySpeedCap: 10 };
    const calls = [
      bash('fail1', false),
      read('a.ts'),
      bash('fail2', false),    // fail1 never recovered (capped at 10)
      bash('fix', true),       // fail2 recovered in 1 call
    ];
    // Recoveries: [10, 1] → mean = 5.5 → 1/5.5 ≈ 0.1818
    expect(computeErrorRecoverySpeed(calls, config)).toBeCloseTo(1 / 5.5, 5);
  });

  test('non-Bash calls do not affect recovery tracking', () => {
    const calls = [
      bash('npm test', false),
      read('foo.ts'),
      edit('foo.ts'),
      write('foo.ts'),
      bash('npm test', true), // 4 calls to recover
    ];
    expect(computeErrorRecoverySpeed(calls)).toBe(0.25);
  });
});

// =============================================================================
// FULL EXTRACTION
// =============================================================================

describe('extractStrategyFeatures', () => {
  test('empty session returns all zeros/defaults', () => {
    const log = makeLog([]);
    const features = extractStrategyFeatures(log);
    expect(features.readBeforeEdit).toBe(0);
    expect(features.testAfterChange).toBe(0);
    expect(features.contextGathering).toBe(0);
    expect(features.outputVerification).toBe(0);
    expect(features.errorRecoverySpeed).toBe(1.0); // no errors = perfect
  });

  test('ideal session: read, edit, test, verify', () => {
    const calls = [
      // Context gathering phase (indices 0-2)
      grep('TODO'),
      glob('**/*.ts'),
      read('src/main.ts'),
      // Edit with prior read (index 3)
      edit('src/main.ts'),
      // Test after change (index 4)
      bash('npm test'),
      // Write with prior read (indices 5-6)
      read('src/output.ts'),
      write('src/output.ts'),
      // Test after write (index 7)
      bash('npm test'),
      // Verify output (index 8)
      read('src/output.ts'),
    ];
    const log = makeLog(calls);
    const features = extractStrategyFeatures(log);

    expect(features.readBeforeEdit).toBe(1.0);      // both edit + write had prior reads
    expect(features.testAfterChange).toBe(1.0);      // test after both edit and write
    expect(features.contextGathering).toBe(1.0);     // first third (3 calls) is all context
    expect(features.outputVerification).toBe(1.0);   // read output.ts after writing it
    expect(features.errorRecoverySpeed).toBe(1.0);   // no errors
  });

  test('careless session: no reading, no testing, no verification', () => {
    const calls = [
      edit('src/main.ts'),     // no prior read
      write('src/output.ts'),  // no verification
      bash('git push'),        // not a test
    ];
    const log = makeLog(calls);
    const features = extractStrategyFeatures(log);

    expect(features.readBeforeEdit).toBe(0);
    expect(features.testAfterChange).toBe(0);
    expect(features.contextGathering).toBe(0);
    expect(features.outputVerification).toBe(0);
    expect(features.errorRecoverySpeed).toBe(1.0); // no errors at least
  });

  test('debugging session: errors and recovery', () => {
    const calls = [
      read('src/bug.ts'),
      edit('src/bug.ts'),
      bash('npm test', false),  // test fails
      read('src/bug.ts'),       // investigate
      edit('src/bug.ts'),
      bash('npm test', true),   // fixed! 3 calls to recover
    ];
    const log = makeLog(calls);
    const features = extractStrategyFeatures(log);

    expect(features.readBeforeEdit).toBe(1.0);          // both edits had prior reads
    expect(features.testAfterChange).toBe(1.0);          // both edits followed by test
    expect(features.errorRecoverySpeed).toBeCloseTo(1/3, 5); // 3 calls to recover
  });
});

// =============================================================================
// CONVERSION UTILITIES
// =============================================================================

describe('featuresToArray / arrayToFeatures', () => {
  test('round-trips correctly', () => {
    const features: StrategyFeatures = {
      readBeforeEdit: 0.8,
      testAfterChange: 0.6,
      contextGathering: 0.9,
      outputVerification: 0.3,
      errorRecoverySpeed: 0.5,
    };
    const arr = featuresToArray(features);
    expect(arr).toEqual([0.8, 0.6, 0.9, 0.3, 0.5]);

    const back = arrayToFeatures(arr);
    expect(back).toEqual(features);
  });

  test('arrayToFeatures throws on too-short array', () => {
    expect(() => arrayToFeatures([0.1, 0.2])).toThrow('Expected at least 5');
  });

  test('featuresToArray matches STRATEGY_FEATURE_NAMES order', () => {
    expect(STRATEGY_FEATURE_NAMES).toEqual([
      'read_before_edit',
      'test_after_change',
      'context_gathering',
      'output_verification',
      'error_recovery_speed',
    ]);
    // Index 0 = read_before_edit = readBeforeEdit, etc.
    const features: StrategyFeatures = {
      readBeforeEdit: 0.1,
      testAfterChange: 0.2,
      contextGathering: 0.3,
      outputVerification: 0.4,
      errorRecoverySpeed: 0.5,
    };
    const arr = featuresToArray(features);
    expect(arr[0]).toBe(0.1); // read_before_edit
    expect(arr[1]).toBe(0.2); // test_after_change
    expect(arr[2]).toBe(0.3); // context_gathering
    expect(arr[3]).toBe(0.4); // output_verification
    expect(arr[4]).toBe(0.5); // error_recovery_speed
  });
});

// =============================================================================
// STRATEGY_FEATURE_NAMES
// =============================================================================

describe('STRATEGY_FEATURE_NAMES', () => {
  test('has 5 features', () => {
    expect(STRATEGY_FEATURE_NAMES).toHaveLength(5);
  });

  test('matches N=5 for Möbius', () => {
    // This is the N that Möbius will use for order-2 truncated coalitions
    // N=5, maxOrder=2 → 16 parameters (tested in MobiusCharacteristic.test.ts)
    expect(STRATEGY_FEATURE_NAMES.length).toBe(5);
  });
});
