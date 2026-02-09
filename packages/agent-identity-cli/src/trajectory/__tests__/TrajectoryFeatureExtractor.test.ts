import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { TrajectoryStore } from '../TrajectoryStore';
import { TrajectoryEvaluator } from '../TrajectoryEvaluator';
import { computeTrajectoryFeatures } from '../TrajectoryFeatureExtractor';
// tier0Confidence/tier1Confidence tested in types.test.ts

function makeTmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traj-feat-'));
  return path.join(dir, 'test.db');
}

function makeEvaluatorAndStore(): {
  evaluator: TrajectoryEvaluator;
  store: TrajectoryStore;
  dbPath: string;
} {
  const dbPath = makeTmpDbPath();
  const store = new TrajectoryStore({ dbPath });
  store.initialize();

  const evaluator = new TrajectoryEvaluator({
    cwd: '/project',
    sessionId: 'feat-test',
    store,
  });
  evaluator.initialize();

  return { evaluator, store, dbPath };
}

// Helpers to generate TS content with varying complexity
function makeCode(opts: {
  imports?: string[];
  exports?: number;
  functions?: number;
  ifs?: number;
}): string {
  const lines: string[] = [];
  for (const imp of opts.imports ?? []) {
    lines.push(`import { x } from '${imp}';`);
  }
  for (let i = 0; i < (opts.exports ?? 0); i++) {
    lines.push(`export const val${i} = ${i};`);
  }
  for (let i = 0; i < (opts.functions ?? 0); i++) {
    let body = 'return 0;';
    for (let j = 0; j < (opts.ifs ?? 0); j++) {
      body = `if (x > ${j}) { ${body} }`;
    }
    lines.push(`function fn${i}(x: number) { ${body} }`);
  }
  return lines.join('\n');
}

describe('TrajectoryFeatureExtractor', () => {
  let evaluator: TrajectoryEvaluator;
  let store: TrajectoryStore;
  let dbPath: string;

  beforeEach(() => {
    ({ evaluator, store, dbPath } = makeEvaluatorAndStore());
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.rmdirSync(path.dirname(dbPath)); } catch { /* ignore */ }
  });

  it('monotonic decrease → negative complexity_shape', () => {
    // Start with high complexity, end with low
    evaluator.onFileChange('/a.ts', makeCode({ functions: 3, ifs: 5 }), 'Write');
    evaluator.onFileChange('/a.ts', makeCode({ functions: 3, ifs: 3 }), 'Edit');
    evaluator.onFileChange('/a.ts', makeCode({ functions: 3, ifs: 1 }), 'Edit');

    const { features } = computeTrajectoryFeatures(evaluator, store);
    expect(features.complexity_shape).toBeLessThan(0);
  });

  it('spike then recover → refactor_detected = 1', () => {
    // Baseline
    evaluator.onFileChange('/a.ts', makeCode({ functions: 2, ifs: 1 }), 'Write');
    evaluator.onFileChange('/b.ts', makeCode({ functions: 2, ifs: 1 }), 'Write');
    // Spike: complexity > 1.5× baseline
    evaluator.onFileChange('/a.ts', makeCode({ functions: 5, ifs: 4 }), 'Edit');
    // Return to baseline
    evaluator.onFileChange('/a.ts', makeCode({ functions: 2, ifs: 1 }), 'Edit');

    const { features } = computeTrajectoryFeatures(evaluator, store);
    expect(features.refactor_detected).toBe(1);
  });

  it('scattered edits → high edit_locality entropy', () => {
    // Edit many different files
    for (let i = 0; i < 10; i++) {
      evaluator.onFileChange(`/src/file${i}.ts`, `const x = ${i};`, 'Write');
    }

    const { features } = computeTrajectoryFeatures(evaluator, store);
    // High entropy = close to 1.0 (scattered)
    expect(features.edit_locality).toBeGreaterThan(0.8);
  });

  it('focused edits → low edit_locality entropy', () => {
    // Edit same file many times
    for (let i = 0; i < 10; i++) {
      evaluator.onFileChange('/src/main.ts', `const x = ${i};`, 'Edit');
    }

    const { features } = computeTrajectoryFeatures(evaluator, store);
    // Single file = 0 (perfectly focused)
    expect(features.edit_locality).toBe(0);
  });

  it('v2.2 piecewise: 3 Tier 0 snapshots → confidence 0.5', () => {
    evaluator.onFileChange('/a.ts', 'const a = 1;', 'Write');
    evaluator.onFileChange('/b.ts', 'const b = 2;', 'Write');
    evaluator.onFileChange('/c.ts', 'const c = 3;', 'Write');

    const { confidences } = computeTrajectoryFeatures(evaluator, store);
    expect(confidences.complexity_shape).toBeCloseTo(0.5);
    expect(confidences.edit_locality).toBeCloseTo(0.5);
  });

  it('v2.2 piecewise: 5 Tier 0 snapshots → confidence 0.8', () => {
    for (let i = 0; i < 5; i++) {
      evaluator.onFileChange(`/f${i}.ts`, `const x = ${i};`, 'Write');
    }

    const { confidences } = computeTrajectoryFeatures(evaluator, store);
    expect(confidences.complexity_shape).toBeCloseTo(0.8);
  });

  it('0 Tier 1 snapshots → coupling features confidence 0.0', () => {
    evaluator.onFileChange('/a.ts', 'const a = 1;', 'Write');

    const { confidences } = computeTrajectoryFeatures(evaluator, store);
    expect(confidences.coupling_direction).toBe(0);
    expect(confidences.edit_dep_alignment).toBe(0);
    expect(confidences.complexity_coupling_corr).toBe(0);
  });

  it('api_surface_delta tracks exports', () => {
    evaluator.onFileChange('/a.ts', 'export const a = 1;', 'Write');
    evaluator.onFileChange('/b.ts', 'export const b = 1;\nexport const c = 2;', 'Write');

    const { features } = computeTrajectoryFeatures(evaluator, store);
    // Total exports: 1 + 2 = 3
    expect(features.api_surface_delta).toBe(3);
  });

  it('structural_churn = variance for multi-edit files', () => {
    // Edit same file with varying complexity
    evaluator.onFileChange('/a.ts', makeCode({ functions: 2, ifs: 1 }), 'Write');
    evaluator.onFileChange('/a.ts', makeCode({ functions: 5, ifs: 4 }), 'Edit');
    evaluator.onFileChange('/a.ts', makeCode({ functions: 1, ifs: 0 }), 'Edit');

    const { features } = computeTrajectoryFeatures(evaluator, store);
    // Should have non-zero churn (variance of complexity across edits)
    expect(features.structural_churn).toBeGreaterThan(0);
  });

  it('single-edit files → structural_churn = 0', () => {
    evaluator.onFileChange('/a.ts', 'const a = 1;', 'Write');
    evaluator.onFileChange('/b.ts', 'const b = 2;', 'Write');

    const { features } = computeTrajectoryFeatures(evaluator, store);
    expect(features.structural_churn).toBe(0);
  });

  it('first-touch order for multi-edit files uses first touch', () => {
    // File /a.ts first touched at step 0
    evaluator.onFileChange('/a.ts', 'const a = 1;', 'Write');
    evaluator.onFileChange('/b.ts', 'const b = 2;', 'Write');
    evaluator.onFileChange('/c.ts', 'const c = 3;', 'Write');
    // Re-edit /a.ts at step 3 — should still have firstTouch = 0
    evaluator.onFileChange('/a.ts', 'const a = 4;', 'Edit');

    const { features } = computeTrajectoryFeatures(evaluator, store);
    // Should work without error (first touch properly tracked)
    expect(typeof features.edit_dep_alignment).toBe('number');
  });

  it('empty session returns all-zero features', () => {
    const { features, confidences } = computeTrajectoryFeatures(evaluator, store);
    expect(features.complexity_shape).toBe(0);
    expect(features.edit_locality).toBe(0);
    expect(features.refactor_detected).toBe(0);
    expect(confidences.complexity_shape).toBe(0);
  });
});
