/**
 * nodeDepth.ts
 *
 * Dependency graph depth computation and Spearman rank correlation
 * for the edit_dep_alignment trajectory feature (v2.2 spec §9).
 *
 * Node depth = longest path from any leaf (depth 0).
 * Leaf nodes have no outgoing dependencies. Cycle nodes get depth 0.
 */

// =============================================================================
// GRAPH DEPTH
// =============================================================================

export interface SimpleGraph {
  /** Map from node → nodes it depends on (outgoing edges). */
  readonly adjacency: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Compute node depths via reverse BFS from leaves.
 *
 * Depth 0 = leaf (no outgoing deps).
 * Depth N = longest path from any leaf.
 * Cycle nodes = depth 0 (unreachable from leaves).
 */
export function computeNodeDepths(graph: SimpleGraph): Map<string, number> {
  const depths = new Map<string, number>();
  const nodes = new Set(graph.adjacency.keys());

  // Also add all target nodes
  for (const targets of graph.adjacency.values()) {
    for (const t of targets) {
      nodes.add(t);
    }
  }

  // Build reverse adjacency: who depends on me?
  const reverseAdj = new Map<string, Set<string>>();
  for (const node of nodes) {
    reverseAdj.set(node, new Set());
  }
  for (const [from, targets] of graph.adjacency) {
    for (const to of targets) {
      reverseAdj.get(to)?.add(from);
    }
  }

  // Find leaves (no outgoing deps)
  const queue: string[] = [];
  for (const node of nodes) {
    const deps = graph.adjacency.get(node);
    if (!deps || deps.size === 0) {
      depths.set(node, 0);
      queue.push(node);
    }
  }

  // BFS from leaves upward
  let idx = 0;
  while (idx < queue.length) {
    const current = queue[idx++];
    const currentDepth = depths.get(current) ?? 0;

    const dependents = reverseAdj.get(current);
    if (!dependents) continue;

    for (const dep of dependents) {
      const newDepth = currentDepth + 1;
      const existing = depths.get(dep);
      if (existing === undefined || newDepth > existing) {
        depths.set(dep, newDepth);
        queue.push(dep); // re-process with higher depth
      }
    }
  }

  // Nodes not reached (cycles) get depth 0
  for (const node of nodes) {
    if (!depths.has(node)) {
      depths.set(node, 0);
    }
  }

  return depths;
}

// =============================================================================
// SPEARMAN RANK CORRELATION
// =============================================================================

/**
 * Compute Spearman rank correlation coefficient.
 *
 * Returns 0 for < 3 data points (insufficient for meaningful correlation).
 * Handles ties with average rank.
 */
export function spearmanRho(x: number[], y: number[]): number {
  const n = x.length;
  if (n !== y.length || n < 3) return 0;

  const ranksX = computeRanks(x);
  const ranksY = computeRanks(y);

  // Pearson correlation of ranks
  const meanX = ranksX.reduce((a, b) => a + b, 0) / n;
  const meanY = ranksY.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < n; i++) {
    const dx = ranksX[i] - meanX;
    const dy = ranksY[i] - meanY;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denom = Math.sqrt(denomX * denomY);
  if (denom === 0) return 0;

  return num / denom;
}

/**
 * Compute edit-dependency alignment score.
 *
 * Measures Spearman correlation between:
 *   - edit order (first-touch stepIndex per file)
 *   - node depth in dependency graph
 *
 * Positive rho → editing leaves before roots (bottom-up)
 * Negative rho → editing roots before leaves (top-down)
 */
export function computeEditDepAlignment(
  editOrder: Array<{ filePath: string; firstStepIndex: number }>,
  nodeDepths: Map<string, number>,
): number {
  // Only include files that appear in both edit order and depth map
  const pairs: Array<{ editIdx: number; depth: number }> = [];

  for (const { filePath, firstStepIndex } of editOrder) {
    const depth = nodeDepths.get(filePath);
    if (depth !== undefined) {
      pairs.push({ editIdx: firstStepIndex, depth });
    }
  }

  if (pairs.length < 3) return 0;

  const editIndices = pairs.map(p => p.editIdx);
  const depths = pairs.map(p => p.depth);

  return spearmanRho(editIndices, depths);
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Compute ranks with average-rank tie handling.
 */
function computeRanks(values: number[]): number[] {
  const n = values.length;
  const indexed = values.map((v, i) => ({ value: v, index: i }));
  indexed.sort((a, b) => a.value - b.value);

  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    // Find group of ties
    let j = i + 1;
    while (j < n && indexed[j].value === indexed[i].value) {
      j++;
    }
    // Average rank for ties (1-based)
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) {
      ranks[indexed[k].index] = avgRank;
    }
    i = j;
  }

  return ranks;
}
