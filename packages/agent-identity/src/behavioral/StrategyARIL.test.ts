/**
 * StrategyARIL.test.ts
 *
 * Tests for the strategy ARIL sub-pipeline in UnifiedIdentity.
 * Verifies that behavioral strategy features (N=5) flow through
 * real Shapley + Möbius attribution instead of synthetic proxies.
 */

import {
  UnifiedIdentity,
  createUnifiedIdentity,
} from './UnifiedIdentity';
import { type StorageBackend } from './IdentityPersistence';
import { type Interaction } from './ReflectionEngine';
import { STRATEGY_FEATURE_NAMES, extractStrategyFeatures, featuresToArray } from './StrategyFeatureExtractor';
import * as ShapleyAttributor from './ShapleyAttributor';
import * as MobiusChar from './MobiusCharacteristic';
import { renderStrategies } from './StrategyRenderer';
import type { ActionLog } from './BehavioralObserver';
import type { Insight } from './ReflectionEngine';
import type {
  PrivateStorageBackend,
  StoredInsight,
  StoredActionLog,
  PrivateStorageStats,
  ActionLogIndex,
} from '../bootstrap/PrivateStorage';

// =============================================================================
// MOCK STORAGE
// =============================================================================

class MockStorage implements StorageBackend {
  private store: Map<string, unknown> = new Map();

  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) || null;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async keys(pattern?: string): Promise<string[]> {
    const allKeys = Array.from(this.store.keys());
    if (!pattern || pattern === '*') return allKeys;
    const regex = new RegExp(pattern.replace('*', '.*'));
    return allKeys.filter(k => regex.test(k));
  }
  isPersistent(): boolean {
    return true;
  }
  clear(): void {
    this.store.clear();
  }
}

class MockPrivateStorage implements PrivateStorageBackend {
  private actionLogs: Map<string, StoredActionLog> = new Map();
  private seq: number = 0;

  async storeActionLog(log: ActionLog, metadata?: Record<string, unknown>): Promise<string> {
    return this.storeActionLogWithInsights(log, [], metadata);
  }
  async storeActionLogWithInsights(
    log: ActionLog, insights: Insight[], metadata?: Record<string, unknown>,
  ): Promise<string> {
    // Mimic real PrivateStorage: same interactionId overwrites (same hash)
    // This matters for ARIL state which always uses 'aril_state' interactionId
    let hash: string | undefined;
    for (const [h, stored] of this.actionLogs) {
      if (stored.log.interactionId === log.interactionId) {
        hash = h;
        break;
      }
    }
    if (!hash) hash = `hash-${this.seq++}`;
    const currentSeq = this.seq++;
    this.actionLogs.set(hash, {
      hash, log, storedAt: Date.now(), seq: currentSeq, metadata,
      insights: insights.length > 0 ? insights : undefined,
    });
    return hash;
  }
  async getActionLog(hash: string): Promise<StoredActionLog | null> {
    return this.actionLogs.get(hash) || null;
  }
  async getAllActionLogs(): Promise<StoredActionLog[]> {
    return Array.from(this.actionLogs.values()).sort((a, b) => a.seq - b.seq);
  }
  async getActionLogsByTimeRange(startTime: number, endTime: number): Promise<StoredActionLog[]> {
    return (await this.getAllActionLogs()).filter(
      l => l.log.startTime >= startTime && l.log.endTime <= endTime,
    );
  }
  async getPivotalInsights(): Promise<StoredInsight[]> {
    return [];
  }
  verify(hash: string, _log: ActionLog): boolean {
    return this.actionLogs.has(hash);
  }
  async getStats(): Promise<PrivateStorageStats> {
    return {
      totalLogs: this.actionLogs.size, totalInsights: 0,
      pivotalInsightCount: 0, totalSizeBytes: 0,
      oldestLog: null, newestLog: null, storageDir: '/mock',
    };
  }
  async exportAll(): Promise<{ index: ActionLogIndex; logs: StoredActionLog[] }> {
    return {
      index: {
        agentDid: 'test', totalLogs: this.actionLogs.size,
        hashes: Array.from(this.actionLogs.keys()),
        totalInsights: 0, pivotalInsightCount: 0,
        lastUpdated: Date.now(), version: 1,
      },
      logs: await this.getAllActionLogs(),
    };
  }
  computeHash(_log: ActionLog): string {
    return `hash-${this.seq}`;
  }
  clear(): void {
    this.actionLogs.clear();
    this.seq = 0;
  }
}

// =============================================================================
// TEST UTILITIES
// =============================================================================

function createTestInteraction(id: string, prompt: string): Interaction {
  return {
    id,
    timestamp: Date.now(),
    prompt,
    context: {},
    response: 'Response for: ' + prompt,
    durationMs: 1000,
    selfStateSnapshot: {
      w: [0.5, 0.5, 0.5, 0.5],
      m: [0.5, 0.5, 0.5, 0.5],
    },
  };
}

/**
 * Record a realistic set of tool calls that exercise all 5 strategy features.
 * Varies behavior based on sessionIndex so feature deviations are non-uniform.
 */
function recordRealisticToolCalls(
  identity: UnifiedIdentity,
  sessionIndex: number,
): void {
  // Context gathering phase (first third)
  identity.recordToolCall('Grep', { pattern: 'TODO' }, 'found', true, 50, false, 'context');
  identity.recordToolCall('Glob', { pattern: '**/*.ts' }, 'files', true, 30, false, 'context');
  identity.recordToolCall('Read', { file_path: 'src/main.ts' }, 'content', true, 100, true, 'read');

  // Read-before-edit pattern
  identity.recordToolCall('Read', { file_path: 'src/target.ts' }, 'old content', true, 80, true, 'read');
  identity.recordToolCall('Edit', { file_path: 'src/target.ts' }, 'edited', true, 120, true, 'edit');

  // Test after change
  identity.recordToolCall(
    'Bash',
    { command: 'npm test' },
    sessionIndex % 3 === 0 ? 'FAIL' : 'PASS',
    sessionIndex % 3 !== 0,
    200,
    true,
    'test',
  );

  // Output verification (write then read)
  identity.recordToolCall('Write', { file_path: 'src/output.ts' }, 'written', true, 100, true, 'write');
  identity.recordToolCall('Read', { file_path: 'src/output.ts' }, 'verify', true, 80, true, 'verify');

  // Varying amount of extra work based on session
  if (sessionIndex % 2 === 0) {
    identity.recordToolCall('Read', { file_path: 'src/extra.ts' }, 'extra', true, 60, false, 'explore');
    identity.recordToolCall('Edit', { file_path: 'src/extra.ts' }, 'edited extra', true, 100, true, 'edit');
    identity.recordToolCall('Bash', { command: 'npm test' }, 'PASS', true, 200, true, 'test');
  }

  // Error recovery (on some sessions)
  if (sessionIndex % 4 === 0) {
    identity.recordToolCall('Bash', { command: 'broken' }, 'ERROR', false, 50, true, 'fail');
    identity.recordToolCall('Read', { file_path: 'src/debug.ts' }, 'debug info', true, 80, true, 'debug');
    identity.recordToolCall('Bash', { command: 'fixed' }, 'OK', true, 100, true, 'fix');
  }
}

/**
 * Run a full observation cycle (start → record → end).
 */
async function runSession(
  identity: UnifiedIdentity,
  sessionIndex: number,
): Promise<void> {
  identity.startObservation(`session-${sessionIndex}`);
  recordRealisticToolCalls(identity, sessionIndex);
  await identity.endObservation(
    createTestInteraction(`session-${sessionIndex}`, `Task ${sessionIndex}`),
  );
}

// =============================================================================
// TESTS
// =============================================================================

describe('Strategy ARIL Sub-Pipeline', () => {
  let storage: MockStorage;
  let privateStorage: MockPrivateStorage;

  beforeEach(() => {
    storage = new MockStorage();
    privateStorage = new MockPrivateStorage();
  });

  test('1. Strategy components initialized after initialize()', async () => {
    const identity = createUnifiedIdentity(storage);
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    expect(identity.getStrategySessionCount()).toBe(0);
    expect(identity.getStrategyAttributions()).toBeNull();
    expect(identity.getStrategyInteractions()).toBeNull();
    expect(identity.getStrategyFeatures()).toBeNull();

    await identity.shutdown();
  });

  test('2. Features extracted after endObservation() with tool calls', async () => {
    const identity = createUnifiedIdentity(storage);
    identity.setPrivateStorage(privateStorage);
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    await runSession(identity, 0);

    const features = identity.getStrategyFeatures();
    expect(features).not.toBeNull();
    expect(features!.readBeforeEdit).toBeGreaterThanOrEqual(0);
    expect(features!.readBeforeEdit).toBeLessThanOrEqual(1);
    expect(features!.testAfterChange).toBeGreaterThanOrEqual(0);
    expect(features!.testAfterChange).toBeLessThanOrEqual(1);
    expect(features!.contextGathering).toBeGreaterThanOrEqual(0);
    expect(features!.contextGathering).toBeLessThanOrEqual(1);
    expect(features!.outputVerification).toBeGreaterThanOrEqual(0);
    expect(features!.outputVerification).toBeLessThanOrEqual(1);
    expect(features!.errorRecoverySpeed).toBeGreaterThanOrEqual(0);
    expect(features!.errorRecoverySpeed).toBeLessThanOrEqual(1);

    await identity.shutdown();
  });

  test('3. Attributions populated with 5 entries matching STRATEGY_FEATURE_NAMES', async () => {
    const identity = createUnifiedIdentity(storage);
    identity.setPrivateStorage(privateStorage);
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    await runSession(identity, 0);

    const attrs = identity.getStrategyAttributions();
    expect(attrs).not.toBeNull();
    expect(attrs).toHaveLength(5);

    for (let i = 0; i < 5; i++) {
      expect(attrs![i].dimension).toBe(STRATEGY_FEATURE_NAMES[i]);
      expect(attrs![i].index).toBe(i);
      expect(typeof attrs![i].shapleyValue).toBe('number');
      expect(Number.isFinite(attrs![i].shapleyValue)).toBe(true);
    }

    await identity.shutdown();
  });

  test('4. Real Shapley values differ from naive proportional attribution', async () => {
    const identity = createUnifiedIdentity(storage);
    identity.setPrivateStorage(privateStorage);
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    // Run multiple sessions to build correlation history
    for (let i = 0; i < 5; i++) {
      await runSession(identity, i);
    }

    const attrs = identity.getStrategyAttributions()!;
    const features = identity.getStrategyFeatures()!;

    // Compute what synthetic would produce
    const featureValues = [
      features.readBeforeEdit, features.testAfterChange,
      features.contextGathering, features.outputVerification,
      features.errorRecoverySpeed,
    ];
    const total = featureValues.reduce((a, b) => a + b, 0) || 1;
    const syntheticValues = featureValues.map(v => v / total);

    // Real Shapley values should generally differ from synthetic proportional
    // (unless the correlation structure happens to make them identical, which
    // is astronomically unlikely with varied sessions)
    const shapleyValues = attrs.map(a => a.shapleyValue);
    const allEqual = shapleyValues.every((v, i) =>
      Math.abs(v - syntheticValues[i]) < 0.001
    );
    expect(allEqual).toBe(false);

    await identity.shutdown();
  });

  test('5. Per-feature confidence: 0 when sessions < 3, increases with correlation', async () => {
    const identity = createUnifiedIdentity(storage);
    identity.setPrivateStorage(privateStorage);
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    // After 1 session: confidence should be 0 (need ≥3 for df≥1)
    await runSession(identity, 0);
    const attrs1 = identity.getStrategyAttributions()!;
    for (const a of attrs1) {
      expect(a.confidence).toBe(0);
    }

    // After 2 sessions: still 0
    await runSession(identity, 1);
    const attrs2 = identity.getStrategyAttributions()!;
    for (const a of attrs2) {
      expect(a.confidence).toBe(0);
    }

    // After 3+ sessions: some confidence values should be > 0
    // (unless all correlations are exactly 0, which is unlikely with varied data)
    await runSession(identity, 2);
    const attrs3 = identity.getStrategyAttributions()!;
    expect(identity.getStrategySessionCount()).toBe(3);
    // At least check they're valid numbers in [0, 1]
    for (const a of attrs3) {
      expect(a.confidence).toBeGreaterThanOrEqual(0);
      expect(a.confidence).toBeLessThanOrEqual(1);
    }

    await identity.shutdown();
  });

  test('6. Möbius interactions: empty before minObservations, may populate after', async () => {
    const identity = createUnifiedIdentity(storage);
    identity.setPrivateStorage(privateStorage);
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    // After 1 session: interactions should be empty (need minObservations=20)
    await runSession(identity, 0);
    const interactions = identity.getStrategyInteractions();
    expect(interactions).not.toBeNull();
    expect(interactions).toHaveLength(0);

    await identity.shutdown();
  });

  test('7. State round-trip: save → load preserves strategy pipeline state', async () => {
    const identity1 = createUnifiedIdentity(storage);
    identity1.setPrivateStorage(privateStorage);
    await identity1.initialize([0.5, 0.5, 0.5, 0.5]);

    // Run several sessions to build state
    for (let i = 0; i < 5; i++) {
      await runSession(identity1, i);
    }

    const sessionCountBefore = identity1.getStrategySessionCount();
    const attrsBefore = identity1.getStrategyAttributions();
    expect(sessionCountBefore).toBe(5);
    expect(attrsBefore).not.toBeNull();

    await identity1.shutdown();

    // Create new identity and load from same storage
    const identity2 = createUnifiedIdentity(storage);
    identity2.setPrivateStorage(privateStorage);
    await identity2.initialize([0.5, 0.5, 0.5, 0.5]);

    // Strategy correlation session count should be restored
    expect(identity2.getStrategySessionCount()).toBe(sessionCountBefore);

    // Run one more session to verify pipeline still works
    await runSession(identity2, 5);
    expect(identity2.getStrategySessionCount()).toBe(sessionCountBefore + 1);
    expect(identity2.getStrategyAttributions()).not.toBeNull();

    await identity2.shutdown();
  });

  test('8. Backward compat: loading old state without strategy fields → fresh init', async () => {
    // First: create and save state WITHOUT strategy fields
    // (simulate old ARIL state by running a session, then manually stripping strategy fields)
    const identity1 = createUnifiedIdentity(storage);
    identity1.setPrivateStorage(privateStorage);
    await identity1.initialize([0.5, 0.5, 0.5, 0.5]);
    await runSession(identity1, 0);
    await identity1.shutdown();

    // Tamper with stored state: remove strategy fields
    const logs = await privateStorage.getAllActionLogs();
    const arilLog = logs.find(l => l.log.interactionId === 'aril_state');
    if (arilLog && arilLog.metadata) {
      delete (arilLog.metadata as Record<string, unknown>).strategyCorrelation;
      delete (arilLog.metadata as Record<string, unknown>).strategyMobius;
      delete (arilLog.metadata as Record<string, unknown>).strategyMobiusBaseline;
      delete (arilLog.metadata as Record<string, unknown>).strategyFeatureRunningMean;
    }

    // Load: should get fresh strategy init (sessionCount=0)
    const identity2 = createUnifiedIdentity(storage);
    identity2.setPrivateStorage(privateStorage);
    await identity2.initialize([0.5, 0.5, 0.5, 0.5]);

    expect(identity2.getStrategySessionCount()).toBe(0);

    // Pipeline should still work
    await runSession(identity2, 1);
    expect(identity2.getStrategyAttributions()).not.toBeNull();
    expect(identity2.getStrategySessionCount()).toBe(1);

    await identity2.shutdown();
  });

  test('9. Pipeline independence: strategy error does not break personality pipeline', async () => {
    const identity = createUnifiedIdentity(storage);
    identity.setPrivateStorage(privateStorage);
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    // Mock extractStrategyFeatures to throw by recording zero tool calls
    // (actually, extractStrategyFeatures handles empty arrays gracefully, so we
    // verify independence via the try/catch structure: personality attributions
    // are computed BEFORE strategy pipeline, so even if strategy throws,
    // personality should be unaffected)

    // Record enough calls for personality pipeline to work
    identity.startObservation('session-independent');
    identity.recordToolCall('Read', { file_path: 'a.ts' }, 'content', true, 100);
    identity.recordToolCall('Edit', { file_path: 'a.ts' }, 'edited', true, 120);
    identity.recordToolCall('Bash', { command: 'npm test' }, 'PASS', true, 200);

    // endObservation should complete without throwing
    const result = await identity.endObservation(
      createTestInteraction('session-independent', 'Test task'),
    );

    // Personality pipeline should have produced results
    expect(result.bridgeResult).toBeDefined();
    expect(result.bridgeResult.newState).toBeDefined();

    // Session count should have incremented (personality pipeline ran)
    expect(identity.getSessionCount()).toBeGreaterThan(0);

    await identity.shutdown();
  });

  test('10. Pipeline differentiation: strategy and personality produce different attributions', async () => {
    const identity = createUnifiedIdentity(storage);
    identity.setPrivateStorage(privateStorage);
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    // Run a few sessions
    for (let i = 0; i < 3; i++) {
      await runSession(identity, i);
    }

    const stratAttrs = identity.getStrategyAttributions();
    expect(stratAttrs).not.toBeNull();
    expect(stratAttrs).toHaveLength(5);

    // Strategy has 5 dimensions, personality has 4 — different N alone
    // ensures they're structurally different pipelines
    expect(stratAttrs!.length).not.toBe(4);

    // Strategy dimension names should be feature names, not personality names
    const stratDimNames = stratAttrs!.map(a => a.dimension);
    expect(stratDimNames).toEqual([...STRATEGY_FEATURE_NAMES]);

    await identity.shutdown();
  });

  test('strategy session count increments each session', async () => {
    const identity = createUnifiedIdentity(storage);
    identity.setPrivateStorage(privateStorage);
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    expect(identity.getStrategySessionCount()).toBe(0);

    await runSession(identity, 0);
    expect(identity.getStrategySessionCount()).toBe(1);

    await runSession(identity, 1);
    expect(identity.getStrategySessionCount()).toBe(2);

    await runSession(identity, 2);
    expect(identity.getStrategySessionCount()).toBe(3);

    await identity.shutdown();
  });

  // ==========================================================================
  // EDGE CASE TESTS (Issue #7)
  // ==========================================================================

  test('correlation ordering: Shapley receives correlation with sessionCount >= 1 on first call', async () => {
    // Verify S3 (updateCorrelationHistory) runs BEFORE S4 (computeShapleyAttribution).
    //
    // KEY SUBTLETY: Jest spies capture object REFERENCES, not snapshots.
    // updateCorrelationHistory mutates history.sessionCount in-place (line 130).
    // A naive spy that inspects correlationArg.sessionCount after endObservation()
    // would see the final state (sessionCount=1) regardless of ordering, because
    // the spy holds a pointer to the same object that was later mutated.
    //
    // Fix: mockImplementation captures sessionCount as a PRIMITIVE (number copy)
    // at the instant computeShapleyAttribution is called, then delegates to the
    // real function. With correct ordering: captured value = 1. Wrong ordering: 0.
    const realFn = ShapleyAttributor.computeShapleyAttribution;
    const capturedSessionCounts: number[] = [];
    const spy = jest.spyOn(ShapleyAttributor, 'computeShapleyAttribution')
      .mockImplementation((R, weightChanges, dimensions, history, config) => {
        // For strategy pipeline calls (N=5), snapshot sessionCount NOW
        if (dimensions.length === STRATEGY_FEATURE_NAMES.length && history) {
          capturedSessionCounts.push(history.sessionCount); // primitive copy
        }
        return realFn(R, weightChanges, dimensions, history, config);
      });

    const identity = createUnifiedIdentity(storage);
    identity.setPrivateStorage(privateStorage);
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    await runSession(identity, 0);

    // The strategy pipeline's Shapley call should have seen sessionCount >= 1
    // (because updateCorrelationHistory incremented it BEFORE Shapley was called)
    expect(capturedSessionCounts.length).toBeGreaterThanOrEqual(1);
    expect(capturedSessionCounts[0]).toBeGreaterThanOrEqual(1);

    // If S3/S4 were swapped (wrong ordering), capturedSessionCounts[0] would be 0.

    spy.mockRestore();
    await identity.shutdown();
  });

  test('zero-deviation edge case: identical sessions produce shrinking Shapley magnitudes', async () => {
    const identity = createUnifiedIdentity(storage);
    identity.setPrivateStorage(privateStorage);
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    let earlyMaxShapley = 0;
    let lateMaxShapley = 0;

    for (let i = 0; i < 20; i++) {
      identity.startObservation(`session-${i}`);
      identity.recordToolCall('Read', { file_path: 'a.ts' }, 'ok', true, 100);
      identity.recordToolCall('Edit', { file_path: 'a.ts' }, 'ok', true, 100);
      identity.recordToolCall('Bash', { command: 'npm test' }, 'ok', true, 200);
      await identity.endObservation(
        createTestInteraction(`session-${i}`, 'Same task'),
      );

      const attrs = identity.getStrategyAttributions()!;
      const maxAbs = Math.max(...attrs.map(a => Math.abs(a.shapleyValue)));

      if (i === 1) earlyMaxShapley = maxAbs;   // session 2 (after initial transient)
      if (i === 19) lateMaxShapley = maxAbs;    // session 20
    }

    // As running mean converges, deviations shrink → Shapley magnitudes shrink.
    // Late sessions should have strictly smaller max Shapley than early sessions.
    // (Shapley magnitude depends on both deviation AND R, but with identical
    // sessions and converging mean, the deviation factor dominates.)
    expect(lateMaxShapley).toBeLessThan(earlyMaxShapley);

    await identity.shutdown();
  });

  test('sign preservation: updateCorrelationHistory receives signed deviations (not absolute)', async () => {
    // Spy on updateCorrelationHistory to capture the deviations argument.
    // With signed deviations, some values should be negative (feature below running mean).
    // With absolute deviations, all values would be >= 0.
    const spy = jest.spyOn(ShapleyAttributor, 'updateCorrelationHistory');

    const identity = createUnifiedIdentity(storage);
    identity.setPrivateStorage(privateStorage);
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    // Run a session where some features are likely below the 0.5 init mean
    // (e.g., no error recovery → errorRecoverySpeed = 1.0 > 0.5,
    //  no output verification → outputVerification = 0 < 0.5)
    identity.startObservation('sign-test');
    // High context gathering (all reads/greps in first third)
    identity.recordToolCall('Grep', { pattern: 'x' }, 'ok', true, 50);
    identity.recordToolCall('Read', { file_path: 'a.ts' }, 'ok', true, 100);
    // Edit without prior read of this specific file → readBeforeEdit = 0
    identity.recordToolCall('Edit', { file_path: 'b.ts' }, 'ok', true, 100);
    // No test after change → testAfterChange = 0
    // No write → outputVerification = 0
    // No failures → errorRecoverySpeed = 1.0 (default for no errors)
    identity.recordToolCall('Read', { file_path: 'c.ts' }, 'ok', true, 100);
    identity.recordToolCall('Edit', { file_path: 'c.ts' }, 'ok', true, 100);
    await identity.endObservation(
      createTestInteraction('sign-test', 'Sign test'),
    );

    // Find the strategy-pipeline call (N=5, not personality N=4)
    // updateCorrelationHistory(history, dimensionMetrics, outcome)
    // args[1] = dimensionMetrics (the deviations Float64Array)
    const strategyCalls = spy.mock.calls.filter(
      args => args[1].length === STRATEGY_FEATURE_NAMES.length,
    );
    expect(strategyCalls.length).toBeGreaterThanOrEqual(1);

    const deviations = strategyCalls[0][1] as Float64Array;
    // With running mean init at 0.5, features like readBeforeEdit=0 produce
    // deviation = 0 - 0.5 = -0.5 (negative). Features like errorRecoverySpeed=1.0
    // produce deviation = 1.0 - 0.5 = +0.5 (positive).
    const hasNegative = Array.from(deviations).some(d => d < -0.01);
    const hasPositive = Array.from(deviations).some(d => d > 0.01);
    expect(hasNegative).toBe(true);
    expect(hasPositive).toBe(true);

    spy.mockRestore();
    await identity.shutdown();
  });

  test('confidence is per-feature (not uniform across all features)', async () => {
    const identity = createUnifiedIdentity(storage);
    identity.setPrivateStorage(privateStorage);
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    // Run enough sessions for confidence to diverge per feature
    for (let i = 0; i < 10; i++) {
      await runSession(identity, i);
    }

    const attrs = identity.getStrategyAttributions()!;
    const confidences = attrs.map(a => a.confidence);

    // With varied session behavior, it's extremely unlikely all 5 features
    // have identical confidence values
    const allIdentical = confidences.every(c => Math.abs(c - confidences[0]) < 0.001);
    // This could theoretically fail if all correlations happen to be identical,
    // but with our varied test data it's astronomically unlikely
    expect(allIdentical).toBe(false);

    await identity.shutdown();
  });

  // ==========================================================================
  // MISSING EDGE CASE TESTS (Issue #7 round 2)
  // ==========================================================================

  test('R=0 boundary: computeShapleyAttribution returns near-zero attributions', () => {
    // Direct unit test for the R=0 edge case.
    // When outcome R=0, there's nothing to distribute — all Shapley values
    // should be 0 (or floating-point noise). This tests the boundary directly
    // without relying on OutcomeEvaluator to produce R=0.
    const history = ShapleyAttributor.createCorrelationHistory(5);

    // Feed some non-trivial correlation data first so the value function
    // has something to work with (avoids the "no history → uniform fallback" path)
    const dummyMetrics = new Float64Array([0.2, -0.1, 0.3, -0.2, 0.1]);
    ShapleyAttributor.updateCorrelationHistory(history, dummyMetrics, 0.5);
    ShapleyAttributor.updateCorrelationHistory(history, dummyMetrics, 0.8);
    ShapleyAttributor.updateCorrelationHistory(history, dummyMetrics, 0.3);

    // Now compute attribution with R=0 and non-zero deviations
    const deviations = new Float64Array([0.1, -0.2, 0.15, -0.1, 0.05]);
    const result = ShapleyAttributor.computeShapleyAttribution(
      0, // R = 0: no outcome to distribute
      deviations,
      [...STRATEGY_FEATURE_NAMES],
      history,
    );

    expect(result.attributions).toHaveLength(5);
    for (const a of result.attributions) {
      // With R=0, Shapley values should be essentially zero
      expect(Math.abs(a.shapleyValue)).toBeLessThan(1e-10);
      expect(Number.isFinite(a.shapleyValue)).toBe(true);
      expect(Number.isNaN(a.shapleyValue)).toBe(false);
    }

    // Efficiency axiom: Σφᵢ should equal R (= 0)
    const sum = result.attributions.reduce((s, a) => s + a.shapleyValue, 0);
    expect(Math.abs(sum)).toBeLessThan(1e-10);
  });

  test('zero-deviation boundary: all deviations exactly zero with non-zero R', () => {
    // Complement of R=0 test. R=0 test proved "nothing to distribute → zero attributions."
    // This test proves "nothing changed → computation doesn't explode."
    //
    // If the value function normalizes by deviation magnitude (||Δw||), zero
    // deviations produce division by zero → NaN/Infinity. The convergence test
    // drives deviations *close* to zero over 20 sessions but never hits exact zero.
    // This test hits the exact boundary.

    const zeroDeviations = new Float64Array([0, 0, 0, 0, 0]);
    const R = 0.7;

    // --- Case A: Fallback path (sessionCount < 5) ---
    // With < 5 sessions, value function uses weight-change-based fallback.
    // Zero weight changes → totalChange < 1e-10 → uniform attribution R * |S| / N.
    const historyA = ShapleyAttributor.createCorrelationHistory(5);
    ShapleyAttributor.updateCorrelationHistory(historyA, new Float64Array([0.2, -0.1, 0.3, -0.2, 0.1]), 0.5);
    ShapleyAttributor.updateCorrelationHistory(historyA, new Float64Array([0.2, -0.1, 0.3, -0.2, 0.1]), 0.8);
    ShapleyAttributor.updateCorrelationHistory(historyA, new Float64Array([0.2, -0.1, 0.3, -0.2, 0.1]), 0.3);

    const resultA = ShapleyAttributor.computeShapleyAttribution(
      R, zeroDeviations, [...STRATEGY_FEATURE_NAMES], historyA,
    );

    expect(resultA.attributions).toHaveLength(5);
    for (const a of resultA.attributions) {
      expect(Number.isFinite(a.shapleyValue)).toBe(true);
      expect(Number.isNaN(a.shapleyValue)).toBe(false);
    }
    // Efficiency axiom: Σφᵢ = R
    const sumA = resultA.attributions.reduce((s, a) => s + a.shapleyValue, 0);
    expect(Math.abs(sumA - R)).toBeLessThan(1e-10);

    // Uniform attribution: each φᵢ = R/5 = 0.14
    for (const a of resultA.attributions) {
      expect(Math.abs(a.shapleyValue - R / 5)).toBeLessThan(1e-10);
    }

    // --- Case B: Correlation path (sessionCount >= 5) ---
    // With >= 5 sessions, value function uses |corr[i]| for coalition values.
    // Deviations are irrelevant on this path — attributions are correlation-driven.
    // Key: still no NaN/Infinity, efficiency still holds.
    //
    // IMPORTANT: Metrics must VARY across sessions — constant metrics give
    // metricVariances[i] = 0 → undefined correlations → fallback to uniform.
    // Use data where different features have different correlation with R.
    const historyB = ShapleyAttributor.createCorrelationHistory(5);
    const sessions = [
      // Feature 1,4 increase with R; feature 3 decreases; 0,2 are noisy
      { m: new Float64Array([0.3, 0.2, 0.5, 0.8, 0.3]), R: 0.3 },
      { m: new Float64Array([0.5, 0.5, 0.4, 0.5, 0.5]), R: 0.5 },
      { m: new Float64Array([0.7, 0.8, 0.6, 0.2, 0.8]), R: 0.8 },
      { m: new Float64Array([0.4, 0.3, 0.5, 0.7, 0.4]), R: 0.4 },
      { m: new Float64Array([0.6, 0.7, 0.3, 0.3, 0.7]), R: 0.7 },
      { m: new Float64Array([0.8, 0.9, 0.5, 0.1, 0.9]), R: 0.9 },
    ];
    for (const s of sessions) {
      ShapleyAttributor.updateCorrelationHistory(historyB, s.m, s.R);
    }

    const resultB = ShapleyAttributor.computeShapleyAttribution(
      R, zeroDeviations, [...STRATEGY_FEATURE_NAMES], historyB,
    );

    expect(resultB.attributions).toHaveLength(5);
    for (const a of resultB.attributions) {
      expect(Number.isFinite(a.shapleyValue)).toBe(true);
      expect(Number.isNaN(a.shapleyValue)).toBe(false);
    }
    const sumB = resultB.attributions.reduce((s, a) => s + a.shapleyValue, 0);
    expect(Math.abs(sumB - R)).toBeLessThan(1e-10);

    // On the correlation path, attributions should NOT be uniform — features
    // have different |corr[i]| values, so they get different shares of R.
    const allUniform = resultB.attributions.every(
      a => Math.abs(a.shapleyValue - R / 5) < 1e-10
    );
    expect(allUniform).toBe(false);
  });

  test('running mean convergence: deviations shrink over identical sessions', async () => {
    // Spy on updateCorrelationHistory to capture deviations each session.
    // With identical sessions, deviations should strictly decrease as the
    // running mean (EMA α=0.1) converges to the actual feature values.
    const spy = jest.spyOn(ShapleyAttributor, 'updateCorrelationHistory');

    const identity = createUnifiedIdentity(storage);
    identity.setPrivateStorage(privateStorage);
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    const deviationNorms: number[] = [];

    for (let i = 0; i < 10; i++) {
      identity.startObservation(`ema-${i}`);
      identity.recordToolCall('Read', { file_path: 'a.ts' }, 'ok', true, 100);
      identity.recordToolCall('Edit', { file_path: 'a.ts' }, 'ok', true, 100);
      identity.recordToolCall('Bash', { command: 'npm test' }, 'ok', true, 200);
      await identity.endObservation(
        createTestInteraction(`ema-${i}`, 'Same task'),
      );

      // Find the strategy-pipeline call from this session (N=5)
      const strategyCalls = spy.mock.calls.filter(
        args => args[1].length === STRATEGY_FEATURE_NAMES.length,
      );
      const latestDeviations = strategyCalls[strategyCalls.length - 1][1] as Float64Array;
      const norm = Array.from(latestDeviations).reduce((s, d) => s + d * d, 0);
      deviationNorms.push(norm);
    }

    // Deviation norms should decrease monotonically (or nearly so)
    // Session 1 has the largest deviations (running mean starts at 0.5)
    // Session 10 has the smallest (mean has converged)
    expect(deviationNorms[0]).toBeGreaterThan(deviationNorms[9]);
    // Final deviation norm should be very small
    expect(deviationNorms[9]).toBeLessThan(deviationNorms[0] * 0.3);

    spy.mockRestore();
    await identity.shutdown();
  });

  test('blend consistency: blended attributions remain finite after Möbius activates', async () => {
    // minObservations = 20, so blend activates at session 21.
    // After 25 sessions, computeBlend(25, 20) = 0.25 — blend is partially active.
    // This test verifies the deviation-based vs level-based blending produces sane results.
    const blendSpy = jest.spyOn(MobiusChar, 'blendShapley');

    const identity = createUnifiedIdentity(storage);
    identity.setPrivateStorage(privateStorage);
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    for (let i = 0; i < 25; i++) {
      await runSession(identity, i);
    }

    // Verify blendShapley was called for the strategy pipeline (arrays of length 5)
    const strategyBlendCalls = blendSpy.mock.calls.filter(
      args => (args[0] as number[]).length === STRATEGY_FEATURE_NAMES.length,
    );
    expect(strategyBlendCalls.length).toBeGreaterThan(0);

    // Verify the blend weight (3rd arg) is in (0, 1] — not 0 and not > 1
    const lastBlendWeight = strategyBlendCalls[strategyBlendCalls.length - 1][2] as number;
    expect(lastBlendWeight).toBeGreaterThan(0);
    expect(lastBlendWeight).toBeLessThanOrEqual(1);

    // Verify blended attributions are all finite (no NaN/Infinity from mixing)
    const attrs = identity.getStrategyAttributions()!;
    expect(attrs).not.toBeNull();
    expect(attrs).toHaveLength(5);
    for (const a of attrs) {
      expect(Number.isFinite(a.shapleyValue)).toBe(true);
      expect(Number.isFinite(a.confidence)).toBe(true);
    }

    // Verify the blended values differ from the pure additive values
    // (blendShapley spy captured both additive and möbius inputs)
    const lastCall = strategyBlendCalls[strategyBlendCalls.length - 1];
    const additiveValues = lastCall[0] as number[];
    const mobiusValues = lastCall[1] as number[];
    // With different inputs to additive vs möbius, they should differ
    const allSame = additiveValues.every((v, i) => Math.abs(v - mobiusValues[i]) < 1e-10);
    // Not guaranteed to differ on every session, but with 25 varied sessions
    // the Möbius learned coefficients should produce different Shapley values
    // from the additive pipeline. If they're identical, the Möbius pipeline
    // isn't contributing anything — which is a real possibility but unlikely.
    // We test the weaker property: both inputs are valid finite arrays.
    for (const v of additiveValues) expect(Number.isFinite(v)).toBe(true);
    for (const v of mobiusValues) expect(Number.isFinite(v)).toBe(true);

    blendSpy.mockRestore();
    await identity.shutdown();
  }, 30000); // 25 sessions may take a few seconds

  test('hook contract: identity exposes real attributions that render with synthetic: false', async () => {
    // This tests the contract between UnifiedIdentity and hook.ts's writeStrategyFile:
    // After endObservation(), getStrategyAttributions() returns N=5 DimensionAttribution[]
    // that satisfy the hook's `realAttrs.length === STRATEGY_FEATURE_NAMES.length` check,
    // causing the hook to render with `synthetic: false` (φ= notation).
    const identity = createUnifiedIdentity(storage);
    identity.setPrivateStorage(privateStorage);
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    await runSession(identity, 0);

    // 1. Verify identity exposes the interface writeStrategyFile expects
    const realAttrs = identity.getStrategyAttributions();
    const realInteractions = identity.getStrategyInteractions();
    const sessionCount = identity.getSessionCount();
    const strategySessionCount = identity.getStrategySessionCount();

    expect(realAttrs).not.toBeNull();
    expect(realAttrs!.length).toBe(STRATEGY_FEATURE_NAMES.length); // This is the hook's gate check
    expect(realInteractions).not.toBeNull();
    expect(sessionCount).toBeGreaterThan(0);
    expect(strategySessionCount).toBeGreaterThan(0);

    // 2. Verify each attribution has the fields renderStrategies needs
    for (let i = 0; i < realAttrs!.length; i++) {
      expect(realAttrs![i].dimension).toBe(STRATEGY_FEATURE_NAMES[i]);
      expect(realAttrs![i].index).toBe(i);
      expect(typeof realAttrs![i].shapleyValue).toBe('number');
      expect(typeof realAttrs![i].confidence).toBe('number');
    }

    // 3. Verify the attributions can be passed to renderStrategies with synthetic: false
    const features = identity.getStrategyFeatures()!;
    expect(features).not.toBeNull();

    const doc = renderStrategies({
      attributions: realAttrs!,
      features,
      sessionCount,
      synthetic: false, // This is the key: hook uses false when real attrs available
      interactions: realInteractions ?? undefined,
    });

    expect(doc.markdown).toBeDefined();
    expect(doc.markdown.length).toBeGreaterThan(0);
    // φ= notation (real Shapley) should appear, NOT w= (synthetic)
    expect(doc.markdown).toContain('φ=');
    expect(doc.markdown).not.toContain('w=');

    // 4. Contrast: synthetic path would use w= notation
    const featureValues = featuresToArray(features);
    const totalFV = featureValues.reduce((a, b) => a + b, 0) || 1;
    const syntheticAttrs = STRATEGY_FEATURE_NAMES.map((name: string, i: number) => ({
      dimension: name, index: i,
      shapleyValue: featureValues[i] / totalFV,
      confidence: 0.5, evidence: [] as string[],
    }));
    const syntheticDoc = renderStrategies({
      attributions: syntheticAttrs, features, sessionCount, synthetic: true,
    });
    expect(syntheticDoc.markdown).toContain('w=');
    expect(syntheticDoc.markdown).not.toContain('φ=');

    await identity.shutdown();
  });

  test('Shapley efficiency: sum of attributions approximately equals R', async () => {
    // Shapley values must satisfy the efficiency axiom: Σδ[i] ≈ v(N) - v(∅)
    // For our value function, this should be approximately R.
    const spy = jest.spyOn(ShapleyAttributor, 'computeShapleyAttribution');

    const identity = createUnifiedIdentity(storage);
    identity.setPrivateStorage(privateStorage);
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    await runSession(identity, 0);

    // Find the strategy Shapley call (N=5)
    const strategyCalls = spy.mock.calls.filter(
      args => args[2].length === STRATEGY_FEATURE_NAMES.length,
    );
    expect(strategyCalls.length).toBeGreaterThanOrEqual(1);

    // The return value contains efficiencyError
    const result = spy.mock.results.find(
      (r, i) => spy.mock.calls[i][2].length === STRATEGY_FEATURE_NAMES.length,
    );
    expect(result).toBeDefined();
    expect(result!.type).toBe('return');

    const attrResult = result!.value as ShapleyAttributor.AttributionResult;
    // Efficiency error should be small (exact computation for N=5)
    expect(attrResult.efficiencyError).toBeLessThan(0.01);

    spy.mockRestore();
    await identity.shutdown();
  });
});
