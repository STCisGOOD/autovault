/**
 * Tests for the core module: AgentRuntime, ExperienceMapping, IdentityManager
 */

import { actionLogToExperience, weightsToContextModifier } from './ExperienceMapping';
import { IdentityManager, createIdentityManager } from './IdentityManager';
import { createBehavioralVocabulary } from '../behavioral/IdentityBridge';
import type { ActionLog, ToolCall } from '../behavioral/BehavioralObserver';
import type { StorageBackend } from '../behavioral/IdentityPersistence';

// =============================================================================
// MOCK STORAGE
// =============================================================================

class MockStorage implements StorageBackend {
  private store: Map<string, unknown> = new Map();

  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
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
    const regex = new RegExp(pattern.replace(/\\*/g, '.*'));
    return allKeys.filter(k => regex.test(k));
  }

  isPersistent(): boolean {
    return false;
  }
}

// =============================================================================
// MOCK ACTION LOG
// =============================================================================

function createMockActionLog(overrides: Partial<ActionLog> = {}): ActionLog {
  const now = Date.now();
  return {
    interactionId: 'test-interaction',
    startTime: now - 60000,
    endTime: now,
    toolCalls: [],
    decisions: [],
    failures: [],
    informationSeeks: [],
    verifications: [],
    resourceUsage: {
      tokensUsed: 0,
      toolCallCount: 0,
      wallTimeMs: 60000,
      apiCalls: 0,
      retriesTotal: 0,
    },
    ...overrides,
  };
}

function createToolCall(
  tool: string,
  success: boolean,
  durationMs: number = 100
): ToolCall {
  return {
    id: `call-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    tool,
    args: {},
    result: success ? 'success' : 'error',
    success,
    timestamp: Date.now(),
    durationMs,
    wasRequired: false,
    context: 'test',
  };
}

// =============================================================================
// EXPERIENCE MAPPING TESTS
// =============================================================================

describe('ExperienceMapping', () => {
  describe('actionLogToExperience', () => {
    const vocabulary = createBehavioralVocabulary();

    test('empty action log produces neutral experience', () => {
      const actionLog = createMockActionLog({ toolCalls: [] });
      const experience = actionLogToExperience(actionLog, vocabulary);

      expect(experience.length).toBe(vocabulary.assertions.length);
      // All zeros for empty log
      for (let i = 0; i < experience.length; i++) {
        expect(experience[i]).toBe(0);
      }
    });

    test('exploratory reads increase curiosity', () => {
      const toolCalls = [
        createToolCall('Read', true),
        createToolCall('Read', true),
        createToolCall('Glob', true),
        createToolCall('Grep', true),
      ];

      const actionLog = createMockActionLog({ toolCalls });
      const experience = actionLogToExperience(actionLog, vocabulary);

      // Curiosity should be elevated
      const curiosityIndex = vocabulary.assertions.indexOf('curiosity');
      expect(experience[curiosityIndex]).toBeGreaterThan(0);
    });

    test('verification after writes increases precision', () => {
      const toolCalls = [
        createToolCall('Write', true),
        createToolCall('Read', true), // Verification read
        createToolCall('Edit', true),
        createToolCall('Bash', true), // Test run
      ];

      const actionLog = createMockActionLog({ toolCalls });
      const experience = actionLogToExperience(actionLog, vocabulary);

      // Precision should be elevated
      const precisionIndex = vocabulary.assertions.indexOf('precision');
      expect(experience[precisionIndex]).toBeGreaterThan(0);
    });

    test('retries after failure increase persistence', () => {
      const toolCalls = [
        createToolCall('Bash', false), // Failure
        createToolCall('Bash', true),  // Retry success
        createToolCall('Write', false),
        createToolCall('Write', true), // Retry success
      ];

      const actionLog = createMockActionLog({ toolCalls });
      const experience = actionLogToExperience(actionLog, vocabulary);

      // Persistence should be elevated
      const persistenceIndex = vocabulary.assertions.indexOf('persistence');
      expect(experience[persistenceIndex]).toBeGreaterThan(0);
    });

    test('asking questions increases empathy', () => {
      const toolCalls = [
        createToolCall('AskUserQuestion', true),
        createToolCall('Read', true),
        createToolCall('AskUserQuestion', true),
      ];

      const actionLog = createMockActionLog({ toolCalls });
      const experience = actionLogToExperience(actionLog, vocabulary);

      // Empathy should be elevated
      const empathyIndex = vocabulary.assertions.indexOf('empathy');
      expect(experience[empathyIndex]).toBeGreaterThan(0);
    });
  });

  describe('weightsToContextModifier', () => {
    const vocabulary = createBehavioralVocabulary();

    test('neutral weights produce balanced modifier', () => {
      const weights = new Float64Array([0.5, 0.5, 0.5, 0.5]);
      const modifier = weightsToContextModifier(weights, vocabulary);

      expect(modifier.description).toContain('Balanced');
      expect(modifier.promptAdditions.length).toBe(0);
      expect(modifier.rawWeights).toEqual([0.5, 0.5, 0.5, 0.5]);
    });

    test('high curiosity generates exploration prompt', () => {
      const weights = new Float64Array([0.9, 0.5, 0.5, 0.5]);
      const modifier = weightsToContextModifier(weights, vocabulary);

      expect(modifier.promptAdditions.length).toBeGreaterThan(0);
      expect(modifier.promptAdditions[0]).toContain('curiosity');
      expect(modifier.promptAdditions[0]).toContain('explore');
    });

    test('high precision generates verification prompt', () => {
      const weights = new Float64Array([0.5, 0.9, 0.5, 0.5]);
      const modifier = weightsToContextModifier(weights, vocabulary);

      expect(modifier.promptAdditions.some(p => p.includes('precision'))).toBe(true);
    });

    test('low weight generates note about weakness', () => {
      const weights = new Float64Array([0.1, 0.5, 0.5, 0.5]);
      const modifier = weightsToContextModifier(weights, vocabulary);

      expect(modifier.promptAdditions.some(p => p.includes('low'))).toBe(true);
    });

    test('behavioral hints contain all dimensions', () => {
      const weights = new Float64Array([0.5, 0.5, 0.5, 0.5]);
      const modifier = weightsToContextModifier(weights, vocabulary);

      for (const dim of vocabulary.assertions) {
        expect(modifier.behavioralHints[dim]).toBeDefined();
        expect(modifier.behavioralHints[dim]).toBe(0.5);
      }
    });
  });
});

// =============================================================================
// IDENTITY MANAGER TESTS
// =============================================================================

describe('IdentityManager', () => {
  let storage: MockStorage;
  let manager: IdentityManager;

  beforeEach(() => {
    storage = new MockStorage();
    manager = createIdentityManager(storage, undefined, { verbose: false });
  });

  describe('session lifecycle', () => {
    test('onSessionStart returns context modifier', async () => {
      const modifier = await manager.onSessionStart('session-1');

      expect(modifier).toBeDefined();
      expect(modifier.behavioralHints).toBeDefined();
      expect(modifier.rawWeights.length).toBe(4);
    });

    test('onSessionEnd processes action log', async () => {
      await manager.onSessionStart('session-1');

      const actionLog = createMockActionLog({
        toolCalls: [
          createToolCall('Read', true),
          createToolCall('Write', true),
        ],
      });

      const result = await manager.onSessionEnd('session-1', actionLog);

      expect(result).toBeDefined();
      expect(result.nextContextModifier).toBeDefined();
      expect(result.summary).toContain('Weight evolution');
      expect(result.warnings).toEqual([]);
    });

    test('weights evolve based on behavior', async () => {
      const weightsBefore = manager.getCurrentWeights();

      await manager.onSessionStart('session-1');

      // Lots of exploratory reads → should increase curiosity
      const actionLog = createMockActionLog({
        toolCalls: Array(10).fill(null).map(() => createToolCall('Read', true)),
      });

      await manager.onSessionEnd('session-1', actionLog);

      const weightsAfter = manager.getCurrentWeights();

      // At least one weight should have changed
      const maxChange = Math.max(
        ...weightsBefore.map((w, i) => Math.abs(w - weightsAfter[i]))
      );
      expect(maxChange).toBeGreaterThan(0);
    });
  });

  describe('persistence', () => {
    test('save and load roundtrip', async () => {
      // Modify state
      await manager.onSessionStart('session-1');
      await manager.onSessionEnd('session-1', createMockActionLog({
        toolCalls: Array(5).fill(null).map(() => createToolCall('Read', true)),
      }));

      const weightsBefore = manager.getCurrentWeights();

      // Save
      const saved = await manager.save();
      expect(saved).toBe(true);

      // Create new manager and load
      const manager2 = createIdentityManager(storage, undefined, { verbose: false });
      const loaded = await manager2.load();
      expect(loaded).toBe(true);

      // Weights should match
      const weightsAfter = manager2.getCurrentWeights();
      expect(weightsAfter).toEqual(weightsBefore);
    });
  });

  describe('accessors', () => {
    test('getState returns current state', () => {
      const state = manager.getState();

      expect(state.dimension).toBe(4);
      expect(state.w.length).toBe(4);
      expect(state.m.length).toBe(4);
    });

    test('getVocabulary returns behavioral vocabulary', () => {
      const vocab = manager.getVocabulary();

      expect(vocab.assertions).toContain('curiosity');
      expect(vocab.assertions).toContain('precision');
      expect(vocab.assertions).toContain('persistence');
      expect(vocab.assertions).toContain('empathy');
    });

    test('getContextModifier returns current modifier', () => {
      const modifier = manager.getContextModifier();

      expect(modifier.behavioralHints).toBeDefined();
      expect(modifier.rawWeights.length).toBe(4);
    });
  });
});
