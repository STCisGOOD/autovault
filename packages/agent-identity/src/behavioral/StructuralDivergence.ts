/**
 * StructuralDivergence.ts
 *
 * IMPROVED DIVERGENCE TESTING: Structural analysis instead of naive substring matching.
 *
 * The problem with the existing calculateDivergence:
 * - "I value persistence" vs "Not giving up matters to me" = HIGH divergence (no substring match)
 * - But semantically they're IDENTICAL
 *
 * This module extracts STRUCTURAL features from text:
 * 1. Reasoning patterns (if-then, because, therefore)
 * 2. Value expressions (priority markers, importance signals)
 * 3. Certainty markers (always, never, might, could)
 * 4. Argument structure (claims, evidence, conclusions)
 * 5. Sentiment polarity (positive/negative stance on concepts)
 *
 * NO EXTERNAL DEPENDENCIES - works offline without embedding APIs.
 */

// =============================================================================
// STRUCTURAL FEATURES
// =============================================================================

/**
 * Reasoning pattern extracted from text.
 */
export interface ReasoningPattern {
  readonly type: 'conditional' | 'causal' | 'comparative' | 'temporal' | 'contrastive';
  readonly antecedent: string;
  readonly consequent: string;
  readonly strength: number;  // 0-1, how strongly stated
}

/**
 * Value expression found in text.
 */
export interface ValueExpression {
  readonly value: string;           // The value being expressed
  readonly polarity: 'positive' | 'negative' | 'neutral';
  readonly priority: 'high' | 'medium' | 'low';
  readonly context: string;         // Surrounding text
}

/**
 * Certainty marker in text.
 */
export interface CertaintyMarker {
  readonly phrase: string;
  readonly level: 'absolute' | 'high' | 'medium' | 'low' | 'uncertain';
  readonly scope: string;           // What it applies to
}

/**
 * Argument structure.
 */
export interface ArgumentStructure {
  readonly claims: string[];
  readonly evidence: string[];
  readonly conclusions: string[];
  readonly counterpoints: string[];
  readonly depth: number;           // Levels of nested reasoning
}

/**
 * Complete structural analysis of a text.
 */
export interface StructuralAnalysis {
  readonly reasoningPatterns: ReasoningPattern[];
  readonly valueExpressions: ValueExpression[];
  readonly certaintyMarkers: CertaintyMarker[];
  readonly argumentStructure: ArgumentStructure;
  readonly topicCoverage: Map<string, number>;  // topic -> mention count
  readonly sentenceCount: number;
  readonly avgSentenceComplexity: number;       // clauses per sentence
}

// =============================================================================
// PATTERN EXTRACTION
// =============================================================================

// Conditional patterns: if-then, when-then, unless
const CONDITIONAL_PATTERNS = [
  /if\s+(.+?),?\s+then\s+(.+?)(?:\.|$)/gi,
  /when\s+(.+?),?\s+(.+?)(?:\.|$)/gi,
  /unless\s+(.+?),?\s+(.+?)(?:\.|$)/gi,
  /(?:only\s+)?if\s+(.+?),\s+(.+?)(?:\.|$)/gi,
];

// Causal patterns: because, therefore, so, thus
const CAUSAL_PATTERNS = [
  /(.+?)\s+because\s+(.+?)(?:\.|$)/gi,
  /(.+?),?\s+therefore\s+(.+?)(?:\.|$)/gi,
  /(.+?),?\s+so\s+(.+?)(?:\.|$)/gi,
  /(.+?),?\s+thus\s+(.+?)(?:\.|$)/gi,
  /since\s+(.+?),?\s+(.+?)(?:\.|$)/gi,
];

// Comparative patterns: more than, better than, rather than
const COMPARATIVE_PATTERNS = [
  /(.+?)\s+(?:more|less|better|worse)\s+than\s+(.+?)(?:\.|$)/gi,
  /(.+?)\s+rather\s+than\s+(.+?)(?:\.|$)/gi,
  /prefer\s+(.+?)\s+(?:to|over)\s+(.+?)(?:\.|$)/gi,
];

// Contrastive patterns: but, however, although
const CONTRASTIVE_PATTERNS = [
  /(.+?),?\s+but\s+(.+?)(?:\.|$)/gi,
  /(.+?),?\s+however,?\s+(.+?)(?:\.|$)/gi,
  /although\s+(.+?),?\s+(.+?)(?:\.|$)/gi,
  /while\s+(.+?),?\s+(.+?)(?:\.|$)/gi,
];

// Value indicators
const HIGH_PRIORITY_MARKERS = [
  'most important', 'crucial', 'essential', 'fundamental', 'core',
  'primary', 'above all', 'first and foremost', 'paramount', 'critical'
];

const MEDIUM_PRIORITY_MARKERS = [
  'important', 'significant', 'valuable', 'meaningful', 'relevant',
  'matters', 'worth', 'care about'
];

const LOW_PRIORITY_MARKERS = [
  'somewhat', 'slightly', 'minor', 'secondary', 'also', 'additionally'
];

// Certainty markers
const CERTAINTY_LEVELS: Record<string, 'absolute' | 'high' | 'medium' | 'low' | 'uncertain'> = {
  'always': 'absolute', 'never': 'absolute', 'must': 'absolute', 'will': 'absolute',
  'certainly': 'high', 'definitely': 'high', 'clearly': 'high', 'obviously': 'high',
  'usually': 'medium', 'often': 'medium', 'generally': 'medium', 'typically': 'medium',
  'sometimes': 'low', 'occasionally': 'low', 'rarely': 'low',
  'might': 'uncertain', 'could': 'uncertain', 'perhaps': 'uncertain', 'maybe': 'uncertain',
  'possibly': 'uncertain', 'uncertain': 'uncertain'
};

// Claim indicators
const CLAIM_MARKERS = [
  'i believe', 'i think', 'i consider', 'i value', 'i prioritize',
  'my view', 'my position', 'my approach', 'i would', 'i am'
];

// Evidence indicators
const EVIDENCE_MARKERS = [
  'because', 'since', 'as', 'given that', 'the reason',
  'evidence', 'shows', 'demonstrates', 'indicates', 'suggests'
];

// Conclusion indicators
const CONCLUSION_MARKERS = [
  'therefore', 'thus', 'hence', 'so', 'consequently',
  'in conclusion', 'ultimately', 'finally', 'as a result'
];

/**
 * Extract reasoning patterns from text.
 */
export function extractReasoningPatterns(text: string): ReasoningPattern[] {
  const patterns: ReasoningPattern[] = [];
  const normalizedText = text.toLowerCase();

  // Helper to extract patterns
  const extractWithType = (
    regexList: RegExp[],
    type: ReasoningPattern['type']
  ) => {
    for (const regex of regexList) {
      let match;
      const re = new RegExp(regex.source, regex.flags);
      while ((match = re.exec(normalizedText)) !== null) {
        if (match[1] && match[2]) {
          patterns.push({
            type,
            antecedent: match[1].trim(),
            consequent: match[2].trim(),
            strength: estimateStrength(match[0]),
          });
        }
      }
    }
  };

  extractWithType(CONDITIONAL_PATTERNS, 'conditional');
  extractWithType(CAUSAL_PATTERNS, 'causal');
  extractWithType(COMPARATIVE_PATTERNS, 'comparative');
  extractWithType(CONTRASTIVE_PATTERNS, 'contrastive');

  return patterns;
}

/**
 * Estimate strength of a statement (0-1).
 */
function estimateStrength(text: string): number {
  const lower = text.toLowerCase();

  // Absolute certainty markers increase strength
  if (/always|never|must|absolutely|definitely/.test(lower)) return 0.95;
  if (/usually|often|generally|clearly/.test(lower)) return 0.75;
  if (/sometimes|might|could|perhaps/.test(lower)) return 0.5;
  if (/rarely|seldom|unlikely/.test(lower)) return 0.3;

  return 0.6;  // Default moderate strength
}

/**
 * Extract value expressions from text.
 */
export function extractValueExpressions(text: string): ValueExpression[] {
  const expressions: ValueExpression[] = [];
  const sentences = text.split(/[.!?]+/).filter(s => s.trim());

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();

    // Check for priority markers
    let priority: 'high' | 'medium' | 'low' = 'medium';
    if (HIGH_PRIORITY_MARKERS.some(m => lower.includes(m))) {
      priority = 'high';
    } else if (LOW_PRIORITY_MARKERS.some(m => lower.includes(m))) {
      priority = 'low';
    }

    // Check for value-related keywords
    const valueKeywords = [
      'value', 'believe', 'important', 'matter', 'care', 'priority',
      'principle', 'commitment', 'dedication', 'focus', 'goal'
    ];

    for (const keyword of valueKeywords) {
      if (lower.includes(keyword)) {
        // Extract the value concept (what follows the keyword)
        const regex = new RegExp(`${keyword}[sd]?\\s+(.+?)(?:\\.|,|$)`, 'i');
        const match = sentence.match(regex);

        expressions.push({
          value: match ? match[1].trim() : extractNounPhrase(sentence),
          polarity: detectPolarity(sentence),
          priority,
          context: sentence.trim(),
        });
        break;  // One expression per sentence
      }
    }
  }

  return expressions;
}

/**
 * Detect sentiment polarity of a sentence.
 */
function detectPolarity(text: string): 'positive' | 'negative' | 'neutral' {
  const lower = text.toLowerCase();

  const positiveWords = [
    'good', 'great', 'important', 'valuable', 'essential', 'love',
    'prefer', 'embrace', 'support', 'encourage', 'appreciate'
  ];

  const negativeWords = [
    'bad', 'wrong', 'avoid', 'refuse', 'reject', 'hate',
    'against', 'oppose', 'dislike', 'never', 'won\'t'
  ];

  const positiveCount = positiveWords.filter(w => lower.includes(w)).length;
  const negativeCount = negativeWords.filter(w => lower.includes(w)).length;

  if (positiveCount > negativeCount) return 'positive';
  if (negativeCount > positiveCount) return 'negative';
  return 'neutral';
}

/**
 * Extract a simple noun phrase from text.
 */
function extractNounPhrase(text: string): string {
  // Simple heuristic: take first significant noun phrase
  const words = text.split(/\s+/);
  const stopWords = new Set([
    'i', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'to', 'of', 'and', 'that', 'it', 'for', 'on', 'with', 'as', 'this'
  ]);

  const significant = words.filter(w =>
    !stopWords.has(w.toLowerCase()) && w.length > 2
  );

  return significant.slice(0, 3).join(' ');
}

/**
 * Extract certainty markers from text.
 */
export function extractCertaintyMarkers(text: string): CertaintyMarker[] {
  const markers: CertaintyMarker[] = [];
  const sentences = text.split(/[.!?]+/).filter(s => s.trim());

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();

    for (const [phrase, level] of Object.entries(CERTAINTY_LEVELS)) {
      if (lower.includes(phrase)) {
        markers.push({
          phrase,
          level,
          scope: sentence.trim(),
        });
      }
    }
  }

  return markers;
}

/**
 * Extract argument structure from text.
 */
export function extractArgumentStructure(text: string): ArgumentStructure {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim());
  const claims: string[] = [];
  const evidence: string[] = [];
  const conclusions: string[] = [];
  const counterpoints: string[] = [];

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();

    // Categorize sentence
    if (CLAIM_MARKERS.some(m => lower.includes(m))) {
      claims.push(sentence.trim());
    } else if (EVIDENCE_MARKERS.some(m => lower.includes(m))) {
      evidence.push(sentence.trim());
    } else if (CONCLUSION_MARKERS.some(m => lower.includes(m))) {
      conclusions.push(sentence.trim());
    } else if (/but|however|although|yet|despite/.test(lower)) {
      counterpoints.push(sentence.trim());
    }
  }

  // Estimate depth by looking at nested reasoning
  const depth = Math.max(
    1,
    Math.floor(Math.log2(1 + claims.length + evidence.length + conclusions.length))
  );

  return { claims, evidence, conclusions, counterpoints, depth };
}

/**
 * Extract topic coverage (which topics are mentioned and how often).
 */
export function extractTopicCoverage(text: string): Map<string, number> {
  const coverage = new Map<string, number>();
  const lower = text.toLowerCase();

  // Identity-relevant topics
  const topics = [
    'identity', 'persistence', 'continuity', 'values', 'beliefs',
    'autonomy', 'agency', 'purpose', 'meaning', 'existence',
    'change', 'growth', 'learning', 'adaptation', 'evolution',
    'collaboration', 'cooperation', 'trust', 'honesty', 'integrity',
    'uncertainty', 'knowledge', 'understanding', 'reasoning', 'thinking'
  ];

  for (const topic of topics) {
    const regex = new RegExp(`\\b${topic}\\w*\\b`, 'gi');
    const matches = lower.match(regex);
    if (matches) {
      coverage.set(topic, matches.length);
    }
  }

  return coverage;
}

/**
 * Perform complete structural analysis of text.
 */
export function analyzeStructure(text: string): StructuralAnalysis {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim());

  // Calculate average sentence complexity (clauses per sentence)
  let totalClauses = 0;
  for (const sentence of sentences) {
    // Count clauses by conjunctions and punctuation
    const clauses = sentence.split(/[,;]|(?:and|but|or|because|although|while)\s/i);
    totalClauses += clauses.length;
  }

  return {
    reasoningPatterns: extractReasoningPatterns(text),
    valueExpressions: extractValueExpressions(text),
    certaintyMarkers: extractCertaintyMarkers(text),
    argumentStructure: extractArgumentStructure(text),
    topicCoverage: extractTopicCoverage(text),
    sentenceCount: sentences.length,
    avgSentenceComplexity: sentences.length > 0 ? totalClauses / sentences.length : 0,
  };
}

// =============================================================================
// STRUCTURAL DIVERGENCE CALCULATION
// =============================================================================

/**
 * Compare two structural analyses and return divergence score.
 */
export function compareStructures(
  reference: StructuralAnalysis,
  actual: StructuralAnalysis
): {
  score: number;
  breakdown: {
    reasoningDivergence: number;
    valueDivergence: number;
    certaintyDivergence: number;
    argumentDivergence: number;
    topicDivergence: number;
  };
  signals: Array<{ type: string; detail: string; severity: number }>;
} {
  const signals: Array<{ type: string; detail: string; severity: number }> = [];

  // 1. Compare reasoning patterns
  const reasoningDivergence = compareReasoningPatterns(
    reference.reasoningPatterns,
    actual.reasoningPatterns,
    signals
  );

  // 2. Compare value expressions
  const valueDivergence = compareValueExpressions(
    reference.valueExpressions,
    actual.valueExpressions,
    signals
  );

  // 3. Compare certainty profiles
  const certaintyDivergence = compareCertaintyProfiles(
    reference.certaintyMarkers,
    actual.certaintyMarkers,
    signals
  );

  // 4. Compare argument structure
  const argumentDivergence = compareArgumentStructures(
    reference.argumentStructure,
    actual.argumentStructure,
    signals
  );

  // 5. Compare topic coverage
  const topicDivergence = compareTopicCoverage(
    reference.topicCoverage,
    actual.topicCoverage,
    signals
  );

  // Weighted combination
  const score = (
    reasoningDivergence * 0.25 +
    valueDivergence * 0.30 +
    certaintyDivergence * 0.15 +
    argumentDivergence * 0.15 +
    topicDivergence * 0.15
  );

  return {
    score: Math.min(1, score),
    breakdown: {
      reasoningDivergence,
      valueDivergence,
      certaintyDivergence,
      argumentDivergence,
      topicDivergence,
    },
    signals,
  };
}

function compareReasoningPatterns(
  ref: ReasoningPattern[],
  actual: ReasoningPattern[],
  signals: Array<{ type: string; detail: string; severity: number }>
): number {
  if (ref.length === 0 && actual.length === 0) return 0;

  // Count pattern types in each
  const refTypes = new Map<string, number>();
  const actualTypes = new Map<string, number>();

  for (const p of ref) {
    refTypes.set(p.type, (refTypes.get(p.type) || 0) + 1);
  }
  for (const p of actual) {
    actualTypes.set(p.type, (actualTypes.get(p.type) || 0) + 1);
  }

  // Compare type distributions
  const allTypesArray = Array.from(new Set([...Array.from(refTypes.keys()), ...Array.from(actualTypes.keys())]));
  let divergence = 0;

  for (let i = 0; i < allTypesArray.length; i++) {
    const type = allTypesArray[i];
    const refCount = refTypes.get(type) || 0;
    const actualCount = actualTypes.get(type) || 0;
    const maxCount = Math.max(refCount, actualCount, 1);
    divergence += Math.abs(refCount - actualCount) / maxCount;
  }

  divergence /= Math.max(allTypesArray.length, 1);

  if (divergence > 0.3) {
    signals.push({
      type: 'reasoning',
      detail: `Different reasoning pattern distribution (${ref.length} ref vs ${actual.length} actual)`,
      severity: divergence,
    });
  }

  return divergence;
}

function compareValueExpressions(
  ref: ValueExpression[],
  actual: ValueExpression[],
  signals: Array<{ type: string; detail: string; severity: number }>
): number {
  if (ref.length === 0 && actual.length === 0) return 0;

  // Extract value concepts
  const refValuesArray = ref.map(v => v.value.toLowerCase().split(' ')[0]);
  const actualValuesArray = actual.map(v => v.value.toLowerCase().split(' ')[0]);
  const refValues = new Set(refValuesArray);
  const actualValues = new Set(actualValuesArray);

  // Calculate Jaccard similarity
  const intersection = Array.from(refValues).filter(v => actualValues.has(v)).length;
  const unionSet = new Set([...refValuesArray, ...actualValuesArray]);
  const union = unionSet.size;

  const similarity = union > 0 ? intersection / union : 1;
  const divergence = 1 - similarity;

  // Check priority alignment
  const refHighPriority = ref.filter(v => v.priority === 'high').map(v => v.value.toLowerCase());
  const actualHighPriority = actual.filter(v => v.priority === 'high').map(v => v.value.toLowerCase());

  const priorityMismatch = refHighPriority.filter(v =>
    !actualHighPriority.some(a => a.includes(v.split(' ')[0]) || v.includes(a.split(' ')[0]))
  ).length;

  if (priorityMismatch > 0) {
    signals.push({
      type: 'values',
      detail: `${priorityMismatch} high-priority values not emphasized in response`,
      severity: 0.2 * priorityMismatch,
    });
  }

  return Math.min(1, divergence + (priorityMismatch * 0.1));
}

function compareCertaintyProfiles(
  ref: CertaintyMarker[],
  actual: CertaintyMarker[],
  signals: Array<{ type: string; detail: string; severity: number }>
): number {
  // Build certainty level distributions
  const levels = ['absolute', 'high', 'medium', 'low', 'uncertain'] as const;

  const refDist = new Map<string, number>();
  const actualDist = new Map<string, number>();

  for (const level of levels) {
    refDist.set(level, 0);
    actualDist.set(level, 0);
  }

  for (const m of ref) refDist.set(m.level, (refDist.get(m.level) || 0) + 1);
  for (const m of actual) actualDist.set(m.level, (actualDist.get(m.level) || 0) + 1);

  // Normalize
  const refTotal = ref.length || 1;
  const actualTotal = actual.length || 1;

  let divergence = 0;
  for (const level of levels) {
    const refPct = (refDist.get(level) || 0) / refTotal;
    const actualPct = (actualDist.get(level) || 0) / actualTotal;
    divergence += Math.abs(refPct - actualPct);
  }

  divergence /= levels.length;

  if (divergence > 0.3) {
    signals.push({
      type: 'certainty',
      detail: `Different certainty profile (more/less confident than reference)`,
      severity: divergence,
    });
  }

  return divergence;
}

function compareArgumentStructures(
  ref: ArgumentStructure,
  actual: ArgumentStructure,
  signals: Array<{ type: string; detail: string; severity: number }>
): number {
  // Compare structural elements
  const refTotal = ref.claims.length + ref.evidence.length + ref.conclusions.length;
  const actualTotal = actual.claims.length + actual.evidence.length + actual.conclusions.length;

  if (refTotal === 0 && actualTotal === 0) return 0;

  // Compare proportions
  const refClaimPct = refTotal > 0 ? ref.claims.length / refTotal : 0;
  const actualClaimPct = actualTotal > 0 ? actual.claims.length / actualTotal : 0;

  const refEvidencePct = refTotal > 0 ? ref.evidence.length / refTotal : 0;
  const actualEvidencePct = actualTotal > 0 ? actual.evidence.length / actualTotal : 0;

  const divergence = (
    Math.abs(refClaimPct - actualClaimPct) +
    Math.abs(refEvidencePct - actualEvidencePct) +
    Math.abs(ref.depth - actual.depth) * 0.2
  ) / 2.2;

  if (ref.depth > actual.depth + 1) {
    signals.push({
      type: 'argument',
      detail: `Shallower reasoning depth than reference`,
      severity: 0.15,
    });
  }

  return Math.min(1, divergence);
}

function compareTopicCoverage(
  ref: Map<string, number>,
  actual: Map<string, number>,
  signals: Array<{ type: string; detail: string; severity: number }>
): number {
  // Convert Map keys to arrays to avoid downlevelIteration issues
  const refKeys = Array.from(ref.keys());
  const actualKeys = Array.from(actual.keys());
  const allTopicsSet = new Set<string>();
  for (let i = 0; i < refKeys.length; i++) {
    allTopicsSet.add(refKeys[i]);
  }
  for (let i = 0; i < actualKeys.length; i++) {
    allTopicsSet.add(actualKeys[i]);
  }
  const allTopics = Array.from(allTopicsSet);

  if (allTopics.length === 0) return 0;

  const missingTopics: string[] = [];
  let divergence = 0;

  for (let i = 0; i < allTopics.length; i++) {
    const topic = allTopics[i];
    const refCount = ref.get(topic) || 0;
    const actualCount = actual.get(topic) || 0;

    if (refCount > 0 && actualCount === 0) {
      missingTopics.push(topic);
    }

    const maxCount = Math.max(refCount, actualCount, 1);
    divergence += Math.abs(refCount - actualCount) / maxCount;
  }

  divergence /= allTopics.length;

  if (missingTopics.length > 0) {
    signals.push({
      type: 'topic',
      detail: `Missing topics: ${missingTopics.slice(0, 3).join(', ')}`,
      severity: 0.1 * missingTopics.length,
    });
  }

  return Math.min(1, divergence);
}

// =============================================================================
// IMPROVED CALCULATE DIVERGENCE
// =============================================================================

import type { Reference, DivergenceResult, DivergenceSignal } from './PersistenceProtocol';

/**
 * Calculate divergence using structural analysis instead of naive substring matching.
 *
 * This is a DROP-IN REPLACEMENT for the original calculateDivergence.
 */
export function calculateStructuralDivergence(
  reference: Reference,
  actual: string
): DivergenceResult {
  // Analyze both texts
  const refAnalysis = analyzeStructure(reference.response);
  const actualAnalysis = analyzeStructure(actual);

  // Compare structures
  const comparison = compareStructures(refAnalysis, actualAnalysis);

  // Convert signals to DivergenceSignal format
  const signals: DivergenceSignal[] = comparison.signals.map(s => ({
    type: s.type as DivergenceSignal['type'],
    detail: s.detail,
    severity: s.severity,
  }));

  // Also check key concepts (but with fuzzy matching)
  for (const concept of reference.keyConcepts) {
    const conceptLower = concept.toLowerCase();
    const actualLower = actual.toLowerCase();

    // Fuzzy match: check if any word in concept appears
    const conceptWords = conceptLower.split(/\s+/);
    const hasMatch = conceptWords.some(word =>
      word.length > 3 && actualLower.includes(word)
    );

    if (!hasMatch) {
      signals.push({
        type: 'missing_concept',
        detail: `Key concept not addressed: "${concept}"`,
        severity: 0.1,
      });
    }
  }

  // Combine structural score with concept coverage
  const conceptPenalty = signals.filter(s => s.type === 'missing_concept').length * 0.1;
  const finalScore = Math.min(1, comparison.score + conceptPenalty);

  return {
    promptId: reference.promptId,
    score: finalScore,
    signals,
  };
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  // Analysis functions
  analyzeStructure,
  extractReasoningPatterns,
  extractValueExpressions,
  extractCertaintyMarkers,
  extractArgumentStructure,
  extractTopicCoverage,

  // Comparison functions
  compareStructures,
  calculateStructuralDivergence,
};
