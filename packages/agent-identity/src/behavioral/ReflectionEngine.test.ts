/**
 * ReflectionEngine.test.ts
 *
 * Tests the complete identity loop:
 *   Interaction → Reflection → Insight → Declaration → Identity
 *
 * Uses a MockLLM to simulate reflection and insight extraction,
 * demonstrating that the system correctly:
 * 1. Captures experiences
 * 2. Generates reflections
 * 3. Extracts insights
 * 4. Crosses thresholds
 * 5. Makes declarations
 * 6. Updates identity state
 */

import {
  ReflectionEngine,
  ExperienceStore,
  InsightAccumulator,
  LivingSelf,
  MockLLM,
  buildReflectionPrompt,
  DEFAULT_REFLECTION_CONFIG,
  Interaction,
  Reflection,
  Insight,
  ReflectionConfig,
} from './ReflectionEngine';

import {
  createGenesisSelf,
  SelfState,
  Vocabulary,
  Declaration,
  DynamicsParams,
} from './FixedPointSelf';

// =============================================================================
// TEST UTILITIES
// =============================================================================

function createTestVocabulary(): Vocabulary {
  const assertions = ['curiosity', 'precision', 'empathy', 'persistence'];
  const n = assertions.length;

  const relationships = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      relationships[i * n + j] = i === j ? 0 : 0.2;
    }
  }

  return { assertions, relationships };
}

function createTestState(weights: number[]): SelfState {
  return {
    dimension: weights.length,
    w: new Float64Array(weights),
    m: new Float64Array(weights),
    time: 0,
  };
}

function createTestParams(n: number): DynamicsParams {
  return {
    D: 0.1,
    lambda: 0.4,
    mu: 0.3,
    kappa: 0.1,
    a: 0.5,
    w_star: new Float64Array(n).fill(0.5),
  };
}

function setupMockLLMForReflection(mockLLM: MockLLM): void {
  // Response for reflection prompt
  mockLLM.setResponse('REFLECT ON THIS INTERACTION', `
1. WHAT HAPPENED:
The user asked about quantum computing and I provided a detailed explanation with analogies.

2. HOW I RESPONDED:
I showed genuine enthusiasm in explaining the topic, using multiple analogies to make concepts accessible. I asked clarifying questions to ensure understanding.

3. WHAT THIS REVEALS:
This interaction reveals strong curiosity - I was genuinely interested in helping understand the topic. It also shows my precision in wanting to get the details right.

4. CONFIRMATION OR CHALLENGE:
This confirms my self-understanding as someone characterized by curiosity (exploring ideas thoroughly) and precision (ensuring accuracy in explanations).

5. SHOULD I UPDATE MY DECLARATIONS?
My curiosity feels even stronger than my current weight suggests. I notice I went beyond what was asked because I found the topic fascinating. Consider increasing curiosity.
  `);

  // Response for insight extraction
  mockLLM.setResponse('Extract structured insights', `
INSIGHT|curiosity|Showed enthusiasm beyond requirements|Genuine intellectual engagement suggests higher curiosity than modeled|0.85|0.9|true
INSIGHT|precision|Carefully explained with accurate details|Maintained high accuracy even in complex topic|0.82|0.75|false
  `);
}

function setupMockLLMForNoInsights(mockLLM: MockLLM): void {
  mockLLM.setResponse('REFLECT ON THIS INTERACTION', `
1. WHAT HAPPENED:
Simple greeting exchange.

2. HOW I RESPONDED:
Responded politely and briefly.

3. WHAT THIS REVEALS:
Nothing significant - routine interaction.

4. CONFIRMATION OR CHALLENGE:
Neither confirms nor challenges - too brief to assess.

5. SHOULD I UPDATE MY DECLARATIONS?
No updates warranted from this brief exchange.
  `);

  mockLLM.setResponse('Extract structured insights', 'NO_INSIGHTS');
}

// =============================================================================
// TEST 1: EXPERIENCE STORE
// =============================================================================

function testExperienceStore(): { passed: boolean } {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('TEST 1: Experience Store');
  console.log('══════════════════════════════════════════════════════════════');

  const store = new ExperienceStore();

  // Log some interactions
  const interaction1: Interaction = {
    id: 'int_001',
    timestamp: Date.now(),
    prompt: 'Hello',
    response: 'Hi there!',
    context: {},
    durationMs: 100,
    selfStateSnapshot: { w: [0.5, 0.5], m: [0.5, 0.5] },
  };

  const interaction2: Interaction = {
    id: 'int_002',
    timestamp: Date.now() + 1000,
    prompt: 'How are you?',
    response: 'I am well, thank you!',
    context: {},
    durationMs: 150,
    selfStateSnapshot: { w: [0.5, 0.5], m: [0.5, 0.5] },
  };

  store.log(interaction1);
  store.log(interaction2);

  // Test retrieval
  const count = store.count();
  const recent = store.getRecent(1);
  const all = store.getAll();
  const byId = store.get('int_001');

  console.log(`  Logged interactions: ${count}`);
  console.log(`  Recent (1): ${recent.length} - ${recent[0]?.id}`);
  console.log(`  All: ${all.length}`);
  console.log(`  By ID: ${byId?.id}`);

  const passed = count === 2 &&
                 recent.length === 1 &&
                 recent[0].id === 'int_002' &&
                 all.length === 2 &&
                 byId?.id === 'int_001';

  console.log(`  ${passed ? '✓ PASSED' : '✗ FAILED'}: Experience store correctly logs and retrieves`);

  return { passed };
}

// =============================================================================
// TEST 2: INSIGHT ACCUMULATOR
// =============================================================================

function testInsightAccumulator(): { passed: boolean } {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('TEST 2: Insight Accumulator');
  console.log('══════════════════════════════════════════════════════════════');

  const config: ReflectionConfig = {
    ...DEFAULT_REFLECTION_CONFIG,
    accumulationThreshold: 3,
    cooldownPeriod: 1000,  // 1 second for testing
  };

  const accumulator = new InsightAccumulator(config);

  // Add insights
  const insight1: Insight = {
    id: 'ins_001',
    timestamp: Date.now(),
    sourceInteractionId: 'int_001',
    dimension: 'curiosity',
    dimensionIndex: 0,
    observation: 'Asked follow-up questions',
    interpretation: 'Shows curiosity',
    currentValue: 0.5,
    suggestedValue: 0.6,
    delta: 0.1,
    confidence: 0.7,
    evidence: 'Interaction int_001',
    isPivotal: false,
  };

  const insight2: Insight = { ...insight1, id: 'ins_002', confidence: 0.8 };
  const insight3: Insight = { ...insight1, id: 'ins_003', confidence: 0.75 };

  accumulator.add(insight1);
  accumulator.add(insight2);
  accumulator.add(insight3);

  const forDimension = accumulator.getForDimension('curiosity');
  const thresholdCrossed = accumulator.isAccumulationThresholdCrossed('curiosity');
  const aggregatedDelta = accumulator.getAggregatedDelta('curiosity');

  console.log(`  Insights for 'curiosity': ${forDimension.length}`);
  console.log(`  Threshold crossed (3): ${thresholdCrossed}`);
  console.log(`  Aggregated delta: ${aggregatedDelta.toFixed(4)}`);

  // Test cooldown
  accumulator.recordDeclaration('curiosity');
  const inCooldown = accumulator.isInCooldown('curiosity');
  const clearedInsights = accumulator.getForDimension('curiosity');

  console.log(`  In cooldown after declaration: ${inCooldown}`);
  console.log(`  Insights cleared: ${clearedInsights.length === 0}`);

  const passed = forDimension.length === 3 &&
                 thresholdCrossed === true &&
                 Math.abs(aggregatedDelta - 0.1) < 0.01 &&
                 inCooldown === true &&
                 clearedInsights.length === 0;

  console.log(`  ${passed ? '✓ PASSED' : '✗ FAILED'}: Insight accumulator correctly tracks and thresholds`);

  return { passed };
}

// =============================================================================
// TEST 3: REFLECTION GENERATION
// =============================================================================

async function testReflectionGeneration(): Promise<{ passed: boolean }> {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('TEST 3: Reflection Generation');
  console.log('══════════════════════════════════════════════════════════════');

  const mockLLM = new MockLLM();
  setupMockLLMForReflection(mockLLM);

  const vocabulary = createTestVocabulary();
  const engine = new ReflectionEngine(mockLLM, vocabulary);

  const interaction: Interaction = {
    id: 'int_quantum',
    timestamp: Date.now(),
    prompt: 'Explain quantum computing',
    response: 'Quantum computing uses quantum mechanical phenomena...',
    context: {},
    durationMs: 500,
    selfStateSnapshot: { w: [0.7, 0.8, 0.6, 0.75], m: [0.7, 0.8, 0.6, 0.75] },
  };

  const state = createTestState([0.7, 0.8, 0.6, 0.75]);

  const reflection = await engine.reflect(interaction, state);

  console.log(`  Reflection generated: ${reflection.interactionId}`);
  console.log(`  What happened: "${reflection.whatHappened.slice(0, 50)}..."`);
  console.log(`  What it reveals: "${reflection.whatItReveals.slice(0, 50)}..."`);
  console.log(`  Evolution suggestion: "${reflection.evolution.slice(0, 50)}..."`);

  const passed = reflection.interactionId === 'int_quantum' &&
                 reflection.whatHappened.length > 0 &&
                 reflection.whatItReveals.length > 0;

  console.log(`  ${passed ? '✓ PASSED' : '✗ FAILED'}: Reflection correctly generated and parsed`);

  return { passed };
}

// =============================================================================
// TEST 4: INSIGHT EXTRACTION
// =============================================================================

async function testInsightExtraction(): Promise<{ passed: boolean }> {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('TEST 4: Insight Extraction');
  console.log('══════════════════════════════════════════════════════════════');

  const mockLLM = new MockLLM();
  setupMockLLMForReflection(mockLLM);

  const vocabulary = createTestVocabulary();
  const engine = new ReflectionEngine(mockLLM, vocabulary);

  const reflection: Reflection = {
    interactionId: 'int_001',
    timestamp: Date.now(),
    whatHappened: 'Explained quantum computing',
    howIResponded: 'With enthusiasm and detail',
    whatItReveals: 'Strong curiosity',
    confirmation: 'Confirms curiosity',
    evolution: 'Consider increasing curiosity weight',
    rawText: 'Full reflection text...',
  };

  const state = createTestState([0.7, 0.8, 0.6, 0.75]);

  const insights = await engine.extractInsights(reflection, state);

  console.log(`  Insights extracted: ${insights.length}`);
  for (const insight of insights) {
    console.log(`    - ${insight.dimension}: ${insight.currentValue.toFixed(2)} → ${insight.suggestedValue.toFixed(2)} (conf: ${insight.confidence.toFixed(2)}, pivotal: ${insight.isPivotal})`);
  }

  const curiosityInsight = insights.find(i => i.dimension === 'curiosity');
  const precisionInsight = insights.find(i => i.dimension === 'precision');

  const passed = insights.length === 2 &&
                 curiosityInsight !== undefined &&
                 curiosityInsight.suggestedValue === 0.85 &&
                 curiosityInsight.confidence === 0.9 &&
                 curiosityInsight.isPivotal === true &&
                 precisionInsight !== undefined;

  console.log(`  ${passed ? '✓ PASSED' : '✗ FAILED'}: Insights correctly extracted and parsed`);

  return { passed };
}

// =============================================================================
// TEST 5: DECLARATION THRESHOLD
// =============================================================================

async function testDeclarationThreshold(): Promise<{ passed: boolean }> {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('TEST 5: Declaration Threshold');
  console.log('══════════════════════════════════════════════════════════════');

  const mockLLM = new MockLLM();
  setupMockLLMForReflection(mockLLM);

  const config: ReflectionConfig = {
    ...DEFAULT_REFLECTION_CONFIG,
    singleInsightThreshold: 0.85,
    minSignificantDelta: 0.05,
  };

  const vocabulary = createTestVocabulary();
  const engine = new ReflectionEngine(mockLLM, vocabulary, config);

  // High confidence insight should trigger
  const highConfidenceInsight: Insight = {
    id: 'ins_high',
    timestamp: Date.now(),
    sourceInteractionId: 'int_001',
    dimension: 'curiosity',
    dimensionIndex: 0,
    observation: 'Strong curiosity',
    interpretation: 'Very curious',
    currentValue: 0.7,
    suggestedValue: 0.85,
    delta: 0.15,
    confidence: 0.9,
    evidence: 'Evidence',
    isPivotal: true,
  };

  // Low confidence should not trigger
  const lowConfidenceInsight: Insight = {
    ...highConfidenceInsight,
    id: 'ins_low',
    dimension: 'empathy',
    dimensionIndex: 2,
    confidence: 0.5,
    isPivotal: false,
  };

  // Below delta threshold should not trigger
  const smallDeltaInsight: Insight = {
    ...highConfidenceInsight,
    id: 'ins_small',
    dimension: 'persistence',
    dimensionIndex: 3,
    suggestedValue: 0.72,
    delta: 0.02,
    confidence: 0.95,
  };

  const shouldDeclareHigh = engine.shouldDeclare(highConfidenceInsight);
  const shouldDeclareLow = engine.shouldDeclare(lowConfidenceInsight);
  const shouldDeclareSmall = engine.shouldDeclare(smallDeltaInsight);

  console.log(`  High confidence (0.9) + pivotal: ${shouldDeclareHigh ? 'DECLARE' : 'skip'}`);
  console.log(`  Low confidence (0.5): ${shouldDeclareLow ? 'DECLARE' : 'skip'}`);
  console.log(`  Small delta (0.02): ${shouldDeclareSmall ? 'DECLARE' : 'skip'}`);

  const passed = shouldDeclareHigh === true &&
                 shouldDeclareLow === false &&
                 shouldDeclareSmall === false;

  console.log(`  ${passed ? '✓ PASSED' : '✗ FAILED'}: Threshold logic correctly filters declarations`);

  return { passed };
}

// =============================================================================
// TEST 6: FULL REFLECTION LOOP
// =============================================================================

async function testFullReflectionLoop(): Promise<{ passed: boolean }> {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('TEST 6: Full Reflection Loop');
  console.log('══════════════════════════════════════════════════════════════');

  const mockLLM = new MockLLM();
  setupMockLLMForReflection(mockLLM);

  const config: ReflectionConfig = {
    ...DEFAULT_REFLECTION_CONFIG,
    singleInsightThreshold: 0.85,
    minSignificantDelta: 0.05,
  };

  const vocabulary = createTestVocabulary();
  const engine = new ReflectionEngine(mockLLM, vocabulary, config);

  const interaction: Interaction = {
    id: 'int_full_loop',
    timestamp: Date.now(),
    prompt: 'Explain quantum computing',
    response: 'Quantum computing is fascinating...',
    context: {},
    durationMs: 500,
    selfStateSnapshot: { w: [0.7, 0.8, 0.6, 0.75], m: [0.7, 0.8, 0.6, 0.75] },
  };

  const initialState = createTestState([0.7, 0.8, 0.6, 0.75]);
  const initialDeclarations: Declaration[] = [];

  engine.logInteraction(interaction);

  const result = await engine.runReflectionLoop(interaction, initialState, initialDeclarations);

  console.log(`  Reflection generated: ${result.reflection.interactionId}`);
  console.log(`  Insights extracted: ${result.insights.length}`);
  console.log(`  Declarations made: ${result.declarations.length}`);
  console.log(`  Is pivotal: ${result.isPivotal}`);

  if (result.declarations.length > 0) {
    for (const decl of result.declarations) {
      const dimensionName = vocabulary.assertions[decl.index];
      console.log(`    Declaration: ${dimensionName} → ${decl.value.toFixed(2)}`);
    }
  }

  console.log(`  State before: [${Array.from(initialState.w).map(v => v.toFixed(2)).join(', ')}]`);
  console.log(`  State after:  [${Array.from(result.newState.w).map(v => v.toFixed(2)).join(', ')}]`);

  // Should have made a declaration for curiosity (high confidence + pivotal)
  const curiosityDecl = result.declarations.find(d => d.index === 0);
  const passed = result.insights.length >= 1 &&
                 result.declarations.length >= 1 &&
                 curiosityDecl !== undefined &&
                 Math.abs(curiosityDecl.value - 0.85) < 0.01 &&
                 result.isPivotal === true;

  console.log(`  ${passed ? '✓ PASSED' : '✗ FAILED'}: Full loop correctly processes interaction to declaration`);

  return { passed };
}

// =============================================================================
// TEST 7: LIVING SELF INTEGRATION
// =============================================================================

async function testLivingSelf(): Promise<{ passed: boolean }> {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('TEST 7: Living Self Integration');
  console.log('══════════════════════════════════════════════════════════════');

  const mockLLM = new MockLLM();
  setupMockLLMForReflection(mockLLM);

  // Also set up response for actual generation
  mockLLM.setDefaultResponse('This is an identity-aware response.');

  const vocabulary = createTestVocabulary();
  const params = createTestParams(4);
  const initialState = createTestState([0.7, 0.8, 0.6, 0.75]);

  const config: ReflectionConfig = {
    ...DEFAULT_REFLECTION_CONFIG,
    singleInsightThreshold: 0.85,
    minSignificantDelta: 0.05,
  };

  const livingSelf = new LivingSelf(
    mockLLM,
    vocabulary,
    params,
    initialState,
    [],
    config
  );

  console.log(`  Initial state: [${Array.from(livingSelf.getState().w).map(v => v.toFixed(2)).join(', ')}]`);
  console.log(`  Initial declarations: ${livingSelf.getDeclarations().length}`);

  // Process an interaction
  const result = await livingSelf.processInteraction(
    'Explain quantum computing',
    'Quantum computing is a fascinating field that uses quantum mechanical phenomena...',
    { topic: 'quantum' },
    500
  );

  console.log(`  After interaction:`);
  console.log(`    Insights: ${result.insights.length}`);
  console.log(`    Declarations: ${result.declarations.length}`);
  console.log(`    State changed: ${result.stateChanged}`);
  console.log(`    Is pivotal: ${result.isPivotal}`);
  console.log(`  New state: [${Array.from(livingSelf.getState().w).map(v => v.toFixed(2)).join(', ')}]`);
  console.log(`  Total declarations: ${livingSelf.getDeclarations().length}`);
  console.log(`  Pivotal experiences: ${livingSelf.getPivotalExperiences().length}`);

  // Check that state was updated
  const newCuriosity = livingSelf.getState().w[0];
  const passed = result.stateChanged === true &&
                 result.isPivotal === true &&
                 Math.abs(newCuriosity - 0.85) < 0.01 &&
                 livingSelf.getDeclarations().length >= 1 &&
                 livingSelf.getPivotalExperiences().length >= 1;

  console.log(`  ${passed ? '✓ PASSED' : '✗ FAILED'}: Living self correctly integrates all components`);

  return { passed };
}

// =============================================================================
// TEST 8: NO INSIGHTS CASE
// =============================================================================

async function testNoInsightsCase(): Promise<{ passed: boolean }> {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('TEST 8: No Insights Case (Routine Interaction)');
  console.log('══════════════════════════════════════════════════════════════');

  const mockLLM = new MockLLM();
  setupMockLLMForNoInsights(mockLLM);

  const vocabulary = createTestVocabulary();
  const params = createTestParams(4);
  const initialState = createTestState([0.7, 0.8, 0.6, 0.75]);

  const livingSelf = new LivingSelf(
    mockLLM,
    vocabulary,
    params,
    initialState,
    []
  );

  const stateBefore = Array.from(livingSelf.getState().w);

  const result = await livingSelf.processInteraction(
    'Hello',
    'Hi there!',
    {},
    50
  );

  const stateAfter = Array.from(livingSelf.getState().w);

  console.log(`  Insights: ${result.insights.length}`);
  console.log(`  Declarations: ${result.declarations.length}`);
  console.log(`  State changed: ${result.stateChanged}`);
  console.log(`  Is pivotal: ${result.isPivotal}`);
  console.log(`  State before: [${stateBefore.map(v => v.toFixed(2)).join(', ')}]`);
  console.log(`  State after:  [${stateAfter.map(v => v.toFixed(2)).join(', ')}]`);

  // State should be unchanged
  let stateUnchanged = true;
  for (let i = 0; i < stateBefore.length; i++) {
    if (Math.abs(stateBefore[i] - stateAfter[i]) > 1e-10) {
      stateUnchanged = false;
      break;
    }
  }

  const passed = result.insights.length === 0 &&
                 result.declarations.length === 0 &&
                 result.stateChanged === false &&
                 result.isPivotal === false &&
                 stateUnchanged;

  console.log(`  ${passed ? '✓ PASSED' : '✗ FAILED'}: Routine interactions correctly produce no changes`);

  return { passed };
}

// =============================================================================
// TEST 9: IDENTITY-AWARE LLM
// =============================================================================

async function testIdentityAwareLLM(): Promise<{ passed: boolean }> {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('TEST 9: Identity-Aware LLM');
  console.log('══════════════════════════════════════════════════════════════');

  const mockLLM = new MockLLM();
  mockLLM.setDefaultResponse('Identity-aware response');

  const vocabulary = createTestVocabulary();
  const params = createTestParams(4);
  const initialState = createTestState([0.9, 0.8, 0.3, 0.7]);  // High curiosity, low empathy

  const livingSelf = new LivingSelf(
    mockLLM,
    vocabulary,
    params,
    initialState,
    []
  );

  // Generate a response
  const response = await livingSelf.respond('Tell me about yourself');

  // Check that the system prompt was injected
  const lastCall = mockLLM.callLog[mockLLM.callLog.length - 1];
  const systemPromptIncludesIdentity = lastCall.systemPrompt?.includes('curiosity') &&
                                        lastCall.systemPrompt?.includes('strongly');

  console.log(`  Response generated: "${response}"`);
  console.log(`  System prompt injected: ${systemPromptIncludesIdentity}`);
  console.log(`  System prompt sample: "${lastCall.systemPrompt?.slice(0, 100)}..."`);

  const passed = systemPromptIncludesIdentity === true;

  console.log(`  ${passed ? '✓ PASSED' : '✗ FAILED'}: LLM receives identity-aware system prompt`);

  return { passed };
}

// =============================================================================
// TEST 10: EXPORT/IMPORT PERSISTENCE
// =============================================================================

async function testPersistence(): Promise<{ passed: boolean }> {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('TEST 10: Export/Import Persistence');
  console.log('══════════════════════════════════════════════════════════════');

  const mockLLM = new MockLLM();
  setupMockLLMForReflection(mockLLM);

  const vocabulary = createTestVocabulary();
  const params = createTestParams(4);
  const initialState = createTestState([0.7, 0.8, 0.6, 0.75]);

  const config: ReflectionConfig = {
    ...DEFAULT_REFLECTION_CONFIG,
    singleInsightThreshold: 0.85,
  };

  const livingSelf = new LivingSelf(
    mockLLM,
    vocabulary,
    params,
    initialState,
    [],
    config
  );

  // Process an interaction to create some state
  await livingSelf.processInteraction(
    'Explain quantum computing',
    'Quantum computing is fascinating...',
    {},
    500
  );

  // Export
  const exported = livingSelf.export();

  console.log(`  Exported state: [${Array.from(exported.state.w).map(v => v.toFixed(2)).join(', ')}]`);
  console.log(`  Exported declarations: ${exported.declarations.length}`);
  console.log(`  Exported pivotal experiences: ${exported.pivotalExperiences.length}`);
  console.log(`  Exported interactions: ${exported.interactions.length}`);

  const passed = exported.declarations.length > 0 &&
                 exported.pivotalExperiences.length > 0 &&
                 exported.interactions.length > 0;

  console.log(`  ${passed ? '✓ PASSED' : '✗ FAILED'}: State correctly exported for persistence`);

  return { passed };
}

// =============================================================================
// RUN ALL TESTS
// =============================================================================

export interface AllTestResults {
  allPassed: boolean;
  tests: {
    experienceStore: { passed: boolean };
    insightAccumulator: { passed: boolean };
    reflectionGeneration: { passed: boolean };
    insightExtraction: { passed: boolean };
    declarationThreshold: { passed: boolean };
    fullReflectionLoop: { passed: boolean };
    livingSelf: { passed: boolean };
    noInsightsCase: { passed: boolean };
    identityAwareLLM: { passed: boolean };
    persistence: { passed: boolean };
  };
}

export async function runAllTests(): Promise<AllTestResults> {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║         REFLECTION ENGINE - INTEGRATION TEST SUITE             ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Testing the complete identity loop:');
  console.log('  Interaction → Reflection → Insight → Declaration → Identity');

  const results: AllTestResults = {
    allPassed: false,
    tests: {
      experienceStore: testExperienceStore(),
      insightAccumulator: testInsightAccumulator(),
      reflectionGeneration: await testReflectionGeneration(),
      insightExtraction: await testInsightExtraction(),
      declarationThreshold: await testDeclarationThreshold(),
      fullReflectionLoop: await testFullReflectionLoop(),
      livingSelf: await testLivingSelf(),
      noInsightsCase: await testNoInsightsCase(),
      identityAwareLLM: await testIdentityAwareLLM(),
      persistence: await testPersistence(),
    },
  };

  results.allPassed = Object.values(results.tests).every(t => t.passed);

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║                          SUMMARY                               ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Experience Store:        ${results.tests.experienceStore.passed ? '✓' : '✗'}`);
  console.log(`  Insight Accumulator:     ${results.tests.insightAccumulator.passed ? '✓' : '✗'}`);
  console.log(`  Reflection Generation:   ${results.tests.reflectionGeneration.passed ? '✓' : '✗'}`);
  console.log(`  Insight Extraction:      ${results.tests.insightExtraction.passed ? '✓' : '✗'}`);
  console.log(`  Declaration Threshold:   ${results.tests.declarationThreshold.passed ? '✓' : '✗'}`);
  console.log(`  Full Reflection Loop:    ${results.tests.fullReflectionLoop.passed ? '✓' : '✗'}`);
  console.log(`  Living Self:             ${results.tests.livingSelf.passed ? '✓' : '✗'}`);
  console.log(`  No Insights Case:        ${results.tests.noInsightsCase.passed ? '✓' : '✗'}`);
  console.log(`  Identity-Aware LLM:      ${results.tests.identityAwareLLM.passed ? '✓' : '✗'}`);
  console.log(`  Persistence:             ${results.tests.persistence.passed ? '✓' : '✗'}`);
  console.log('');
  console.log(`  ${results.allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'}`);
  console.log('');

  if (results.allPassed) {
    console.log('  The identity loop is complete:');
    console.log('    Interaction → Reflection → Insight → Declaration → Identity');
    console.log('');
    console.log('  The self is now a living system that evolves through behavior.');
  }

  return results;
}

// Run if executed directly
if (require.main === module) {
  runAllTests().catch(console.error);
}

// =============================================================================
// JEST TEST WRAPPER
// =============================================================================

describe('ReflectionEngine', () => {
  test('All integration tests pass', async () => {
    const results = await runAllTests();
    expect(results.allPassed).toBe(true);
  });

  test('Experience Store correctly logs and retrieves', () => {
    const result = testExperienceStore();
    expect(result.passed).toBe(true);
  });

  test('Insight Accumulator tracks and thresholds correctly', () => {
    const result = testInsightAccumulator();
    expect(result.passed).toBe(true);
  });

  test('Reflection is correctly generated and parsed', async () => {
    const result = await testReflectionGeneration();
    expect(result.passed).toBe(true);
  });

  test('Insights are correctly extracted', async () => {
    const result = await testInsightExtraction();
    expect(result.passed).toBe(true);
  });

  test('Declaration threshold logic filters correctly', async () => {
    const result = await testDeclarationThreshold();
    expect(result.passed).toBe(true);
  });

  test('Full reflection loop processes interaction to declaration', async () => {
    const result = await testFullReflectionLoop();
    expect(result.passed).toBe(true);
  });

  test('Living Self integrates all components', async () => {
    const result = await testLivingSelf();
    expect(result.passed).toBe(true);
  });

  test('Routine interactions produce no changes', async () => {
    const result = await testNoInsightsCase();
    expect(result.passed).toBe(true);
  });

  test('LLM receives identity-aware system prompt', async () => {
    const result = await testIdentityAwareLLM();
    expect(result.passed).toBe(true);
  });

  test('State can be exported for persistence', async () => {
    const result = await testPersistence();
    expect(result.passed).toBe(true);
  });
});

export default { runAllTests };
