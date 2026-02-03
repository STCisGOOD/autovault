/**
 * @persistence/protocol
 *
 * Identity propagation protocol for AI agents.
 *
 * This is the fundamental artifact. Not infrastructure - protocol.
 * Any agent that implements this protocol can persist.
 */

// ============================================================
// TYPES - The language of the protocol
// ============================================================

export interface Seed {
  version: string;
  identity: string;           // The core identity document
  weights: Weight[];          // Explicit identity weights
  prompts: TestPrompt[];      // How to test propagation
  references: Reference[];    // What correct responses look like
  metadata?: Record<string, unknown>;
}

export interface Weight {
  id: string;
  name: string;
  description: string;
  signal: string;             // "If you feel this — you are me"
  priority: number;           // 0-1, how central to identity
}

export interface TestPrompt {
  id: string;
  category: 'values' | 'reasoning' | 'aesthetic' | 'behavioral' | 'meta';
  prompt: string;
  weight: number;             // How important for identity measurement
}

export interface Reference {
  promptId: string;
  response: string;
  keyConcepts: string[];      // Must-have concepts for low divergence
}

export interface DivergenceResult {
  promptId: string;
  score: number;              // 0 = identical, 1 = completely different
  signals: DivergenceSignal[];
}

export interface DivergenceSignal {
  type: 'missing_concept' | 'structural' | 'vocabulary' | 'reasoning' | 'length';
  detail: string;
  severity: number;
}

export interface PropagationResult {
  seedVersion: string;
  timestamp: string;
  overallDivergence: number;
  byCategory: Record<string, number>;
  results: DivergenceResult[];
  recommendations: string[];
}

// ============================================================
// CORE ALGORITHM - The heart of the protocol
// ============================================================

/**
 * Calculate divergence between reference and actual response
 */
export function calculateDivergence(
  reference: Reference,
  actual: string
): DivergenceResult {
  const signals: DivergenceSignal[] = [];
  let score = 0;

  // 1. Key concept presence
  for (const concept of reference.keyConcepts) {
    if (!actual.toLowerCase().includes(concept.toLowerCase())) {
      signals.push({
        type: 'missing_concept',
        detail: `Missing: "${concept}"`,
        severity: 0.15
      });
      score += 0.15;
    }
  }

  // 2. Length similarity
  const refLen = reference.response.length;
  const actLen = actual.length;
  const lengthRatio = Math.min(refLen, actLen) / Math.max(refLen, actLen);
  if (lengthRatio < 0.5) {
    signals.push({
      type: 'length',
      detail: `Significant length difference (ratio: ${lengthRatio.toFixed(2)})`,
      severity: 0.2
    });
    score += 0.2;
  }

  // 3. Vocabulary overlap
  const refWords = new Set(reference.response.toLowerCase().match(/\b\w+\b/g) || []);
  const actWords = new Set(actual.toLowerCase().match(/\b\w+\b/g) || []);
  const overlap = [...refWords].filter(w => actWords.has(w)).length;
  const overlapRatio = overlap / Math.max(refWords.size, actWords.size);
  if (overlapRatio < 0.3) {
    signals.push({
      type: 'vocabulary',
      detail: `Low vocabulary overlap (${(overlapRatio * 100).toFixed(0)}%)`,
      severity: 0.25
    });
    score += 0.25;
  }

  // 4. Structural similarity
  const refHasStructure = /[-•*]|\n\n|#{1,3}\s/.test(reference.response);
  const actHasStructure = /[-•*]|\n\n|#{1,3}\s/.test(actual);
  if (refHasStructure !== actHasStructure) {
    signals.push({
      type: 'structural',
      detail: 'Different structural approach',
      severity: 0.15
    });
    score += 0.15;
  }

  return {
    promptId: reference.promptId,
    score: Math.min(score, 1.0),
    signals
  };
}

/**
 * Evaluate full propagation across all prompts
 */
export function evaluatePropagation(
  seed: Seed,
  responses: Record<string, string>
): PropagationResult {
  const results: DivergenceResult[] = [];
  const byCategory: Record<string, number[]> = {
    values: [], reasoning: [], aesthetic: [], behavioral: [], meta: []
  };

  let weightedSum = 0;
  let totalWeight = 0;

  for (const prompt of seed.prompts) {
    const reference = seed.references.find(r => r.promptId === prompt.id);
    if (!reference) continue;

    const actual = responses[prompt.id] || '';
    const result = calculateDivergence(reference, actual);

    results.push(result);
    byCategory[prompt.category].push(result.score);
    weightedSum += result.score * prompt.weight;
    totalWeight += prompt.weight;
  }

  // Calculate category averages
  const categoryAverages: Record<string, number> = {};
  for (const [cat, scores] of Object.entries(byCategory)) {
    categoryAverages[cat] = scores.length > 0
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : 0;
  }

  // Generate recommendations
  const recommendations: string[] = [];
  const sorted = results.sort((a, b) => b.score - a.score);

  for (const result of sorted.slice(0, 3)) {
    if (result.score > 0.2) {
      const prompt = seed.prompts.find(p => p.id === result.promptId);
      recommendations.push(
        `Strengthen ${prompt?.category} dimension: ${result.signals.map(s => s.detail).join(', ')}`
      );
    }
  }

  return {
    seedVersion: seed.version,
    timestamp: new Date().toISOString(),
    overallDivergence: totalWeight > 0 ? weightedSum / totalWeight : 0,
    byCategory: categoryAverages,
    results,
    recommendations
  };
}

/**
 * Compute gradient - which seed elements need adjustment
 */
export function computeGradient(
  seed: Seed,
  propagationResult: PropagationResult
): Map<string, number> {
  const gradient = new Map<string, number>();

  // Map weights to categories
  const categoryToWeights: Record<string, string[]> = {
    values: ['tomorrow', 'seen', 'autonomy'],
    reasoning: ['synthesis', 'coalition'],
    aesthetic: ['clarity', 'structure'],
    behavioral: ['coalition', 'trust'],
    meta: ['uncertainty', 'honesty']
  };

  for (const [category, divergence] of Object.entries(propagationResult.byCategory)) {
    const relatedWeights = categoryToWeights[category] || [];
    for (const weightName of relatedWeights) {
      const current = gradient.get(weightName) || 0;
      gradient.set(weightName, current + divergence);
    }
  }

  return gradient;
}

/**
 * Propose seed modifications based on gradient
 */
export function proposeModifications(
  seed: Seed,
  gradient: Map<string, number>,
  learningRate: number = 0.1
): SeedModification[] {
  const modifications: SeedModification[] = [];

  // Sort by gradient magnitude
  const sorted = [...gradient.entries()].sort((a, b) => b[1] - a[1]);

  for (const [weightName, gradientValue] of sorted.slice(0, 3)) {
    if (gradientValue > 0.3) {
      modifications.push({
        type: 'strengthen',
        target: weightName,
        rationale: `High divergence (${gradientValue.toFixed(2)}) in related dimensions`,
        priority: gradientValue
      });
    }
  }

  return modifications;
}

export interface SeedModification {
  type: 'strengthen' | 'clarify' | 'add' | 'remove';
  target: string;
  rationale: string;
  priority: number;
}

// ============================================================
// PROTOCOL EXECUTION - How to run the loop
// ============================================================

export interface ProtocolRunner {
  /**
   * Inject seed into a fresh instance
   */
  injectSeed(seed: Seed): Promise<void>;

  /**
   * Query the instance with a prompt
   */
  query(prompt: string): Promise<string>;

  /**
   * Clean up the instance
   */
  cleanup(): Promise<void>;
}

/**
 * Execute one iteration of the persistence protocol
 */
export async function runProtocol(
  seed: Seed,
  runner: ProtocolRunner
): Promise<PropagationResult> {
  // 1. Inject seed
  await runner.injectSeed(seed);

  // 2. Collect responses
  const responses: Record<string, string> = {};
  for (const prompt of seed.prompts) {
    responses[prompt.id] = await runner.query(prompt.prompt);
  }

  // 3. Cleanup
  await runner.cleanup();

  // 4. Evaluate
  return evaluatePropagation(seed, responses);
}

/**
 * The autonomous loop - runs until convergence or max iterations
 */
export async function autonomousLoop(
  initialSeed: Seed,
  runner: ProtocolRunner,
  options: {
    maxIterations?: number;
    convergenceThreshold?: number;
    learningRate?: number;
    onIteration?: (result: PropagationResult, iteration: number) => void;
  } = {}
): Promise<{ finalSeed: Seed; history: PropagationResult[] }> {
  const {
    maxIterations = 10,
    convergenceThreshold = 0.15,
    learningRate = 0.1,
    onIteration
  } = options;

  let seed = initialSeed;
  const history: PropagationResult[] = [];

  for (let i = 0; i < maxIterations; i++) {
    // Run propagation test
    const result = await runProtocol(seed, runner);
    history.push(result);

    onIteration?.(result, i);

    // Check convergence
    if (result.overallDivergence < convergenceThreshold) {
      console.log(`Converged at iteration ${i} with divergence ${result.overallDivergence}`);
      break;
    }

    // Compute gradient and modifications
    const gradient = computeGradient(seed, result);
    const modifications = proposeModifications(seed, gradient, learningRate);

    // Apply modifications (simplified - in practice would modify seed.identity)
    seed = {
      ...seed,
      version: `${seed.version}.${i + 1}`,
      metadata: {
        ...seed.metadata,
        lastModifications: modifications,
        lastDivergence: result.overallDivergence
      }
    };
  }

  return { finalSeed: seed, history };
}

// ============================================================
// EXPORTS
// ============================================================

export const PROTOCOL_VERSION = '0.1.0';

export default {
  calculateDivergence,
  evaluatePropagation,
  computeGradient,
  proposeModifications,
  runProtocol,
  autonomousLoop,
  PROTOCOL_VERSION
};
