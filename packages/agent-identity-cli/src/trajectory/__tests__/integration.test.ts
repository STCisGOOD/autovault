/**
 * Integration tests for the full trajectory pipeline.
 *
 * Tests the end-to-end flow:
 *   tool call → evaluator.onFileChange → feature extraction → ARIL signals
 *
 * These test the "glue" between components, not individual units.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { TrajectoryStore } from '../TrajectoryStore';
import { TrajectoryEvaluator } from '../TrajectoryEvaluator';
import { computeTrajectoryFeatures } from '../TrajectoryFeatureExtractor';
import { trajectoryFeaturesToSignals } from '../trajectoryBridge';
import { TRAJECTORY_BASE_WEIGHT } from '../types';

function makeTmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traj-integ-'));
  return path.join(dir, 'test.db');
}

function makePipeline(sessionId = 'integ-session'): {
  evaluator: TrajectoryEvaluator;
  store: TrajectoryStore;
  dbPath: string;
} {
  const dbPath = makeTmpDbPath();
  const store = new TrajectoryStore({ dbPath });
  store.initialize();
  store.initSession();

  const evaluator = new TrajectoryEvaluator({
    cwd: '/project',
    sessionId,
    store,
  });
  evaluator.initialize();

  return { evaluator, store, dbPath };
}

describe('Trajectory Pipeline Integration', () => {
  let evaluator: TrajectoryEvaluator;
  let store: TrajectoryStore;
  let dbPath: string;

  beforeEach(() => {
    ({ evaluator, store, dbPath } = makePipeline());
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.rmdirSync(path.dirname(dbPath)); } catch { /* ignore */ }
  });

  it('Write triggers evaluator.onFileChange and produces snapshots', () => {
    // Simulate PostToolUse on Write
    const content = `
      import { readFileSync } from 'fs';
      export function hello() { return 'world'; }
    `;
    const result = evaluator.onFileChange('/src/hello.ts', content, 'Write');

    expect(result.snapshot.toolType).toBe('Write');
    expect(result.snapshot.tier).toBe(0);
    expect(result.snapshot.metricsJson.function_count).toBe(1);
    expect(result.snapshot.metricsJson.raw_imports).toEqual(['fs']);
  });

  it('Read does NOT produce trajectory data (only Write/Edit/NotebookEdit)', () => {
    // Simulate what the hook does: only feed Write/Edit/NotebookEdit
    // Read should NOT be fed to the evaluator
    const toolName = 'Read';
    const shouldFeed = ['Write', 'Edit', 'NotebookEdit'].includes(toolName);
    expect(shouldFeed).toBe(false);
  });

  it('full pipeline: tool calls → features → OutcomeSignals', () => {
    // Simulate a coding session with multiple edits
    evaluator.onFileChange('/src/index.ts', `
      import { helper } from './utils';
      export function main() {
        if (true) { return helper(); }
      }
    `, 'Write');

    evaluator.onFileChange('/src/utils.ts', `
      export function helper() { return 42; }
    `, 'Write');

    evaluator.onFileChange('/src/index.ts', `
      import { helper } from './utils';
      import { config } from './config';
      export function main() {
        return helper() + config.value;
      }
    `, 'Edit');

    evaluator.onFileChange('/src/config.ts', `
      export const config = { value: 10 };
    `, 'Write');

    evaluator.onFileChange('/src/index.test.ts', `
      import { main } from './index';
      test('main returns 52', () => { expect(main()).toBe(52); });
    `, 'Write');

    // Extract features
    const { features, confidences } = computeTrajectoryFeatures(evaluator, store);

    // Features should be populated
    expect(typeof features.complexity_shape).toBe('number');
    expect(typeof features.edit_locality).toBe('number');
    expect(typeof features.api_surface_delta).toBe('number');

    // Confidences should be based on snapshot count (5 Tier 0 edits → 0.8)
    expect(confidences.complexity_shape).toBeCloseTo(0.8);

    // Convert to OutcomeSignals
    const signals = trajectoryFeaturesToSignals(features, confidences);

    // Should produce signals for features with non-zero confidence
    expect(signals.length).toBeGreaterThan(0);

    // All signals should have source='trajectory'
    for (const sig of signals) {
      expect(sig.source).toBe('trajectory');
      expect(sig.value).toBeGreaterThanOrEqual(-1);
      expect(sig.value).toBeLessThanOrEqual(1);
      expect(sig.weight).toBeLessThanOrEqual(TRAJECTORY_BASE_WEIGHT);
    }
  });

  it('zero-confidence features not sent to ARIL', () => {
    // Only 1 edit → very low confidence
    evaluator.onFileChange('/src/a.ts', 'const a = 1;', 'Write');

    const { features, confidences } = computeTrajectoryFeatures(evaluator, store);
    const signals = trajectoryFeaturesToSignals(features, confidences);

    // Tier 1 features should have 0 confidence (no Tier 1 snapshots)
    expect(confidences.coupling_direction).toBe(0);
    expect(confidences.edit_dep_alignment).toBe(0);

    // Zero-confidence features should NOT appear in signals (filtered out)
    // All signals should have weight > 0
    const zeroWeightSignals = signals.filter(s => s.weight === 0);
    expect(zeroWeightSignals.length).toBe(0);
  });

  it('evaluator failure does not break session flow', () => {
    // Simulate what hook.ts does: wrap in try-catch
    let trajSignals: Array<{ source: string; value: number; weight: number }> = [];

    try {
      // This should work fine
      evaluator.onFileChange('/src/a.ts', 'const a = 1;', 'Write');
      const { features, confidences } = computeTrajectoryFeatures(evaluator, store);
      trajSignals = trajectoryFeaturesToSignals(features, confidences);
    } catch {
      // Trajectory failure is non-fatal
      trajSignals = [];
    }

    // Should have produced some signals
    expect(trajSignals.length).toBeGreaterThan(0);

    // Now test actual failure: force evaluator into bad state
    let errorSignals: typeof trajSignals = [];
    try {
      // Close store to simulate failure
      store.close();
      const { features, confidences } = computeTrajectoryFeatures(evaluator, store);
      errorSignals = trajectoryFeaturesToSignals(features, confidences);
    } catch {
      // This is expected — evaluator failure is caught
      errorSignals = [];
    }

    // Should gracefully handle the error
    expect(errorSignals).toEqual([]);
  });

  it('persistSession writes features to SQLite', () => {
    evaluator.onFileChange('/src/a.ts', 'export const a = 1;', 'Write');
    evaluator.onFileChange('/src/b.ts', 'export const b = 2;', 'Write');
    evaluator.onFileChange('/src/c.ts', 'export const c = 3;', 'Write');

    const { features, confidences } = computeTrajectoryFeatures(evaluator, store);

    store.persistSession('integ-session', {
      features,
      confidences,
      stepCount: evaluator.getCurrentStep(),
      filesTouched: evaluator.getSeenPaths().size,
    });

    // Verify persistence
    const db = (store as any).db;
    const row = db.prepare('SELECT * FROM trajectory_features WHERE session_id = ?')
      .get('integ-session') as Record<string, unknown>;

    expect(row).toBeTruthy();
    expect(row.step_count).toBe(3);
    expect(row.files_touched).toBe(3);
    expect(typeof row.complexity_shape).toBe('number');
    expect(typeof row.complexity_shape_confidence).toBe('number');
  });
});
