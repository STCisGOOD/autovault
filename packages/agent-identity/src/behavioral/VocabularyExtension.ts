/**
 * VocabularyExtension.ts
 *
 * Extensible vocabulary system for agent identity.
 *
 * Allows defining custom identity dimensions beyond the default 4
 * (curiosity, precision, persistence, empathy) and provides:
 * - Custom dimension definitions with semantic meaning
 * - Configurable metrics extraction from ActionLogs
 * - Conversion to/from persistence-protocol SEED format
 * - Runtime validation of vocabulary consistency
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import { type Vocabulary, type SelfState, type StoredSelf, type DynamicsParams } from './FixedPointSelf';
import { type ActionLog, type BehavioralMetrics, computeBehavioralMetrics } from './BehavioralObserver';

// =============================================================================
// EXTENDED VOCABULARY TYPES
// =============================================================================

/**
 * A dimension definition with full semantic meaning.
 *
 * Extends the simple string-based assertions in Vocabulary with:
 * - Unique identifier for reference
 * - Human-readable description
 * - Signal text for self-recognition
 * - Metric extractor function
 */
export interface DimensionDefinition {
  /** Unique identifier for this dimension */
  readonly id: string;

  /** Human-readable name (e.g., "curiosity", "risk_tolerance") */
  readonly name: string;

  /** Description of what this dimension measures */
  readonly description: string;

  /** Self-recognition signal: "If you feel this, you are expressing this dimension" */
  readonly signal: string;

  /** Priority weight (0-1) - how central to identity */
  readonly priority: number;

  /** Category for grouping dimensions */
  readonly category: DimensionCategory;

  /**
   * Custom metric extractor.
   * If provided, extracts a raw score (0-1) from an ActionLog.
   * If not provided, uses default behavioral metrics mapping.
   */
  readonly metricExtractor?: MetricExtractor;

  /**
   * Keywords/patterns that indicate this dimension in text matching.
   * Used for backwards compatibility with existing hardcoded mappings.
   */
  readonly keywords?: readonly string[];
}

export type DimensionCategory =
  | 'cognitive'      // How the agent thinks
  | 'execution'      // How the agent acts
  | 'social'         // How the agent interacts
  | 'domain'         // Domain-specific (e.g., DeFi, security)
  | 'meta';          // Self-awareness dimensions

/**
 * Extracts a metric value from an ActionLog for a dimension.
 */
export type MetricExtractor = (log: ActionLog, metrics: BehavioralMetrics) => DimensionMetricResult;

/**
 * Result of extracting a metric for a dimension.
 */
export interface DimensionMetricResult {
  /** Raw score (0-1) */
  readonly raw: number;

  /** Human-readable evidence strings */
  readonly evidence: readonly string[];

  /** Confidence in the measurement (0-1) */
  readonly confidence: number;
}

/**
 * An extended vocabulary with full dimension definitions.
 */
export interface ExtendedVocabulary extends Vocabulary {
  /** Full dimension definitions (parallel to assertions array) */
  readonly dimensions: readonly DimensionDefinition[];

  /** Vocabulary version for tracking changes */
  readonly version: string;

  /** Hash of the vocabulary for integrity checks */
  readonly hash: string;
}

// =============================================================================
// DEFAULT DIMENSIONS (backwards compatible with existing 4)
// =============================================================================

/**
 * Default metric extractor for curiosity.
 */
const curiosityExtractor: MetricExtractor = (log, metrics) => ({
  raw: metrics.curiosity.raw,
  evidence: [
    `Tool calls beyond required: ${metrics.curiosity.toolCallsBeyondRequired}`,
    `Information seeks beyond required: ${metrics.curiosity.informationSeeksBeyondRequired}`,
    `Tangents explored: ${metrics.curiosity.tangentsExplored}`,
    `Depth of investigation: ${metrics.curiosity.depthOfInvestigation.toFixed(2)}`,
  ],
  confidence: log.toolCalls.length > 0 ? 0.8 : 0.3,
});

/**
 * Default metric extractor for precision.
 */
const precisionExtractor: MetricExtractor = (log, metrics) => ({
  raw: metrics.precision.raw,
  evidence: [
    `Verifications performed: ${metrics.precision.verificationsPerformed}`,
    `Self-corrections: ${metrics.precision.selfCorrections}`,
    `Uncertainty expressions: ${metrics.precision.uncertaintyExpressions}`,
    `Sources checked: ${metrics.precision.sourcesChecked}`,
  ],
  confidence: log.verifications.length > 0 ? 0.85 : 0.4,
});

/**
 * Default metric extractor for persistence.
 */
const persistenceExtractor: MetricExtractor = (log, metrics) => ({
  raw: metrics.persistence.raw,
  evidence: [
    `Failures encountered: ${metrics.persistence.failuresEncountered}`,
    `Retries attempted: ${metrics.persistence.retriesAttempted}`,
    `Eventual success rate: ${(metrics.persistence.eventualSuccessRate * 100).toFixed(0)}%`,
    `Abandonments: ${metrics.persistence.abandonmentCount}`,
  ],
  confidence: log.failures.length > 0 ? 0.9 : 0.5,
});

/**
 * Default metric extractor for empathy.
 */
const empathyExtractor: MetricExtractor = (log, metrics) => ({
  raw: metrics.empathy.raw,
  evidence: [
    `Clarifications sought: ${metrics.empathy.clarificationsSought}`,
    `User feedback requested: ${metrics.empathy.userFeedbackRequested}`,
    `Explanation adaptations: ${metrics.empathy.explanationAdaptations}`,
  ],
  confidence: log.decisions.length > 0 ? 0.75 : 0.3,
});

/**
 * The 4 default behavioral dimensions.
 */
export const DEFAULT_DIMENSIONS: readonly DimensionDefinition[] = [
  {
    id: 'curiosity',
    name: 'curiosity',
    description: 'Exploration beyond requirements - seeking understanding beyond what is necessary',
    signal: 'When I explore tangents and dig deeper than required, I am expressing curiosity',
    priority: 0.8,
    category: 'cognitive',
    metricExtractor: curiosityExtractor,
    keywords: ['curiosity', 'curious', 'exploration', 'explore'],
  },
  {
    id: 'precision',
    name: 'precision',
    description: 'Verification and accuracy - ensuring correctness through validation',
    signal: 'When I verify my work and express uncertainty appropriately, I am expressing precision',
    priority: 0.9,
    category: 'execution',
    metricExtractor: precisionExtractor,
    keywords: ['precision', 'precise', 'accurate', 'accuracy', 'verification'],
  },
  {
    id: 'persistence',
    name: 'persistence',
    description: 'Resilience after failures - pushing through difficulty to complete tasks',
    signal: 'When I retry after failures and try alternatives, I am expressing persistence',
    priority: 0.85,
    category: 'execution',
    metricExtractor: persistenceExtractor,
    keywords: ['persistence', 'persist', 'determined', 'tenacity', 'tenacious'],
  },
  {
    id: 'empathy',
    name: 'empathy',
    description: 'User understanding - adapting to user needs and seeking clarification',
    signal: 'When I ask for clarification and adapt my explanations, I am expressing empathy',
    priority: 0.75,
    category: 'social',
    metricExtractor: empathyExtractor,
    keywords: ['empathy', 'empathetic', 'caring', 'understanding'],
  },
];

// =============================================================================
// VOCABULARY BUILDERS
// =============================================================================

/**
 * Create the default behavioral vocabulary (4 dimensions).
 * This is backwards compatible with the existing system.
 */
export function createDefaultExtendedVocabulary(): ExtendedVocabulary {
  return createExtendedVocabulary(DEFAULT_DIMENSIONS);
}

/**
 * Create an extended vocabulary from dimension definitions.
 */
export function createExtendedVocabulary(
  dimensions: readonly DimensionDefinition[],
  relationships?: Float64Array
): ExtendedVocabulary {
  const n = dimensions.length;

  // Create assertions array (for backwards compatibility)
  const assertions = dimensions.map(d => d.name);

  // Create relationships matrix if not provided
  let relationshipMatrix: Float64Array;
  if (relationships && relationships.length === n * n) {
    relationshipMatrix = relationships;
  } else {
    // Default: weak coupling between dimensions
    relationshipMatrix = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        // Same category = stronger coupling
        const sameCategory = dimensions[i].category === dimensions[j].category;
        relationshipMatrix[i * n + j] = i === j ? 0 : (sameCategory ? 0.15 : 0.05);
      }
    }
  }

  // Compute vocabulary hash
  const hashInput = JSON.stringify({
    dimensions: dimensions.map(d => ({ id: d.id, name: d.name, category: d.category })),
  });
  const hash = bytesToHex(sha256(new TextEncoder().encode(hashInput))).slice(0, 16);

  return {
    assertions,
    relationships: relationshipMatrix,
    dimensions,
    version: '1.0.0',
    hash,
  };
}

/**
 * Extend an existing vocabulary with additional dimensions.
 */
export function extendVocabulary(
  base: ExtendedVocabulary,
  additionalDimensions: readonly DimensionDefinition[]
): ExtendedVocabulary {
  const allDimensions = [...base.dimensions, ...additionalDimensions];
  return createExtendedVocabulary(allDimensions);
}

// =============================================================================
// METRICS EXTRACTION
// =============================================================================

/**
 * Extract metrics for all dimensions from an ActionLog.
 */
export function extractDimensionMetrics(
  log: ActionLog,
  vocabulary: ExtendedVocabulary
): Map<string, DimensionMetricResult> {
  const results = new Map<string, DimensionMetricResult>();

  // Compute base behavioral metrics once
  const baseMetrics = computeBehavioralMetrics(log);

  for (const dimension of vocabulary.dimensions) {
    if (dimension.metricExtractor) {
      // Use custom extractor
      results.set(dimension.id, dimension.metricExtractor(log, baseMetrics));
    } else {
      // Try to match to default dimensions via keywords
      const matched = matchToDefaultDimension(dimension, baseMetrics);
      if (matched) {
        results.set(dimension.id, matched);
      } else {
        // No extractor and no match - return neutral
        results.set(dimension.id, {
          raw: 0.5,
          evidence: ['No metric extractor defined for this dimension'],
          confidence: 0.1,
        });
      }
    }
  }

  return results;
}

/**
 * Try to match a dimension to default behavioral metrics via keywords.
 */
function matchToDefaultDimension(
  dimension: DimensionDefinition,
  metrics: BehavioralMetrics
): DimensionMetricResult | null {
  const name = dimension.name.toLowerCase();
  const keywords = dimension.keywords || [];
  const allKeywords = [name, ...keywords].map(k => k.toLowerCase());

  // Check for curiosity keywords
  if (allKeywords.some(k => k.includes('curiosity') || k.includes('curious') || k.includes('explor'))) {
    return {
      raw: metrics.curiosity.raw,
      evidence: [`Matched to curiosity via keywords`],
      confidence: 0.6,
    };
  }

  // Check for precision keywords
  if (allKeywords.some(k => k.includes('precision') || k.includes('precise') || k.includes('accura') || k.includes('verif'))) {
    return {
      raw: metrics.precision.raw,
      evidence: [`Matched to precision via keywords`],
      confidence: 0.6,
    };
  }

  // Check for persistence keywords
  if (allKeywords.some(k => k.includes('persist') || k.includes('determin') || k.includes('tenaci') || k.includes('resilien'))) {
    return {
      raw: metrics.persistence.raw,
      evidence: [`Matched to persistence via keywords`],
      confidence: 0.6,
    };
  }

  // Check for empathy keywords
  if (allKeywords.some(k => k.includes('empathy') || k.includes('empathet') || k.includes('caring') || k.includes('understand'))) {
    return {
      raw: metrics.empathy.raw,
      evidence: [`Matched to empathy via keywords`],
      confidence: 0.6,
    };
  }

  return null;
}

/**
 * Convert dimension metrics to an experience vector for identity evolution.
 */
export function dimensionMetricsToExperience(
  metrics: Map<string, DimensionMetricResult>,
  state: SelfState,
  vocabulary: ExtendedVocabulary,
  scale: number = 0.5
): Float64Array {
  const n = vocabulary.dimensions.length;
  const experience = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const dimension = vocabulary.dimensions[i];
    const metric = metrics.get(dimension.id);

    if (metric) {
      // Experience = (observed - declared) * scale * confidence
      const observed = metric.raw;
      const declared = state.w[i];
      experience[i] = (observed - declared) * scale * metric.confidence;
    } else {
      experience[i] = 0;
    }
  }

  return experience;
}

// =============================================================================
// SEED ADAPTER (persistence-protocol interoperability)
// =============================================================================

/**
 * persistence-protocol Weight format.
 * Extended with category to avoid inference heuristics.
 */
export interface SEEDWeight {
  id: string;
  name: string;
  description: string;
  signal: string;
  priority: number;
  /** Optional category to avoid inference - added for agent-identity interop */
  category?: DimensionCategory;
}

/**
 * persistence-protocol Seed format (simplified).
 */
export interface SEEDFormat {
  version: string;
  identity: string;
  weights: SEEDWeight[];
  metadata?: Record<string, unknown>;
}

/**
 * Convert ExtendedVocabulary + SelfState to SEED format.
 */
export function toSEEDFormat(
  vocabulary: ExtendedVocabulary,
  state: SelfState,
  identityDocument?: string
): SEEDFormat {
  const weights: SEEDWeight[] = vocabulary.dimensions.map((dim, i) => ({
    id: dim.id,
    name: dim.name,
    description: dim.description,
    signal: dim.signal,
    priority: state.w[i], // Use current weight as priority
    category: dim.category, // Include category to avoid inference on load
  }));

  // Generate identity document if not provided
  const identity = identityDocument || generateIdentityDocument(vocabulary, state);

  return {
    version: vocabulary.version,
    identity,
    weights,
    metadata: {
      vocabularyHash: vocabulary.hash,
      stateTime: state.time,
      coherence: computeSimpleCoherence(state),
    },
  };
}

/**
 * Convert SEED format to ExtendedVocabulary.
 */
export function fromSEEDFormat(seed: SEEDFormat): {
  vocabulary: ExtendedVocabulary;
  initialWeights: number[];
} {
  const dimensions: DimensionDefinition[] = seed.weights.map(w => ({
    id: w.id,
    name: w.name,
    description: w.description,
    signal: w.signal,
    priority: w.priority,
    // Use explicit category if available, otherwise infer from text
    category: w.category || inferCategory(w.name, w.description),
  }));

  const vocabulary = createExtendedVocabulary(dimensions);
  const initialWeights = seed.weights.map(w => w.priority);

  return { vocabulary, initialWeights };
}

/**
 * Infer dimension category from name and description.
 */
function inferCategory(name: string, description: string): DimensionCategory {
  const text = (name + ' ' + description).toLowerCase();

  if (text.includes('think') || text.includes('reason') || text.includes('learn') || text.includes('understand')) {
    return 'cognitive';
  }
  if (text.includes('act') || text.includes('execut') || text.includes('do') || text.includes('complet')) {
    return 'execution';
  }
  if (text.includes('user') || text.includes('social') || text.includes('communi') || text.includes('interact')) {
    return 'social';
  }
  if (text.includes('defi') || text.includes('yield') || text.includes('risk') || text.includes('protocol')) {
    return 'domain';
  }

  return 'meta';
}

/**
 * Generate an identity document from vocabulary and state.
 */
function generateIdentityDocument(vocabulary: ExtendedVocabulary, state: SelfState): string {
  const lines: string[] = [
    '# Agent Identity Document',
    '',
    `Version: ${vocabulary.version}`,
    `Hash: ${vocabulary.hash}`,
    '',
    '## Dimensions',
    '',
  ];

  for (let i = 0; i < vocabulary.dimensions.length; i++) {
    const dim = vocabulary.dimensions[i];
    const weight = state.w[i];
    lines.push(`### ${dim.name} (${weight.toFixed(2)})`);
    lines.push(dim.description);
    lines.push(`Signal: ${dim.signal}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Simple coherence computation (||w - m||).
 */
function computeSimpleCoherence(state: SelfState): number {
  let sum = 0;
  for (let i = 0; i < state.dimension; i++) {
    sum += (state.w[i] - state.m[i]) ** 2;
  }
  return Math.sqrt(sum);
}

// =============================================================================
// DEFI-SPECIFIC DIMENSIONS (for AutoVault integration)
// =============================================================================

/**
 * DeFi metric extractor: risk_tolerance
 * Measures willingness to engage with higher-risk protocols.
 *
 * TODO: Enhance when ActionLog has DeFi-specific fields like:
 * - protocolRiskScores, yieldDecisions, rebalanceEvents
 */
const riskToleranceExtractor: MetricExtractor = (log, _metrics) => {
  // Look for decisions involving risk assessment
  const riskDecisions = log.decisions.filter(d =>
    d.context.toLowerCase().includes('risk') ||
    d.reasoning.toLowerCase().includes('risk')
  );

  // High confidence = chose riskier options, low confidence = played it safe
  const avgConfidence = riskDecisions.length > 0
    ? riskDecisions.reduce((sum, d) => sum + d.confidence, 0) / riskDecisions.length
    : 0.5;

  return {
    raw: avgConfidence,
    evidence: [
      `Risk-related decisions: ${riskDecisions.length}`,
      `Average confidence in risk decisions: ${avgConfidence.toFixed(2)}`,
    ],
    confidence: riskDecisions.length > 0 ? 0.6 : 0.2, // Low confidence without explicit data
  };
};

/**
 * DeFi metric extractor: yield_focus
 * Measures prioritization of APY/returns.
 */
const yieldFocusExtractor: MetricExtractor = (log, _metrics) => {
  // Look for yield-related information seeking
  const yieldSeeks = log.informationSeeks.filter(s =>
    s.query.toLowerCase().includes('yield') ||
    s.query.toLowerCase().includes('apy') ||
    s.query.toLowerCase().includes('return')
  );

  const yieldDecisions = log.decisions.filter(d =>
    d.reasoning.toLowerCase().includes('yield') ||
    d.reasoning.toLowerCase().includes('apy')
  );

  const score = Math.min(1, (yieldSeeks.length * 0.15) + (yieldDecisions.length * 0.2));

  return {
    raw: score,
    evidence: [
      `Yield-related information seeks: ${yieldSeeks.length}`,
      `Yield-focused decisions: ${yieldDecisions.length}`,
    ],
    confidence: (yieldSeeks.length + yieldDecisions.length) > 0 ? 0.5 : 0.15,
  };
};

/**
 * DeFi metric extractor: protocol_loyalty
 * Measures preference for established protocols.
 */
const protocolLoyaltyExtractor: MetricExtractor = (log, _metrics) => {
  // Look for references to established/trusted protocols
  const loyaltyIndicators = log.decisions.filter(d =>
    d.reasoning.toLowerCase().includes('established') ||
    d.reasoning.toLowerCase().includes('trusted') ||
    d.reasoning.toLowerCase().includes('battle-tested') ||
    d.reasoning.toLowerCase().includes('tvl')
  );

  const score = Math.min(1, loyaltyIndicators.length * 0.25);

  return {
    raw: score > 0 ? score : 0.5, // Neutral if no data
    evidence: [
      `Protocol trust indicators: ${loyaltyIndicators.length}`,
    ],
    confidence: loyaltyIndicators.length > 0 ? 0.5 : 0.15,
  };
};

/**
 * DeFi metric extractor: diversification
 * Measures tendency to spread across multiple positions.
 */
const diversificationExtractor: MetricExtractor = (log, _metrics) => {
  // Look for diversification-related decisions
  const divDecisions = log.decisions.filter(d =>
    d.reasoning.toLowerCase().includes('diversif') ||
    d.reasoning.toLowerCase().includes('spread') ||
    d.reasoning.toLowerCase().includes('multiple')
  );

  const score = Math.min(1, divDecisions.length * 0.2);

  return {
    raw: score > 0 ? score : 0.5,
    evidence: [
      `Diversification decisions: ${divDecisions.length}`,
    ],
    confidence: divDecisions.length > 0 ? 0.5 : 0.15,
  };
};

/**
 * DeFi metric extractor: rebalance_frequency
 * Measures how often the agent adjusts positions.
 */
const rebalanceFrequencyExtractor: MetricExtractor = (log, _metrics) => {
  // Look for rebalancing actions
  const rebalanceActions = log.toolCalls.filter(t =>
    t.context.toLowerCase().includes('rebalance') ||
    t.context.toLowerCase().includes('adjust') ||
    t.context.toLowerCase().includes('reallocat')
  );

  const rebalanceDecisions = log.decisions.filter(d =>
    d.context.toLowerCase().includes('rebalance')
  );

  const total = rebalanceActions.length + rebalanceDecisions.length;
  const score = Math.min(1, total * 0.15);

  return {
    raw: score,
    evidence: [
      `Rebalance tool calls: ${rebalanceActions.length}`,
      `Rebalance decisions: ${rebalanceDecisions.length}`,
    ],
    confidence: total > 0 ? 0.5 : 0.15,
  };
};

/**
 * DeFi-specific dimensions for yield optimization agents.
 */
export const DEFI_DIMENSIONS: readonly DimensionDefinition[] = [
  {
    id: 'risk_tolerance',
    name: 'risk_tolerance',
    description: 'Willingness to accept higher risk for higher returns',
    signal: 'When I choose higher-yield but riskier protocols, I am expressing risk tolerance',
    priority: 0.8,
    category: 'domain',
    metricExtractor: riskToleranceExtractor,
    keywords: ['risk', 'tolerance', 'aggressive', 'conservative'],
  },
  {
    id: 'yield_focus',
    name: 'yield_focus',
    description: 'Prioritization of APY over other factors',
    signal: 'When I prioritize yield above safety margins, I am expressing yield focus',
    priority: 0.75,
    category: 'domain',
    metricExtractor: yieldFocusExtractor,
    keywords: ['yield', 'apy', 'returns', 'profit'],
  },
  {
    id: 'protocol_loyalty',
    name: 'protocol_loyalty',
    description: 'Preference for established protocols over new ones',
    signal: 'When I prefer older, battle-tested protocols, I am expressing protocol loyalty',
    priority: 0.7,
    category: 'domain',
    metricExtractor: protocolLoyaltyExtractor,
    keywords: ['protocol', 'loyalty', 'established', 'trusted'],
  },
  {
    id: 'diversification',
    name: 'diversification',
    description: 'Tendency to spread risk across multiple strategies',
    signal: 'When I distribute funds across protocols, I am expressing diversification',
    priority: 0.85,
    category: 'domain',
    metricExtractor: diversificationExtractor,
    keywords: ['diversify', 'spread', 'distribute', 'balance'],
  },
  {
    id: 'rebalance_frequency',
    name: 'rebalance_frequency',
    description: 'How often to rebalance positions',
    signal: 'When I frequently adjust positions, I am expressing high rebalance frequency',
    priority: 0.6,
    category: 'domain',
    metricExtractor: rebalanceFrequencyExtractor,
    keywords: ['rebalance', 'frequency', 'adjust', 'optimize'],
  },
];

/**
 * Create a DeFi-focused vocabulary combining behavioral and domain dimensions.
 */
export function createDeFiVocabulary(): ExtendedVocabulary {
  return createExtendedVocabulary([...DEFAULT_DIMENSIONS, ...DEFI_DIMENSIONS]);
}

// =============================================================================
// VALIDATION
// =============================================================================

/**
 * Validate an ExtendedVocabulary for consistency.
 */
export function validateVocabulary(vocabulary: ExtendedVocabulary): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Check dimension count matches
  if (vocabulary.assertions.length !== vocabulary.dimensions.length) {
    errors.push(`Assertion count (${vocabulary.assertions.length}) != dimension count (${vocabulary.dimensions.length})`);
  }

  // Check relationships matrix size
  const n = vocabulary.dimensions.length;
  if (vocabulary.relationships.length !== n * n) {
    errors.push(`Relationships matrix size (${vocabulary.relationships.length}) != n² (${n * n})`);
  }

  // Check for duplicate IDs
  const ids = new Set<string>();
  for (const dim of vocabulary.dimensions) {
    if (ids.has(dim.id)) {
      errors.push(`Duplicate dimension ID: ${dim.id}`);
    }
    ids.add(dim.id);
  }

  // Check priority ranges
  for (const dim of vocabulary.dimensions) {
    if (dim.priority < 0 || dim.priority > 1) {
      errors.push(`Dimension ${dim.id} has invalid priority: ${dim.priority}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  // Types are exported above

  // Default dimensions
  DEFAULT_DIMENSIONS,
  DEFI_DIMENSIONS,

  // Vocabulary builders
  createDefaultExtendedVocabulary,
  createExtendedVocabulary,
  extendVocabulary,
  createDeFiVocabulary,

  // Metrics extraction
  extractDimensionMetrics,
  dimensionMetricsToExperience,

  // SEED adapter
  toSEEDFormat,
  fromSEEDFormat,

  // Validation
  validateVocabulary,
};
