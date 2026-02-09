/**
 * TrajectoryEvaluator.ts
 *
 * Core engine for tracking code-level metrics across a session (v2.2 spec §12).
 *
 * On every Write/Edit/NotebookEdit tool call, the evaluator:
 *   1. Checks seenPaths lifecycle (v2.2: BEFORE any mutations)
 *   2. Parses with tree-sitter (incremental) or TS API fallback
 *   3. Extracts Tier 0 metrics (<15ms per edit)
 *   4. Stores raw import specifiers for change detection
 *   5. Determines Tier 1 triggers (import delta, new file, export surface)
 *   6. Writes metric snapshot to SQLite (batched)
 *
 * Module-level singleton per session. Parse trees + seenPaths + import cache
 * live in memory for session lifetime.
 */

import * as ts from 'typescript';
import * as crypto from 'crypto';
import type { TrajectoryStore } from './TrajectoryStore';
import type { MetricSnapshot, Tier0Result, Granularity, MetricTier } from './types';
import { TRAJECTORY_SCHEMA_VERSION } from './types';
import { classifyFileRole, classifyPackage } from './fileClassifier';

// =============================================================================
// RESOLVED GRAPH INTERFACE
// =============================================================================

/** Minimal interface for the resolved dependency graph (provided by DepGraphManager). */
export interface ResolvedGraphRef {
  hasNode(filePath: string): boolean;
  hasIncomingEdges(filePath: string): boolean;
}

/** Null-object graph for when Tier 1 hasn't run yet. */
const NULL_GRAPH: ResolvedGraphRef = {
  hasNode: () => false,
  hasIncomingEdges: () => false,
};

// =============================================================================
// TIER 0 METRICS INTERFACE
// =============================================================================

interface Tier0Metrics {
  raw_imports: string[];
  export_count: number;
  function_count: number;
  ast_depth: number;
  cyclomatic_complexity: number;
  line_count: number;
  loc_delta: number;
}

// =============================================================================
// EVALUATOR
// =============================================================================

export interface TrajectoryEvaluatorConfig {
  cwd: string;
  sessionId: string;
  store: TrajectoryStore;
  packageRoots?: string[];
}

export class TrajectoryEvaluator {
  // In-memory session state
  private rawImportCache: Map<string, Set<string>> = new Map();
  private exportCountCache: Map<string, number> = new Map();
  private lineCountCache: Map<string, number> = new Map();
  private seenPaths: Set<string> = new Set();
  private contentHashCache: Map<string, string> = new Map();

  // Trajectory state
  private currentStep: number = 0;
  private readonly store: TrajectoryStore;
  private sessionSchemaVersion: number = TRAJECTORY_SCHEMA_VERSION;

  // Graph reference (from DepGraphManager, populated by Tier 1)
  private resolvedGraph: ResolvedGraphRef = NULL_GRAPH;

  readonly projectRoot: string;
  readonly sessionId: string;
  private readonly packageRoots: string[];

  constructor(config: TrajectoryEvaluatorConfig) {
    this.projectRoot = config.cwd;
    this.sessionId = config.sessionId;
    this.store = config.store;
    this.packageRoots = config.packageRoots ?? [];
  }

  /**
   * Initialize the evaluator. Pin schema version from store.
   */
  initialize(): void {
    this.sessionSchemaVersion = this.store.initSession();
  }

  /**
   * Called on every Write/Edit/NotebookEdit.
   *
   * v2.2 critical ordering:
   *   1. isFirstTouchInSession = !seenPaths.has(filePath)
   *   2. seenPaths.add(filePath)
   *   3. isNewFile = isFirstTouchInSession && !resolvedGraph.hasNode(filePath)
   *   4. oldSpecifiers = rawImportCache.get(filePath)
   *   5. Parse → extract metrics
   *   6. Determine Tier 1 triggers
   *   7. Store snapshot
   */
  onFileChange(filePath: string, content: string, toolType: string): Tier0Result {
    const normalizedPath = normalizePath(filePath);

    // Skip .ipynb files — raw JSON notebook format fed to ts.createSourceFile
    // produces garbage metrics (function_count, imports, etc. all meaningless).
    // Corrupted metrics are worse than missing metrics.
    if (normalizedPath.endsWith('.ipynb')) {
      const step = this.currentStep++;
      const snapshot = this.buildSnapshot(normalizedPath, step, toolType, {}, 0);
      return { snapshot, tier1Trigger: false };
    }

    const step = this.currentStep++;

    // --- v2.2 lifecycle: check BEFORE mutations ---
    const isFirstTouchInSession = !this.seenPaths.has(normalizedPath);
    this.seenPaths.add(normalizedPath);
    const isNewFile = isFirstTouchInSession && !this.resolvedGraph.hasNode(normalizedPath);

    // --- Content-hash cache check ---
    const contentHash = hashContent(content);
    const prevHash = this.contentHashCache.get(normalizedPath);

    if (prevHash === contentHash) {
      // Content unchanged — return cached result without re-parsing
      const cachedMetrics = this.store.getCachedAnalysis(normalizedPath, contentHash, 0);
      if (cachedMetrics) {
        const snapshot = this.buildSnapshot(
          normalizedPath, step, toolType, cachedMetrics, 0,
        );
        this.store.writeSnapshot(snapshot);
        return { snapshot, tier1Trigger: false };
      }
    }
    this.contentHashCache.set(normalizedPath, contentHash);

    // --- Capture old state BEFORE parsing (reference aliasing guard) ---
    const oldSpecifiers = this.rawImportCache.get(normalizedPath);
    const oldExportCount = this.exportCountCache.get(normalizedPath);

    // --- Parse and extract Tier 0 metrics ---
    const metrics = this.extractTier0Metrics(normalizedPath, content);

    // --- Update caches ---
    this.rawImportCache.set(normalizedPath, new Set(metrics.raw_imports));
    this.exportCountCache.set(normalizedPath, metrics.export_count);
    this.lineCountCache.set(normalizedPath, metrics.line_count);

    // --- Cache in SQLite for content-hash dedup ---
    const metricsRecord: Record<string, unknown> = { ...metrics };
    this.store.setCachedAnalysis(normalizedPath, contentHash, 0, metricsRecord);

    // --- Build snapshot ---
    const snapshot = this.buildSnapshot(
      normalizedPath, step, toolType, metricsRecord, 0,
    );
    this.store.writeSnapshot(snapshot);

    // --- Determine Tier 1 triggers ---
    const tier1Trigger = this.checkTier1Trigger(
      normalizedPath, metrics, oldSpecifiers, oldExportCount, isNewFile,
    );

    return { snapshot, tier1Trigger };
  }

  /**
   * Update resolved graph after Tier 1 batch completes.
   */
  updateResolvedGraph(graph: ResolvedGraphRef): void {
    this.resolvedGraph = graph;
  }

  /**
   * Get full trajectory for feature extraction.
   */
  getTrajectory(): MetricSnapshot[] {
    this.store.flush();
    return this.store.queryBySession(this.sessionId);
  }

  /**
   * Expose seen paths for feature extraction at session end.
   */
  getSeenPaths(): ReadonlySet<string> {
    return this.seenPaths;
  }

  /**
   * Get the current step index.
   */
  getCurrentStep(): number {
    return this.currentStep;
  }

  /**
   * Get raw import cache (for feature extraction).
   */
  getRawImportCache(): ReadonlyMap<string, Set<string>> {
    return this.rawImportCache;
  }

  /**
   * Get export count cache (for feature extraction).
   */
  getExportCountCache(): ReadonlyMap<string, number> {
    return this.exportCountCache;
  }

  /**
   * Flush and shutdown.
   */
  shutdown(): void {
    this.store.flush();
  }

  // ===========================================================================
  // PRIVATE — TIER 0 EXTRACTION
  // ===========================================================================

  /**
   * Extract Tier 0 metrics using TypeScript compiler API.
   *
   * This is the fallback parser (also used when tree-sitter isn't available).
   * Uses ts.createSourceFile for AST — no project context needed, fast enough
   * for per-edit analysis (~3-5ms for typical files).
   */
  private extractTier0Metrics(filePath: string, content: string): Tier0Metrics {
    const prevLineCount = this.lineCountCache.get(filePath) ?? 0;

    // Determine script kind from extension
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    let scriptKind = ts.ScriptKind.TS;
    if (ext === 'tsx' || ext === 'jsx') scriptKind = ts.ScriptKind.TSX;
    else if (ext === 'js' || ext === 'mjs' || ext === 'cjs') scriptKind = ts.ScriptKind.JS;

    try {
      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true, // setParentNodes
        scriptKind,
      );

      const rawImports: string[] = [];
      let exportCount = 0;
      let functionCount = 0;
      let maxDepth = 0;
      let complexity = 0;

      const walk = (node: ts.Node, depth: number): void => {
        if (depth > maxDepth) maxDepth = depth;

        // Import declarations
        if (ts.isImportDeclaration(node)) {
          const moduleSpec = node.moduleSpecifier;
          if (ts.isStringLiteral(moduleSpec)) {
            rawImports.push(moduleSpec.text);
          }
        }

        // Dynamic imports: import('...')
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          if (node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
            rawImports.push(node.arguments[0].text);
          }
        }

        // Require calls: require('...')
        if (ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === 'require' &&
            node.arguments.length > 0 &&
            ts.isStringLiteral(node.arguments[0])) {
          rawImports.push(node.arguments[0].text);
        }

        // Export declarations
        if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) {
          exportCount++;
        }
        // Export modifier on variable/function/class declarations
        if (ts.canHaveModifiers(node)) {
          const mods = ts.getModifiers(node);
          if (mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
            exportCount++;
          }
        }

        // Function declarations
        if (ts.isFunctionDeclaration(node) ||
            ts.isMethodDeclaration(node) ||
            ts.isArrowFunction(node) ||
            ts.isFunctionExpression(node)) {
          functionCount++;
        }

        // Cyclomatic complexity: count decision points.
        // SwitchStatement (not CaseClause) to avoid inflating complexity
        // for large switch blocks — each switch is one decision point.
        switch (node.kind) {
          case ts.SyntaxKind.IfStatement:
          case ts.SyntaxKind.ForStatement:
          case ts.SyntaxKind.ForInStatement:
          case ts.SyntaxKind.ForOfStatement:
          case ts.SyntaxKind.WhileStatement:
          case ts.SyntaxKind.DoStatement:
          case ts.SyntaxKind.SwitchStatement:
          case ts.SyntaxKind.CatchClause:
          case ts.SyntaxKind.ConditionalExpression: // ternary
            complexity++;
            break;
        }

        // Binary expressions: && and ||
        if (ts.isBinaryExpression(node)) {
          if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
              node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
            complexity++;
          }
        }

        ts.forEachChild(node, child => walk(child, depth + 1));
      };

      walk(sourceFile, 0);

      const lineCount = content.split('\n').filter(l => l.trim().length > 0).length;

      return {
        raw_imports: rawImports,
        export_count: exportCount,
        function_count: functionCount,
        ast_depth: maxDepth,
        cyclomatic_complexity: complexity,
        line_count: lineCount,
        loc_delta: lineCount - prevLineCount,
      };
    } catch {
      // Parse failure — return minimal metrics
      const lineCount = content.split('\n').filter(l => l.trim().length > 0).length;
      return {
        raw_imports: [],
        export_count: 0,
        function_count: 0,
        ast_depth: 0,
        cyclomatic_complexity: 0,
        line_count: lineCount,
        loc_delta: lineCount - prevLineCount,
      };
    }
  }

  // ===========================================================================
  // PRIVATE — TIER 1 TRIGGER DETECTION
  // ===========================================================================

  private checkTier1Trigger(
    filePath: string,
    metrics: Tier0Metrics,
    oldSpecifiers: Set<string> | undefined,
    oldExportCount: number | undefined,
    isNewFile: boolean,
  ): boolean {
    // Trigger 1: New file (first touch in session + not in resolved graph)
    if (isNewFile) return true;

    // Trigger 2: Import specifiers changed
    if (oldSpecifiers) {
      const newSpecifiers = new Set(metrics.raw_imports);
      if (!setsEqual(oldSpecifiers, newSpecifiers)) return true;
    }

    // Trigger 3: Export surface changed on file with dependents
    if (oldExportCount !== undefined && oldExportCount !== metrics.export_count) {
      if (this.resolvedGraph.hasIncomingEdges(filePath)) return true;
    }

    return false;
  }

  // ===========================================================================
  // PRIVATE — SNAPSHOT BUILDING
  // ===========================================================================

  private buildSnapshot(
    filePath: string,
    stepIndex: number,
    toolType: string,
    metricsJson: Record<string, unknown>,
    tier: MetricTier,
  ): MetricSnapshot {
    return {
      sessionId: this.sessionId,
      stepIndex,
      timestampMs: Date.now(),
      filePath,
      toolType,
      granularity: 'file' as Granularity,
      packageName: classifyPackage(filePath, this.packageRoots),
      fileRole: classifyFileRole(filePath),
      metricsJson,
      tier,
      schemaVersion: this.sessionSchemaVersion,
    };
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/** Normalize path to forward slashes for consistent comparison. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** SHA-256 content hash (fast, deterministic). */
function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Set equality check. */
function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}
