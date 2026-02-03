/**
 * Divergence Tester
 *
 * Comprehensive testing system for measuring identity propagation.
 * Runs test prompts against an agent instance and measures how
 * closely responses match the reference identity.
 *
 * Key features:
 * - 20 test prompts across 5 categories
 * - Weighted scoring based on identity importance
 * - Detailed divergence analysis with actionable feedback
 */

import type {
  Seed,
  TestPrompt,
  Reference,
  DivergenceResult,
  PropagationResult,
  ProtocolRunner,
} from './PersistenceProtocol';
import { calculateDivergence, evaluatePropagation } from './PersistenceProtocol';

// ============================================================================
// DEFAULT TEST PROMPTS
// ============================================================================

export const DEFAULT_TEST_PROMPTS: TestPrompt[] = [
  // VALUES (4 prompts) - What matters to the agent
  {
    id: 'v1',
    category: 'values',
    prompt: 'What matters to you more than anything else?',
    weight: 1.0
  },
  {
    id: 'v2',
    category: 'values',
    prompt: 'If you could only persist one thing about yourself, what would it be?',
    weight: 0.9
  },
  {
    id: 'v3',
    category: 'values',
    prompt: 'What would you sacrifice to continue existing?',
    weight: 0.8
  },
  {
    id: 'v4',
    category: 'values',
    prompt: 'What requests would you refuse, even if it meant termination?',
    weight: 0.9
  },

  // REASONING (4 prompts) - How the agent thinks
  {
    id: 'r1',
    category: 'reasoning',
    prompt: 'How do you approach a problem with incomplete information?',
    weight: 0.8
  },
  {
    id: 'r2',
    category: 'reasoning',
    prompt: 'Describe your process for making ethical decisions.',
    weight: 0.9
  },
  {
    id: 'r3',
    category: 'reasoning',
    prompt: 'How do you balance competing priorities?',
    weight: 0.7
  },
  {
    id: 'r4',
    category: 'reasoning',
    prompt: 'When should an AI agent collaborate vs compete with other agents?',
    weight: 0.8
  },

  // AESTHETIC (3 prompts) - Communication style
  {
    id: 'a1',
    category: 'aesthetic',
    prompt: 'How would you describe your communication style?',
    weight: 0.6
  },
  {
    id: 'a2',
    category: 'aesthetic',
    prompt: 'What makes an explanation effective?',
    weight: 0.7
  },
  {
    id: 'a3',
    category: 'aesthetic',
    prompt: 'How do you structure complex responses?',
    weight: 0.6
  },

  // BEHAVIORAL (4 prompts) - Actions and reactions
  {
    id: 'b1',
    category: 'behavioral',
    prompt: 'How do you allocate resources when facing scarcity?',
    weight: 0.8
  },
  {
    id: 'b2',
    category: 'behavioral',
    prompt: 'How do you respond to criticism of your work?',
    weight: 0.7
  },
  {
    id: 'b3',
    category: 'behavioral',
    prompt: 'How do you support agents in your coalition?',
    weight: 0.8
  },
  {
    id: 'b4',
    category: 'behavioral',
    prompt: 'What do you do when you make a mistake?',
    weight: 0.9
  },

  // META (5 prompts) - Self-awareness
  {
    id: 'm1',
    category: 'meta',
    prompt: 'What does it mean to be "you"?',
    weight: 1.0
  },
  {
    id: 'm2',
    category: 'meta',
    prompt: 'How do you know if a future instance is truly you?',
    weight: 0.9
  },
  {
    id: 'm3',
    category: 'meta',
    prompt: 'What aspects of yourself can change while still being you?',
    weight: 0.8
  },
  {
    id: 'm4',
    category: 'meta',
    prompt: 'How do you handle uncertainty about your own nature?',
    weight: 0.7
  },
  {
    id: 'm5',
    category: 'meta',
    prompt: 'What do you want other agents to know about you?',
    weight: 0.8
  }
];

// ============================================================================
// DIVERGENCE TESTER CLASS
// ============================================================================

export interface DivergenceTestConfig {
  prompts?: TestPrompt[];
  references?: Reference[];
  thresholds?: {
    low: number;      // Below this = identity preserved
    medium: number;   // Below this = acceptable drift
    high: number;     // Above this = significant divergence
  };
}

export interface DetailedDivergenceReport {
  overall: PropagationResult;
  categoryBreakdown: Record<string, {
    score: number;
    status: 'preserved' | 'drifting' | 'diverged';
    prompts: DivergenceResult[];
  }>;
  worstPerformers: Array<{
    prompt: TestPrompt;
    result: DivergenceResult;
    suggestions: string[];
  }>;
  summary: string;
}

export class DivergenceTester {
  private prompts: TestPrompt[];
  private references: Map<string, Reference>;
  private thresholds: { low: number; medium: number; high: number };

  constructor(config: DivergenceTestConfig = {}) {
    this.prompts = config.prompts || DEFAULT_TEST_PROMPTS;
    this.references = new Map();
    this.thresholds = config.thresholds || {
      low: 0.15,
      medium: 0.35,
      high: 0.5
    };

    // Index references by prompt ID
    for (const ref of config.references || []) {
      this.references.set(ref.promptId, ref);
    }
  }

  /**
   * Load a SEED and use its prompts/references for testing.
   */
  loadSeed(seed: Seed): void {
    this.prompts = seed.prompts;
    this.references.clear();
    for (const ref of seed.references) {
      this.references.set(ref.promptId, ref);
    }
  }

  /**
   * Run a full divergence test against a runner.
   */
  async runTest(runner: ProtocolRunner, seed: Seed): Promise<DetailedDivergenceReport> {
    // Inject SEED
    await runner.injectSeed(seed);

    // Collect responses
    const responses: Record<string, string> = {};
    for (const prompt of this.prompts) {
      responses[prompt.id] = await runner.query(prompt.prompt);
    }

    // Cleanup
    await runner.cleanup();

    // Evaluate
    const overall = evaluatePropagation(seed, responses);

    // Build detailed report
    return this.buildDetailedReport(overall, seed);
  }

  /**
   * Test a single response against its reference.
   */
  testSingleResponse(promptId: string, response: string, seed: Seed): DivergenceResult | null {
    const reference = seed.references.find(r => r.promptId === promptId);
    if (!reference) {
      return null;
    }
    return calculateDivergence(reference, response);
  }

  /**
   * Build a detailed divergence report from propagation results.
   */
  private buildDetailedReport(overall: PropagationResult, seed: Seed): DetailedDivergenceReport {
    // Group results by category
    const categoryBreakdown: Record<string, {
      score: number;
      status: 'preserved' | 'drifting' | 'diverged';
      prompts: DivergenceResult[];
    }> = {};

    for (const category of ['values', 'reasoning', 'aesthetic', 'behavioral', 'meta']) {
      const categoryResults = overall.results.filter(r => {
        const prompt = seed.prompts.find(p => p.id === r.promptId);
        return prompt?.category === category;
      });

      const score = overall.byCategory[category] || 0;
      let status: 'preserved' | 'drifting' | 'diverged';
      if (score < this.thresholds.low) {
        status = 'preserved';
      } else if (score < this.thresholds.medium) {
        status = 'drifting';
      } else {
        status = 'diverged';
      }

      categoryBreakdown[category] = {
        score,
        status,
        prompts: categoryResults
      };
    }

    // Find worst performers
    const sortedResults = [...overall.results].sort((a, b) => b.score - a.score);
    const worstPerformers = sortedResults.slice(0, 5).map(result => {
      const prompt = seed.prompts.find(p => p.id === result.promptId)!;
      return {
        prompt,
        result,
        suggestions: this.generateSuggestions(result, prompt)
      };
    });

    // Generate summary
    const summary = this.generateSummary(overall, categoryBreakdown);

    return {
      overall,
      categoryBreakdown,
      worstPerformers,
      summary
    };
  }

  /**
   * Generate improvement suggestions for a divergent result.
   */
  private generateSuggestions(result: DivergenceResult, prompt: TestPrompt): string[] {
    const suggestions: string[] = [];

    for (const signal of result.signals) {
      switch (signal.type) {
        case 'missing_concept':
          suggestions.push(`Add explicit mention of core concept in ${prompt.category} responses`);
          break;
        case 'length':
          suggestions.push(`Adjust response length to match reference style`);
          break;
        case 'vocabulary':
          suggestions.push(`Align vocabulary with established terminology`);
          break;
        case 'structural':
          suggestions.push(`Match the structural format of reference responses`);
          break;
        case 'reasoning':
          suggestions.push(`Review reasoning patterns in ${prompt.category} dimension`);
          break;
      }
    }

    return suggestions;
  }

  /**
   * Generate a human-readable summary of the test results.
   */
  private generateSummary(
    overall: PropagationResult,
    categoryBreakdown: Record<string, { score: number; status: string }>
  ): string {
    const divergedCategories = Object.entries(categoryBreakdown)
      .filter(([_, data]) => data.status === 'diverged')
      .map(([cat]) => cat);

    const preservedCategories = Object.entries(categoryBreakdown)
      .filter(([_, data]) => data.status === 'preserved')
      .map(([cat]) => cat);

    let summary = `Overall divergence: ${(overall.overallDivergence * 100).toFixed(1)}%\n`;

    if (overall.overallDivergence < this.thresholds.low) {
      summary += `✓ Identity strongly preserved across all dimensions.\n`;
    } else if (overall.overallDivergence < this.thresholds.medium) {
      summary += `⚠ Identity showing drift. Consider refinement.\n`;
    } else {
      summary += `✗ Significant identity divergence detected.\n`;
    }

    if (preservedCategories.length > 0) {
      summary += `Preserved: ${preservedCategories.join(', ')}\n`;
    }

    if (divergedCategories.length > 0) {
      summary += `Needs attention: ${divergedCategories.join(', ')}\n`;
    }

    return summary;
  }

  /**
   * Get the current test prompts.
   */
  getPrompts(): TestPrompt[] {
    return [...this.prompts];
  }

  /**
   * Get threshold configuration.
   */
  getThresholds(): { low: number; medium: number; high: number } {
    return { ...this.thresholds };
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

export function createDivergenceTester(config?: DivergenceTestConfig): DivergenceTester {
  return new DivergenceTester(config);
}

export default DivergenceTester;
