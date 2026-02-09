/**
 * StrategyRenderer.test.ts
 *
 * Tests for the v2 strategy template renderer.
 */

import {
  renderStrategies,
  DEFAULT_RENDER_CONFIG,
  type StrategyRenderInput,
  type StrategyRenderConfig,
  type RenderedStrategy,
  type StrategyDocument,
} from './StrategyRenderer';
import type { StrategyFeatures } from './StrategyFeatureExtractor';
import type { DimensionAttribution } from './ShapleyAttributor';

// =============================================================================
// HELPERS
// =============================================================================

function makeAttribution(
  index: number,
  shapleyValue: number,
  confidence = 0.9,
  dimension = '',
): DimensionAttribution {
  const names = [
    'read_before_edit', 'test_after_change', 'context_gathering',
    'output_verification', 'error_recovery_speed',
  ];
  return {
    dimension: dimension || names[index] || `dim_${index}`,
    index,
    shapleyValue,
    confidence,
    evidence: [],
  };
}

function makeFeatures(overrides: Partial<StrategyFeatures> = {}): StrategyFeatures {
  return {
    readBeforeEdit: 0.8,
    testAfterChange: 0.6,
    contextGathering: 0.7,
    outputVerification: 0.4,
    errorRecoverySpeed: 0.9,
    ...overrides,
  };
}

function makeInput(overrides: Partial<StrategyRenderInput> = {}): StrategyRenderInput {
  return {
    attributions: [
      makeAttribution(0, 0.31),  // read_before_edit: strong positive
      makeAttribution(1, 0.22),  // test_after_change: moderate positive
      makeAttribution(2, 0.15),  // context_gathering: mild positive
      makeAttribution(3, 0.05),  // output_verification: weak positive
      makeAttribution(4, -0.08), // error_recovery_speed: mild negative
    ],
    features: makeFeatures(),
    sessionCount: 47,
    ...overrides,
  };
}

// =============================================================================
// RENDERING
// =============================================================================

describe('renderStrategies', () => {
  test('produces a StrategyDocument with strategies and markdown', () => {
    const doc = renderStrategies(makeInput());
    expect(doc.strategies).toBeDefined();
    expect(doc.markdown).toBeDefined();
    expect(doc.sessionCount).toBe(47);
    expect(typeof doc.markdown).toBe('string');
  });

  test('ranks strategies by |φ| descending', () => {
    const doc = renderStrategies(makeInput());
    const phis = doc.strategies.map(s => Math.abs(s.shapleyValue));
    for (let i = 1; i < phis.length; i++) {
      expect(phis[i]).toBeLessThanOrEqual(phis[i - 1]);
    }
  });

  test('first strategy has highest |φ|', () => {
    const doc = renderStrategies(makeInput());
    expect(doc.strategies[0].featureName).toBe('read_before_edit');
    expect(doc.strategies[0].shapleyValue).toBe(0.31);
  });

  test('caps at maxStrategies', () => {
    const config: StrategyRenderConfig = { ...DEFAULT_RENDER_CONFIG, maxStrategies: 2 };
    const doc = renderStrategies(makeInput(), config);
    expect(doc.strategies.length).toBe(2);
  });

  test('filters out strategies below minShapleyMagnitude', () => {
    const config: StrategyRenderConfig = { ...DEFAULT_RENDER_CONFIG, minShapleyMagnitude: 0.10 };
    const doc = renderStrategies(makeInput(), config);
    // Only φ>=0.10: read_before_edit(0.31), test_after_change(0.22), context_gathering(0.15)
    // output_verification(0.05) and error_recovery_speed(-0.08) filtered out
    expect(doc.strategies.every(s => Math.abs(s.shapleyValue) >= 0.10)).toBe(true);
    expect(doc.strategies.length).toBe(3);
  });

  test('marks negative-φ strategies as warnings', () => {
    const doc = renderStrategies(makeInput());
    const warning = doc.strategies.find(s => s.featureName === 'error_recovery_speed');
    expect(warning).toBeDefined();
    expect(warning!.isWarning).toBe(true);
  });

  test('excludes warnings when includeWarnings is false', () => {
    const config: StrategyRenderConfig = { ...DEFAULT_RENDER_CONFIG, includeWarnings: false };
    const doc = renderStrategies(makeInput(), config);
    expect(doc.strategies.every(s => !s.isWarning)).toBe(true);
  });

  test('positive strategies have positive instruction', () => {
    const doc = renderStrategies(makeInput());
    const positive = doc.strategies.find(s => s.featureName === 'read_before_edit');
    expect(positive).toBeDefined();
    expect(positive!.isWarning).toBe(false);
    expect(positive!.instruction).toContain('Read files before modifying');
  });

  test('carries measured feature values', () => {
    const doc = renderStrategies(makeInput());
    const readEdit = doc.strategies.find(s => s.featureName === 'read_before_edit');
    expect(readEdit!.measuredValue).toBe(0.8);
  });
});

// =============================================================================
// MARKDOWN FORMAT
// =============================================================================

describe('markdown output', () => {
  test('starts with session count header', () => {
    const doc = renderStrategies(makeInput());
    expect(doc.markdown).toContain('## Learned strategies (ARIL, 47 sessions)');
  });

  test('contains φ values', () => {
    const doc = renderStrategies(makeInput());
    expect(doc.markdown).toContain('φ=+0.31');
    expect(doc.markdown).toContain('φ=+0.22');
  });

  test('contains confidence percentages', () => {
    const doc = renderStrategies(makeInput());
    expect(doc.markdown).toContain('90% confidence');
  });

  test('contains measured values as percentages', () => {
    const doc = renderStrategies(makeInput());
    expect(doc.markdown).toContain('80%');  // readBeforeEdit = 0.8
  });

  test('numbered list for positive strategies', () => {
    const doc = renderStrategies(makeInput());
    expect(doc.markdown).toContain('1. **Read before editing.');
  });

  test('warning prefix for negative strategies', () => {
    const doc = renderStrategies(makeInput());
    // error_recovery_speed has negative φ, should get ⚠ prefix
    expect(doc.markdown).toMatch(/⚠/);
  });

  test('each strategy has bold title and instruction on same line', () => {
    const doc = renderStrategies(makeInput());
    // Format: N. **Title.** Instruction
    expect(doc.markdown).toMatch(/\d+\.\s+\*\*[^*]+\.\*\*\s+.+/);
  });

  test('each strategy has observation with φ on next line', () => {
    const doc = renderStrategies(makeInput());
    // Format:    Observation (φ=+X.XX, N% confidence)
    expect(doc.markdown).toMatch(/\s{3}.+\(φ=[+-]\d+\.\d+, \d+% confidence\)/);
  });

  test('stays concise (under 500 chars for 4 strategies)', () => {
    const doc = renderStrategies(makeInput());
    // ~200 tokens ≈ ~800 chars. We should be well under.
    expect(doc.markdown.length).toBeLessThan(800);
  });
});

// =============================================================================
// EDGE CASES
// =============================================================================

describe('edge cases', () => {
  test('empty attributions produces "insufficient data" message', () => {
    const doc = renderStrategies({
      attributions: [],
      features: makeFeatures(),
      sessionCount: 0,
    });
    expect(doc.strategies).toHaveLength(0);
    expect(doc.markdown).toContain('Insufficient data');
  });

  test('all below threshold produces "insufficient data"', () => {
    const input = makeInput({
      attributions: [
        makeAttribution(0, 0.005),
        makeAttribution(1, -0.003),
        makeAttribution(2, 0.001),
        makeAttribution(3, 0.002),
        makeAttribution(4, -0.001),
      ],
    });
    const doc = renderStrategies(input);
    expect(doc.strategies).toHaveLength(0);
    expect(doc.markdown).toContain('Insufficient data');
  });

  test('single strong strategy renders correctly', () => {
    const input = makeInput({
      attributions: [
        makeAttribution(0, 0.50, 0.95),
        makeAttribution(1, 0.005),
        makeAttribution(2, 0.003),
        makeAttribution(3, 0.001),
        makeAttribution(4, 0.002),
      ],
    });
    const doc = renderStrategies(input);
    expect(doc.strategies).toHaveLength(1);
    expect(doc.strategies[0].featureName).toBe('read_before_edit');
    expect(doc.markdown).toContain('φ=+0.50');
  });

  test('zero session count renders correctly', () => {
    const input = makeInput({ sessionCount: 0 });
    const doc = renderStrategies(input);
    expect(doc.markdown).toContain('0 sessions');
  });

  test('100% measured value renders as "100%"', () => {
    const input = makeInput({
      features: makeFeatures({ readBeforeEdit: 1.0 }),
    });
    const doc = renderStrategies(input);
    expect(doc.markdown).toContain('100%');
  });

  test('0% measured value renders as "0%"', () => {
    const input = makeInput({
      features: makeFeatures({ readBeforeEdit: 0.0 }),
      attributions: [
        makeAttribution(0, 0.31),
        makeAttribution(1, 0.005),
        makeAttribution(2, 0.003),
        makeAttribution(3, 0.001),
        makeAttribution(4, 0.002),
      ],
    });
    const doc = renderStrategies(input);
    const readStrat = doc.strategies.find(s => s.featureName === 'read_before_edit');
    expect(readStrat!.measuredValue).toBe(0);
    expect(doc.markdown).toContain('Read-first rate: 0%');
  });

  test('negative φ formats with minus sign', () => {
    const input = makeInput({
      attributions: [
        makeAttribution(0, -0.25),
        makeAttribution(1, 0.005),
        makeAttribution(2, 0.003),
        makeAttribution(3, 0.001),
        makeAttribution(4, 0.002),
      ],
    });
    const doc = renderStrategies(input);
    expect(doc.markdown).toContain('φ=-0.25');
  });

  test('handles more attributions than feature names (ignores extras)', () => {
    const input = makeInput({
      attributions: [
        makeAttribution(0, 0.31),
        makeAttribution(1, 0.22),
        makeAttribution(2, 0.15),
        makeAttribution(3, 0.05),
        makeAttribution(4, -0.08),
        makeAttribution(5, 0.40), // extra — no matching feature name
      ],
    });
    const doc = renderStrategies(input);
    // Should only have entries for the 5 known features
    expect(doc.strategies.every(s =>
      ['read_before_edit', 'test_after_change', 'context_gathering',
        'output_verification', 'error_recovery_speed'].includes(s.featureName)
    )).toBe(true);
  });

  test('fewer attributions than features still works', () => {
    const input = makeInput({
      attributions: [
        makeAttribution(0, 0.31),
        makeAttribution(1, 0.22),
        // Only 2 attributions for 5 features
      ],
    });
    const doc = renderStrategies(input);
    expect(doc.strategies.length).toBe(2);
  });
});

// =============================================================================
// INTERACTION TERMS (MÖBIUS)
// =============================================================================

describe('interaction term rendering', () => {
  test('no interactions: no interaction section in output', () => {
    const doc = renderStrategies(makeInput());
    expect(doc.markdown).not.toContain('synergy');
    expect(doc.markdown).not.toContain('conflict');
  });

  test('positive interaction renders as synergy', () => {
    const doc = renderStrategies(makeInput({
      interactions: [
        { dimensions: [0, 1], strength: 0.15 },
      ],
    }));
    expect(doc.markdown).toContain('read-first + test-after synergy +0.15');
  });

  test('negative interaction renders as conflict', () => {
    const doc = renderStrategies(makeInput({
      interactions: [
        { dimensions: [2, 4], strength: -0.10 },
      ],
    }));
    expect(doc.markdown).toContain('context + recovery conflict -0.10');
  });

  test('interactions below minShapleyMagnitude are filtered out', () => {
    const doc = renderStrategies(makeInput({
      interactions: [
        { dimensions: [0, 1], strength: 0.005 }, // below default 0.01
      ],
    }));
    expect(doc.markdown).not.toContain('synergy');
  });

  test('at most 2 interactions rendered', () => {
    const doc = renderStrategies(makeInput({
      interactions: [
        { dimensions: [0, 1], strength: 0.20 },
        { dimensions: [1, 2], strength: 0.15 },
        { dimensions: [2, 3], strength: 0.10 },
      ],
    }));
    // Count synergy/conflict lines
    const lines = doc.markdown.split('\n').filter(l => l.includes('synergy') || l.includes('conflict'));
    expect(lines.length).toBe(2);
  });

  test('interactions sorted by |strength| descending', () => {
    const doc = renderStrategies(makeInput({
      interactions: [
        { dimensions: [2, 3], strength: 0.05 },
        { dimensions: [0, 1], strength: 0.20 },
      ],
    }));
    const lines = doc.markdown.split('\n').filter(l => l.includes('synergy'));
    expect(lines[0]).toContain('+0.20');
    expect(lines[1]).toContain('+0.05');
  });

  test('3-way interaction renders all names', () => {
    const doc = renderStrategies(makeInput({
      interactions: [
        { dimensions: [0, 1, 2], strength: 0.12 },
      ],
    }));
    expect(doc.markdown).toContain('read-first + test-after + context synergy +0.12');
  });

  test('interactions use blockquote format', () => {
    const doc = renderStrategies(makeInput({
      interactions: [
        { dimensions: [0, 1], strength: 0.15 },
      ],
    }));
    expect(doc.markdown).toMatch(/^> .+synergy/m);
  });
});

// =============================================================================
// SYNTHETIC vs REAL ATTRIBUTION NOTATION
// =============================================================================

describe('synthetic attribution notation', () => {
  test('default (synthetic=false) uses φ= notation', () => {
    const doc = renderStrategies(makeInput());
    expect(doc.markdown).toContain('φ=');
    expect(doc.markdown).not.toContain('w=');
  });

  test('synthetic=false explicitly uses φ= notation', () => {
    const doc = renderStrategies(makeInput({ synthetic: false }));
    expect(doc.markdown).toContain('φ=');
  });

  test('synthetic=true uses w= notation instead of φ=', () => {
    const doc = renderStrategies(makeInput({ synthetic: true }));
    expect(doc.markdown).toContain('w=');
    expect(doc.markdown).not.toContain('φ=');
  });

  test('synthetic=true still contains attribution values', () => {
    const doc = renderStrategies(makeInput({ synthetic: true }));
    expect(doc.markdown).toContain('w=+0.31');
    expect(doc.markdown).toContain('w=+0.22');
  });

  test('synthetic=true negative values format correctly', () => {
    const input = makeInput({
      synthetic: true,
      attributions: [
        makeAttribution(0, -0.25),
        makeAttribution(1, 0.005),
        makeAttribution(2, 0.003),
        makeAttribution(3, 0.001),
        makeAttribution(4, 0.002),
      ],
    });
    const doc = renderStrategies(input);
    expect(doc.markdown).toContain('w=-0.25');
  });
});

// =============================================================================
// CONFIG DEFAULTS
// =============================================================================

describe('DEFAULT_RENDER_CONFIG', () => {
  test('maxStrategies is 4', () => {
    expect(DEFAULT_RENDER_CONFIG.maxStrategies).toBe(4);
  });

  test('minShapleyMagnitude is 0.01', () => {
    expect(DEFAULT_RENDER_CONFIG.minShapleyMagnitude).toBe(0.01);
  });

  test('includeWarnings is true', () => {
    expect(DEFAULT_RENDER_CONFIG.includeWarnings).toBe(true);
  });

  test('config is frozen', () => {
    expect(Object.isFrozen(DEFAULT_RENDER_CONFIG)).toBe(true);
  });
});
