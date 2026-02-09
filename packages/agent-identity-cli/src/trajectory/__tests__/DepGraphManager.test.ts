import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { DepGraphManager } from '../DepGraphManager';
import type { DepCruiserResult } from '../DepGraphManager';
import { TrajectoryStore } from '../TrajectoryStore';

function makeTmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depgraph-'));
  return path.join(dir, 'test.db');
}

function makeManager(): {
  manager: DepGraphManager;
  store: TrajectoryStore;
  dbPath: string;
} {
  const dbPath = makeTmpDbPath();
  const store = new TrajectoryStore({ dbPath });
  store.initialize();

  const manager = new DepGraphManager({
    cwd: '/project',
    store,
  });

  return { manager, store, dbPath };
}

// Simulate dep-cruiser result
function makeCruiserResult(): DepCruiserResult {
  return {
    modules: [
      {
        source: 'src/index.ts',
        dependencies: [
          { resolved: 'src/utils.ts', module: './utils', dependencyTypes: ['local'] },
          { resolved: 'src/config.ts', module: './config', dependencyTypes: ['local'] },
        ],
      },
      {
        source: 'src/utils.ts',
        dependencies: [
          { resolved: 'src/helpers.ts', module: './helpers', dependencyTypes: ['local'] },
        ],
      },
      {
        source: 'src/config.ts',
        dependencies: [],
      },
      {
        source: 'src/helpers.ts',
        dependencies: [],
      },
      {
        source: 'src/app.ts',
        dependencies: [
          { resolved: 'src/index.ts', module: './index', dependencyTypes: ['local'] },
        ],
      },
    ],
  };
}

describe('DepGraphManager', () => {
  let manager: DepGraphManager;
  let store: TrajectoryStore;
  let dbPath: string;

  beforeEach(() => {
    ({ manager, store, dbPath } = makeManager());
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.rmdirSync(path.dirname(dbPath)); } catch { /* ignore */ }
  });

  it('updateFromResult populates graph correctly', () => {
    const result = makeCruiserResult();
    manager.updateFromResult(result);

    // src/index.ts exists
    expect(manager.hasNode('src/index.ts')).toBe(true);
    // src/helpers.ts exists
    expect(manager.hasNode('src/helpers.ts')).toBe(true);
    // unknown file doesn't exist
    expect(manager.hasNode('src/unknown.ts')).toBe(false);
  });

  it('hasIncomingEdges correct for depended files', () => {
    manager.updateFromResult(makeCruiserResult());

    // src/utils.ts is depended on by src/index.ts
    expect(manager.hasIncomingEdges('src/utils.ts')).toBe(true);
    // src/config.ts is depended on by src/index.ts
    expect(manager.hasIncomingEdges('src/config.ts')).toBe(true);
    // src/app.ts has no dependents
    expect(manager.hasIncomingEdges('src/app.ts')).toBe(false);
  });

  it('computeMetrics returns Ca/Ce/instability', () => {
    manager.updateFromResult(makeCruiserResult());

    // src/index.ts: depends on utils + config (Ce=2), depended on by app (Ca=1)
    const indexMetrics = manager.computeMetrics('src/index.ts');
    expect(indexMetrics.ce).toBe(2);
    expect(indexMetrics.ca).toBe(1);
    expect(indexMetrics.instability).toBeCloseTo(2 / 3);

    // src/helpers.ts: leaf — no outgoing deps (Ce=0), depended on by utils (Ca=1)
    const helpersMetrics = manager.computeMetrics('src/helpers.ts');
    expect(helpersMetrics.ce).toBe(0);
    expect(helpersMetrics.ca).toBe(1);
    expect(helpersMetrics.instability).toBe(0); // maximally stable
  });

  it('computeNodeDepths returns correct depths', () => {
    manager.updateFromResult(makeCruiserResult());

    const depths = manager.computeNodeDepths();
    // Leaves: config.ts, helpers.ts → depth 0
    expect(depths.get('src/config.ts')).toBe(0);
    expect(depths.get('src/helpers.ts')).toBe(0);
    // utils.ts depends on helpers.ts → depth 1
    expect(depths.get('src/utils.ts')).toBe(1);
    // index.ts depends on utils(1) and config(0) → depth 2
    expect(depths.get('src/index.ts')).toBe(2);
    // app.ts depends on index(2) → depth 3
    expect(depths.get('src/app.ts')).toBe(3);
  });

  it('persistGraph writes to SQLite and can be reloaded', () => {
    manager.updateFromResult(makeCruiserResult());
    manager.persistGraph('test-session', 5);

    // Load from store
    const cached = store.loadLatestDepGraph('typescript');
    expect(cached).not.toBeNull();
    expect(cached!.nodeCount).toBe(5);
    expect(cached!.edgeCount).toBeGreaterThan(0);
    expect(cached!.sessionId).toBe('test-session');
    expect(cached!.stepIndex).toBe(5);
  });

  it('cache hit: loads graph from SQLite', async () => {
    // First manager populates cache
    manager.updateFromResult(makeCruiserResult());
    manager.persistGraph('test-session', 0);

    // Second manager loads from cache
    const { store: store2 } = makeManager();
    // Use same DB
    const store3 = new TrajectoryStore({ dbPath });
    store3.initialize();
    const manager3 = new DepGraphManager({ cwd: '/project', store: store3 });
    await manager3.initializeGraph();

    // Should have loaded the cached graph
    expect(manager3.hasNode('src/index.ts')).toBe(true);
    expect(manager3.hasIncomingEdges('src/utils.ts')).toBe(true);

    store2.close();
    store3.close();
  });

  it('empty graph returns sensible defaults', () => {
    expect(manager.hasNode('anything')).toBe(false);
    expect(manager.hasIncomingEdges('anything')).toBe(false);
    const metrics = manager.computeMetrics('anything');
    expect(metrics.ca).toBe(0);
    expect(metrics.ce).toBe(0);
    expect(metrics.instability).toBe(0);
  });
});
