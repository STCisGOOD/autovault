/**
 * IdentityPersistence.test.ts
 *
 * Tests the persistence layer for identity storage.
 */

import {
  IdentityPersistence,
  createIdentityPersistence,
  verifyStoredSelf,
  DEFAULT_PERSISTENCE_CONFIG,
  type StorageBackend,
  type LoadResult,
} from './IdentityPersistence';

import {
  createIdentityBridge,
  createBehavioralVocabulary,
} from './IdentityBridge';

import { BehavioralObserver } from './BehavioralObserver';
import { type Interaction } from './ReflectionEngine';

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

  // Test helper
  clear(): void {
    this.store.clear();
  }
}

// =============================================================================
// TEST UTILITIES
// =============================================================================

function createTestInteraction(): Interaction {
  return {
    id: 'test-001',
    timestamp: Date.now(),
    prompt: 'Help me understand this codebase',
    context: {},
    response: 'Let me explore the codebase for you...',
    durationMs: 2000,
    selfStateSnapshot: {
      w: [0.5, 0.5, 0.5, 0.5],
      m: [0.5, 0.5, 0.5, 0.5],
    },
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('IdentityPersistence', () => {
  let storage: MockStorage;
  let persistence: IdentityPersistence;

  beforeEach(() => {
    storage = new MockStorage(true);
    persistence = createIdentityPersistence(storage);
  });

  describe('load', () => {
    test('creates new identity when no stored data', async () => {
      const result = await persistence.load([0.5, 0.5, 0.5, 0.5]);

      expect(result.isNew).toBe(true);
      expect(result.bridge).not.toBeNull();
      expect(result.verification).toBeNull();
      expect(result.bridge!.getState().dimension).toBe(4);
    });

    test('restores identity from storage', async () => {
      // First create and save an identity
      const result1 = await persistence.load([0.5, 0.5, 0.5, 0.5]);
      await persistence.save();

      // Create a new persistence instance and load
      const persistence2 = createIdentityPersistence(storage);
      const result2 = await persistence2.load([0.5, 0.5, 0.5, 0.5]);

      expect(result2.isNew).toBe(false);
      expect(result2.restored).toBe(true);
      expect(result2.bridge).not.toBeNull();
    });

    test('verifies integrity on load when configured', async () => {
      // Create and save an identity
      const result1 = await persistence.load([0.5, 0.5, 0.5, 0.5]);
      await persistence.save();

      // Load with verification
      const persistence2 = createIdentityPersistence(storage, {
        verifyOnLoad: true,
      });
      const result2 = await persistence2.load([0.5, 0.5, 0.5, 0.5]);

      expect(result2.verification).not.toBeNull();
      expect(result2.verification!.valid).toBe(true);
      expect(result2.verification!.chainIntact).toBe(true);
      expect(result2.verification!.stateConsistent).toBe(true);
    });
  });

  describe('save', () => {
    test('saves identity to storage', async () => {
      await persistence.load([0.5, 0.5, 0.5, 0.5]);
      const saved = await persistence.save();

      expect(saved).toBe(true);

      // Verify data was stored
      const keys = await storage.keys();
      expect(keys.some(k => k.includes('identity:current'))).toBe(true);
    });

    test('returns false when no bridge loaded', async () => {
      const saved = await persistence.save();
      expect(saved).toBe(false);
    });
  });

  describe('clear', () => {
    test('removes all identity data', async () => {
      await persistence.load([0.5, 0.5, 0.5, 0.5]);
      await persistence.save();

      await persistence.clear();

      expect(persistence.getBridge()).toBeNull();
      expect(await persistence.exists()).toBe(false);
    });
  });

  describe('exists', () => {
    test('returns false when no identity stored', async () => {
      const exists = await persistence.exists();
      expect(exists).toBe(false);
    });

    test('returns true after save', async () => {
      await persistence.load([0.5, 0.5, 0.5, 0.5]);
      await persistence.save();

      const exists = await persistence.exists();
      expect(exists).toBe(true);
    });
  });

  describe('getStatus', () => {
    test('returns correct status', async () => {
      // Before loading
      let status = persistence.getStatus();
      expect(status.hasIdentity).toBe(false);
      expect(status.isPersistent).toBe(true);
      expect(status.declarationCount).toBe(0);

      // After loading
      await persistence.load([0.5, 0.5, 0.5, 0.5]);
      status = persistence.getStatus();
      expect(status.hasIdentity).toBe(true);
      expect(status.declarationCount).toBe(0);
    });
  });

  describe('round-trip serialization', () => {
    test('preserves state through save/load cycle', async () => {
      // Load and evolve identity
      const result1 = await persistence.load([0.6, 0.7, 0.5, 0.4]);
      const bridge1 = result1.bridge!;

      // Process an interaction to evolve state
      const observer = new BehavioralObserver();
      observer.startObservation('test-001');
      observer.recordToolCall('Read', {}, '', true, 100, true, 'Required');
      observer.recordToolCall('Glob', {}, '', true, 50, false, 'Exploring');
      const actionLog = observer.endObservation();

      await bridge1.processInteraction(createTestInteraction(), actionLog);

      // Save state
      await persistence.save();

      // Capture state before reload
      const stateBefore = bridge1.getState();

      // Load in new persistence instance
      const persistence2 = createIdentityPersistence(storage);
      const result2 = await persistence2.load([0.5, 0.5, 0.5, 0.5]); // Default weights ignored

      const stateAfter = result2.bridge!.getState();

      // Verify state is preserved
      expect(stateAfter.dimension).toBe(stateBefore.dimension);
      expect(stateAfter.time).toBe(stateBefore.time);

      for (let i = 0; i < stateBefore.dimension; i++) {
        expect(stateAfter.w[i]).toBeCloseTo(stateBefore.w[i], 10);
        expect(stateAfter.m[i]).toBeCloseTo(stateBefore.m[i], 10);
      }
    });
  });
});

describe('verifyStoredSelf', () => {
  test('validates correct StoredSelf', () => {
    const bridge = createIdentityBridge([0.5, 0.5, 0.5, 0.5]);
    const stored = bridge.export();

    const result = verifyStoredSelf(stored);

    expect(result.valid).toBe(true);
    expect(result.chainIntact).toBe(true);
    expect(result.stateConsistent).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('detects dimension mismatch', () => {
    const bridge = createIdentityBridge([0.5, 0.5, 0.5, 0.5]);
    const stored = bridge.export();

    // Corrupt the dimension
    const corrupted = {
      ...stored,
      currentState: {
        ...stored.currentState,
        dimension: 3, // Wrong!
      },
    };

    const result = verifyStoredSelf(corrupted);

    expect(result.valid).toBe(false);
    expect(result.stateConsistent).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('configuration', () => {
  test('uses default config when not specified', () => {
    const storage = new MockStorage();
    const persistence = createIdentityPersistence(storage);

    // We can't directly access config, but we can verify behavior
    expect(persistence).toBeDefined();
  });

  test('accepts custom config', () => {
    const storage = new MockStorage();
    const persistence = createIdentityPersistence(storage, {
      autoSave: false,
      verifyOnLoad: false,
      keyPrefix: 'custom:',
    });

    expect(persistence).toBeDefined();
  });
});

describe('non-persistent storage fallback', () => {
  test('works with non-persistent storage', async () => {
    const memoryStorage = new MockStorage(false);
    const persistence = createIdentityPersistence(memoryStorage);

    await persistence.load([0.5, 0.5, 0.5, 0.5]);

    const status = persistence.getStatus();
    expect(status.isPersistent).toBe(false);
    expect(status.hasIdentity).toBe(true);
  });
});
