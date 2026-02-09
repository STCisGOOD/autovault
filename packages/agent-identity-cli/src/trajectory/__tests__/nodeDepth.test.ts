import { spearmanRho, computeNodeDepths, computeEditDepAlignment } from '../nodeDepth';
import type { SimpleGraph } from '../nodeDepth';

describe('spearmanRho', () => {
  it('perfect positive correlation → rho ≈ 1.0', () => {
    const rho = spearmanRho([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]);
    expect(rho).toBeCloseTo(1.0, 5);
  });

  it('perfect negative correlation → rho ≈ -1.0', () => {
    const rho = spearmanRho([1, 2, 3, 4, 5], [50, 40, 30, 20, 10]);
    expect(rho).toBeCloseTo(-1.0, 5);
  });

  it('< 3 data points → 0', () => {
    expect(spearmanRho([1, 2], [3, 4])).toBe(0);
    expect(spearmanRho([1], [2])).toBe(0);
    expect(spearmanRho([], [])).toBe(0);
  });

  it('handles ties with average rank', () => {
    // [1, 1, 3] → ranks [1.5, 1.5, 3]
    // [10, 20, 30] → ranks [1, 2, 3]
    const rho = spearmanRho([1, 1, 3], [10, 20, 30]);
    expect(rho).toBeGreaterThan(0);
    expect(rho).toBeLessThanOrEqual(1.0);
  });

  it('no correlation → rho ≈ 0', () => {
    const rho = spearmanRho([1, 2, 3, 4, 5, 6], [3, 1, 6, 2, 5, 4]);
    expect(Math.abs(rho)).toBeLessThan(0.5);
  });
});

describe('computeNodeDepths', () => {
  it('leaf depth = 0', () => {
    const graph: SimpleGraph = {
      adjacency: new Map([
        ['a', new Set<string>()],
      ]),
    };
    const depths = computeNodeDepths(graph);
    expect(depths.get('a')).toBe(0);
  });

  it('chain depth correct: a→b→c', () => {
    const graph: SimpleGraph = {
      adjacency: new Map([
        ['a', new Set(['b'])],
        ['b', new Set(['c'])],
        ['c', new Set<string>()],
      ]),
    };
    const depths = computeNodeDepths(graph);
    expect(depths.get('c')).toBe(0); // leaf
    expect(depths.get('b')).toBe(1);
    expect(depths.get('a')).toBe(2);
  });

  it('cycle nodes = depth 0', () => {
    const graph: SimpleGraph = {
      adjacency: new Map([
        ['a', new Set(['b'])],
        ['b', new Set(['a'])], // cycle
      ]),
    };
    const depths = computeNodeDepths(graph);
    // Both nodes form a cycle with no leaf — depth 0
    expect(depths.get('a')).toBe(0);
    expect(depths.get('b')).toBe(0);
  });

  it('diamond graph: correct depths', () => {
    //   a
    //  / \
    // b   c
    //  \ /
    //   d
    const graph: SimpleGraph = {
      adjacency: new Map([
        ['a', new Set(['b', 'c'])],
        ['b', new Set(['d'])],
        ['c', new Set(['d'])],
        ['d', new Set<string>()],
      ]),
    };
    const depths = computeNodeDepths(graph);
    expect(depths.get('d')).toBe(0);
    expect(depths.get('b')).toBe(1);
    expect(depths.get('c')).toBe(1);
    expect(depths.get('a')).toBe(2);
  });
});

describe('computeEditDepAlignment', () => {
  it('returns 0 for < 3 files', () => {
    const result = computeEditDepAlignment(
      [{ filePath: 'a', firstStepIndex: 0 }],
      new Map([['a', 0]]),
    );
    expect(result).toBe(0);
  });

  it('bottom-up editing (leaves first) → positive correlation', () => {
    // Edit order: d(0), c(1), b(2), a(3) — editing from leaves to roots
    // Depths: d=0, c=1, b=1, a=2
    const nodeDepths = new Map([['d', 0], ['c', 1], ['b', 1], ['a', 2]]);
    const editOrder = [
      { filePath: 'd', firstStepIndex: 0 },
      { filePath: 'c', firstStepIndex: 1 },
      { filePath: 'b', firstStepIndex: 2 },
      { filePath: 'a', firstStepIndex: 3 },
    ];
    const rho = computeEditDepAlignment(editOrder, nodeDepths);
    // Leaves first → negative rho (early steps = low depth)
    // Actually: edit index correlates with depth → positive rho
    expect(rho).toBeGreaterThan(0);
  });
});
