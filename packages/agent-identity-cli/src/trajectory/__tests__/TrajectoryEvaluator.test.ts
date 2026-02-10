import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { TrajectoryStore } from '../TrajectoryStore';
import { TrajectoryEvaluator, normalizePath } from '../TrajectoryEvaluator';
import type { ResolvedGraphRef } from '../TrajectoryEvaluator';

function makeTmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traj-eval-'));
  return path.join(dir, 'test.db');
}

function makeEvaluator(overrides: Partial<{
  dbPath: string;
  sessionId: string;
  cwd: string;
}> = {}): { evaluator: TrajectoryEvaluator; store: TrajectoryStore; dbPath: string } {
  const dbPath = overrides.dbPath ?? makeTmpDbPath();
  const store = new TrajectoryStore({ dbPath });
  store.initialize();

  const evaluator = new TrajectoryEvaluator({
    cwd: overrides.cwd ?? '/project',
    sessionId: overrides.sessionId ?? 'test-session',
    store,
  });
  evaluator.initialize();

  return { evaluator, store, dbPath };
}

// Sample TypeScript content for testing
const SAMPLE_TS = `
import { foo } from './utils';
import * as path from 'path';

export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  if (a > b) {
    return a - b;
  }
  return 0;
}

const helper = (x: number) => x * 2;
`;

const SAMPLE_TS_MODIFIED = `
import { foo, bar } from './utils';
import * as path from 'path';
import { readFileSync } from 'fs';

export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  if (a > b) {
    return a - b;
  }
  return 0;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

const helper = (x: number) => x * 2;
`;

const EMPTY_FILE = '';

describe('TrajectoryEvaluator', () => {
  let evaluator: TrajectoryEvaluator;
  let store: TrajectoryStore;
  let dbPath: string;

  beforeEach(() => {
    ({ evaluator, store, dbPath } = makeEvaluator());
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.rmdirSync(path.dirname(dbPath)); } catch { /* ignore */ }
  });

  it('extracts correct metrics for known TS file', () => {
    const result = evaluator.onFileChange('/src/index.ts', SAMPLE_TS, 'Write');

    const metrics = result.snapshot.metricsJson;
    // Should find 2 imports: './utils' and 'path'
    expect(metrics.raw_imports).toEqual(['./utils', 'path']);
    // 2 exported functions
    expect(metrics.export_count).toBe(2);
    // 3 functions: add, subtract, helper (arrow)
    expect(metrics.function_count).toBe(3);
    // Should have some ast depth
    expect(metrics.ast_depth).toBeGreaterThan(0);
    // 1 if statement
    expect(metrics.cyclomatic_complexity).toBeGreaterThanOrEqual(1);
    // Non-empty lines
    expect(metrics.line_count).toBeGreaterThan(0);
  });

  it('stores raw import specifiers (not resolved paths)', () => {
    const result = evaluator.onFileChange('/src/index.ts', SAMPLE_TS, 'Write');
    const imports = result.snapshot.metricsJson.raw_imports as string[];
    // Should be raw specifiers, not resolved paths
    expect(imports).toContain('./utils');
    expect(imports).toContain('path');
    expect(imports).not.toContain('/src/utils.ts'); // NOT resolved
  });

  it('onFileChange increments stepIndex', () => {
    const r1 = evaluator.onFileChange('/src/a.ts', 'const a = 1;', 'Write');
    const r2 = evaluator.onFileChange('/src/b.ts', 'const b = 2;', 'Write');
    const r3 = evaluator.onFileChange('/src/c.ts', 'const c = 3;', 'Write');

    expect(r1.snapshot.stepIndex).toBe(0);
    expect(r2.snapshot.stepIndex).toBe(1);
    expect(r3.snapshot.stepIndex).toBe(2);
  });

  it('content-hash cache prevents re-parse on unchanged content', () => {
    // First parse
    evaluator.onFileChange('/src/a.ts', SAMPLE_TS, 'Write');
    // Same content again — should use cache
    const r2 = evaluator.onFileChange('/src/a.ts', SAMPLE_TS, 'Edit');
    // Should still produce valid metrics from cache
    expect(r2.snapshot.metricsJson.function_count).toBe(3);
    // But should NOT trigger Tier 1 (no changes)
    expect(r2.tier1Trigger).toBe(false);
  });

  describe('v2.2 lifecycle: seenPaths + resolvedGraph', () => {
    it('first touch in session + not in graph → isNewFile=true, tier1Trigger=true', () => {
      // No graph set → hasNode returns false
      const result = evaluator.onFileChange('/src/new.ts', 'const x = 1;', 'Write');
      expect(result.tier1Trigger).toBe(true);
    });

    it('second touch same file → NOT a new file', () => {
      evaluator.onFileChange('/src/a.ts', 'const x = 1;', 'Write');
      // Second touch — different content but same file
      const r2 = evaluator.onFileChange('/src/a.ts', 'const x = 2;', 'Edit');
      // Not new file, no import changes → no trigger
      expect(r2.tier1Trigger).toBe(false);
    });

    it('file in resolved graph but first session touch → NOT new file', () => {
      // Set up graph that knows about the file
      const graph: ResolvedGraphRef = {
        hasNode: (p: string) => p === '/src/existing.ts',
        hasIncomingEdges: () => false,
      };
      evaluator.updateResolvedGraph(graph);

      const result = evaluator.onFileChange('/src/existing.ts', 'const x = 1;', 'Write');
      // File exists in graph → not "new", but first touch with no old imports
      // No import changes (no old specifiers to compare) → no trigger
      expect(result.tier1Trigger).toBe(false);
    });
  });

  it('tier 1 trigger fires when raw specifiers change', () => {
    // First touch
    evaluator.onFileChange('/src/a.ts', SAMPLE_TS, 'Write');
    // Second touch with different imports
    const r2 = evaluator.onFileChange('/src/a.ts', SAMPLE_TS_MODIFIED, 'Edit');
    // Import specifiers changed (added 'fs') → trigger
    expect(r2.tier1Trigger).toBe(true);
  });

  it('tier 1 trigger fires when exports change on file with dependents', () => {
    // Set up graph where the file has incoming edges (dependents)
    const graph: ResolvedGraphRef = {
      hasNode: (p: string) => p === '/src/lib.ts',
      hasIncomingEdges: (p: string) => p === '/src/lib.ts',
    };
    evaluator.updateResolvedGraph(graph);

    // First touch
    evaluator.onFileChange('/src/lib.ts', 'export const a = 1;', 'Write');
    // Second touch with more exports
    const r2 = evaluator.onFileChange(
      '/src/lib.ts',
      'export const a = 1;\nexport const b = 2;',
      'Edit',
    );
    expect(r2.tier1Trigger).toBe(true);
  });

  it('tier 1 trigger does NOT fire when exports change on file with NO dependents', () => {
    const graph: ResolvedGraphRef = {
      hasNode: (p: string) => p === '/src/leaf.ts',
      hasIncomingEdges: () => false, // no dependents
    };
    evaluator.updateResolvedGraph(graph);

    evaluator.onFileChange('/src/leaf.ts', 'export const a = 1;', 'Write');
    const r2 = evaluator.onFileChange(
      '/src/leaf.ts',
      'export const a = 1;\nexport const b = 2;',
      'Edit',
    );
    // Exports changed but no dependents → no trigger
    expect(r2.tier1Trigger).toBe(false);
  });

  it('empty file produces valid metrics', () => {
    const result = evaluator.onFileChange('/src/empty.ts', EMPTY_FILE, 'Write');
    const metrics = result.snapshot.metricsJson;
    expect(metrics.raw_imports).toEqual([]);
    expect(metrics.export_count).toBe(0);
    expect(metrics.function_count).toBe(0);
    expect(metrics.line_count).toBe(0);
    expect(metrics.cyclomatic_complexity).toBe(0);
  });

  it('non-TS file fallback produces valid metrics', () => {
    // .json file — parser won't understand it, should fallback gracefully
    const result = evaluator.onFileChange(
      '/src/data.json',
      '{"key": "value"}',
      'Write',
    );
    const metrics = result.snapshot.metricsJson;
    expect(metrics.line_count).toBeGreaterThan(0);
    expect(metrics.raw_imports).toEqual([]);
  });

  it('metric snapshot serialization roundtrip', () => {
    evaluator.onFileChange('/src/index.ts', SAMPLE_TS, 'Write');
    store.flush();
    const results = store.queryBySession('test-session');
    expect(results.length).toBe(1);
    const s = results[0];
    expect(s.sessionId).toBe('test-session');
    expect(s.filePath).toBe('/src/index.ts');
    expect(s.toolType).toBe('Write');
    expect(s.tier).toBe(0);
    expect(s.fileRole).toBe('source');
    expect(typeof s.metricsJson.function_count).toBe('number');
  });

  it('shutdown flushes store', () => {
    evaluator.onFileChange('/src/a.ts', 'const a = 1;', 'Write');
    // Not explicitly flushed
    evaluator.shutdown();
    // Should be in DB now
    const results = store.queryBySession('test-session');
    expect(results.length).toBe(1);
  });

  it('getSeenPaths tracks all touched files', () => {
    evaluator.onFileChange('/src/a.ts', 'const a = 1;', 'Write');
    evaluator.onFileChange('/src/b.ts', 'const b = 2;', 'Write');
    evaluator.onFileChange('/src/a.ts', 'const a = 3;', 'Edit');

    const seen = evaluator.getSeenPaths();
    expect(seen.size).toBe(2);
    expect(seen.has('/src/a.ts')).toBe(true);
    expect(seen.has('/src/b.ts')).toBe(true);
  });

  it('loc_delta tracks line count changes', () => {
    const r1 = evaluator.onFileChange('/src/a.ts', 'const a = 1;', 'Write');
    expect(r1.snapshot.metricsJson.loc_delta).toBe(1); // 0 → 1

    const r2 = evaluator.onFileChange(
      '/src/a.ts',
      'const a = 1;\nconst b = 2;\nconst c = 3;',
      'Edit',
    );
    expect(r2.snapshot.metricsJson.loc_delta).toBe(2); // 1 → 3
  });
});

describe('reconstructFromStore', () => {
  it('rebuilds seenPaths from existing snapshots', () => {
    const dbPath = makeTmpDbPath();
    const store = new TrajectoryStore({ dbPath });
    store.initialize();

    // Create evaluator, write some snapshots, then close
    const eval1 = new TrajectoryEvaluator({ cwd: '/project', sessionId: 'sess-1', store });
    eval1.initialize();
    eval1.onFileChange('/src/a.ts', 'const a = 1;', 'Write');
    eval1.onFileChange('/src/b.ts', 'const b = 2;', 'Write');
    eval1.shutdown();
    store.close();

    // Reconstruct from a fresh store (simulates new process)
    const store2 = new TrajectoryStore({ dbPath });
    store2.initialize();
    const eval2 = TrajectoryEvaluator.reconstructFromStore({
      cwd: '/project', sessionId: 'sess-1', store: store2,
    });

    expect(eval2.getSeenPaths().size).toBe(2);
    expect(eval2.getSeenPaths().has('/src/a.ts')).toBe(true);
    expect(eval2.getSeenPaths().has('/src/b.ts')).toBe(true);

    store2.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.rmdirSync(path.dirname(dbPath)); } catch { /* ignore */ }
  });

  it('rebuilds currentStep correctly', () => {
    const dbPath = makeTmpDbPath();
    const store = new TrajectoryStore({ dbPath });
    store.initialize();

    const eval1 = new TrajectoryEvaluator({ cwd: '/project', sessionId: 'sess-1', store });
    eval1.initialize();
    eval1.onFileChange('/src/a.ts', 'const a = 1;', 'Write'); // step 0
    eval1.onFileChange('/src/b.ts', 'const b = 2;', 'Write'); // step 1
    eval1.onFileChange('/src/c.ts', 'const c = 3;', 'Write'); // step 2
    eval1.shutdown();
    store.close();

    const store2 = new TrajectoryStore({ dbPath });
    store2.initialize();
    const eval2 = TrajectoryEvaluator.reconstructFromStore({
      cwd: '/project', sessionId: 'sess-1', store: store2,
    });

    // Next step should be 3
    expect(eval2.getCurrentStep()).toBe(3);

    // New file change should get step 3
    const r = eval2.onFileChange('/src/d.ts', 'const d = 4;', 'Write');
    expect(r.snapshot.stepIndex).toBe(3);

    store2.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.rmdirSync(path.dirname(dbPath)); } catch { /* ignore */ }
  });

  it('rebuilds rawImportCache for import delta detection', () => {
    const dbPath = makeTmpDbPath();
    const store = new TrajectoryStore({ dbPath });
    store.initialize();

    const content1 = `import { foo } from './utils';\nconst x = 1;`;
    const eval1 = new TrajectoryEvaluator({ cwd: '/project', sessionId: 'sess-1', store });
    eval1.initialize();
    eval1.onFileChange('/src/a.ts', content1, 'Write');
    eval1.shutdown();
    store.close();

    // Reconstruct
    const store2 = new TrajectoryStore({ dbPath });
    store2.initialize();
    const eval2 = TrajectoryEvaluator.reconstructFromStore({
      cwd: '/project', sessionId: 'sess-1', store: store2,
    });

    // Import cache should be populated
    const importCache = eval2.getRawImportCache();
    expect(importCache.get('/src/a.ts')).toEqual(new Set(['./utils']));

    // Modifying imports should trigger Tier 1
    const content2 = `import { foo } from './utils';\nimport { bar } from 'lodash';\nconst x = 1;`;
    const r = eval2.onFileChange('/src/a.ts', content2, 'Edit');
    expect(r.tier1Trigger).toBe(true);

    store2.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.rmdirSync(path.dirname(dbPath)); } catch { /* ignore */ }
  });

  it('rebuilds lineCountCache for loc_delta', () => {
    const dbPath = makeTmpDbPath();
    const store = new TrajectoryStore({ dbPath });
    store.initialize();

    const eval1 = new TrajectoryEvaluator({ cwd: '/project', sessionId: 'sess-1', store });
    eval1.initialize();
    eval1.onFileChange('/src/a.ts', 'const a = 1;', 'Write'); // 1 line
    eval1.shutdown();
    store.close();

    const store2 = new TrajectoryStore({ dbPath });
    store2.initialize();
    const eval2 = TrajectoryEvaluator.reconstructFromStore({
      cwd: '/project', sessionId: 'sess-1', store: store2,
    });

    // Add 2 more lines → delta should be +2
    const r = eval2.onFileChange('/src/a.ts', 'const a = 1;\nconst b = 2;\nconst c = 3;', 'Edit');
    expect(r.snapshot.metricsJson.loc_delta).toBe(2);

    store2.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.rmdirSync(path.dirname(dbPath)); } catch { /* ignore */ }
  });

  it('rebuilds exportCountCache for api surface tracking', () => {
    const dbPath = makeTmpDbPath();
    const store = new TrajectoryStore({ dbPath });
    store.initialize();

    const eval1 = new TrajectoryEvaluator({ cwd: '/project', sessionId: 'sess-1', store });
    eval1.initialize();
    eval1.onFileChange('/src/a.ts', 'export const a = 1;\nexport const b = 2;', 'Write');
    eval1.shutdown();
    store.close();

    const store2 = new TrajectoryStore({ dbPath });
    store2.initialize();
    const eval2 = TrajectoryEvaluator.reconstructFromStore({
      cwd: '/project', sessionId: 'sess-1', store: store2,
    });

    expect(eval2.getExportCountCache().get('/src/a.ts')).toBe(2);

    store2.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.rmdirSync(path.dirname(dbPath)); } catch { /* ignore */ }
  });

  it('handles empty session (no prior snapshots)', () => {
    const dbPath = makeTmpDbPath();
    const store = new TrajectoryStore({ dbPath });
    store.initialize();
    store.initSession();

    const eval2 = TrajectoryEvaluator.reconstructFromStore({
      cwd: '/project', sessionId: 'sess-1', store,
    });

    expect(eval2.getCurrentStep()).toBe(0);
    expect(eval2.getSeenPaths().size).toBe(0);
    expect(eval2.getRawImportCache().size).toBe(0);

    // Should work normally for new file changes
    const r = eval2.onFileChange('/src/a.ts', 'const x = 1;', 'Write');
    expect(r.snapshot.stepIndex).toBe(0);

    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.rmdirSync(path.dirname(dbPath)); } catch { /* ignore */ }
  });

  it('uses latest snapshot per file (multiple edits)', () => {
    const dbPath = makeTmpDbPath();
    const store = new TrajectoryStore({ dbPath });
    store.initialize();

    const eval1 = new TrajectoryEvaluator({ cwd: '/project', sessionId: 'sess-1', store });
    eval1.initialize();
    eval1.onFileChange('/src/a.ts', `import { x } from './x';\nconst a = 1;`, 'Write');
    eval1.onFileChange('/src/a.ts', `import { y } from './y';\nconst a = 2;\nconst b = 3;`, 'Edit');
    eval1.shutdown();
    store.close();

    const store2 = new TrajectoryStore({ dbPath });
    store2.initialize();
    const eval2 = TrajectoryEvaluator.reconstructFromStore({
      cwd: '/project', sessionId: 'sess-1', store: store2,
    });

    // Should have latest imports (./y, not ./x)
    expect(eval2.getRawImportCache().get('/src/a.ts')).toEqual(new Set(['./y']));
    // Line count should be from latest (2 non-empty lines)
    // const a = 2; and const b = 3; and import line = 3 lines
    expect(eval2.getCurrentStep()).toBe(2);

    store2.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.rmdirSync(path.dirname(dbPath)); } catch { /* ignore */ }
  });
});

describe('normalizePath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('C:\\Users\\test\\file.ts')).toBe('C:/Users/test/file.ts');
  });

  it('leaves forward slashes unchanged', () => {
    expect(normalizePath('/src/index.ts')).toBe('/src/index.ts');
  });
});
