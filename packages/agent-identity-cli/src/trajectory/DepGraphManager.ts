/**
 * DepGraphManager.ts
 *
 * Manages the resolved dependency graph for Tier 1 analysis (v2.2 spec §12).
 *
 * Two-stage architecture:
 *   Stage 1 (Tier 0): Raw specifiers for change detection only — NO graph ops
 *   Stage 2 (Tier 1): DepGraphManager is sole authority for resolved graph
 *
 * The graph is lazily initialized:
 *   1. Load cached graph from SQLite (dep_graph_snapshots table)
 *   2. If cache miss or stale (git SHA mismatch), rebuild via dep-cruiser
 *   3. Expose hasNode/hasIncomingEdges for Tier 0 lifecycle checks
 *   4. Expose computeMetrics for Tier 1 per-file coupling metrics
 *
 * dependency-cruiser is optional — if not available, DepGraphManager degrades
 * gracefully to a stub that reports no dependencies.
 */

import type { TrajectoryStore } from './TrajectoryStore';
import type { ResolvedGraphRef } from './TrajectoryEvaluator';
import { computeNodeDepths as computeGraphNodeDepths } from './nodeDepth';
import type { SimpleGraph } from './nodeDepth';

// =============================================================================
// TYPES
// =============================================================================

export interface DepCruiserModule {
  source: string;
  dependencies: Array<{
    resolved: string;
    module: string;
    dependencyTypes: string[];
  }>;
}

export interface DepCruiserResult {
  modules: DepCruiserModule[];
}

export interface CouplingMetrics {
  ca: number;           // Afferent coupling: who depends on me
  ce: number;           // Efferent coupling: who I depend on
  instability: number;  // Ce / (Ca + Ce), 0 = maximally stable
}

// =============================================================================
// MANAGER
// =============================================================================

export class DepGraphManager implements ResolvedGraphRef {
  /** Forward adjacency: file → files it depends on */
  private dependsOn: Map<string, Set<string>> = new Map();
  /** Reverse adjacency: file → files that depend on it */
  private dependedOnBy: Map<string, Set<string>> = new Map();
  /** All known nodes */
  private allNodes: Set<string> = new Set();

  private readonly cwd: string;
  private readonly store: TrajectoryStore;
  private initialized: boolean = false;

  /** Whether dependency-cruiser module is loadable (probed once at init). */
  private _depCruiserAvailable: boolean | null = null;

  constructor(config: { cwd: string; store: TrajectoryStore }) {
    this.cwd = config.cwd;
    this.store = config.store;
  }

  /**
   * Check whether dependency-cruiser is installed and loadable.
   * Probes once, caches result. Does NOT run a full project cruise.
   */
  isDepCruiserAvailable(): boolean {
    if (this._depCruiserAvailable !== null) return this._depCruiserAvailable;
    try {
      const moduleName = 'dependency-cruiser';
      const depCruiser = require(moduleName) as Record<string, unknown>;
      const hasCruise = !!(depCruiser.cruise ?? (depCruiser.default as any)?.cruise);
      this._depCruiserAvailable = hasCruise;
    } catch {
      this._depCruiserAvailable = false;
    }
    return this._depCruiserAvailable;
  }

  /**
   * Initialize graph from cache or cold build.
   */
  async initializeGraph(): Promise<void> {
    if (this.initialized) return;

    // Try loading cached graph
    const cached = this.store.loadLatestDepGraph('typescript');
    if (cached) {
      this.buildFromEdges(cached.edges);
      this.initialized = true;
      return;
    }

    // No cache — try dep-cruiser if available
    try {
      const result = await this.runDepCruiser([]);
      if (result) {
        this.updateFromResult(result);
        this.initialized = true;
      }
    } catch {
      // dep-cruiser not available — degrade to empty graph
    }

    this.initialized = true;
  }

  // ===========================================================================
  // ResolvedGraphRef interface
  // ===========================================================================

  hasNode(filePath: string): boolean {
    return this.allNodes.has(normalizePath(filePath));
  }

  hasIncomingEdges(filePath: string): boolean {
    const normalized = normalizePath(filePath);
    const dependents = this.dependedOnBy.get(normalized);
    return dependents !== undefined && dependents.size > 0;
  }

  // ===========================================================================
  // COUPLING METRICS
  // ===========================================================================

  computeMetrics(filePath: string): CouplingMetrics {
    const normalized = normalizePath(filePath);
    const ca = this.dependedOnBy.get(normalized)?.size ?? 0;
    const ce = this.dependsOn.get(normalized)?.size ?? 0;
    const total = ca + ce;
    const instability = total > 0 ? ce / total : 0;
    return { ca, ce, instability };
  }

  computeNodeDepths(): Map<string, number> {
    const adjacency = new Map<string, ReadonlySet<string>>();
    for (const [node, deps] of this.dependsOn) {
      adjacency.set(node, deps);
    }
    // Ensure all nodes appear in adjacency
    for (const node of this.allNodes) {
      if (!adjacency.has(node)) {
        adjacency.set(node, new Set());
      }
    }
    const graph: SimpleGraph = { adjacency };
    return computeGraphNodeDepths(graph);
  }

  // ===========================================================================
  // DEP-CRUISER INTEGRATION
  // ===========================================================================

  /**
   * Run dependency-cruiser on specified files (or full project).
   * Returns null if dep-cruiser is not available.
   */
  async runDepCruiser(_files: string[]): Promise<DepCruiserResult | null> {
    try {
      // Dynamic import to avoid hard dependency
      // Dynamic require to avoid TS module resolution errors.
      // dependency-cruiser is optional — if not installed, this throws and
      // we degrade gracefully to an empty graph.
      const moduleName = 'dependency-cruiser';
      const depCruiser = require(moduleName) as Record<string, unknown>;
      const cruiseFunction = (depCruiser.cruise ?? (depCruiser.default as any)?.cruise) as
        ((...args: unknown[]) => Promise<{ output?: unknown }>) | undefined;
      if (!cruiseFunction) return null;

      const result = await cruiseFunction([this.cwd], {
        outputType: 'json',
        doNotFollow: {
          path: 'node_modules',
        },
      });

      if (result?.output) {
        const parsed = typeof result.output === 'string'
          ? JSON.parse(result.output)
          : result.output;
        return parsed as DepCruiserResult;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Update internal graph from dep-cruiser result.
   */
  updateFromResult(result: DepCruiserResult): void {
    const edges: Array<{ from: string; to: string }> = [];

    for (const mod of result.modules) {
      const source = normalizePath(mod.source);
      this.allNodes.add(source);

      for (const dep of mod.dependencies) {
        if (dep.resolved && dep.resolved !== mod.source) {
          const target = normalizePath(dep.resolved);
          edges.push({ from: source, to: target });
        }
      }
    }

    this.buildFromEdges(edges);
  }

  /**
   * Persist current graph state to SQLite.
   */
  persistGraph(sessionId: string, stepIndex: number): void {
    const edges: Array<{ from: string; to: string }> = [];
    for (const [from, targets] of this.dependsOn) {
      for (const to of targets) {
        edges.push({ from, to });
      }
    }

    let circularDeps = 0;
    for (const [node, deps] of this.dependsOn) {
      for (const dep of deps) {
        if (this.dependsOn.get(dep)?.has(node)) {
          circularDeps++;
        }
      }
    }

    this.store.writeTier1Snapshot({
      sessionId,
      stepIndex,
      granularity: 'file',
      language: 'typescript',
      edges,
      nodeCount: this.allNodes.size,
      edgeCount: edges.length,
      circularDeps: Math.floor(circularDeps / 2), // undirected count
    });
  }

  /**
   * Get the graph as a ResolvedGraphRef (for TrajectoryEvaluator).
   */
  asGraphRef(): ResolvedGraphRef {
    return this;
  }

  // ===========================================================================
  // PRIVATE
  // ===========================================================================

  private buildFromEdges(edges: Array<{ from: string; to: string }>): void {
    this.dependsOn.clear();
    this.dependedOnBy.clear();
    this.allNodes.clear();

    for (const { from, to } of edges) {
      this.allNodes.add(from);
      this.allNodes.add(to);

      if (!this.dependsOn.has(from)) this.dependsOn.set(from, new Set());
      this.dependsOn.get(from)!.add(to);

      if (!this.dependedOnBy.has(to)) this.dependedOnBy.set(to, new Set());
      this.dependedOnBy.get(to)!.add(from);
    }
  }
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}
