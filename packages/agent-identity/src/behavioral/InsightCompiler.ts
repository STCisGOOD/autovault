/**
 * InsightCompiler.ts
 *
 * Compiles raw insights into behavioral patterns, gated by ARIL
 * attribution scores. Patterns aren't just "what the LLM said" —
 * they're "what the gradient confirmed."
 *
 * A pattern compiles when:
 *   1. 3+ insights cluster in the same dimension, AND
 *   2. The dimension's ARIL fitness f[i] > f̄ (above average)
 *
 * Patterns from low-fitness dimensions decay faster:
 *   decay_rate = base_rate / (1 + f[i])
 */

import type { Insight } from './ReflectionEngine';
import type { DimensionAttribution } from './ShapleyAttributor';
import { safeFinite, safeDivide } from './math';

// =============================================================================
// TYPES
// =============================================================================

export interface CompiledPattern {
  /** Unique pattern ID */
  id: string;
  /** Primary dimension */
  dimension: string;
  /** Human-readable behavioral pattern */
  pattern: string;
  /** Raw insight observations supporting this pattern */
  evidence: string[];
  /** Confidence, informed by ARIL fitness (not just insight count) */
  confidence: number;
  /** Average Shapley attribution weight for this dimension */
  shapleyWeight: number;
  /** Number of sessions supporting this pattern */
  sessionCount: number;
  /** Auto-detected domain (if any) */
  domain?: string;
  /** When first observed */
  firstSeen: number;
  /** When last reinforced */
  lastReinforced: number;
}

export interface CompilerConfig {
  /** Min insights to form a pattern (default: 3) */
  minInsightsForPattern: number;
  /** Base decay rate per session without reinforcement (default: 0.02) */
  baseDecayRate: number;
  /** Max patterns to maintain (default: 50) */
  maxPatterns: number;
  /** Min confidence to keep a pattern (default: 0.1) */
  minConfidenceToKeep: number;
  /** Max buffered insights per dimension (default: 50) */
  maxBufferPerDimension: number;
}

export const DEFAULT_COMPILER_CONFIG: CompilerConfig = {
  minInsightsForPattern: 3,
  baseDecayRate: 0.02,
  maxPatterns: 50,
  minConfidenceToKeep: 0.1,
  maxBufferPerDimension: 50,
};

// =============================================================================
// COMPILER
// =============================================================================

export class InsightCompiler {
  private patterns: Map<string, CompiledPattern> = new Map();
  private insightBuffer: Map<string, Insight[]> = new Map();
  private readonly config: CompilerConfig;

  constructor(
    config: Partial<CompilerConfig> = {},
    initialPatterns: CompiledPattern[] = []
  ) {
    this.config = { ...DEFAULT_COMPILER_CONFIG, ...config };
    for (const p of initialPatterns) {
      this.patterns.set(p.id, p);
    }
  }

  /**
   * Compile new insights, gated by ARIL fitness and attributions.
   *
   * @param insights - New insights from this session
   * @param fitness - ARIL fitness scores per dimension
   * @param attributions - Shapley attributions from this session
   * @returns Newly compiled or reinforced patterns
   */
  compile(
    insights: Insight[],
    fitness: Float64Array,
    attributions: DimensionAttribution[]
  ): CompiledPattern[] {
    const now = Date.now();

    // Compute average fitness (guard NaN and zero-length)
    const fitnessLen = fitness.length;
    let fBar = 0;
    if (fitnessLen > 0) {
      for (let i = 0; i < fitnessLen; i++) {
        fBar += safeFinite(fitness[i], 0);
      }
      fBar = safeDivide(fBar, fitnessLen, 0);
    }

    // Buffer insights by dimension (bounded per dimension)
    for (const insight of insights) {
      const dim = insight.dimension;
      if (!this.insightBuffer.has(dim)) {
        this.insightBuffer.set(dim, []);
      }
      const buf = this.insightBuffer.get(dim)!;
      buf.push(insight);
      // Prevent unbounded growth — keep most recent entries
      if (buf.length > this.config.maxBufferPerDimension) {
        buf.splice(0, buf.length - this.config.maxBufferPerDimension);
      }
    }

    const newOrReinforced: CompiledPattern[] = [];

    // Check each dimension for pattern compilation
    for (const [dim, bufferedInsights] of this.insightBuffer) {
      const dimIndex = insights.find(i => i.dimension === dim)?.dimensionIndex ?? -1;
      const dimFitness = dimIndex >= 0 && dimIndex < fitnessLen
        ? safeFinite(fitness[dimIndex], 0)
        : 0;

      // ARIL gate: only compile if fitness > average (skip gate if no fitness data)
      if (fitnessLen > 0 && dimFitness <= fBar) {
        continue;
      }

      // Threshold gate: need enough insights
      if (bufferedInsights.length < this.config.minInsightsForPattern) {
        continue;
      }

      // Get attribution weight for this dimension
      const attr = attributions.find(a => a.dimension === dim);
      const shapleyWeight = attr ? attr.shapleyValue : 0;

      // Check if pattern already exists for this dimension
      const existingId = `pattern:${dim}`;
      const existing = this.patterns.get(existingId);

      if (existing) {
        // Reinforce existing pattern
        existing.evidence.push(
          ...bufferedInsights.slice(-3).map(i => i.observation)
        );
        // Keep evidence bounded
        if (existing.evidence.length > 10) {
          existing.evidence = existing.evidence.slice(-10);
        }
        existing.sessionCount++;
        existing.lastReinforced = now;
        existing.confidence = Math.min(
          safeFinite(existing.confidence + 0.1 * dimFitness, existing.confidence),
          1.0
        );
        existing.shapleyWeight = (existing.shapleyWeight + shapleyWeight) / 2;
        newOrReinforced.push(existing);
      } else {
        // Compile new pattern
        const pattern = synthesizePattern(dim, bufferedInsights);
        const compiled: CompiledPattern = {
          id: existingId,
          dimension: dim,
          pattern,
          evidence: bufferedInsights.slice(-5).map(i => i.observation),
          confidence: Math.min(dimFitness + 0.3, 1.0),
          shapleyWeight,
          sessionCount: 1,
          firstSeen: now,
          lastReinforced: now,
        };
        this.patterns.set(compiled.id, compiled);
        newOrReinforced.push(compiled);
      }

      // Clear buffer for compiled dimension
      this.insightBuffer.set(dim, []);
    }

    return newOrReinforced;
  }

  /**
   * Decay patterns based on fitness and time since last reinforcement.
   * Patterns from low-fitness dimensions decay faster.
   *
   * @param fitness - Current ARIL fitness scores
   * @param dimensions - Dimension names
   */
  decay(fitness: Float64Array, dimensions: readonly string[]): void {
    const toRemove: string[] = [];

    for (const [id, pattern] of this.patterns) {
      const dimIndex = dimensions.indexOf(pattern.dimension);
      const dimFitness = dimIndex >= 0 && dimIndex < fitness.length
        ? safeFinite(fitness[dimIndex], 0)
        : 0;

      // Fitness-modulated decay: low fitness → faster decay
      const decayRate = this.config.baseDecayRate / (1 + Math.abs(dimFitness));
      pattern.confidence -= decayRate;

      if (pattern.confidence < this.config.minConfidenceToKeep) {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      this.patterns.delete(id);
    }

    // Enforce max patterns limit (remove lowest confidence)
    if (this.patterns.size > this.config.maxPatterns) {
      const sorted = [...this.patterns.entries()]
        .sort((a, b) => a[1].confidence - b[1].confidence);
      const excess = this.patterns.size - this.config.maxPatterns;
      for (let i = 0; i < excess; i++) {
        this.patterns.delete(sorted[i][0]);
      }
    }
  }

  /**
   * Get all compiled patterns, sorted by confidence.
   */
  getPatterns(): CompiledPattern[] {
    return [...this.patterns.values()]
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Get patterns for a specific dimension.
   */
  getPatternsForDimension(dimension: string): CompiledPattern[] {
    return [...this.patterns.values()]
      .filter(p => p.dimension === dimension)
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Get the insight buffer (for debugging/inspection).
   */
  getInsightBuffer(): Map<string, Insight[]> {
    return new Map(this.insightBuffer);
  }
}

// =============================================================================
// SERIALIZATION
// =============================================================================

export interface SerializedCompilerState {
  patterns: CompiledPattern[];
  insightBuffer: Record<string, Insight[]>;
}

export function serializeCompilerState(compiler: InsightCompiler): SerializedCompilerState {
  const buffer: Record<string, Insight[]> = {};
  for (const [dim, insights] of compiler.getInsightBuffer()) {
    buffer[dim] = insights;
  }
  return {
    patterns: compiler.getPatterns(),
    insightBuffer: buffer,
  };
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/**
 * Synthesize a human-readable pattern from a cluster of insights.
 * Non-LLM fallback uses keyword frequency + templates.
 */
function synthesizePattern(dimension: string, insights: Insight[]): string {
  // Extract common themes via keyword frequency
  const wordFreq = new Map<string, number>();
  for (const insight of insights) {
    const words = insight.observation.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2);
    for (const word of words) {
      wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
    }
  }

  // Get top keywords
  const topWords = [...wordFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => w);

  // Determine trend direction
  const avgDelta = safeDivide(
    insights.reduce((s, i) => s + safeFinite(i.delta, 0), 0), insights.length, 0
  );
  const direction = avgDelta > 0 ? 'increasing' : avgDelta < 0 ? 'decreasing' : 'stable';

  // Template-based synthesis
  if (topWords.length > 0) {
    return `When working with ${topWords.join(', ')}: ${dimension} is ${direction} ` +
      `(${insights.length} observations, avg Δ=${avgDelta.toFixed(3)})`;
  }

  return `${dimension} trend: ${direction} over ${insights.length} observations ` +
    `(avg Δ=${avgDelta.toFixed(3)})`;
}
