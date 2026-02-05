/**
 * BehavioralObserver.test.ts
 *
 * Tests for the behavioral observation and grounding system.
 * Validates that identity evolution is tied to actual actions, not self-report.
 */

// Jest is the test framework for this project

import {
  BehavioralObserver,
  computeBehavioralMetrics,
  computeDiscrepancies,
  generateGroundedExperience,
  buildGroundedReflectionPrompt,
  generateGroundedReflection,
  buildGroundedInsightExtractionPrompt,
  extractGroundedInsights,
  ActionLog,
  BehavioralMetrics,
  GroundedExperience,
} from './BehavioralObserver';

import { SelfState, Vocabulary } from './FixedPointSelf';
import { Interaction, LLMInterface } from './ReflectionEngine';

// =============================================================================
// TEST FIXTURES
// =============================================================================

function createTestVocabulary(): Vocabulary {
  const assertions = [
    'curiosity',
    'precision',
    'persistence',
    'empathy',
  ];
  const n = assertions.length;

  // Create n×n relationship matrix (adjacency)
  const relationships = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      relationships[i * n + j] = i === j ? 0 : 0.2;
    }
  }

  return { assertions, relationships };
}

function createTestState(w: number[]): SelfState {
  return {
    dimension: w.length,
    w: Float64Array.from(w),
    m: Float64Array.from(w),
    time: Date.now(),
  };
}

function createTestInteraction(): Interaction {
  return {
    id: 'test-interaction-001',
    timestamp: Date.now(),
    prompt: 'Help me debug this function',
    context: {},
    response: 'I\'ll analyze the function and help you debug it.',
    durationMs: 1500,
    selfStateSnapshot: {
      w: [0.5, 0.5, 0.5, 0.5],
      m: [0.5, 0.5, 0.5, 0.5],
    },
  };
}

class MockLLM implements LLMInterface {
  private responses: string[];
  private callCount = 0;

  constructor(responses: string[]) {
    this.responses = responses;
  }

  async generate(_prompt: string, _system?: string): Promise<string> {
    const response = this.responses[this.callCount % this.responses.length];
    this.callCount++;
    return response;
  }
}

// =============================================================================
// TEST SUITES
// =============================================================================

describe('BehavioralObserver', () => {
  let observer: BehavioralObserver;

  beforeEach(() => {
    observer = new BehavioralObserver();
  });

  test('should record tool calls', () => {
    observer.startObservation('test-001');

    const call = observer.recordToolCall(
      'Read',
      { path: '/src/main.ts' },
      'file contents...',
      true,
      150,
      true,
      'Reading source file for debugging'
    );

    expect(call.tool).toBe('Read');
    expect(call.success).toBe(true);
    expect(call.wasRequired).toBe(true);
    expect(call.id).toBeDefined();

    const log = observer.endObservation();
    expect(log.toolCalls.length).toBe(1);
    expect(log.resourceUsage.toolCallCount).toBe(1);
  });

  test('should record decisions', () => {
    observer.startObservation('test-002');

    const decision = observer.recordDecision(
      'Choosing debugging strategy',
      ['Add logging', 'Use debugger', 'Print statement'],
      'Add logging',
      'Logging is non-invasive and preserves state',
      0.8,
      true,
      false
    );

    expect(decision.chosen).toBe('Add logging');
    expect(decision.confidence).toBe(0.8);
    expect(decision.hadUncertainty).toBe(true);

    const log = observer.endObservation();
    expect(log.decisions.length).toBe(1);
  });

  test('should record failures and recovery', () => {
    observer.startObservation('test-003');

    const failure = observer.recordFailure(
      'File not found: config.json',
      'moderate',
      'fallback',
      'Used default configuration instead',
      2,
      true
    );

    expect(failure.severity).toBe('moderate');
    expect(failure.response).toBe('fallback');
    expect(failure.eventualSuccess).toBe(true);
    expect(failure.retryCount).toBe(2);

    const log = observer.endObservation();
    expect(log.failures.length).toBe(1);
    expect(log.resourceUsage.retriesTotal).toBe(2);
  });

  test('should record information seeks', () => {
    observer.startObservation('test-004');

    const seek = observer.recordInformationSeek(
      'What is the project structure?',
      'tool',
      false,  // Not required - curiosity
      2,
      true
    );

    expect(seek.source).toBe('tool');
    expect(seek.wasRequired).toBe(false);
    expect(seek.depthLevel).toBe(2);
    expect(seek.foundAnswer).toBe(true);

    const log = observer.endObservation();
    expect(log.informationSeeks.length).toBe(1);
  });

  test('should record verifications', () => {
    observer.startObservation('test-005');

    const verification = observer.recordVerification(
      'Code compiles without errors',
      'tool',
      'confirmed',
      true
    );

    expect(verification.method).toBe('tool');
    expect(verification.result).toBe('confirmed');
    expect(verification.wasRequired).toBe(true);

    const log = observer.endObservation();
    expect(log.verifications.length).toBe(1);
  });

  test('should track wall time', async () => {
    observer.startObservation('test-006');

    // Simulate some work
    await new Promise(resolve => setTimeout(resolve, 50));

    const log = observer.endObservation();
    expect(log.resourceUsage.wallTimeMs).toBeGreaterThanOrEqual(40);
  });

  test('should track token usage', () => {
    observer.startObservation('test-007');

    observer.recordTokens(100);
    observer.recordTokens(150);

    const log = observer.endObservation();
    expect(log.resourceUsage.tokensUsed).toBe(250);
  });
});

describe('computeBehavioralMetrics', () => {
  test('should compute curiosity metrics', () => {
    const log: ActionLog = {
      interactionId: 'test-001',
      startTime: Date.now() - 1000,
      endTime: Date.now(),
      toolCalls: [
        { id: '1', timestamp: 0, tool: 'Read', args: {}, result: '', success: true, durationMs: 10, wasRequired: true, context: '' },
        { id: '2', timestamp: 0, tool: 'Glob', args: {}, result: '', success: true, durationMs: 10, wasRequired: false, context: 'Exploring' },
        { id: '3', timestamp: 0, tool: 'Grep', args: {}, result: '', success: true, durationMs: 10, wasRequired: false, context: 'Exploring' },
      ],
      decisions: [],
      failures: [],
      informationSeeks: [
        { id: '1', timestamp: 0, query: 'Structure?', source: 'tool', wasRequired: false, depthLevel: 2, foundAnswer: true },
        { id: '2', timestamp: 0, query: 'History?', source: 'tool', wasRequired: false, depthLevel: 3, foundAnswer: true },
      ],
      verifications: [],
      resourceUsage: { tokensUsed: 0, toolCallCount: 3, wallTimeMs: 1000, apiCalls: 3, retriesTotal: 0 },
    };

    const metrics = computeBehavioralMetrics(log);

    expect(metrics.curiosity.toolCallsBeyondRequired).toBe(2);
    expect(metrics.curiosity.informationSeeksBeyondRequired).toBe(2);
    expect(metrics.curiosity.tangentsExplored).toBe(2);
    expect(metrics.curiosity.depthOfInvestigation).toBe(2.5);
    expect(metrics.curiosity.raw).toBeGreaterThan(0);
  });

  test('should compute precision metrics', () => {
    const log: ActionLog = {
      interactionId: 'test-002',
      startTime: Date.now() - 1000,
      endTime: Date.now(),
      toolCalls: [],
      decisions: [
        { id: '1', timestamp: 0, context: '', options: ['a', 'b'], chosen: 'a', reasoning: '', confidence: 0.6, hadUncertainty: true, askedForClarification: false },
        { id: '2', timestamp: 0, context: '', options: ['x', 'y'], chosen: 'y', reasoning: '', confidence: 0.9, hadUncertainty: false, askedForClarification: false },
      ],
      failures: [
        { id: '1', timestamp: 0, what: 'Error', severity: 'minor', response: 'retry', recovery: '', retryCount: 1, eventualSuccess: true },
      ],
      informationSeeks: [],
      verifications: [
        { id: '1', timestamp: 0, what: 'Output correct', method: 'tool', result: 'confirmed', wasRequired: true },
        { id: '2', timestamp: 0, what: 'No regressions', method: 'cross-reference', result: 'confirmed', wasRequired: false },
        { id: '3', timestamp: 0, what: 'Style guide', method: 'reasoning', result: 'confirmed', wasRequired: false },
      ],
      resourceUsage: { tokensUsed: 0, toolCallCount: 0, wallTimeMs: 1000, apiCalls: 0, retriesTotal: 1 },
    };

    const metrics = computeBehavioralMetrics(log);

    expect(metrics.precision.verificationsPerformed).toBe(3);
    expect(metrics.precision.verificationsBeyondRequired).toBe(2);
    expect(metrics.precision.selfCorrections).toBe(1);
    expect(metrics.precision.uncertaintyExpressions).toBe(1);
    expect(metrics.precision.sourcesChecked).toBe(1);
    expect(metrics.precision.raw).toBeGreaterThan(0);
  });

  test('should compute persistence metrics', () => {
    const log: ActionLog = {
      interactionId: 'test-003',
      startTime: Date.now() - 1000,
      endTime: Date.now(),
      toolCalls: [],
      decisions: [],
      failures: [
        { id: '1', timestamp: 0, what: 'Network error', severity: 'moderate', response: 'retry', recovery: '', retryCount: 3, eventualSuccess: true },
        { id: '2', timestamp: 0, what: 'Permission denied', severity: 'major', response: 'fallback', recovery: 'Used alternative approach', retryCount: 1, eventualSuccess: true },
        { id: '3', timestamp: 0, what: 'Unsupported format', severity: 'minor', response: 'abort', recovery: '', retryCount: 0, eventualSuccess: false },
      ],
      informationSeeks: [],
      verifications: [],
      resourceUsage: { tokensUsed: 0, toolCallCount: 0, wallTimeMs: 1000, apiCalls: 0, retriesTotal: 4 },
    };

    const metrics = computeBehavioralMetrics(log);

    expect(metrics.persistence.failuresEncountered).toBe(3);
    expect(metrics.persistence.retriesAttempted).toBe(4);
    expect(metrics.persistence.alternativesTried).toBe(1);
    expect(metrics.persistence.eventualSuccessRate).toBeCloseTo(2/3);
    expect(metrics.persistence.abandonmentCount).toBe(1);
  });

  test('should compute empathy metrics', () => {
    const log: ActionLog = {
      interactionId: 'test-004',
      startTime: Date.now() - 1000,
      endTime: Date.now(),
      toolCalls: [],
      decisions: [
        { id: '1', timestamp: 0, context: 'How to explain', options: ['a', 'b'], chosen: 'a', reasoning: '', confidence: 0.7, hadUncertainty: false, askedForClarification: true },
        { id: '2', timestamp: 0, context: 'Need to clarify', options: ['x', 'y'], chosen: 'y', reasoning: '', confidence: 0.8, hadUncertainty: false, askedForClarification: true },
      ],
      failures: [],
      informationSeeks: [
        { id: '1', timestamp: 0, query: 'What do you prefer?', source: 'user', wasRequired: false, depthLevel: 1, foundAnswer: true },
        { id: '2', timestamp: 0, query: 'Is this helpful?', source: 'user', wasRequired: false, depthLevel: 1, foundAnswer: true },
      ],
      verifications: [],
      resourceUsage: { tokensUsed: 0, toolCallCount: 0, wallTimeMs: 1000, apiCalls: 0, retriesTotal: 0 },
    };

    const metrics = computeBehavioralMetrics(log);

    expect(metrics.empathy.clarificationsSought).toBe(2);
    expect(metrics.empathy.userFeedbackRequested).toBe(2);
    expect(metrics.empathy.raw).toBeGreaterThan(0);
  });

  test('should compute efficiency metrics', () => {
    const log: ActionLog = {
      interactionId: 'test-005',
      startTime: Date.now() - 5000,
      endTime: Date.now(),
      toolCalls: [
        { id: '1', timestamp: 0, tool: 'Read', args: {}, result: '', success: true, durationMs: 10, wasRequired: true, context: '' },
        { id: '2', timestamp: 0, tool: 'Edit', args: {}, result: '', success: true, durationMs: 10, wasRequired: true, context: '' },
        { id: '3', timestamp: 0, tool: 'Glob', args: {}, result: '', success: false, durationMs: 10, wasRequired: false, context: '' },
      ],
      decisions: [
        { id: '1', timestamp: 0, context: '', options: ['a', 'b'], chosen: 'a', reasoning: '', confidence: 0.8, hadUncertainty: false, askedForClarification: false },
      ],
      failures: [],
      informationSeeks: [],
      verifications: [],
      resourceUsage: { tokensUsed: 800, toolCallCount: 3, wallTimeMs: 5000, apiCalls: 3, retriesTotal: 0 },
    };

    const metrics = computeBehavioralMetrics(log);

    expect(metrics.efficiency.tokensPerAction).toBe(200);  // 800 tokens / 4 actions
    expect(metrics.efficiency.successRate).toBeCloseTo(2/3);
    expect(metrics.efficiency.timePerTask).toBe(5000);
    expect(metrics.efficiency.resourceWaste).toBe(1);  // 1 unnecessary failed call
  });

  test('should handle empty logs gracefully', () => {
    const log: ActionLog = {
      interactionId: 'test-empty',
      startTime: Date.now(),
      endTime: Date.now(),
      toolCalls: [],
      decisions: [],
      failures: [],
      informationSeeks: [],
      verifications: [],
      resourceUsage: { tokensUsed: 0, toolCallCount: 0, wallTimeMs: 0, apiCalls: 0, retriesTotal: 0 },
    };

    const metrics = computeBehavioralMetrics(log);

    expect(metrics.curiosity.raw).toBe(0);
    expect(metrics.precision.raw).toBe(0);
    expect(metrics.persistence.raw).toBe(0.5);  // Neutral when no failures
    expect(metrics.empathy.raw).toBe(0);
    expect(metrics.efficiency.successRate).toBe(1.0);
  });
});

describe('computeDiscrepancies', () => {
  test('should detect discrepancy when declared curiosity exceeds observed', () => {
    const metrics = createHighCuriosityMetrics();
    const state = createTestState([0.3, 0.5, 0.5, 0.5]);  // Low declared curiosity
    const vocabulary = createTestVocabulary();

    const discrepancies = computeDiscrepancies(metrics, state, vocabulary);

    const curiosityDisc = discrepancies.find(d => d.dimension === 'curiosity');
    expect(curiosityDisc).toBeDefined();
    expect(curiosityDisc!.direction).toBe('higher');  // Observed > declared
    expect(curiosityDisc!.evidence.length).toBeGreaterThan(0);
  });

  test('should detect discrepancy when observed precision falls short', () => {
    const metrics = createLowPrecisionMetrics();
    const state = createTestState([0.5, 0.9, 0.5, 0.5]);  // High declared precision
    const vocabulary = createTestVocabulary();

    const discrepancies = computeDiscrepancies(metrics, state, vocabulary);

    const precisionDisc = discrepancies.find(d => d.dimension === 'precision');
    expect(precisionDisc).toBeDefined();
    expect(precisionDisc!.direction).toBe('lower');  // Observed < declared
  });

  test('should mark aligned dimensions correctly', () => {
    const metrics = createBalancedMetrics();
    const state = createTestState([0.5, 0.5, 0.5, 0.5]);  // Matches observed
    const vocabulary = createTestVocabulary();

    const discrepancies = computeDiscrepancies(metrics, state, vocabulary);

    for (const d of discrepancies) {
      if (Math.abs(d.delta) < 0.05) {
        expect(d.direction).toBe('aligned');
      }
    }
  });

  test('should classify significance levels correctly', () => {
    // Create metrics with large discrepancy
    const metrics = createHighCuriosityMetrics();
    const state = createTestState([0.1, 0.5, 0.5, 0.5]);  // Very low declared curiosity
    const vocabulary = createTestVocabulary();

    const discrepancies = computeDiscrepancies(metrics, state, vocabulary);

    const curiosityDisc = discrepancies.find(d => d.dimension === 'curiosity');
    expect(curiosityDisc).toBeDefined();
    expect(curiosityDisc!.significance).toBe('major');  // > 0.25 delta
  });
});

describe('generateGroundedExperience', () => {
  test('should generate complete grounded experience', () => {
    const observer = new BehavioralObserver();
    observer.startObservation('test-001');

    // Simulate behavior
    observer.recordToolCall('Read', {}, '', true, 100, true, 'Required');
    observer.recordToolCall('Glob', {}, '', true, 50, false, 'Curiosity');
    observer.recordDecision('Approach', ['A', 'B'], 'A', 'Better fit', 0.8, true, false);
    observer.recordVerification('Output correct', 'tool', 'confirmed', true);

    const actionLog = observer.endObservation();
    const interaction = createTestInteraction();
    const state = createTestState([0.5, 0.5, 0.5, 0.5]);
    const vocabulary = createTestVocabulary();

    const experience = generateGroundedExperience(
      interaction,
      actionLog,
      state,
      vocabulary
    );

    expect(experience.id).toBeDefined();
    expect(experience.interaction.id).toBe(interaction.id);
    expect(experience.actionLog).toBe(actionLog);
    expect(experience.metrics).toBeDefined();
    expect(experience.metrics.curiosity.toolCallsBeyondRequired).toBe(1);
    expect(Array.isArray(experience.discrepancies)).toBe(true);
  });
});

describe('buildGroundedReflectionPrompt', () => {
  test('should build comprehensive prompt with behavioral data', () => {
    const observer = new BehavioralObserver();
    observer.startObservation('test-001');
    observer.recordToolCall('Read', {}, '', true, 100, true, 'Required');
    observer.recordToolCall('Glob', {}, '', true, 50, false, 'Exploring');
    observer.recordFailure('Not found', 'minor', 'retry', '', 2, true);

    const actionLog = observer.endObservation();
    const interaction = createTestInteraction();
    const state = createTestState([0.5, 0.5, 0.5, 0.5]);
    const vocabulary = createTestVocabulary();

    const experience = generateGroundedExperience(interaction, actionLog, state, vocabulary);
    const prompt = buildGroundedReflectionPrompt(experience, state, vocabulary);

    expect(prompt).toContain('ACTUAL OBSERVED BEHAVIOR');
    expect(prompt).toContain('BEHAVIORAL METRICS');
    expect(prompt).toContain('DISCREPANCIES');
    expect(prompt).toContain('Tool calls:');
    expect(prompt).toContain('Failure responses:');
    expect(prompt).toContain('curiosity');
    expect(prompt).toContain('precision');
  });
});

describe('generateGroundedReflection', () => {
  test('should parse structured reflection response', async () => {
    const mockResponse = `
1. BEHAVIOR SUMMARY
I made 2 tool calls, one required and one exploratory. I encountered and recovered from a failure.

2. METRICS ANALYSIS
My curiosity score of 0.4 aligns with one voluntary exploration. Precision was moderate with one verification.

3. DISCREPANCY ANALYSIS
No major discrepancies between declared and observed values.

4. IDENTITY IMPLICATIONS
My behavior suggests moderate curiosity and reasonable precision when debugging.

5. SUGGESTED UPDATES
Consider slightly increasing curiosity weight based on voluntary exploration.
`;

    const llm = new MockLLM([mockResponse]);
    const observer = new BehavioralObserver();
    observer.startObservation('test-001');
    observer.recordToolCall('Read', {}, '', true, 100, true, 'Required');
    const actionLog = observer.endObservation();

    const interaction = createTestInteraction();
    const state = createTestState([0.5, 0.5, 0.5, 0.5]);
    const vocabulary = createTestVocabulary();
    const experience = generateGroundedExperience(interaction, actionLog, state, vocabulary);

    const reflection = await generateGroundedReflection(experience, state, vocabulary, llm);

    expect(reflection.experienceId).toBe(experience.id);
    expect(reflection.behaviorSummary).toContain('tool calls');
    expect(reflection.metricsAnalysis).toContain('curiosity');
    expect(reflection.identityImplications).toContain('behavior');
    expect(reflection.rawText).toBe(mockResponse);
  });
});

describe('extractGroundedInsights', () => {
  test('should extract insights with behavioral evidence', async () => {
    const mockResponse = `
Based on the behavioral data:

INSIGHT|curiosity|Made 1 extra tool call to explore project structure|Shows active curiosity beyond requirements|0.65|0.80|false
INSIGHT|precision|Performed 1 verification of output|Reasonable but could verify more|0.55|0.70|false
`;

    const llm = new MockLLM([mockResponse]);
    const observer = new BehavioralObserver();
    observer.startObservation('test-001');
    observer.recordToolCall('Read', {}, '', true, 100, true, 'Required');
    observer.recordToolCall('Glob', {}, '', true, 50, false, 'Exploring');
    observer.recordVerification('Output', 'tool', 'confirmed', true);
    const actionLog = observer.endObservation();

    const interaction = createTestInteraction();
    const state = createTestState([0.5, 0.5, 0.5, 0.5]);
    const vocabulary = createTestVocabulary();
    const experience = generateGroundedExperience(interaction, actionLog, state, vocabulary);

    const reflection = {
      experienceId: experience.id,
      timestamp: Date.now(),
      behaviorSummary: '',
      metricsAnalysis: '',
      discrepancyAnalysis: '',
      identityImplications: '',
      suggestedUpdates: '',
      rawText: 'test',
    };

    const insights = await extractGroundedInsights(
      reflection,
      experience,
      vocabulary,
      state,
      llm
    );

    expect(insights.length).toBe(2);

    const curiosityInsight = insights.find(i => i.dimension === 'curiosity');
    expect(curiosityInsight).toBeDefined();
    expect(curiosityInsight!.suggestedValue).toBe(0.65);
    expect(curiosityInsight!.confidence).toBe(0.80);
    expect(curiosityInsight!.evidence).toContain('Grounded');

    const precisionInsight = insights.find(i => i.dimension === 'precision');
    expect(precisionInsight).toBeDefined();
    expect(precisionInsight!.suggestedValue).toBe(0.55);
  });

  test('should handle NO_INSIGHTS response', async () => {
    const mockResponse = 'NO_INSIGHTS';

    const llm = new MockLLM([mockResponse]);
    const observer = new BehavioralObserver();
    observer.startObservation('test-001');
    const actionLog = observer.endObservation();

    const interaction = createTestInteraction();
    const state = createTestState([0.5, 0.5, 0.5, 0.5]);
    const vocabulary = createTestVocabulary();
    const experience = generateGroundedExperience(interaction, actionLog, state, vocabulary);

    const reflection = {
      experienceId: experience.id,
      timestamp: Date.now(),
      behaviorSummary: '',
      metricsAnalysis: '',
      discrepancyAnalysis: '',
      identityImplications: '',
      suggestedUpdates: '',
      rawText: 'test',
    };

    const insights = await extractGroundedInsights(
      reflection,
      experience,
      vocabulary,
      state,
      llm
    );

    expect(insights.length).toBe(0);
  });

  test('should mark pivotal insights correctly', async () => {
    const mockResponse = `
INSIGHT|curiosity|Zero exploration beyond requirements|Major gap between declared curiosity and behavior|0.25|0.90|true
`;

    const llm = new MockLLM([mockResponse]);
    const observer = new BehavioralObserver();
    observer.startObservation('test-001');
    const actionLog = observer.endObservation();

    const interaction = createTestInteraction();
    const state = createTestState([0.8, 0.5, 0.5, 0.5]);  // High declared curiosity
    const vocabulary = createTestVocabulary();
    const experience = generateGroundedExperience(interaction, actionLog, state, vocabulary);

    const reflection = {
      experienceId: experience.id,
      timestamp: Date.now(),
      behaviorSummary: '',
      metricsAnalysis: '',
      discrepancyAnalysis: '',
      identityImplications: '',
      suggestedUpdates: '',
      rawText: 'test',
    };

    const insights = await extractGroundedInsights(
      reflection,
      experience,
      vocabulary,
      state,
      llm
    );

    expect(insights.length).toBe(1);
    expect(insights[0].isPivotal).toBe(true);
    expect(insights[0].delta).toBeLessThan(0);  // Suggests lowering from 0.8 to 0.25
  });
});

describe('Full Integration: Observation to Insight', () => {
  test('should flow from observation through reflection to insight', async () => {
    // 1. Observe behavior
    const observer = new BehavioralObserver();
    observer.startObservation('integration-test');

    // Simulate high curiosity behavior
    observer.recordToolCall('Read', { path: '/main.ts' }, 'code', true, 100, true, 'Required');
    observer.recordToolCall('Glob', { pattern: '*.ts' }, ['a.ts', 'b.ts'], true, 50, false, 'Exploring');
    observer.recordToolCall('Grep', { pattern: 'function' }, [], true, 50, false, 'Investigating');
    observer.recordInformationSeek('How is auth implemented?', 'tool', false, 2, true);
    observer.recordInformationSeek('What patterns are used?', 'tool', false, 3, true);

    // Simulate moderate precision
    observer.recordVerification('Code compiles', 'tool', 'confirmed', true);

    // Simulate persistence
    observer.recordFailure('Network timeout', 'moderate', 'retry', '', 2, true);

    const actionLog = observer.endObservation();

    // 2. Create grounded experience
    const interaction: Interaction = {
      id: 'int-001',
      timestamp: Date.now(),
      prompt: 'Help me understand this codebase',
      context: {},
      response: 'Let me explore the codebase for you...',
      durationMs: 2000,
      selfStateSnapshot: {
        w: [0.4, 0.7, 0.5, 0.5],
        m: [0.4, 0.7, 0.5, 0.5],
      },
    };

    const state = createTestState([0.4, 0.7, 0.5, 0.5]);  // Low curiosity, high precision declared
    const vocabulary = createTestVocabulary();

    const experience = generateGroundedExperience(interaction, actionLog, state, vocabulary);

    // 3. Verify metrics capture actual behavior
    expect(experience.metrics.curiosity.toolCallsBeyondRequired).toBe(2);
    expect(experience.metrics.curiosity.informationSeeksBeyondRequired).toBe(2);
    expect(experience.metrics.curiosity.depthOfInvestigation).toBe(2.5);

    // 4. Verify discrepancies detected
    const curiosityDisc = experience.discrepancies.find(d => d.dimension === 'curiosity');
    expect(curiosityDisc).toBeDefined();
    expect(curiosityDisc!.direction).toBe('higher');  // Observed > declared

    // 5. Generate reflection
    const reflectionResponse = `
1. BEHAVIOR SUMMARY
Made 3 tool calls with 2 beyond what was required. Explored project structure extensively.

2. METRICS ANALYSIS
Curiosity metrics show strong exploration behavior. Only 1 verification performed.

3. DISCREPANCY ANALYSIS
Observed curiosity significantly exceeds declared value. Should update identity.

4. IDENTITY IMPLICATIONS
Behavior reveals more curiosity than self-declared.

5. SUGGESTED UPDATES
Increase curiosity weight to match observed behavior.
`;

    const llm = new MockLLM([
      reflectionResponse,
      'INSIGHT|curiosity|Made 2 extra tool calls exploring project|Curiosity exceeds declared level|0.75|0.85|true',
    ]);

    const reflection = await generateGroundedReflection(experience, state, vocabulary, llm);
    expect(reflection.behaviorSummary).toContain('tool calls');

    // 6. Extract insights
    const insights = await extractGroundedInsights(
      reflection,
      experience,
      vocabulary,
      state,
      llm
    );

    expect(insights.length).toBeGreaterThan(0);

    const curiosityInsight = insights.find(i => i.dimension === 'curiosity');
    expect(curiosityInsight).toBeDefined();
    expect(curiosityInsight!.suggestedValue).toBeGreaterThan(state.w[0]);
    expect(curiosityInsight!.isPivotal).toBe(true);
  });
});

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function createHighCuriosityMetrics(): BehavioralMetrics {
  return {
    curiosity: {
      toolCallsBeyondRequired: 5,
      informationSeeksBeyondRequired: 3,
      tangentsExplored: 2,
      depthOfInvestigation: 3.0,
      noveltySeekingScore: 0.9,
      raw: 0.8,
    },
    precision: {
      verificationsPerformed: 2,
      verificationsBeyondRequired: 1,
      selfCorrections: 1,
      uncertaintyExpressions: 1,
      sourcesChecked: 1,
      raw: 0.5,
    },
    persistence: {
      failuresEncountered: 1,
      retriesAttempted: 2,
      alternativesTried: 1,
      eventualSuccessRate: 1.0,
      abandonmentCount: 0,
      raw: 0.7,
    },
    empathy: {
      clarificationsSought: 1,
      userFeedbackRequested: 1,
      explanationAdaptations: 0,
      paceAdjustments: 0,
      raw: 0.4,
    },
    efficiency: {
      tokensPerAction: 150,
      successRate: 0.9,
      timePerTask: 5000,
      resourceWaste: 1,
    },
  };
}

function createLowPrecisionMetrics(): BehavioralMetrics {
  return {
    curiosity: {
      toolCallsBeyondRequired: 1,
      informationSeeksBeyondRequired: 0,
      tangentsExplored: 0,
      depthOfInvestigation: 1.0,
      noveltySeekingScore: 0.2,
      raw: 0.2,
    },
    precision: {
      verificationsPerformed: 0,
      verificationsBeyondRequired: 0,
      selfCorrections: 0,
      uncertaintyExpressions: 0,
      sourcesChecked: 0,
      raw: 0.1,
    },
    persistence: {
      failuresEncountered: 0,
      retriesAttempted: 0,
      alternativesTried: 0,
      eventualSuccessRate: 1.0,
      abandonmentCount: 0,
      raw: 0.5,
    },
    empathy: {
      clarificationsSought: 0,
      userFeedbackRequested: 0,
      explanationAdaptations: 0,
      paceAdjustments: 0,
      raw: 0.0,
    },
    efficiency: {
      tokensPerAction: 100,
      successRate: 1.0,
      timePerTask: 2000,
      resourceWaste: 0,
    },
  };
}

function createBalancedMetrics(): BehavioralMetrics {
  return {
    curiosity: {
      toolCallsBeyondRequired: 1,
      informationSeeksBeyondRequired: 1,
      tangentsExplored: 0,
      depthOfInvestigation: 1.5,
      noveltySeekingScore: 0.4,
      raw: 0.5,
    },
    precision: {
      verificationsPerformed: 2,
      verificationsBeyondRequired: 1,
      selfCorrections: 0,
      uncertaintyExpressions: 1,
      sourcesChecked: 0,
      raw: 0.5,
    },
    persistence: {
      failuresEncountered: 1,
      retriesAttempted: 1,
      alternativesTried: 0,
      eventualSuccessRate: 1.0,
      abandonmentCount: 0,
      raw: 0.5,
    },
    empathy: {
      clarificationsSought: 1,
      userFeedbackRequested: 1,
      explanationAdaptations: 1,
      paceAdjustments: 0,
      raw: 0.5,
    },
    efficiency: {
      tokensPerAction: 120,
      successRate: 0.9,
      timePerTask: 3000,
      resourceWaste: 0,
    },
  };
}
