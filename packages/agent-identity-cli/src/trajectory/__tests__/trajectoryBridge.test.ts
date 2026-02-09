import { trajectoryFeaturesToSignals } from '../trajectoryBridge';
import { TRAJECTORY_BASE_WEIGHT } from '../types';
import type { TrajectoryFeatures } from '../types';

const ALL_ZERO_FEATURES: TrajectoryFeatures = {
  complexity_shape: 0,
  coupling_direction: 0,
  edit_dep_alignment: 0,
  edit_locality: 0,
  complexity_coupling_corr: 0,
  structural_churn: 0,
  api_surface_delta: 0,
  refactor_detected: 0,
};

describe('trajectoryFeaturesToSignals', () => {
  it('produces OutcomeSignal with source="trajectory"', () => {
    const signals = trajectoryFeaturesToSignals(
      { ...ALL_ZERO_FEATURES, complexity_shape: -0.5 },
      { complexity_shape: 0.8 },
    );
    const sig = signals.find(s => s.weight > 0);
    expect(sig).toBeDefined();
    expect(sig!.source).toBe('trajectory');
  });

  it('weight = BASE_WEIGHT × confidence', () => {
    const signals = trajectoryFeaturesToSignals(
      { ...ALL_ZERO_FEATURES, edit_locality: 0.5 },
      { edit_locality: 0.6 },
    );
    const sig = signals.find(s => s.weight > 0);
    expect(sig).toBeDefined();
    expect(sig!.weight).toBeCloseTo(TRAJECTORY_BASE_WEIGHT * 0.6);
  });

  it('zero-confidence features filtered out', () => {
    const confidences: Record<string, number> = {
      complexity_shape: 0,
      coupling_direction: 0,
      edit_dep_alignment: 0,
      edit_locality: 0,
      complexity_coupling_corr: 0,
      structural_churn: 0,
      api_surface_delta: 0,
      refactor_detected: 0,
    };

    const signals = trajectoryFeaturesToSignals(ALL_ZERO_FEATURES, confidences);
    expect(signals.length).toBe(0);
  });

  it('values are normalized to [-1, 1]', () => {
    const signals = trajectoryFeaturesToSignals(
      {
        ...ALL_ZERO_FEATURES,
        complexity_shape: 100,  // extreme value
        edit_dep_alignment: -0.5,  // already in range
      },
      {
        complexity_shape: 1.0,
        edit_dep_alignment: 1.0,
      },
    );

    for (const sig of signals) {
      expect(sig.value).toBeGreaterThanOrEqual(-1);
      expect(sig.value).toBeLessThanOrEqual(1);
    }
  });

  it('no confidence field on OutcomeSignal', () => {
    const signals = trajectoryFeaturesToSignals(
      { ...ALL_ZERO_FEATURES, complexity_shape: 0.5 },
      { complexity_shape: 0.8 },
    );
    for (const sig of signals) {
      expect((sig as any).confidence).toBeUndefined();
    }
  });

  it('multiple features with confidence produce multiple signals', () => {
    const signals = trajectoryFeaturesToSignals(
      {
        ...ALL_ZERO_FEATURES,
        complexity_shape: -0.3,
        edit_locality: 0.5,
        refactor_detected: 1,
      },
      {
        complexity_shape: 0.8,
        edit_locality: 0.5,
        refactor_detected: 0.8,
      },
    );
    expect(signals.length).toBe(3);
  });
});
