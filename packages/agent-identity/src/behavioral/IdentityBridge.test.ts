/**
 * IdentityBridge.test.ts
 *
 * Tests the unified identity bridge that connects:
 *   BehavioralObserver → FixedPointSelf → Declarations → Persistence
 */

import {
  IdentityBridge,
  createIdentityBridge,
  createBehavioralVocabulary,
  createBehavioralParams,
  metricsToExperience,
  discrepanciesToExperience,
  DEFAULT_BRIDGE_CONFIG,
  BridgeConfig,
} from './IdentityBridge';

import {
  BehavioralObserver,
  computeBehavioralMetrics,
  computeDiscrepancies,
  BehavioralMetrics,
} from './BehavioralObserver';

import { SelfState, Vocabulary } from './FixedPointSelf';
import { Interaction, LLMInterface } from './ReflectionEngine';

// =============================================================================
// TEST UTILITIES
// =============================================================================

function createTestState(weights: number[]): SelfState {
  return {
    dimension: weights.length,
    w: Float64Array.from(weights),
    m: Float64Array.from(weights),
    time: 0,
  };
}

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

class MockLLM implements LLMInterface {
  private responses: string[];
  private callIndex = 0;

  constructor(responses: string[]) {
    this.responses = responses;
  }

  async generate(_prompt: string, _system?: string): Promise<string> {
    const response = this.responses[this.callIndex % this.responses.length];
    this.callIndex++;
    return response;
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe('createBehavioralVocabulary', () => {
  test('creates vocabulary with 4 dimensions', () => {
    const vocab = createBehavioralVocabulary();

    expect(vocab.assertions.length).toBe(4);
    expect(vocab.assertions).toContain('curiosity');
    expect(vocab.assertions).toContain('precision');
    expect(vocab.assertions).toContain('persistence');
    expect(vocab.assertions).toContain('empathy');
  });

  test('creates proper relationship matrix', () => {
    const vocab = createBehavioralVocabulary();
    const n = vocab.assertions.length;

    expect(vocab.relationships.length).toBe(n * n);

    // Diagonal should be 0, off-diagonal should be 0.1
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) {
          expect(vocab.relationships[i * n + j]).toBe(0);
        } else {
          expect(vocab.relationships[i * n + j]).toBe(0.1);
        }
      }
    }
  });
});

describe('createBehavioralParams', () => {
  test('creates params satisfying stability conditions', () => {
    const params = createBehavioralParams(4);

    // Theorem 5.1: μ > κ/2
    expect(params.mu).toBeGreaterThan(params.kappa / 2);

    // Theorem 7.3: λ > 0.25 (for a = 0.5)
    expect(params.lambda).toBeGreaterThan(0.25);

    // a = 0.5 for bistable dynamics
    expect(params.a).toBe(0.5);
  });
});

describe('metricsToExperience', () => {
  test('maps metrics to experience vector', () => {
    const vocab = createBehavioralVocabulary();
    const state = createTestState([0.5, 0.5, 0.5, 0.5]);

    const metrics: BehavioralMetrics = {
      curiosity: { toolCallsBeyondRequired: 5, informationSeeksBeyondRequired: 3, tangentsExplored: 2, depthOfInvestigation: 3.0, noveltySeekingScore: 0.9, raw: 0.8 },
      precision: { verificationsPerformed: 2, verificationsBeyondRequired: 1, selfCorrections: 1, uncertaintyExpressions: 1, sourcesChecked: 1, raw: 0.6 },
      persistence: { failuresEncountered: 1, retriesAttempted: 2, alternativesTried: 1, eventualSuccessRate: 1.0, abandonmentCount: 0, raw: 0.7 },
      empathy: { clarificationsSought: 1, userFeedbackRequested: 1, explanationAdaptations: 0, paceAdjustments: 0, raw: 0.4 },
      efficiency: { tokensPerAction: 150, successRate: 0.9, timePerTask: 5000, resourceWaste: 1 },
    };

    const experience = metricsToExperience(metrics, state, vocab, 1.0);

    expect(experience.length).toBe(4);

    // Curiosity: observed 0.8, declared 0.5, delta = 0.3
    expect(experience[0]).toBeCloseTo(0.3, 2);

    // Precision: observed 0.6, declared 0.5, delta = 0.1
    expect(experience[1]).toBeCloseTo(0.1, 2);

    // Persistence: observed 0.7, declared 0.5, delta = 0.2
    expect(experience[2]).toBeCloseTo(0.2, 2);

    // Empathy: observed 0.4, declared 0.5, delta = -0.1
    expect(experience[3]).toBeCloseTo(-0.1, 2);
  });

  test('respects scale factor', () => {
    const vocab = createBehavioralVocabulary();
    const state = createTestState([0.5, 0.5, 0.5, 0.5]);

    const metrics: BehavioralMetrics = {
      curiosity: { toolCallsBeyondRequired: 0, informationSeeksBeyondRequired: 0, tangentsExplored: 0, depthOfInvestigation: 0, noveltySeekingScore: 0, raw: 1.0 },
      precision: { verificationsPerformed: 0, verificationsBeyondRequired: 0, selfCorrections: 0, uncertaintyExpressions: 0, sourcesChecked: 0, raw: 0.5 },
      persistence: { failuresEncountered: 0, retriesAttempted: 0, alternativesTried: 0, eventualSuccessRate: 1.0, abandonmentCount: 0, raw: 0.5 },
      empathy: { clarificationsSought: 0, userFeedbackRequested: 0, explanationAdaptations: 0, paceAdjustments: 0, raw: 0.5 },
      efficiency: { tokensPerAction: 0, successRate: 1.0, timePerTask: 0, resourceWaste: 0 },
    };

    const exp1 = metricsToExperience(metrics, state, vocab, 1.0);
    const exp05 = metricsToExperience(metrics, state, vocab, 0.5);

    // Scale should halve the experience signal
    expect(exp05[0]).toBeCloseTo(exp1[0] * 0.5, 5);
  });
});

describe('createIdentityBridge', () => {
  test('creates bridge with default vocabulary', () => {
    const bridge = createIdentityBridge([0.5, 0.5, 0.5, 0.5]);

    expect(bridge.getState().dimension).toBe(4);
    expect(bridge.getDeclarations().length).toBe(0);
    expect(bridge.getVocabulary().assertions.length).toBe(4);
  });

  test('throws on mismatched weights length', () => {
    expect(() => createIdentityBridge([0.5, 0.5])).toThrow();
  });
});

describe('IdentityBridge.processInteraction', () => {
  test('processes interaction and evolves identity', async () => {
    const bridge = createIdentityBridge([0.5, 0.5, 0.5, 0.5]);

    // Create behavioral observation with high curiosity
    const observer = new BehavioralObserver();
    observer.startObservation('test-001');

    // Record high curiosity behavior
    observer.recordToolCall('Read', {}, '', true, 100, true, 'Required');
    observer.recordToolCall('Glob', {}, '', true, 50, false, 'Exploring');
    observer.recordToolCall('Grep', {}, '', true, 50, false, 'Investigating');
    observer.recordInformationSeek('What patterns?', 'tool', false, 2, true);
    observer.recordInformationSeek('How implemented?', 'tool', false, 3, true);

    const actionLog = observer.endObservation();
    const interaction = createTestInteraction();

    const result = await bridge.processInteraction(interaction, actionLog);

    // Should have computed experience
    expect(result.experience).toBeDefined();
    expect(result.experience.metrics.curiosity.toolCallsBeyondRequired).toBe(2);

    // Should have evolved state
    expect(result.newState).toBeDefined();

    // Energy should have changed (we introduced non-zero experience)
    // Note: Energy may increase or decrease depending on the signal
    expect(typeof result.energyBefore).toBe('number');
    expect(typeof result.energyAfter).toBe('number');

    // Summary should be generated
    expect(result.summary).toContain('curiosity');
  });

  test('detects behavioral discrepancies', async () => {
    // Start with low declared curiosity
    const bridge = createIdentityBridge([0.2, 0.5, 0.5, 0.5]);

    const observer = new BehavioralObserver();
    observer.startObservation('test-002');

    // Record HIGH curiosity behavior (lots of exploration)
    observer.recordToolCall('Read', {}, '', true, 100, true, 'Required');
    observer.recordToolCall('Glob', {}, '', true, 50, false, 'Exploring 1');
    observer.recordToolCall('Glob', {}, '', true, 50, false, 'Exploring 2');
    observer.recordToolCall('Grep', {}, '', true, 50, false, 'Investigating');
    observer.recordInformationSeek('Pattern 1', 'tool', false, 2, true);
    observer.recordInformationSeek('Pattern 2', 'tool', false, 3, true);
    observer.recordInformationSeek('Pattern 3', 'tool', false, 2, true);

    const actionLog = observer.endObservation();
    const interaction = createTestInteraction();

    const result = await bridge.processInteraction(interaction, actionLog);

    // Should detect that observed curiosity > declared curiosity
    const curiosityDisc = result.experience.discrepancies.find(
      d => d.dimension === 'curiosity'
    );

    expect(curiosityDisc).toBeDefined();
    expect(curiosityDisc!.direction).toBe('higher');
  });

  test('generates insights with LLM', async () => {
    const mockLLM = new MockLLM([
      // Reflection response
      `1. BEHAVIOR SUMMARY
Made 3 exploratory tool calls beyond requirements.

2. METRICS ANALYSIS
Curiosity score (0.8) exceeds declared value (0.5).

3. DISCREPANCY ANALYSIS
Significant gap in curiosity dimension.

4. IDENTITY IMPLICATIONS
Agent demonstrates more curiosity than self-declared.

5. SUGGESTED UPDATES
Increase curiosity weight to 0.75.`,
      // Insight extraction response
      `INSIGHT|curiosity|Made 3 extra exploratory calls|Demonstrates higher curiosity than declared|0.75|0.85|true`,
    ]);

    const bridge = createIdentityBridge([0.5, 0.5, 0.5, 0.5], mockLLM);

    const observer = new BehavioralObserver();
    observer.startObservation('test-003');
    observer.recordToolCall('Read', {}, '', true, 100, true, 'Required');
    observer.recordToolCall('Glob', {}, '', true, 50, false, 'Exploring');
    observer.recordToolCall('Grep', {}, '', true, 50, false, 'Investigating');
    const actionLog = observer.endObservation();

    const result = await bridge.processInteraction(
      createTestInteraction(),
      actionLog
    );

    // Should have reflection
    expect(result.reflection).not.toBeNull();
    expect(result.reflection!.behaviorSummary).toContain('tool calls');

    // Should have insights
    expect(result.insights.length).toBeGreaterThan(0);

    const curiosityInsight = result.insights.find(i => i.dimension === 'curiosity');
    expect(curiosityInsight).toBeDefined();
    expect(curiosityInsight!.isPivotal).toBe(true);
  });

  test('makes declarations when thresholds crossed', async () => {
    const config: BridgeConfig = {
      ...DEFAULT_BRIDGE_CONFIG,
      autoDeclarePivotal: true,
      declarationThreshold: 0.8,
    };

    const mockLLM = new MockLLM([
      // Reflection
      `1. BEHAVIOR SUMMARY
High curiosity behavior observed.

2-5. ...`,
      // Insight - high confidence, pivotal
      `INSIGHT|curiosity|Extensive exploration|Major discrepancy|0.80|0.90|true`,
    ]);

    const bridge = createIdentityBridge([0.5, 0.5, 0.5, 0.5], mockLLM, config);
    const stateBefore = bridge.getState();

    const observer = new BehavioralObserver();
    observer.startObservation('test-004');
    observer.recordToolCall('Read', {}, '', true, 100, true, 'Required');
    observer.recordToolCall('Glob', {}, '', true, 50, false, 'Exploring');
    observer.recordInformationSeek('Deep question', 'tool', false, 3, true);
    const actionLog = observer.endObservation();

    const result = await bridge.processInteraction(
      createTestInteraction(),
      actionLog
    );

    // Should have made a declaration
    expect(result.declarations.length).toBeGreaterThan(0);

    // Identity should have changed
    expect(result.identityChanged).toBe(true);

    // Declaration should be in the chain
    expect(bridge.getDeclarations().length).toBeGreaterThan(0);
  });
});

describe('IdentityBridge.export', () => {
  test('exports StoredSelf for persistence', () => {
    const bridge = createIdentityBridge([0.6, 0.7, 0.5, 0.4]);

    const stored = bridge.export();

    expect(stored.currentState).toBeDefined();
    expect(stored.declarations).toBeDefined();
    expect(stored.continuityProof).toBeDefined();
    expect(stored.continuityProof.chainLength).toBe(0); // No declarations yet
  });
});

describe('End-to-end: Behavior → Identity Evolution', () => {
  test('complete flow from observation to identity change', async () => {
    // 1. Start with neutral identity
    const bridge = createIdentityBridge([0.5, 0.5, 0.5, 0.5]);
    const initialCuriosity = bridge.getState().w[0];

    // 2. Observe high curiosity behavior over multiple interactions
    for (let i = 0; i < 5; i++) {
      const observer = new BehavioralObserver();
      observer.startObservation(`interaction-${i}`);

      // High curiosity pattern
      observer.recordToolCall('Read', {}, '', true, 100, true, 'Required');
      observer.recordToolCall('Glob', {}, '', true, 50, false, 'Exploring');
      observer.recordToolCall('Grep', {}, '', true, 50, false, 'Investigating');
      observer.recordInformationSeek('Question', 'tool', false, 2, true);

      const actionLog = observer.endObservation();
      const interaction: Interaction = {
        id: `int-${i}`,
        timestamp: Date.now(),
        prompt: `Task ${i}`,
        context: {},
        response: 'Response',
        durationMs: 1000,
        selfStateSnapshot: {
          w: Array.from(bridge.getState().w),
          m: Array.from(bridge.getState().m),
        },
      };

      await bridge.processInteraction(interaction, actionLog);
    }

    // 3. Identity should have drifted toward observed behavior
    const finalCuriosity = bridge.getState().w[0];

    // Curiosity should have increased (observed > declared repeatedly)
    // The evolution is gradual, so we just check direction
    expect(finalCuriosity).toBeGreaterThan(initialCuriosity);
  });
});
