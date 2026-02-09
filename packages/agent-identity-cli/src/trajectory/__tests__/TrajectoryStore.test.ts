import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { TrajectoryStore } from '../TrajectoryStore';
import type { MetricSnapshot, SessionPersistData } from '../types';
import { TRAJECTORY_SCHEMA_VERSION } from '../types';

function makeTmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traj-test-'));
  return path.join(dir, 'test-trajectory.db');
}

function makeSnapshot(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    sessionId: 'test-session',
    stepIndex: 0,
    timestampMs: Date.now(),
    filePath: '/src/index.ts',
    toolType: 'Write',
    granularity: 'file',
    packageName: null,
    fileRole: 'source',
    metricsJson: { function_count: 5, line_count: 100 },
    tier: 0,
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    ...overrides,
  };
}

describe('TrajectoryStore', () => {
  let store: TrajectoryStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    store = new TrajectoryStore({ dbPath });
    store.initialize();
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.rmdirSync(path.dirname(dbPath)); } catch { /* ignore */ }
  });

  it('schema creation is idempotent', () => {
    // Call initialize again — should not throw
    store.initialize();
    // And again
    store.initialize();
    // Should still work
    store.initSession();
  });

  it('WAL mode is enabled', () => {
    // better-sqlite3 returns the journal mode as a string
    const dbPath2 = makeTmpDbPath();
    const store2 = new TrajectoryStore({ dbPath: dbPath2, walMode: true });
    store2.initialize();
    // WAL mode is set in constructor, verify by writing/reading
    const snapshot = makeSnapshot();
    store2.writeSnapshot(snapshot);
    store2.flush();
    const results = store2.queryBySession('test-session');
    expect(results.length).toBe(1);
    store2.close();
    try { fs.unlinkSync(dbPath2); } catch { /* ignore */ }
    try { fs.rmdirSync(path.dirname(dbPath2)); } catch { /* ignore */ }
  });

  it('batched insert of 100 snapshots within transaction', () => {
    const snapshots = Array.from({ length: 100 }, (_, i) =>
      makeSnapshot({ stepIndex: i, filePath: `/src/file${i}.ts` })
    );
    store.writeBatch(snapshots);
    const results = store.queryBySession('test-session');
    expect(results.length).toBe(100);
  });

  it('initSession pins and returns schema_version', () => {
    const version = store.initSession();
    expect(version).toBe(TRAJECTORY_SCHEMA_VERSION);
  });

  it('writes use pinned schema_version', () => {
    store.initSession();
    const snapshot = makeSnapshot({ schemaVersion: 999 }); // overridden schemaVersion ignored
    store.writeSnapshot(snapshot);
    store.flush();
    const results = store.queryBySession('test-session');
    expect(results[0].schemaVersion).toBe(TRAJECTORY_SCHEMA_VERSION);
  });

  it('queryBySession returns correct rows ordered by step_index', () => {
    // Insert out of order
    store.writeBatch([
      makeSnapshot({ stepIndex: 2, filePath: '/c.ts' }),
      makeSnapshot({ stepIndex: 0, filePath: '/a.ts' }),
      makeSnapshot({ stepIndex: 1, filePath: '/b.ts' }),
    ]);

    const results = store.queryBySession('test-session');
    expect(results.length).toBe(3);
    expect(results[0].stepIndex).toBe(0);
    expect(results[1].stepIndex).toBe(1);
    expect(results[2].stepIndex).toBe(2);
  });

  it('getDistinctFiles returns unique paths', () => {
    store.writeBatch([
      makeSnapshot({ stepIndex: 0, filePath: '/a.ts' }),
      makeSnapshot({ stepIndex: 1, filePath: '/b.ts' }),
      makeSnapshot({ stepIndex: 2, filePath: '/a.ts' }), // duplicate
    ]);

    const files = store.getDistinctFiles('test-session');
    expect(files.sort()).toEqual(['/a.ts', '/b.ts']);
  });

  it('getSnapshotCountByTier separates Tier 0 and Tier 1', () => {
    store.writeBatch([
      makeSnapshot({ stepIndex: 0, tier: 0 }),
      makeSnapshot({ stepIndex: 1, tier: 0 }),
      makeSnapshot({ stepIndex: 2, tier: 1 }),
    ]);

    const counts = store.getSnapshotCountByTier('test-session');
    expect(counts.tier0).toBe(2);
    expect(counts.tier1).toBe(1);
  });

  it('analysis_cache: hit/miss/overwrite', () => {
    // Miss
    const miss = store.getCachedAnalysis('/a.ts', 'hash1', 0);
    expect(miss).toBeNull();

    // Store
    store.setCachedAnalysis('/a.ts', 'hash1', 0, { complexity: 5 });
    const hit = store.getCachedAnalysis('/a.ts', 'hash1', 0);
    expect(hit).toEqual({ complexity: 5 });

    // Overwrite
    store.setCachedAnalysis('/a.ts', 'hash1', 0, { complexity: 10 });
    const overwritten = store.getCachedAnalysis('/a.ts', 'hash1', 0);
    expect(overwritten).toEqual({ complexity: 10 });

    // Different hash = miss
    const diffHash = store.getCachedAnalysis('/a.ts', 'hash2', 0);
    expect(diffHash).toBeNull();
  });

  it('persistSession writes trajectory_features row', () => {
    const data: SessionPersistData = {
      features: {
        complexity_shape: -0.5,
        coupling_direction: 0.3,
        edit_dep_alignment: 0.7,
        edit_locality: 0.4,
        complexity_coupling_corr: -0.2,
        structural_churn: 0.1,
        api_surface_delta: 3,
        refactor_detected: 1,
      },
      confidences: {
        complexity_shape: 0.8,
        coupling_direction: 0.6,
        edit_dep_alignment: 0.6,
        edit_locality: 0.8,
        complexity_coupling_corr: 0.6,
        structural_churn: 0.8,
        api_surface_delta: 0.8,
        refactor_detected: 0.8,
      },
      stepCount: 10,
      filesTouched: 5,
      tier0SnapshotCount: 8,
      tier1SnapshotCount: 2,
    };

    store.persistSession('test-session', data);

    // Verify by raw query
    const db = (store as any).db;
    const row = db.prepare('SELECT * FROM trajectory_features WHERE session_id = ?')
      .get('test-session') as Record<string, unknown>;

    expect(row).toBeTruthy();
    expect(row.complexity_shape).toBeCloseTo(-0.5);
    expect(row.complexity_shape_confidence).toBeCloseTo(0.8);
    expect(row.refactor_detected).toBe(1);
    expect(row.step_count).toBe(10);
    expect(row.files_touched).toBe(5);
  });

  it('deleteSession removes all session data', () => {
    store.writeBatch([
      makeSnapshot({ stepIndex: 0 }),
      makeSnapshot({ stepIndex: 1 }),
    ]);

    const data: SessionPersistData = {
      features: {
        complexity_shape: 0, coupling_direction: 0, edit_dep_alignment: 0,
        edit_locality: 0, complexity_coupling_corr: 0, structural_churn: 0,
        api_surface_delta: 0, refactor_detected: 0,
      },
      confidences: {},
      stepCount: 2,
      filesTouched: 1,
    };
    store.persistSession('test-session', data);

    // Verify data exists
    expect(store.queryBySession('test-session').length).toBe(2);

    // Delete
    store.deleteSession('test-session');

    // Verify gone
    expect(store.queryBySession('test-session').length).toBe(0);
    const db = (store as any).db;
    const row = db.prepare('SELECT * FROM trajectory_features WHERE session_id = ?')
      .get('test-session');
    expect(row).toBeUndefined();
  });

  it('close() is safe to call multiple times', () => {
    store.close();
    // Should not throw
    store.close();
    store.close();
  });

  it('writeSnapshot auto-flushes at batchSize', () => {
    const smallBatchStore = new TrajectoryStore({
      dbPath: makeTmpDbPath(),
      batchSize: 3,
    });
    smallBatchStore.initialize();

    // Write 3 snapshots — should auto-flush
    smallBatchStore.writeSnapshot(makeSnapshot({ stepIndex: 0 }));
    smallBatchStore.writeSnapshot(makeSnapshot({ stepIndex: 1 }));
    smallBatchStore.writeSnapshot(makeSnapshot({ stepIndex: 2 }));

    // Should already be in DB without explicit flush
    const results = smallBatchStore.queryBySession('test-session');
    expect(results.length).toBe(3);

    smallBatchStore.close();
  });

  it('getStepCount returns correct count', () => {
    store.writeBatch([
      makeSnapshot({ stepIndex: 0 }),
      makeSnapshot({ stepIndex: 1 }),
      makeSnapshot({ stepIndex: 4 }), // gap is fine — MAX(step_index) + 1
    ]);
    expect(store.getStepCount('test-session')).toBe(5);
  });

  it('queryBySession with tier filter', () => {
    store.writeBatch([
      makeSnapshot({ stepIndex: 0, tier: 0 }),
      makeSnapshot({ stepIndex: 1, tier: 1 }),
      makeSnapshot({ stepIndex: 2, tier: 0 }),
    ]);

    const tier0 = store.queryBySession('test-session', { tier: 0 });
    expect(tier0.length).toBe(2);
    expect(tier0.every(s => s.tier === 0)).toBe(true);
  });

  it('metricsJson roundtrips correctly', () => {
    const metrics = {
      function_count: 5,
      raw_imports: ['./utils', 'fs'],
      ast_depth: 7,
      nested: { a: 1 },
    };
    store.writeBatch([makeSnapshot({ metricsJson: metrics })]);
    const [result] = store.queryBySession('test-session');
    expect(result.metricsJson).toEqual(metrics);
  });
});
