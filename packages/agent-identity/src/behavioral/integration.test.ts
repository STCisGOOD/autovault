/**
 * integration.test.ts
 *
 * End-to-end integration tests for the agent identity system.
 *
 * These tests verify the complete flow:
 * - BehavioralObserver captures actions
 * - IdentityBridge maps behavior to identity evolution
 * - IdentityPersistence saves/loads identity
 * - UnifiedIdentity orchestrates everything
 */

import {
  UnifiedIdentity,
  createUnifiedIdentity,
} from './UnifiedIdentity';

import { type StorageBackend } from './IdentityPersistence';

import {
  IdentityPersistence,
  createIdentityPersistence,
} from './IdentityPersistence';

import {
  createIdentityBridge,
  createBehavioralVocabulary,
} from './IdentityBridge';

import { BehavioralObserver, computeBehavioralMetrics } from './BehavioralObserver';
import { type Interaction, MockLLM } from './ReflectionEngine';

// =============================================================================
// MOCK STORAGE
// =============================================================================

class MockStorage implements StorageBackend {
  private store: Map<string, unknown> = new Map();
  private _isPersistent: boolean;

  constructor(isPersistent: boolean = true) {
    this._isPersistent = isPersistent;
  }

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
    return this._isPersistent;
  }

  clear(): void {
    this.store.clear();
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

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe('Integration: Full Identity Lifecycle', () => {
  let storage: MockStorage;

  beforeEach(() => {
    storage = new MockStorage(true);
  });

  test('complete lifecycle: initialize → observe → evolve → save → restore', async () => {
    // Phase 1: Initialize
    const identity = createUnifiedIdentity(storage);
    const loadResult = await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    expect(loadResult.isNew).toBe(true);
    expect(identity.getStatus().initialized).toBe(true);

    // Phase 2: First interaction with HIGH CURIOSITY behavior
    identity.startObservation('interaction-1');
    identity.recordToolCall('Read', { path: 'file.ts' }, 'content', true, 100, true, 'Reading required file');
    identity.recordToolCall('Glob', { pattern: '*.ts' }, 'files', true, 50, false, 'Exploring codebase');
    identity.recordToolCall('Grep', { pattern: 'function' }, 'matches', true, 50, false, 'Investigating patterns');
    identity.recordInformationSeek('What patterns exist?', 'tool', false, 2, true);
    identity.recordInformationSeek('How is this implemented?', 'tool', false, 3, true);

    const result1 = await identity.endObservation(createTestInteraction('interaction-1', 'Explore the codebase'));

    // Should have detected curiosity behavior
    expect(result1.bridgeResult.experience.metrics.curiosity.toolCallsBeyondRequired).toBeGreaterThan(0);

    // Phase 3: Second interaction with HIGH PRECISION behavior
    identity.startObservation('interaction-2');
    identity.recordToolCall('Read', { path: 'config.ts' }, 'content', true, 100, true, 'Required');
    identity.recordVerification('config schema', 'tool', 'confirmed', false);
    identity.recordVerification('type safety', 'reasoning', 'confirmed', false);
    identity.recordDecision(
      'Implementation approach',
      ['quick', 'thorough'],
      'thorough',
      'Better accuracy',
      0.9,
      false,
      false
    );

    const result2 = await identity.endObservation(createTestInteraction('interaction-2', 'Verify configuration'));

    // Should have detected precision behavior
    expect(result2.bridgeResult.experience.metrics.precision.verificationsBeyondRequired).toBeGreaterThan(0);

    // Phase 4: Save identity
    await identity.save();
    const stateBefore = identity.getState()!;

    // Phase 5: Restore identity in new instance
    const identity2 = createUnifiedIdentity(storage);
    const loadResult2 = await identity2.initialize([0.5, 0.5, 0.5, 0.5]);

    expect(loadResult2.isNew).toBe(false);
    expect(loadResult2.restored).toBe(true);

    const stateAfter = identity2.getState()!;

    // State should be preserved
    expect(stateAfter.dimension).toBe(stateBefore.dimension);
    for (let i = 0; i < stateBefore.dimension; i++) {
      expect(stateAfter.w[i]).toBeCloseTo(stateBefore.w[i], 10);
    }

    // Shutdown
    await identity.shutdown();
    await identity2.shutdown();
  });

  test('identity evolves toward observed behavior over multiple interactions', async () => {
    const identity = createUnifiedIdentity(storage);
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    const initialCuriosity = identity.getState()!.w[0]; // Curiosity is dimension 0

    // Run 10 interactions with consistently HIGH CURIOSITY
    for (let i = 0; i < 10; i++) {
      identity.startObservation(`high-curiosity-${i}`);

      // Always do extra exploration
      identity.recordToolCall('Read', {}, '', true, 100, true, 'Required');
      identity.recordToolCall('Glob', {}, '', true, 50, false, 'Exploring');
      identity.recordToolCall('Grep', {}, '', true, 50, false, 'Investigating');
      identity.recordToolCall('Read', {}, '', true, 50, false, 'More exploration');
      identity.recordInformationSeek('Question 1', 'tool', false, 2, true);
      identity.recordInformationSeek('Question 2', 'tool', false, 3, true);

      await identity.endObservation(
        createTestInteraction(`high-curiosity-${i}`, `Explore task ${i}`)
      );
    }

    const finalCuriosity = identity.getState()!.w[0];

    // Curiosity should have increased (observed consistently > declared)
    expect(finalCuriosity).toBeGreaterThan(initialCuriosity);

    await identity.shutdown();
  });

  test('handles failures gracefully during observation', async () => {
    const identity = createUnifiedIdentity(storage);
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    identity.startObservation('failure-test');

    // Record a failure with retry
    identity.recordToolCall('Read', { path: 'missing.ts' }, 'error', false, 100, true, 'Required file');
    identity.recordFailure('File not found', 'moderate', 'retry', 'Tried alternative path', 2, true);
    identity.recordToolCall('Read', { path: 'alternative.ts' }, 'content', true, 100, true, 'Fallback');

    const result = await identity.endObservation(
      createTestInteraction('failure-test', 'Handle missing file')
    );

    // Should record persistence behavior (retries attempted)
    expect(result.bridgeResult.experience.metrics.persistence.retriesAttempted).toBeGreaterThan(0);

    await identity.shutdown();
  });

  test('status reflects current state correctly', async () => {
    const identity = createUnifiedIdentity(storage);

    // Before initialization
    let status = identity.getStatus();
    expect(status.initialized).toBe(false);
    expect(status.weights).toHaveLength(0);

    // After initialization
    await identity.initialize([0.6, 0.7, 0.5, 0.4]);
    status = identity.getStatus();
    expect(status.initialized).toBe(true);
    expect(status.weights).toHaveLength(4);
    expect(status.weights[0]).toBeCloseTo(0.6, 5);
    expect(status.dimensions).toEqual(['curiosity', 'precision', 'persistence', 'empathy']);

    // During observation
    identity.startObservation('status-test');
    status = identity.getStatus();
    expect(status.currentObservationId).toBe('status-test');

    // After observation ends
    identity.recordToolCall('Read', {}, '', true, 100, true, 'Test');
    await identity.endObservation(createTestInteraction('status-test', 'Status test'));
    status = identity.getStatus();
    expect(status.currentObservationId).toBeNull();

    await identity.shutdown();
  });
});

describe('Integration: Behavioral Observer → Bridge', () => {
  test('metrics flow correctly from observer to bridge', async () => {
    const observer = new BehavioralObserver();
    observer.startObservation('metrics-flow-test');

    // High curiosity pattern
    observer.recordToolCall('Read', {}, '', true, 100, true, 'Required');
    observer.recordToolCall('Glob', {}, '', true, 50, false, 'Extra exploration');
    observer.recordToolCall('Grep', {}, '', true, 50, false, 'More exploration');

    // Some precision
    observer.recordVerification('type check', 'reasoning', 'confirmed', false);

    const actionLog = observer.endObservation();

    // Compute metrics directly
    const metrics = computeBehavioralMetrics(actionLog);

    expect(metrics.curiosity.toolCallsBeyondRequired).toBe(2); // Glob + Grep
    expect(metrics.precision.verificationsBeyondRequired).toBe(1);

    // Now process through bridge
    const bridge = createIdentityBridge([0.5, 0.5, 0.5, 0.5]);
    const result = await bridge.processInteraction(
      createTestInteraction('metrics-flow-test', 'Test interaction'),
      actionLog
    );

    // Bridge should receive the same metrics
    expect(result.experience.metrics.curiosity.toolCallsBeyondRequired).toBe(2);
    expect(result.experience.metrics.precision.verificationsBeyondRequired).toBe(1);
  });

  test('discrepancies detected between declared and observed behavior', async () => {
    // Low declared curiosity
    const bridge = createIdentityBridge([0.2, 0.5, 0.5, 0.5]);

    const observer = new BehavioralObserver();
    observer.startObservation('discrepancy-test');

    // But HIGH observed curiosity
    observer.recordToolCall('Read', {}, '', true, 100, true, 'Required');
    observer.recordToolCall('Glob', {}, '', true, 50, false, 'Exploring 1');
    observer.recordToolCall('Glob', {}, '', true, 50, false, 'Exploring 2');
    observer.recordToolCall('Grep', {}, '', true, 50, false, 'Investigating');
    observer.recordInformationSeek('Deep question 1', 'tool', false, 3, true);
    observer.recordInformationSeek('Deep question 2', 'tool', false, 3, true);

    const actionLog = observer.endObservation();
    const result = await bridge.processInteraction(
      createTestInteraction('discrepancy-test', 'Explore deeply'),
      actionLog
    );

    // Should detect discrepancy
    const curiosityDisc = result.experience.discrepancies.find(
      d => d.dimension === 'curiosity'
    );

    expect(curiosityDisc).toBeDefined();
    expect(curiosityDisc!.direction).toBe('higher'); // Observed > declared
  });
});

describe('Integration: Persistence Round-Trip', () => {
  let storage: MockStorage;

  beforeEach(() => {
    storage = new MockStorage(true);
  });

  test('declarations persist and verify on reload', async () => {
    const mockLLM = new MockLLM();
    // Set up reflection response
    mockLLM.setResponse('BEHAVIOR SUMMARY', `1. BEHAVIOR SUMMARY: High curiosity observed.\n2-5. ...`);
    // Set up insight response - pivotal, high confidence
    mockLLM.setResponse('INSIGHT', `INSIGHT|curiosity|Many exploratory calls|High curiosity demonstrated|0.75|0.95|true`);
    mockLLM.setDefaultResponse('Default response.');

    // Create first instance with LLM for declarations
    const identity1 = createUnifiedIdentity(storage, {
      bridge: {
        evolutionTimeStep: 0.05,
        declarationThreshold: 0.8,
        minDiscrepancyDelta: 0.1,
        experienceScale: 0.5,
        autoDeclarePivotal: true, // This should create declarations
      },
    });
    identity1.setLLM(mockLLM);
    await identity1.initialize([0.5, 0.5, 0.5, 0.5]);

    // Run interaction that should create declaration
    identity1.startObservation('declaration-test');
    identity1.recordToolCall('Read', {}, '', true, 100, true, 'Required');
    identity1.recordToolCall('Glob', {}, '', true, 50, false, 'Exploring');
    identity1.recordInformationSeek('Deep question', 'tool', false, 3, true);

    const result = await identity1.endObservation(
      createTestInteraction('declaration-test', 'Test declarations')
    );

    // May or may not have declarations depending on insight extraction
    const declarationCountBefore = identity1.getDeclarations().length;
    await identity1.save();
    await identity1.shutdown();

    // Reload in second instance
    const identity2 = createUnifiedIdentity(storage);
    const loadResult = await identity2.initialize([0.5, 0.5, 0.5, 0.5]);

    expect(loadResult.isNew).toBe(false);
    expect(identity2.getDeclarations().length).toBe(declarationCountBefore);

    await identity2.shutdown();
  });

  test('vocabulary and params persist correctly', async () => {
    const identity1 = createUnifiedIdentity(storage);
    await identity1.initialize([0.6, 0.7, 0.5, 0.4]);

    const vocab1 = identity1.getStatus().dimensions;
    const weights1 = identity1.getStatus().weights;

    await identity1.save();
    await identity1.shutdown();

    // Reload
    const identity2 = createUnifiedIdentity(storage);
    await identity2.initialize([0.1, 0.1, 0.1, 0.1]); // Different defaults (should be ignored)

    const vocab2 = identity2.getStatus().dimensions;
    const weights2 = identity2.getStatus().weights;

    // Vocabulary should match
    expect(vocab2).toEqual(vocab1);

    // Weights should be restored, not defaults
    expect(weights2[0]).toBeCloseTo(weights1[0], 5);
    expect(weights2[1]).toBeCloseTo(weights1[1], 5);

    await identity2.shutdown();
  });
});

describe('Integration: Error Handling', () => {
  test('throws when observing without initialization', () => {
    const identity = createUnifiedIdentity(new MockStorage());

    expect(() => {
      identity.startObservation('test');
    }).toThrow('Identity not initialized');
  });

  test('throws when ending observation without starting', async () => {
    const identity = createUnifiedIdentity(new MockStorage());
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    await expect(async () => {
      await identity.endObservation(createTestInteraction('test', 'Test'));
    }).rejects.toThrow('No active observation');

    await identity.shutdown();
  });

  test('warns but continues when recording without observation', async () => {
    const identity = createUnifiedIdentity(new MockStorage());
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    // These should warn but not throw
    identity.recordToolCall('Read', {}, '', true, 100, true, 'Test');
    identity.recordInformationSeek('Question', 'tool', true, 1, true);
    identity.recordDecision('Choice', ['a', 'b'], 'a', 'reason', 0.9, false, false);
    identity.recordFailure('Error', 'minor', 'retry', 'recovery', 1, true);
    identity.recordVerification('target', 'tool', 'confirmed', true);

    expect(warnSpy).toHaveBeenCalledTimes(5);

    warnSpy.mockRestore();
    await identity.shutdown();
  });
});

// =============================================================================
// FULL INSIGHT → STORAGE → RELOAD → INTUITION PATH
// =============================================================================

import type { ActionLog } from './BehavioralObserver';
import type { Insight } from './ReflectionEngine';
import type {
  PrivateStorageBackend,
  StoredInsight,
  StoredActionLog,
  PrivateStorageStats,
  ActionLogIndex,
} from '../bootstrap/PrivateStorage';

/**
 * In-memory mock of PrivateStorage for testing the full insight path.
 * Implements the FULL PrivateStorageBackend interface.
 */
class MockPrivateStorage implements PrivateStorageBackend {
  private actionLogs: Map<string, StoredActionLog> = new Map();
  private seq: number = 0;
  private agentDid: string = 'test-agent';

  async storeActionLog(log: ActionLog, metadata?: Record<string, unknown>): Promise<string> {
    return this.storeActionLogWithInsights(log, [], metadata);
  }

  async storeActionLogWithInsights(
    log: ActionLog,
    insights: Insight[],
    metadata?: Record<string, unknown>
  ): Promise<string> {
    const hash = this.computeHash(log);
    this.seq++;

    const stored: StoredActionLog = {
      hash,
      log,
      storedAt: Date.now(),
      seq: this.seq,
      metadata,
      insights: insights.length > 0 ? insights : undefined,
    };

    this.actionLogs.set(hash, stored);
    return hash;
  }

  async getActionLog(hash: string): Promise<StoredActionLog | null> {
    return this.actionLogs.get(hash) || null;
  }

  async getAllActionLogs(): Promise<StoredActionLog[]> {
    return Array.from(this.actionLogs.values()).sort((a, b) => a.seq - b.seq);
  }

  async getActionLogsByTimeRange(startTime: number, endTime: number): Promise<StoredActionLog[]> {
    const all = await this.getAllActionLogs();
    return all.filter(
      (log) => log.log.startTime >= startTime && log.log.endTime <= endTime
    );
  }

  async getPivotalInsights(): Promise<StoredInsight[]> {
    const pivotalInsights: StoredInsight[] = [];

    for (const [hash, stored] of this.actionLogs) {
      if (stored.insights) {
        for (const insight of stored.insights) {
          if (insight.isPivotal) {
            pivotalInsights.push({
              insight,
              actionLogHash: hash,
              storedAt: stored.storedAt,
            });
          }
        }
      }
    }

    // Sort by timestamp (oldest first)
    return pivotalInsights.sort((a, b) => a.insight.timestamp - b.insight.timestamp);
  }

  verify(hash: string, log: ActionLog): boolean {
    const computed = this.computeHash(log);
    return computed === hash;
  }

  async getStats(): Promise<PrivateStorageStats> {
    const logs = await this.getAllActionLogs();
    let totalInsights = 0;
    let pivotalCount = 0;

    for (const log of logs) {
      if (log.insights) {
        totalInsights += log.insights.length;
        pivotalCount += log.insights.filter(i => i.isPivotal).length;
      }
    }

    const timestamps = logs.map(l => l.storedAt).sort((a, b) => a - b);

    return {
      totalLogs: logs.length,
      totalInsights,
      pivotalInsightCount: pivotalCount,
      totalSizeBytes: 0, // Mock doesn't track size
      oldestLog: timestamps[0] || null,
      newestLog: timestamps[timestamps.length - 1] || null,
      storageDir: '/mock/storage',
    };
  }

  async exportAll(): Promise<{ index: ActionLogIndex; logs: StoredActionLog[] }> {
    const logs = await this.getAllActionLogs();
    const stats = await this.getStats();

    return {
      index: {
        agentDid: this.agentDid,
        totalLogs: stats.totalLogs,
        hashes: Array.from(this.actionLogs.keys()),
        totalInsights: stats.totalInsights,
        pivotalInsightCount: stats.pivotalInsightCount,
        lastUpdated: Date.now(),
        version: 1,
      },
      logs,
    };
  }

  computeHash(log: ActionLog): string {
    // Deterministic hash for testing
    const json = JSON.stringify(log, Object.keys(log).sort());
    let hash = 0;
    for (let i = 0; i < json.length; i++) {
      const char = json.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16).padStart(16, '0');
  }

  // Test helpers
  getStoredCount(): number {
    return this.actionLogs.size;
  }

  getAllInsightsForTest(): Insight[] {
    const all: Insight[] = [];
    for (const stored of this.actionLogs.values()) {
      if (stored.insights) {
        all.push(...stored.insights);
      }
    }
    return all;
  }

  clear(): void {
    this.actionLogs.clear();
    this.seq = 0;
  }
}

describe('Integration: Full Insight → Storage → Reload → Intuition Path', () => {
  let storage: MockStorage;
  let privateStorage: MockPrivateStorage;

  beforeEach(() => {
    storage = new MockStorage(true);
    privateStorage = new MockPrivateStorage();
  });

  test('insights are stored with ActionLogs when LLM generates them', async () => {
    const mockLLM = new MockLLM();

    // Set up LLM to return proper reflection format
    // The reflection prompt starts with "You are reflecting on your behavior"
    mockLLM.setResponse('You are reflecting', `
1. BEHAVIOR SUMMARY: Agent showed high curiosity with 3 extra exploratory tool calls.
2. METRICS ANALYSIS: Declared curiosity (0.50) was lower than observed behavior suggests.
3. DISCREPANCY ANALYSIS: Significant exploration beyond requirements indicates genuine curiosity.
4. IDENTITY IMPLICATIONS: Behavior aligns with an inquisitive agent profile.
5. SUGGESTED UPDATES: The extra exploration of tangential topics shows authentic curiosity.
    `);

    // Set up insight extraction to return pivotal insights
    // The insight prompt starts with "Extract insights from this GROUNDED reflection"
    mockLLM.setResponse('Extract insights', `INSIGHT|curiosity|Made 3 extra exploratory calls beyond requirements|Genuine curiosity exceeds declared level|0.72|0.88|true
INSIGHT|precision|Verified results before proceeding|Shows careful attention to accuracy|0.65|0.75|false`);

    mockLLM.setDefaultResponse('NO_INSIGHTS');

    const identity = createUnifiedIdentity(storage, {
      bridge: {
        evolutionTimeStep: 0.05,
        declarationThreshold: 0.7,
        minDiscrepancyDelta: 0.1,
        experienceScale: 0.5,
        autoDeclarePivotal: true,
      },
    });
    identity.setLLM(mockLLM);
    identity.setPrivateStorage(privateStorage);

    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    // Run an interaction with high-curiosity behavior
    identity.startObservation('insight-test-1');
    identity.recordToolCall('Read', { path: 'main.ts' }, 'content', true, 100, true, 'Required');
    identity.recordToolCall('Glob', { pattern: '*.ts' }, 'files', true, 50, false, 'Exploring structure');
    identity.recordToolCall('Grep', { pattern: 'export' }, 'matches', true, 50, false, 'Investigating exports');
    identity.recordToolCall('Read', { path: 'utils.ts' }, 'content', true, 50, false, 'Following curiosity');
    identity.recordInformationSeek('How are exports organized?', 'tool', false, 2, true);
    identity.recordVerification('export structure', 'tool', 'confirmed', false);

    const result = await identity.endObservation(
      createTestInteraction('insight-test-1', 'Explore the codebase structure')
    );

    // Verify insights were generated
    expect(result.bridgeResult.insights.length).toBeGreaterThan(0);

    // Verify ActionLog was stored with insights
    expect(result.actionLogHash).toBeDefined();
    // 1 ActionLog + 1 ARIL state save = 2 entries
    expect(privateStorage.getStoredCount()).toBeGreaterThanOrEqual(1);

    // Verify insights include pivotal ones
    const allInsights = privateStorage.getAllInsightsForTest();
    expect(allInsights.length).toBeGreaterThan(0);
    expect(allInsights.some(i => i.isPivotal)).toBe(true);

    await identity.shutdown();
  });

  test('pivotal insights are loaded back on identity reload', async () => {
    const mockLLM = new MockLLM();

    // Configure LLM for insight generation
    mockLLM.setResponse('You are reflecting', `
1. BEHAVIOR SUMMARY: High curiosity demonstrated through extensive exploration.
2. CLAIMED VS OBSERVED: Curiosity behavior exceeds declared level.
3. ENERGY FLOW: Strong exploratory drive.
4. COHERENCE: Behavior consistent with curious agent.
5. PIVOTAL MOMENTS: Significant exploration beyond task requirements.
    `);

    mockLLM.setResponse('Extract insights',
      `INSIGHT|curiosity|Explored 4 files beyond requirements|Strong intrinsic curiosity|0.78|0.92|true`
    );
    mockLLM.setDefaultResponse('NO_INSIGHTS');

    // SESSION 1: Generate and store insights
    const identity1 = createUnifiedIdentity(storage, {
      bridge: {
        evolutionTimeStep: 0.05,
        declarationThreshold: 0.7,
        minDiscrepancyDelta: 0.1,
        experienceScale: 0.5,
        autoDeclarePivotal: true,
      },
    });
    identity1.setLLM(mockLLM);
    identity1.setPrivateStorage(privateStorage);

    await identity1.initialize([0.5, 0.5, 0.5, 0.5]);

    // Run interaction that generates pivotal insight
    identity1.startObservation('session1-interaction');
    identity1.recordToolCall('Read', {}, '', true, 100, true, 'Required');
    identity1.recordToolCall('Glob', {}, '', true, 50, false, 'Exploring');
    identity1.recordToolCall('Grep', {}, '', true, 50, false, 'Searching');
    identity1.recordToolCall('Read', {}, '', true, 50, false, 'More exploration');
    identity1.recordInformationSeek('Deep question', 'tool', false, 3, true);

    const result1 = await identity1.endObservation(
      createTestInteraction('session1-interaction', 'Explore deeply')
    );

    // Verify insight was generated and stored
    expect(result1.bridgeResult.insights.length).toBeGreaterThan(0);
    const pivotalInsightsStored = privateStorage.getAllInsightsForTest().filter(i => i.isPivotal);
    expect(pivotalInsightsStored.length).toBeGreaterThan(0);

    await identity1.save();
    await identity1.shutdown();

    // SESSION 2: Reload and verify insights are loaded
    const identity2 = createUnifiedIdentity(storage);
    identity2.setPrivateStorage(privateStorage); // Same private storage

    const loadResult = await identity2.initialize([0.5, 0.5, 0.5, 0.5]);

    // Verify identity was restored (not new)
    expect(loadResult.isNew).toBe(false);

    // Verify intuition was loaded
    expect(loadResult.intuition).not.toBeNull();
    expect(loadResult.intuition!.insightCount).toBeGreaterThan(0);

    // Verify getAccumulatedWisdom returns the loaded insights
    const wisdom = identity2.getAccumulatedWisdom();
    expect(wisdom.insights.length).toBeGreaterThan(0);
    expect(wisdom.summary).toContain('pivotal insight');
    expect(wisdom.contextPrompt).toContain('From past experience');

    // Verify getIntuition returns semantic guidance
    const intuition = identity2.getIntuition();
    expect(intuition).not.toBeNull();
    expect(intuition!.contextGuidance).toContain('Learned Intuition');

    await identity2.shutdown();
  });

  test('multiple sessions accumulate insights correctly', async () => {
    const mockLLM = new MockLLM();

    // SESSION 1: Curiosity insight
    mockLLM.setResponse('You are reflecting', '1. BEHAVIOR SUMMARY: Curious exploration observed.');
    mockLLM.setResponse('Extract insights',
      `INSIGHT|curiosity|Extensive exploration|High curiosity demonstrated|0.75|0.90|true`
    );
    mockLLM.setDefaultResponse('NO_INSIGHTS');

    const identity1 = createUnifiedIdentity(storage, {
      bridge: { autoDeclarePivotal: true, declarationThreshold: 0.7, minDiscrepancyDelta: 0.1, experienceScale: 0.5, evolutionTimeStep: 0.05 },
    });
    identity1.setLLM(mockLLM);
    identity1.setPrivateStorage(privateStorage);
    await identity1.initialize([0.5, 0.5, 0.5, 0.5]);

    identity1.startObservation('session1');
    identity1.recordToolCall('Read', {}, '', true, 100, true, 'Required');
    identity1.recordToolCall('Glob', {}, '', true, 50, false, 'Exploring');
    await identity1.endObservation(createTestInteraction('session1', 'Explore'));
    await identity1.save();
    await identity1.shutdown();

    // SESSION 2: Precision insight
    mockLLM.setResponse('Extract insights',
      `INSIGHT|precision|Verified all claims|High attention to accuracy|0.80|0.85|true`
    );

    const identity2 = createUnifiedIdentity(storage);
    identity2.setLLM(mockLLM);
    identity2.setPrivateStorage(privateStorage);
    await identity2.initialize([0.5, 0.5, 0.5, 0.5]);

    identity2.startObservation('session2');
    identity2.recordToolCall('Read', {}, '', true, 100, true, 'Required');
    identity2.recordVerification('result', 'tool', 'confirmed', false);
    identity2.recordVerification('assumption', 'reasoning', 'confirmed', false);
    await identity2.endObservation(createTestInteraction('session2', 'Verify'));
    await identity2.save();
    await identity2.shutdown();

    // SESSION 3: Load and verify accumulated insights
    const identity3 = createUnifiedIdentity(storage);
    identity3.setPrivateStorage(privateStorage);
    const loadResult = await identity3.initialize([0.5, 0.5, 0.5, 0.5]);

    // Should have insights from BOTH sessions
    expect(loadResult.intuition!.insightCount).toBe(2);

    const wisdom = identity3.getAccumulatedWisdom();
    expect(wisdom.insights.length).toBe(2);

    // Should have insights for both dimensions
    const dimensions = wisdom.insights.map(i => i.insight.dimension);
    expect(dimensions).toContain('curiosity');
    expect(dimensions).toContain('precision');

    // Summary should mention both
    expect(wisdom.summary).toContain('curiosity');
    expect(wisdom.summary).toContain('precision');

    await identity3.shutdown();
  });

  test('intuition contextGuidance provides actionable guidance', async () => {
    const mockLLM = new MockLLM();
    mockLLM.setResponse('You are reflecting', '1. BEHAVIOR SUMMARY: Observed behavior.');
    mockLLM.setResponse('Extract insights',
      `INSIGHT|curiosity|Always explores before committing|Exploration before action is natural|0.72|0.88|true
INSIGHT|persistence|Retried 3 times before succeeding|High persistence under adversity|0.80|0.90|true`
    );
    mockLLM.setDefaultResponse('NO_INSIGHTS');

    const identity = createUnifiedIdentity(storage, {
      bridge: { autoDeclarePivotal: true, declarationThreshold: 0.7, minDiscrepancyDelta: 0.1, experienceScale: 0.5, evolutionTimeStep: 0.05 },
    });
    identity.setLLM(mockLLM);
    identity.setPrivateStorage(privateStorage);
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    // Generate insights
    identity.startObservation('guidance-test');
    identity.recordToolCall('Read', {}, '', true, 100, true, 'Required');
    identity.recordToolCall('Glob', {}, '', true, 50, false, 'Exploring');
    identity.recordFailure('First attempt', 'minor', 'retry', 'retrying', 3, true);
    await identity.endObservation(createTestInteraction('guidance-test', 'Test'));
    await identity.save();
    await identity.shutdown();

    // Reload and check intuition
    const identity2 = createUnifiedIdentity(storage);
    identity2.setPrivateStorage(privateStorage);
    await identity2.initialize([0.5, 0.5, 0.5, 0.5]);

    const intuition = identity2.getIntuition();
    expect(intuition).not.toBeNull();

    // contextGuidance should be structured and actionable
    expect(intuition!.contextGuidance).toContain('Learned Intuition');
    expect(intuition!.contextGuidance.length).toBeGreaterThan(50);

    // dimensionLessons should be organized by dimension
    expect(intuition!.dimensionLessons.size).toBeGreaterThan(0);

    // pivotalPatterns should capture key behavioral patterns
    expect(intuition!.pivotalPatterns.length).toBeGreaterThan(0);

    await identity2.shutdown();
  });

  test('getAccumulatedWisdom contextPrompt is ready for LLM injection', async () => {
    const mockLLM = new MockLLM();
    mockLLM.setResponse('You are reflecting', '1. BEHAVIOR SUMMARY: Observed.');
    mockLLM.setResponse('Extract insights',
      `INSIGHT|curiosity|Explores deeply before acting|Deep exploration is natural|0.75|0.85|true`
    );
    mockLLM.setDefaultResponse('NO_INSIGHTS');

    const identity = createUnifiedIdentity(storage, {
      bridge: { autoDeclarePivotal: true, declarationThreshold: 0.7, minDiscrepancyDelta: 0.1, experienceScale: 0.5, evolutionTimeStep: 0.05 },
    });
    identity.setLLM(mockLLM);
    identity.setPrivateStorage(privateStorage);
    await identity.initialize([0.5, 0.5, 0.5, 0.5]);

    identity.startObservation('context-test');
    identity.recordToolCall('Read', {}, '', true, 100, true, 'Required');
    identity.recordToolCall('Glob', {}, '', true, 50, false, 'Exploring');
    await identity.endObservation(createTestInteraction('context-test', 'Test'));
    await identity.save();
    await identity.shutdown();

    // Reload
    const identity2 = createUnifiedIdentity(storage);
    identity2.setPrivateStorage(privateStorage);
    await identity2.initialize([0.5, 0.5, 0.5, 0.5]);

    const wisdom = identity2.getAccumulatedWisdom();

    // contextPrompt should be ready for LLM system prompt injection
    expect(wisdom.contextPrompt).toMatch(/^From past experience/);
    expect(wisdom.contextPrompt).toContain('curiosity');

    // Should be concise enough for prompt injection
    expect(wisdom.contextPrompt.split('\n').length).toBeLessThan(20);

    await identity2.shutdown();
  });
});
