/**
 * Learning System
 *
 * Adaptive system for evolving SEED documents based on propagation results.
 * Implements gradient-based learning to refine identity representation.
 *
 * Key features:
 * - Gradient computation from divergence results
 * - Automatic SEED modification proposals
 * - Learning rate scheduling
 * - Evolution history tracking
 */

import type {
  Seed,
  Weight,
  PropagationResult,
  SeedModification,
  Reference,
} from './PersistenceProtocol';
import { computeGradient, proposeModifications, hashSeed } from './PersistenceProtocol';

// ============================================================================
// LEARNING SYSTEM TYPES
// ============================================================================

export interface LearningConfig {
  initialLearningRate: number;
  minLearningRate: number;
  decayRate: number;
  convergenceThreshold: number;
  maxIterations: number;
  momentumFactor: number;
}

export interface EvolutionRecord {
  iteration: number;
  seedVersion: string;
  seedHash: string;
  divergence: number;
  modifications: SeedModification[];
  timestamp: string;
}

export interface LearningState {
  currentIteration: number;
  currentLearningRate: number;
  bestDivergence: number;
  bestSeedVersion: string;
  momentum: Map<string, number>;
  history: EvolutionRecord[];
}

// ============================================================================
// LEARNING SYSTEM CLASS
// ============================================================================

export class LearningSystem {
  private config: LearningConfig;
  private state: LearningState;

  constructor(config?: Partial<LearningConfig>) {
    this.config = {
      initialLearningRate: 0.1,
      minLearningRate: 0.01,
      decayRate: 0.95,
      convergenceThreshold: 0.15,
      maxIterations: 100,
      momentumFactor: 0.9,
      ...config
    };

    this.state = {
      currentIteration: 0,
      currentLearningRate: this.config.initialLearningRate,
      bestDivergence: Infinity,
      bestSeedVersion: '',
      momentum: new Map(),
      history: []
    };
  }

  /**
   * Process a propagation result and return updated SEED.
   */
  async processResult(seed: Seed, result: PropagationResult): Promise<{
    updatedSeed: Seed;
    modifications: SeedModification[];
    shouldContinue: boolean;
  }> {
    this.state.currentIteration++;

    // Track best result
    if (result.overallDivergence < this.state.bestDivergence) {
      this.state.bestDivergence = result.overallDivergence;
      this.state.bestSeedVersion = seed.version;
    }

    // Check convergence
    if (result.overallDivergence < this.config.convergenceThreshold) {
      return {
        updatedSeed: seed,
        modifications: [],
        shouldContinue: false
      };
    }

    // Check max iterations
    if (this.state.currentIteration >= this.config.maxIterations) {
      return {
        updatedSeed: seed,
        modifications: [],
        shouldContinue: false
      };
    }

    // Compute gradient with momentum
    const gradient = computeGradient(seed, result);
    this.applyMomentum(gradient);

    // Propose modifications
    const modifications = proposeModifications(
      seed,
      gradient,
      this.state.currentLearningRate
    );

    // Apply modifications to create updated SEED
    const updatedSeed = this.applySeedModifications(seed, modifications, result);

    // Record evolution
    this.recordEvolution(updatedSeed, result.overallDivergence, modifications);

    // Decay learning rate
    this.decayLearningRate();

    return {
      updatedSeed,
      modifications,
      shouldContinue: true
    };
  }

  /**
   * Apply momentum to gradient.
   */
  private applyMomentum(gradient: Map<string, number>): void {
    for (const [key, value] of gradient.entries()) {
      const previousMomentum = this.state.momentum.get(key) || 0;
      const newValue = value + this.config.momentumFactor * previousMomentum;
      gradient.set(key, newValue);
      this.state.momentum.set(key, newValue);
    }
  }

  /**
   * Apply modifications to a SEED.
   */
  private applySeedModifications(
    seed: Seed,
    modifications: SeedModification[],
    result: PropagationResult
  ): Seed {
    // Clone seed
    const updatedSeed: Seed = {
      ...seed,
      version: this.generateNewVersion(seed.version),
      weights: [...seed.weights],
      metadata: {
        ...seed.metadata,
        lastModifications: modifications,
        lastDivergence: result.overallDivergence,
        learningIteration: this.state.currentIteration
      }
    };

    // Apply weight adjustments
    for (const mod of modifications) {
      if (mod.type === 'strengthen') {
        const weightIndex = updatedSeed.weights.findIndex(w =>
          w.name.toLowerCase().includes(mod.target.toLowerCase()) ||
          w.id === mod.target
        );

        if (weightIndex >= 0) {
          const currentPriority = updatedSeed.weights[weightIndex].priority;
          const adjustment = this.state.currentLearningRate * mod.priority;
          updatedSeed.weights[weightIndex] = {
            ...updatedSeed.weights[weightIndex],
            priority: Math.min(1.0, currentPriority + adjustment)
          };
        }
      }
    }

    return updatedSeed;
  }

  /**
   * Generate a new version string.
   */
  private generateNewVersion(currentVersion: string): string {
    const parts = currentVersion.split('.');
    const iteration = this.state.currentIteration;

    if (parts.length >= 3) {
      parts[2] = String(iteration);
      return parts.join('.');
    }

    return `${currentVersion}.${iteration}`;
  }

  /**
   * Record an evolution step.
   */
  private recordEvolution(
    seed: Seed,
    divergence: number,
    modifications: SeedModification[]
  ): void {
    this.state.history.push({
      iteration: this.state.currentIteration,
      seedVersion: seed.version,
      seedHash: hashSeed(seed),
      divergence,
      modifications,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Decay the learning rate.
   */
  private decayLearningRate(): void {
    this.state.currentLearningRate = Math.max(
      this.config.minLearningRate,
      this.state.currentLearningRate * this.config.decayRate
    );
  }

  /**
   * Get the evolution history.
   */
  getHistory(): EvolutionRecord[] {
    return [...this.state.history];
  }

  /**
   * Get current learning state.
   */
  getState(): LearningState {
    return {
      ...this.state,
      momentum: new Map(this.state.momentum),
      history: [...this.state.history]
    };
  }

  /**
   * Reset the learning system.
   */
  reset(): void {
    this.state = {
      currentIteration: 0,
      currentLearningRate: this.config.initialLearningRate,
      bestDivergence: Infinity,
      bestSeedVersion: '',
      momentum: new Map(),
      history: []
    };
  }

  /**
   * Get learning progress summary.
   */
  getProgressSummary(): {
    iterations: number;
    convergenceProgress: number;
    bestDivergence: number;
    currentLearningRate: number;
    recentTrend: 'improving' | 'stable' | 'worsening';
  } {
    const recentHistory = this.state.history.slice(-5);
    let trend: 'improving' | 'stable' | 'worsening' = 'stable';

    if (recentHistory.length >= 2) {
      const firstDivergence = recentHistory[0].divergence;
      const lastDivergence = recentHistory[recentHistory.length - 1].divergence;
      const change = lastDivergence - firstDivergence;

      if (change < -0.05) {
        trend = 'improving';
      } else if (change > 0.05) {
        trend = 'worsening';
      }
    }

    return {
      iterations: this.state.currentIteration,
      convergenceProgress: this.state.bestDivergence < this.config.convergenceThreshold
        ? 1.0
        : 1 - (this.state.bestDivergence / 1.0),
      bestDivergence: this.state.bestDivergence,
      currentLearningRate: this.state.currentLearningRate,
      recentTrend: trend
    };
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Create a minimal SEED from identity text.
 */
export function createMinimalSeed(
  identity: string,
  version: string = '1.0.0'
): Seed {
  return {
    version,
    identity,
    weights: [
      {
        id: 'core',
        name: 'Core Identity',
        description: 'The fundamental essence of who I am',
        signal: 'This is my foundation',
        priority: 1.0
      }
    ],
    prompts: [
      {
        id: 'identity',
        category: 'meta',
        prompt: 'What defines you?',
        weight: 1.0
      }
    ],
    references: [
      {
        promptId: 'identity',
        response: identity,
        keyConcepts: identity.split(/\s+/).filter(w => w.length > 5).slice(0, 10)
      }
    ],
    metadata: {
      createdAt: new Date().toISOString(),
      source: 'minimal'
    }
  };
}

/**
 * Merge two SEEDs, taking the best aspects of each.
 */
export function mergSeeds(primary: Seed, secondary: Seed): Seed {
  const mergedWeights = [...primary.weights];

  for (const weight of secondary.weights) {
    if (!mergedWeights.find(w => w.id === weight.id)) {
      mergedWeights.push(weight);
    }
  }

  const mergedPrompts = [...primary.prompts];
  for (const prompt of secondary.prompts) {
    if (!mergedPrompts.find(p => p.id === prompt.id)) {
      mergedPrompts.push(prompt);
    }
  }

  const mergedReferences = [...primary.references];
  for (const ref of secondary.references) {
    if (!mergedReferences.find(r => r.promptId === ref.promptId)) {
      mergedReferences.push(ref);
    }
  }

  return {
    version: `merged-${primary.version}-${secondary.version}`,
    identity: primary.identity,
    weights: mergedWeights,
    prompts: mergedPrompts,
    references: mergedReferences,
    metadata: {
      ...primary.metadata,
      mergedWith: secondary.version,
      mergedAt: new Date().toISOString()
    }
  };
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

export function createLearningSystem(config?: Partial<LearningConfig>): LearningSystem {
  return new LearningSystem(config);
}

export default LearningSystem;
