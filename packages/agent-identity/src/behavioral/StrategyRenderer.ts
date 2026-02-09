/**
 * StrategyRenderer.ts
 *
 * Renders ranked behavioral strategies into the hybrid procedural-instruction +
 * empirical-pattern format for `.aril/strategies.md`.
 *
 * Template-generated (no LLM call). The output activates BOTH procedural
 * instruction following AND few-shot ICL in the consuming model.
 *
 * Target: ~200 tokens. Behavioral guidance decays by turn 8 (Laban et al.,
 * COLM 2024), so shorter = higher adherence.
 *
 * Part of ARIL v2 (Strategy-Atom Architecture).
 */

import {
  STRATEGY_FEATURE_NAMES,
  type StrategyFeatureName,
  type StrategyFeatures,
} from './StrategyFeatureExtractor';
import type { DimensionAttribution } from './ShapleyAttributor';

// =============================================================================
// TYPES
// =============================================================================

/** A Möbius interaction term between two or more features. */
export interface InteractionTerm {
  /** Feature indices (e.g., [0, 1] for read_before_edit × test_after_change). */
  readonly dimensions: readonly number[];
  /** Interaction strength from Möbius μ({i,j}) coefficient. Positive = synergy. */
  readonly strength: number;
}

/** Input data for rendering strategies. */
export interface StrategyRenderInput {
  /** Per-feature Shapley attributions (ordered by STRATEGY_FEATURE_NAMES). */
  readonly attributions: readonly DimensionAttribution[];
  /** This session's measured feature values. */
  readonly features: StrategyFeatures;
  /** Number of ARIL sessions completed. */
  readonly sessionCount: number;
  /**
   * Whether attributions are synthetic (heuristic proxies, not real Shapley).
   * When true, uses honest "weight=" notation instead of "φ=" (Shapley symbol).
   * Default: false (real Shapley values).
   */
  readonly synthetic?: boolean;
  /**
   * Möbius interaction terms (pairwise or higher-order synergies/conflicts).
   * When present, the strongest interactions are rendered after individual strategies.
   * These come from the Möbius decomposition: μ({i,j}) coefficients for |T| ≥ 2.
   */
  readonly interactions?: readonly InteractionTerm[];
}

/** Configuration for rendering. */
export interface StrategyRenderConfig {
  /** Maximum strategies to include. Default: 4. */
  readonly maxStrategies: number;
  /** Minimum |φ| to include a strategy. Default: 0.01. */
  readonly minShapleyMagnitude: number;
  /** Include negative-impact strategies as warnings. Default: true. */
  readonly includeWarnings: boolean;
}

export const DEFAULT_RENDER_CONFIG: Readonly<StrategyRenderConfig> = Object.freeze({
  maxStrategies: 4,
  minShapleyMagnitude: 0.01,
  includeWarnings: true,
});

/** A single rendered strategy entry. */
export interface RenderedStrategy {
  readonly featureName: StrategyFeatureName;
  readonly title: string;
  readonly instruction: string;
  readonly observation: string;
  readonly shapleyValue: number;
  readonly confidence: number;
  readonly measuredValue: number;
  readonly isWarning: boolean;
}

/** Complete rendered output. */
export interface StrategyDocument {
  /** Ranked strategy entries. */
  readonly strategies: readonly RenderedStrategy[];
  /** Pre-formatted markdown for .aril/strategies.md. */
  readonly markdown: string;
  /** Number of sessions this is based on. */
  readonly sessionCount: number;
}

// =============================================================================
// STRATEGY TEMPLATES
// =============================================================================

interface StrategyTemplate {
  readonly title: string;
  /** Imperative instruction when the strategy has positive Shapley. */
  readonly positive: string;
  /** Warning instruction when the strategy has negative Shapley. */
  readonly negative: string;
  /** Generates an empirical observation from the measured value. */
  readonly observe: (value: number) => string;
}

const STRATEGY_TEMPLATES: Record<StrategyFeatureName, StrategyTemplate> = {
  read_before_edit: {
    title: 'Read before editing',
    positive: 'Read files before modifying them. Understand existing structure, then make targeted edits.',
    negative: 'Reading files before editing may not be helping. Consider more targeted reads.',
    observe: (v) => `Read-first rate: ${pct(v)}.`,
  },
  test_after_change: {
    title: 'Test after changes',
    positive: 'Run tests after code changes. Successful sessions follow an edit → test → fix cycle.',
    negative: 'Running tests after every change may be slowing progress. Consider batching edits.',
    observe: (v) => `Test-after-edit rate: ${pct(v)}.`,
  },
  context_gathering: {
    title: 'Gather context first',
    positive: 'Start with Grep/Glob/Read to understand the codebase before writing code.',
    negative: 'Heavy upfront exploration may not be productive. Consider exploring as needed.',
    observe: (v) => `Early exploration rate: ${pct(v)}.`,
  },
  output_verification: {
    title: 'Verify written files',
    positive: 'Read files back after writing to confirm correctness.',
    negative: 'Re-reading written files may be redundant. Trust the Write tool output.',
    observe: (v) => `Verification rate: ${pct(v)}.`,
  },
  error_recovery_speed: {
    title: 'Recover from errors quickly',
    positive: 'When a command fails, investigate the cause immediately and fix in few steps.',
    negative: 'Quick recovery attempts may not be thorough enough. Take more time to investigate.',
    observe: (v) => `Recovery efficiency: ${pct(v)}.`,
  },
};

// =============================================================================
// RENDERING
// =============================================================================

/**
 * Renders a StrategyDocument from attribution data and measured features.
 *
 * Strategies are ranked by |Shapley value| (most impactful first),
 * filtered by minimum magnitude, and capped at maxStrategies.
 */
export function renderStrategies(
  input: StrategyRenderInput,
  config: StrategyRenderConfig = DEFAULT_RENDER_CONFIG,
): StrategyDocument {
  const { attributions, features, sessionCount } = input;
  const featureValues = featuresToMap(features);

  // Build strategy entries from attributions
  const entries: RenderedStrategy[] = [];

  for (let i = 0; i < attributions.length && i < STRATEGY_FEATURE_NAMES.length; i++) {
    const attr = attributions[i];
    const featureName = STRATEGY_FEATURE_NAMES[i];
    const template = STRATEGY_TEMPLATES[featureName];
    const value = featureValues.get(featureName) ?? 0;
    const isWarning = attr.shapleyValue < 0;

    if (Math.abs(attr.shapleyValue) < config.minShapleyMagnitude) continue;
    if (isWarning && !config.includeWarnings) continue;

    entries.push({
      featureName,
      title: template.title,
      instruction: isWarning ? template.negative : template.positive,
      observation: template.observe(value),
      shapleyValue: attr.shapleyValue,
      confidence: attr.confidence,
      measuredValue: value,
      isWarning,
    });
  }

  // Sort by |φ| descending (most impactful first)
  entries.sort((a, b) => Math.abs(b.shapleyValue) - Math.abs(a.shapleyValue));

  // Cap at maxStrategies
  const strategies = entries.slice(0, config.maxStrategies);

  // Filter and sort interactions by |strength|, keep top 2
  const interactions = (input.interactions ?? [])
    .filter(t => Math.abs(t.strength) >= config.minShapleyMagnitude)
    .sort((a, b) => Math.abs(b.strength) - Math.abs(a.strength))
    .slice(0, 2);

  // Render markdown
  const markdown = formatMarkdown(strategies, sessionCount, input.synthetic ?? false, interactions);

  return { strategies, markdown, sessionCount };
}

/**
 * Formats strategies into the hybrid procedural+empirical markdown.
 *
 * Target: ~200 tokens. Each entry is 2 lines:
 *   1. **Title** + imperative instruction
 *   2. Empirical observation + Shapley value + confidence
 */
function formatMarkdown(
  strategies: readonly RenderedStrategy[],
  sessionCount: number,
  synthetic: boolean,
  interactions: readonly InteractionTerm[] = [],
): string {
  if (strategies.length === 0) {
    return `## Learned strategies (ARIL, ${sessionCount} sessions)\n\nInsufficient data. Strategies will appear after more sessions.\n`;
  }

  const lines: string[] = [
    `## Learned strategies (ARIL, ${sessionCount} sessions)`,
    '',
  ];

  for (let i = 0; i < strategies.length; i++) {
    const s = strategies[i];
    const prefix = s.isWarning ? '⚠' : `${i + 1}.`;
    const conf = Math.round(s.confidence * 100);

    // Use honest notation: φ= for real Shapley values, w= for synthetic proxies
    const attrLabel = synthetic
      ? `w=${formatPhi(s.shapleyValue)}`
      : `φ=${formatPhi(s.shapleyValue)}`;

    lines.push(`${prefix} **${s.title}.** ${s.instruction}`);
    lines.push(`   ${s.observation} (${attrLabel}, ${conf}% confidence)`);
  }

  // Render Möbius interaction terms (synergies/conflicts between strategies)
  if (interactions.length > 0) {
    lines.push('');
    for (const inter of interactions) {
      const names = inter.dimensions
        .filter(d => d < STRATEGY_FEATURE_NAMES.length)
        .map(d => featureShortName(STRATEGY_FEATURE_NAMES[d]));
      if (names.length < 2) continue;
      const label = inter.strength > 0 ? 'synergy' : 'conflict';
      lines.push(`> ${names.join(' + ')} ${label} ${formatPhi(inter.strength)}`);
    }
  }

  return lines.join('\n') + '\n';
}

/** Short human-readable name for a strategy feature. */
function featureShortName(name: StrategyFeatureName): string {
  const SHORT_NAMES: Record<StrategyFeatureName, string> = {
    read_before_edit: 'read-first',
    test_after_change: 'test-after',
    context_gathering: 'context',
    output_verification: 'verify',
    error_recovery_speed: 'recovery',
  };
  return SHORT_NAMES[name] ?? name;
}

// =============================================================================
// HELPERS
// =============================================================================

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function formatPhi(v: number): string {
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}`;
}

function featuresToMap(features: StrategyFeatures): Map<StrategyFeatureName, number> {
  const map = new Map<StrategyFeatureName, number>();
  map.set('read_before_edit', features.readBeforeEdit);
  map.set('test_after_change', features.testAfterChange);
  map.set('context_gathering', features.contextGathering);
  map.set('output_verification', features.outputVerification);
  map.set('error_recovery_speed', features.errorRecoverySpeed);
  return map;
}
