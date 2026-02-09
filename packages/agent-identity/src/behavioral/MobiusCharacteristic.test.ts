/**
 * MobiusCharacteristic.test.ts
 *
 * Tests for the learned characteristic function using Möbius decomposition.
 *
 * Test categories from the Phase 3 spec:
 *   3.6.1  Möbius identity verification
 *   3.6.2  LASSO recovery on synthetic data
 *   3.6.3  Shapley from Möbius equals exact enumeration
 *   3.6.4  Additive game gives proportional attribution
 *   3.6.5  Blend transition
 *   3.6.6  Active set detection
 *   3.6.8  Adaptive barrier changes energy gradient (deferred to Step 3)
 *   3.6.9  Order adaptation triggers correctly
 *   3.6.11 Shapley efficiency holds for learned game
 *   3.6.12 Temporal decay reduces old observation influence
 */

import {
  popcount,
  isSubset,
  enumerateCoalitions,
  parameterCount,
  getActiveSet,
  buildDesignMatrix,
  solveLASSO,
  precomputeGram,
  computeTemporalWeights,
  learnCoefficients,
  evaluateCharacteristic,
  evaluateAllCoalitions,
  shapleyFromMobius,
  exactMobiusTransform,
  exactShapleyFromValues,
  computeFitResidual,
  checkOrderAdaptation,
  computeBlend,
  blendShapley,
  createMobiusState,
  serializeMobiusState,
  deserializeMobiusState,
  pruneObservations,
  MobiusCharacteristic,
  DEFAULT_MOBIUS_CONFIG,
  type CoalitionObservation,
  type MobiusConfig,
} from './MobiusCharacteristic';

// =============================================================================
// HELPERS
// =============================================================================

/** Create a synthetic observation. */
function makeObs(
  activeMask: number,
  outcome: number,
  weights: number[] = [0.5, 0.5, 0.5, 0.5],
  baselineWeights: number[] = [0.5, 0.5, 0.5, 0.5],
  sessionId: number = 0,
  timestamp: number = Date.now()
): CoalitionObservation {
  return { sessionId, activeMask, weights, baselineWeights, outcome, timestamp };
}

/**
 * Build a known non-additive game for N=4.
 *
 * v({1}) = 2, v({2}) = 3, v({1,2}) = 10 (synergy: 10 > 2+3)
 * v({3}) = 1, v({4}) = 1
 * All other coalitions: sum of individual values + pairwise synergy for {1,2}
 *
 * Möbius coefficients:
 *   m({1}) = 2, m({2}) = 3, m({3}) = 1, m({4}) = 1
 *   m({1,2}) = 5  (the synergy: 10 - 2 - 3 = 5)
 *   All other m(T) = 0
 */
function buildSynergisticGame(): number[] {
  const N = 4;
  const total = 1 << N;
  const values = new Array(total).fill(0);

  // Individual values
  const individual = [2, 3, 1, 1]; // dims 0,1,2,3

  // Pairwise synergy between dim 0 and dim 1
  const synergy01 = 5; // m({0,1}) = 5

  for (let mask = 0; mask < total; mask++) {
    let v = 0;
    // Sum individual contributions
    for (let i = 0; i < N; i++) {
      if (mask & (1 << i)) v += individual[i];
    }
    // Add synergy if both dim 0 and dim 1 are present
    if ((mask & 0b0011) === 0b0011) {
      v += synergy01;
    }
    values[mask] = v;
  }

  return values;
}

/**
 * Build a purely additive game: v(S) = Σ_{i∈S} c[i].
 */
function buildAdditiveGame(contributions: number[]): number[] {
  const N = contributions.length;
  const total = 1 << N;
  const values = new Array(total).fill(0);

  for (let mask = 0; mask < total; mask++) {
    for (let i = 0; i < N; i++) {
      if (mask & (1 << i)) values[mask] += contributions[i];
    }
  }

  return values;
}

// =============================================================================
// BIT UTILITIES
// =============================================================================

describe('MobiusCharacteristic', () => {
  describe('bit utilities', () => {
    test('popcount counts set bits', () => {
      expect(popcount(0b0000)).toBe(0);
      expect(popcount(0b0001)).toBe(1);
      expect(popcount(0b0101)).toBe(2);
      expect(popcount(0b1111)).toBe(4);
      expect(popcount(0b11111111)).toBe(8);
      expect(popcount(0xFFFF)).toBe(16);
    });

    test('isSubset checks bitmask containment', () => {
      expect(isSubset(0b0001, 0b0011)).toBe(true);  // {0} ⊆ {0,1}
      expect(isSubset(0b0011, 0b0011)).toBe(true);  // {0,1} ⊆ {0,1}
      expect(isSubset(0b0000, 0b1111)).toBe(true);  // ∅ ⊆ N
      expect(isSubset(0b0100, 0b0011)).toBe(false);  // {2} ⊄ {0,1}
      expect(isSubset(0b0011, 0b0001)).toBe(false);  // {0,1} ⊄ {0}
    });
  });

  // ===========================================================================
  // COALITION ENUMERATION
  // ===========================================================================

  describe('coalition enumeration', () => {
    test('enumerateCoalitions for N=4, k=2 gives 11 entries', () => {
      const coalitions = enumerateCoalitions(4, 2);
      // C(4,0) + C(4,1) + C(4,2) = 1 + 4 + 6 = 11
      expect(coalitions.length).toBe(11);

      // Verify all have popcount ≤ 2
      for (const mask of coalitions) {
        expect(popcount(mask)).toBeLessThanOrEqual(2);
      }

      // Verify includes empty set, all singletons, all pairs
      expect(coalitions).toContain(0b0000); // ∅
      expect(coalitions).toContain(0b0001); // {0}
      expect(coalitions).toContain(0b0010); // {1}
      expect(coalitions).toContain(0b0100); // {2}
      expect(coalitions).toContain(0b1000); // {3}
      expect(coalitions).toContain(0b0011); // {0,1}
      expect(coalitions).toContain(0b0101); // {0,2}
      expect(coalitions).toContain(0b1010); // {1,3}
    });

    test('enumerateCoalitions for N=4, k=4 gives 16 entries (full)', () => {
      const coalitions = enumerateCoalitions(4, 4);
      expect(coalitions.length).toBe(16); // 2^4
    });

    test('parameterCount matches expected values', () => {
      expect(parameterCount(4, 2)).toBe(11);
      expect(parameterCount(4, 3)).toBe(15);
      expect(parameterCount(4, 4)).toBe(16);
      expect(parameterCount(5, 2)).toBe(16);   // 1 + 5 + 10 = 16 (v2 starter features)
      expect(parameterCount(8, 2)).toBe(37);
      expect(parameterCount(10, 2)).toBe(56);  // 1 + 10 + 45 = 56 (v2 expanded)
      expect(parameterCount(12, 2)).toBe(79);  // 1 + 12 + 66 = 79
      expect(parameterCount(16, 2)).toBe(137);
    });

    test('enumerateCoalitions for N=5, k=2 gives 16 entries', () => {
      const coalitions = enumerateCoalitions(5, 2);
      expect(coalitions.length).toBe(16); // C(5,0)+C(5,1)+C(5,2) = 1+5+10
      for (const mask of coalitions) {
        expect(popcount(mask)).toBeLessThanOrEqual(2);
      }
    });

    test('enumerateCoalitions for N=10, k=2 gives 56 entries', () => {
      const coalitions = enumerateCoalitions(10, 2);
      expect(coalitions.length).toBe(56); // C(10,0)+C(10,1)+C(10,2) = 1+10+45
      for (const mask of coalitions) {
        expect(popcount(mask)).toBeLessThanOrEqual(2);
      }
    });
  });

  // ===========================================================================
  // 3.6.1: MÖBIUS IDENTITY VERIFICATION
  // ===========================================================================

  describe('Möbius identity (3.6.1)', () => {
    test('exact Möbius transform recovers known coefficients from synergistic game', () => {
      const values = buildSynergisticGame();
      const coefficients = exactMobiusTransform(values, 4);

      // Individual contributions
      expect(coefficients.get(0b0001)).toBeCloseTo(2, 10);   // m({0}) = 2
      expect(coefficients.get(0b0010)).toBeCloseTo(3, 10);   // m({1}) = 3
      expect(coefficients.get(0b0100)).toBeCloseTo(1, 10);   // m({2}) = 1
      expect(coefficients.get(0b1000)).toBeCloseTo(1, 10);   // m({3}) = 1

      // Synergy
      expect(coefficients.get(0b0011)).toBeCloseTo(5, 10);   // m({0,1}) = 5

      // All other pairwise should be 0 (not in map)
      expect(coefficients.has(0b0101)).toBe(false); // m({0,2}) = 0
      expect(coefficients.has(0b0110)).toBe(false); // m({1,2}) = 0
      expect(coefficients.has(0b1001)).toBe(false); // m({0,3}) = 0
    });

    test('reconstruction from Möbius coefficients matches original values', () => {
      const values = buildSynergisticGame();
      const coefficients = exactMobiusTransform(values, 4);

      // Reconstruct: v(S) = Σ_{T⊆S} m(T)
      for (let mask = 0; mask < 16; mask++) {
        const reconstructed = evaluateCharacteristic(mask, coefficients);
        expect(reconstructed).toBeCloseTo(values[mask], 10);
      }
    });

    test('Möbius transform of additive game has only singleton coefficients', () => {
      const values = buildAdditiveGame([1, 2, 3, 4]);
      const coefficients = exactMobiusTransform(values, 4);

      for (const [T, mT] of coefficients) {
        if (popcount(T) >= 2) {
          expect(Math.abs(mT)).toBeLessThan(1e-10);
        }
      }

      expect(coefficients.get(0b0001)).toBeCloseTo(1, 10);
      expect(coefficients.get(0b0010)).toBeCloseTo(2, 10);
      expect(coefficients.get(0b0100)).toBeCloseTo(3, 10);
      expect(coefficients.get(0b1000)).toBeCloseTo(4, 10);
    });
  });

  // ===========================================================================
  // 3.6.2: LASSO RECOVERY ON SYNTHETIC DATA
  // ===========================================================================

  describe('LASSO recovery (3.6.2)', () => {
    test('recovers nonzero Möbius coefficients from noiseless observations', () => {
      // Known game: m({0}) = 2, m({1}) = 3, m({0,1}) = 5
      // Generate observations from sessions with varying active sets
      const N = 4;
      const coalitions = enumerateCoalitions(N, 2);
      const now = Date.now();

      const observations: CoalitionObservation[] = [
        // Sessions with different active sets
        makeObs(0b0001, 2, [0.7, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 0, now),   // only dim 0: v=2
        makeObs(0b0010, 3, [0.5, 0.7, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 1, now),   // only dim 1: v=3
        makeObs(0b0011, 10, [0.7, 0.7, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 2, now),  // dims 0+1: v=10 (synergy!)
        makeObs(0b0100, 1, [0.5, 0.5, 0.7, 0.5], [0.5, 0.5, 0.5, 0.5], 3, now),   // only dim 2: v=1
        makeObs(0b1000, 1, [0.5, 0.5, 0.5, 0.7], [0.5, 0.5, 0.5, 0.5], 4, now),   // only dim 3: v=1
        makeObs(0b0111, 11, [0.7, 0.7, 0.7, 0.5], [0.5, 0.5, 0.5, 0.5], 5, now),  // dims 0+1+2: v=10+1=11
        makeObs(0b1111, 12, [0.7, 0.7, 0.7, 0.7], [0.5, 0.5, 0.5, 0.5], 6, now),  // all: v=12
        makeObs(0b0101, 3, [0.7, 0.5, 0.7, 0.5], [0.5, 0.5, 0.5, 0.5], 7, now),   // dims 0+2: v=3 (no synergy)
        makeObs(0b0110, 4, [0.5, 0.7, 0.7, 0.5], [0.5, 0.5, 0.5, 0.5], 8, now),   // dims 1+2: v=4 (no synergy)
        makeObs(0b1001, 3, [0.7, 0.5, 0.5, 0.7], [0.5, 0.5, 0.5, 0.5], 9, now),   // dims 0+3: v=3 (no synergy)
        makeObs(0b1010, 4, [0.5, 0.7, 0.5, 0.7], [0.5, 0.5, 0.5, 0.5], 10, now),  // dims 1+3: v=4 (no synergy)
      ];

      const config: MobiusConfig = {
        ...DEFAULT_MOBIUS_CONFIG,
        regularization: 0.001, // very low regularization for noiseless data
        decayRate: 0,          // no temporal decay
      };

      const coefficients = learnCoefficients(observations, coalitions, config);

      // Should recover individual contributions
      expect(coefficients.get(0b0001) ?? 0).toBeCloseTo(2, 1);
      expect(coefficients.get(0b0010) ?? 0).toBeCloseTo(3, 1);
      expect(coefficients.get(0b0100) ?? 0).toBeCloseTo(1, 1);
      expect(coefficients.get(0b1000) ?? 0).toBeCloseTo(1, 1);

      // Should recover the synergy
      expect(coefficients.get(0b0011) ?? 0).toBeCloseTo(5, 1);

      // Other pairwise terms should be near zero
      expect(Math.abs(coefficients.get(0b0101) ?? 0)).toBeLessThan(0.5);
      expect(Math.abs(coefficients.get(0b0110) ?? 0)).toBeLessThan(0.5);
      expect(Math.abs(coefficients.get(0b1001) ?? 0)).toBeLessThan(0.5);
      expect(Math.abs(coefficients.get(0b1010) ?? 0)).toBeLessThan(0.5);
      expect(Math.abs(coefficients.get(0b1100) ?? 0)).toBeLessThan(0.5);
    });

    test('L1 regularization zeros out spurious interactions', () => {
      // Purely additive game v(S) = Σ_{i∈S} c[i] with c = [1,2,3,4]
      // Need enough diverse observations to over-determine the 11-parameter k=2 model
      const N = 4;
      const coalitions = enumerateCoalitions(N, 2);
      const now = Date.now();
      const baseline = [0.5, 0.5, 0.5, 0.5];

      // Generate all 15 nonempty subsets, each with the additive outcome
      const individual = [1, 2, 3, 4];
      const observations: CoalitionObservation[] = [];
      let id = 0;
      for (let mask = 1; mask < 16; mask++) {
        let outcome = 0;
        const w = [0.5, 0.5, 0.5, 0.5];
        for (let i = 0; i < N; i++) {
          if (mask & (1 << i)) {
            outcome += individual[i];
            w[i] = 0.7;
          }
        }
        // Repeat each 3× to overdetermine
        for (let rep = 0; rep < 3; rep++) {
          observations.push(makeObs(mask, outcome, w, baseline, id++, now));
        }
      }

      const config: MobiusConfig = {
        ...DEFAULT_MOBIUS_CONFIG,
        regularization: 0.5,  // strong L1 — must earn interactions from data
        decayRate: 0,
      };

      const coefficients = learnCoefficients(observations, coalitions, config);

      // All pairwise terms should be zero or negligible
      for (const [T, mT] of coefficients) {
        if (popcount(T) >= 2) {
          expect(Math.abs(mT)).toBeLessThan(0.5);
        }
      }
    });

    test('LASSO with noisy data still recovers dominant interactions', () => {
      const N = 4;
      const coalitions = enumerateCoalitions(N, 2);
      const now = Date.now();

      // Same synergistic game but with ±0.5 noise on outcomes
      const noise = [0.3, -0.2, 0.5, -0.1, 0.4, -0.3, 0.2, -0.4, 0.1, -0.5, 0.3];
      const observations: CoalitionObservation[] = [
        makeObs(0b0001, 2 + noise[0], [0.7, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 0, now),
        makeObs(0b0010, 3 + noise[1], [0.5, 0.7, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 1, now),
        makeObs(0b0011, 10 + noise[2], [0.7, 0.7, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 2, now),
        makeObs(0b0100, 1 + noise[3], [0.5, 0.5, 0.7, 0.5], [0.5, 0.5, 0.5, 0.5], 3, now),
        makeObs(0b1000, 1 + noise[4], [0.5, 0.5, 0.5, 0.7], [0.5, 0.5, 0.5, 0.5], 4, now),
        makeObs(0b0111, 11 + noise[5], [0.7, 0.7, 0.7, 0.5], [0.5, 0.5, 0.5, 0.5], 5, now),
        makeObs(0b1111, 12 + noise[6], [0.7, 0.7, 0.7, 0.7], [0.5, 0.5, 0.5, 0.5], 6, now),
        makeObs(0b0101, 3 + noise[7], [0.7, 0.5, 0.7, 0.5], [0.5, 0.5, 0.5, 0.5], 7, now),
        makeObs(0b0110, 4 + noise[8], [0.5, 0.7, 0.7, 0.5], [0.5, 0.5, 0.5, 0.5], 8, now),
        makeObs(0b1001, 3 + noise[9], [0.7, 0.5, 0.5, 0.7], [0.5, 0.5, 0.5, 0.5], 9, now),
        makeObs(0b1010, 4 + noise[10], [0.5, 0.7, 0.5, 0.7], [0.5, 0.5, 0.5, 0.5], 10, now),
      ];

      const config: MobiusConfig = {
        ...DEFAULT_MOBIUS_CONFIG,
        regularization: 0.01,
        decayRate: 0,
      };

      const coefficients = learnCoefficients(observations, coalitions, config);

      // Dominant synergy should still be detected
      const synergy = coefficients.get(0b0011) ?? 0;
      expect(synergy).toBeGreaterThan(2); // true value is 5, should be detectable through noise
    });
  });

  // ===========================================================================
  // 3.6.3: SHAPLEY FROM MÖBIUS EQUALS EXACT ENUMERATION
  // ===========================================================================

  describe('Shapley from Möbius vs exact enumeration (3.6.3)', () => {
    test('Möbius Shapley matches exact enumeration for synergistic game', () => {
      const values = buildSynergisticGame();
      const N = 4;

      // Method A: exact enumeration
      const exactShapley = exactShapleyFromValues(values, N);

      // Method B: Möbius coefficients → closed form
      const mobiusCoeffs = exactMobiusTransform(values, N);
      const mobiusShapley = shapleyFromMobius(N, mobiusCoeffs);

      // They should match to machine precision
      for (let i = 0; i < N; i++) {
        expect(mobiusShapley[i]).toBeCloseTo(exactShapley[i], 10);
      }
    });

    test('Möbius Shapley matches exact enumeration for additive game', () => {
      const contributions = [1, 2, 3, 4];
      const values = buildAdditiveGame(contributions);
      const N = 4;

      const exactShapley = exactShapleyFromValues(values, N);
      const mobiusCoeffs = exactMobiusTransform(values, N);
      const mobiusShapley = shapleyFromMobius(N, mobiusCoeffs);

      for (let i = 0; i < N; i++) {
        expect(mobiusShapley[i]).toBeCloseTo(exactShapley[i], 10);
      }
    });

    test('Möbius Shapley matches for game with multiple synergies', () => {
      // Custom game: synergies between {0,1} and {2,3}
      const N = 4;
      const total = 1 << N;
      const values = new Array(total).fill(0);

      for (let mask = 0; mask < total; mask++) {
        let v = 0;
        if (mask & 1) v += 1;
        if (mask & 2) v += 1;
        if (mask & 4) v += 1;
        if (mask & 8) v += 1;
        if ((mask & 0b0011) === 0b0011) v += 3; // {0,1} synergy
        if ((mask & 0b1100) === 0b1100) v += 2; // {2,3} synergy
        values[mask] = v;
      }

      const exactShapley = exactShapleyFromValues(values, N);
      const mobiusCoeffs = exactMobiusTransform(values, N);
      const mobiusShapley = shapleyFromMobius(N, mobiusCoeffs);

      for (let i = 0; i < N; i++) {
        expect(mobiusShapley[i]).toBeCloseTo(exactShapley[i], 10);
      }
    });
  });

  // ===========================================================================
  // 3.6.4: ADDITIVE GAME GIVES PROPORTIONAL ATTRIBUTION
  // ===========================================================================

  describe('additive game gives proportional attribution (3.6.4)', () => {
    test('Shapley values equal individual contributions for additive game', () => {
      const contributions = [1, 2, 3, 4];
      const values = buildAdditiveGame(contributions);
      const N = 4;

      const mobiusCoeffs = exactMobiusTransform(values, N);
      const shapley = shapleyFromMobius(N, mobiusCoeffs);

      // For additive games, φ[i] = c[i] exactly
      for (let i = 0; i < N; i++) {
        expect(shapley[i]).toBeCloseTo(contributions[i], 10);
      }
    });
  });

  // ===========================================================================
  // 3.6.5: BLEND TRANSITION
  // ===========================================================================

  describe('blend transition (3.6.5)', () => {
    test('blend=0 when below minObservations', () => {
      expect(computeBlend(0, 20)).toBe(0);
      expect(computeBlend(10, 20)).toBe(0);
      expect(computeBlend(19, 20)).toBe(0);
    });

    test('blend=1 at 2× minObservations', () => {
      expect(computeBlend(40, 20)).toBe(1);
      expect(computeBlend(100, 20)).toBe(1);
    });

    test('blend ramps linearly between minObs and 2×minObs', () => {
      expect(computeBlend(20, 20)).toBeCloseTo(0, 10);
      expect(computeBlend(25, 20)).toBeCloseTo(0.25, 10);
      expect(computeBlend(30, 20)).toBeCloseTo(0.5, 10);
      expect(computeBlend(35, 20)).toBeCloseTo(0.75, 10);
    });

    test('blendShapley interpolates linearly', () => {
      const additive = [1, 2, 3, 4];
      const mobius = [5, 6, 7, 8];

      const blended50 = blendShapley(additive, mobius, 0.5);
      expect(blended50[0]).toBeCloseTo(3, 10);
      expect(blended50[1]).toBeCloseTo(4, 10);
      expect(blended50[2]).toBeCloseTo(5, 10);
      expect(blended50[3]).toBeCloseTo(6, 10);

      const blended0 = blendShapley(additive, mobius, 0);
      expect(blended0).toEqual(additive);

      const blended1 = blendShapley(additive, mobius, 1);
      expect(blended1).toEqual(mobius);
    });
  });

  // ===========================================================================
  // 3.6.6: ACTIVE SET DETECTION
  // ===========================================================================

  describe('active set detection (3.6.6)', () => {
    test('all dimensions deviate → full active set', () => {
      const mask = getActiveSet([0.7, 0.8, 0.3, 0.9], [0.5, 0.5, 0.5, 0.5], 0.1);
      expect(mask).toBe(0b1111);
    });

    test('one dimension at baseline → excluded from active set', () => {
      const mask = getActiveSet([0.7, 0.5, 0.3, 0.9], [0.5, 0.5, 0.5, 0.5], 0.1);
      // dim 1 at 0.5 = baseline → not active
      expect(mask).toBe(0b1101); // dims 0, 2, 3
    });

    test('all at baseline → empty active set', () => {
      const mask = getActiveSet([0.5, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 0.1);
      expect(mask).toBe(0b0000);
    });

    test('threshold sensitivity', () => {
      const weights = [0.55, 0.65, 0.45, 0.5];
      const baseline = [0.5, 0.5, 0.5, 0.5];

      // Low threshold: all deviations count
      const lowThresh = getActiveSet(weights, baseline, 0.01);
      expect(lowThresh).toBe(0b0111); // dims 0 (Δ=0.05), 1 (Δ=0.15), 2 (Δ=0.05)

      // High threshold: only large deviations count
      const highThresh = getActiveSet(weights, baseline, 0.1);
      expect(highThresh).toBe(0b0010); // only dim 1 (Δ=0.15)
    });

    test('uses consolidated baseline, not fixed 0.5', () => {
      // Baseline is the consolidated init, not necessarily 0.5
      const baseline = [0.3, 0.7, 0.2, 0.8];
      const weights = [0.3, 0.7, 0.5, 0.8]; // only dim 2 deviates (0.5 vs 0.2 = Δ0.3)

      const mask = getActiveSet(weights, baseline, 0.1);
      expect(mask).toBe(0b0100); // only dim 2
    });
  });

  // ===========================================================================
  // 3.6.9: ORDER ADAPTATION
  // ===========================================================================

  describe('order adaptation (3.6.9)', () => {
    test('does not increase order when fit is good', () => {
      const N = 4;
      // Build a k=2 game and learn with k=2 → good fit
      const coalitions = enumerateCoalitions(N, 2);
      const now = Date.now();

      const observations: CoalitionObservation[] = [
        makeObs(0b0001, 2, [0.7, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 0, now),
        makeObs(0b0010, 3, [0.5, 0.7, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 1, now),
        makeObs(0b0011, 10, [0.7, 0.7, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 2, now),
        makeObs(0b0100, 1, [0.5, 0.5, 0.7, 0.5], [0.5, 0.5, 0.5, 0.5], 3, now),
        makeObs(0b1000, 1, [0.5, 0.5, 0.5, 0.7], [0.5, 0.5, 0.5, 0.5], 4, now),
        makeObs(0b0101, 3, [0.7, 0.5, 0.7, 0.5], [0.5, 0.5, 0.5, 0.5], 5, now),
        makeObs(0b1111, 12, [0.7, 0.7, 0.7, 0.7], [0.5, 0.5, 0.5, 0.5], 6, now),
      ];

      const config: MobiusConfig = {
        ...DEFAULT_MOBIUS_CONFIG,
        regularization: 0.001,
        decayRate: 0,
        residualThreshold: 0.3,
      };

      const coefficients = learnCoefficients(observations, coalitions, config);
      const newOrder = checkOrderAdaptation(observations, coefficients, 2, N, config);

      // k=2 should be sufficient for a k=2 game
      expect(newOrder).toBe(2);
    });

    test('maxOrder config enforces hard cap on order adaptation', () => {
      const N = 4;

      // Same 3-way game that would trigger adaptation from k=2 to k=3
      const now = Date.now();
      const baseline = [0.5, 0.5, 0.5, 0.5];
      const observations: CoalitionObservation[] = [];
      let id = 0;

      for (let mask = 1; mask < 16; mask++) {
        let outcome = 0;
        const w = [0.5, 0.5, 0.5, 0.5];
        for (let i = 0; i < N; i++) {
          if (mask & (1 << i)) {
            outcome += 1;
            w[i] = 0.7;
          }
        }
        if ((mask & 0b0111) === 0b0111) outcome += 20;
        for (let rep = 0; rep < 4; rep++) {
          observations.push(makeObs(mask, outcome, w, baseline, id++, now));
        }
      }

      const coalitions = enumerateCoalitions(N, 2);
      const config: MobiusConfig = {
        ...DEFAULT_MOBIUS_CONFIG,
        maxOrder: 2,                // HARD CAP at 2
        regularization: 0.01,
        decayRate: 0,
        residualThreshold: 0.05,    // would trigger upgrade if maxOrder allowed
      };

      const coefficients = learnCoefficients(observations, coalitions, config);
      const newOrder = checkOrderAdaptation(observations, coefficients, 2, N, config);

      // maxOrder=2 should prevent adaptation to k=3 even though fit is poor
      expect(newOrder).toBe(2);
    });

    test('increases order when k=2 model has poor fit on k=3 game', () => {
      const N = 4;

      // Build a game with a STRONG 3-way interaction and NO pairwise interactions.
      // v(S) = Σ_{i∈S} 1 + 20 · 1[{0,1,2} ⊆ S]
      // The 20 can't be absorbed by any combination of pairwise terms because
      // the 3-way indicator isn't decomposable into pairs.
      const now = Date.now();
      const baseline = [0.5, 0.5, 0.5, 0.5];

      const observations: CoalitionObservation[] = [];
      let id = 0;

      for (let mask = 1; mask < 16; mask++) {
        let outcome = 0;
        const w = [0.5, 0.5, 0.5, 0.5];
        for (let i = 0; i < N; i++) {
          if (mask & (1 << i)) {
            outcome += 1;
            w[i] = 0.7;
          }
        }
        // Strong 3-way synergy (only when ALL of {0,1,2} present)
        if ((mask & 0b0111) === 0b0111) outcome += 20;

        for (let rep = 0; rep < 4; rep++) {
          observations.push(makeObs(mask, outcome, w, baseline, id++, now));
        }
      }

      const coalitions = enumerateCoalitions(N, 2);
      const config: MobiusConfig = {
        ...DEFAULT_MOBIUS_CONFIG,
        maxOrder: 4,                // allow adaptation up to order 4
        regularization: 0.01,
        decayRate: 0,
        residualThreshold: 0.05, // k=2 residual is ~0.098 → this triggers upgrade
      };

      const coefficients = learnCoefficients(observations, coalitions, config);
      const residual = computeFitResidual(observations, coefficients);

      // k=2 can't perfectly capture the 3-way interaction — some residual remains
      // The pairwise model absorbs MOST of it but not all
      expect(residual).toBeGreaterThan(0.01);

      const newOrder = checkOrderAdaptation(observations, coefficients, 2, N, config);
      expect(newOrder).toBe(3);
    });
  });

  // ===========================================================================
  // 3.6.11: SHAPLEY EFFICIENCY
  // ===========================================================================

  describe('Shapley efficiency (3.6.11)', () => {
    test('Σ φ[i] = v(N) - v(∅) for learned coefficients', () => {
      const N = 4;
      const values = buildSynergisticGame();
      const coefficients = exactMobiusTransform(values, N);

      const shapley = shapleyFromMobius(N, coefficients);
      const sumPhi = shapley.reduce((a, b) => a + b, 0);

      const vGrand = values[(1 << N) - 1]; // v(N)
      const vEmpty = values[0];              // v(∅)

      expect(sumPhi).toBeCloseTo(vGrand - vEmpty, 10);
    });

    test('efficiency holds for arbitrary coefficient sets', () => {
      // Manually construct coefficients
      const N = 4;
      const coefficients = new Map<number, number>();
      coefficients.set(0b0000, 1.5);  // m(∅) = constant term
      coefficients.set(0b0001, 2.0);
      coefficients.set(0b0010, -1.0);
      coefficients.set(0b0100, 3.0);
      coefficients.set(0b1000, 0.5);
      coefficients.set(0b0011, 4.0);  // interaction {0,1}
      coefficients.set(0b1100, -2.0); // interaction {2,3}

      const shapley = shapleyFromMobius(N, coefficients);
      const sumPhi = shapley.reduce((a, b) => a + b, 0);

      const vGrand = evaluateCharacteristic((1 << N) - 1, coefficients);
      const vEmpty = evaluateCharacteristic(0, coefficients);

      expect(sumPhi).toBeCloseTo(vGrand - vEmpty, 10);
    });
  });

  // ===========================================================================
  // 3.6.12: TEMPORAL DECAY
  // ===========================================================================

  describe('temporal decay (3.6.12)', () => {
    test('recent observations have higher weight than old ones', () => {
      const now = Date.now();
      const DAY = 86400000;

      const observations: CoalitionObservation[] = [
        makeObs(0b0001, 1, [0.7, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 0, now - 30 * DAY), // 30 days old
        makeObs(0b0001, 1, [0.7, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 1, now),              // today
      ];

      const weights = computeTemporalWeights(observations, 0.01, now);

      // Recent observation should have higher weight
      expect(weights[1]).toBeGreaterThan(weights[0]);

      // 30 days old at decay=0.01: exp(-30*0.01) ≈ 0.74
      expect(weights[0]).toBeCloseTo(Math.exp(-30 * 0.01), 2);
      expect(weights[1]).toBeCloseTo(1.0, 10);
    });

    test('temporal decay shifts learned coefficients toward recent data', () => {
      const now = Date.now();
      const DAY = 86400000;
      const N = 4;
      const coalitions = enumerateCoalitions(N, 2);
      const baseline = [0.5, 0.5, 0.5, 0.5];

      // Need observations with diverse active sets so the design matrix has
      // enough rank to separate m({0}) from m(∅) and pairwise terms.

      // Phase 1 (30 days ago): dim 0 contributes v=5
      const oldObs: CoalitionObservation[] = [];
      for (let i = 0; i < 5; i++) {
        oldObs.push(makeObs(0b0001, 5, [0.7, 0.5, 0.5, 0.5], baseline, i, now - 30 * DAY));
        oldObs.push(makeObs(0b0011, 8, [0.7, 0.7, 0.5, 0.5], baseline, i + 5, now - 30 * DAY));
        oldObs.push(makeObs(0b0010, 3, [0.5, 0.7, 0.5, 0.5], baseline, i + 10, now - 30 * DAY));
      }

      // Phase 2 (today): dim 0 contributes v=1 (shifted down)
      const newObs: CoalitionObservation[] = [];
      for (let i = 0; i < 5; i++) {
        newObs.push(makeObs(0b0001, 1, [0.7, 0.5, 0.5, 0.5], baseline, i + 15, now));
        newObs.push(makeObs(0b0011, 4, [0.7, 0.7, 0.5, 0.5], baseline, i + 20, now));
        newObs.push(makeObs(0b0010, 3, [0.5, 0.7, 0.5, 0.5], baseline, i + 25, now));
      }

      const allObs = [...oldObs, ...newObs];

      // With decay: m({0}) should be closer to 1 (recent value)
      const configDecay: MobiusConfig = {
        ...DEFAULT_MOBIUS_CONFIG,
        regularization: 0.001,
        decayRate: 0.1, // aggressive decay — old obs down-weighted significantly
      };
      const coeffsDecay = learnCoefficients(allObs, coalitions, configDecay);
      const mDim0Decay = coeffsDecay.get(0b0001) ?? 0;

      // Without decay: m({0}) should be closer to 3 (average of 5 and 1)
      const configNoDecay: MobiusConfig = {
        ...DEFAULT_MOBIUS_CONFIG,
        regularization: 0.001,
        decayRate: 0,
      };
      const coeffsNoDecay = learnCoefficients(allObs, coalitions, configNoDecay);
      const mDim0NoDecay = coeffsNoDecay.get(0b0001) ?? 0;

      // With decay, coefficient should be lower (closer to recent v=1)
      // Without decay, coefficient should be higher (closer to average v=3)
      expect(mDim0Decay).toBeLessThan(mDim0NoDecay);
    });
  });

  // ===========================================================================
  // DESIGN MATRIX
  // ===========================================================================

  describe('design matrix', () => {
    test('Φ[i][j] = 1 iff coalition[j] ⊆ activeSet(obs[i])', () => {
      const coalitions = [0b0000, 0b0001, 0b0010, 0b0011]; // ∅, {0}, {1}, {0,1}
      const observations: CoalitionObservation[] = [
        makeObs(0b0001, 1), // only dim 0 active
        makeObs(0b0011, 2), // dims 0,1 active
      ];

      const Phi = buildDesignMatrix(observations, coalitions);

      // Obs 0 (active: {0}): ∅⊆{0}=1, {0}⊆{0}=1, {1}⊆{0}=0, {0,1}⊆{0}=0
      expect(Phi[0]).toEqual([1, 1, 0, 0]);

      // Obs 1 (active: {0,1}): ∅⊆{0,1}=1, {0}⊆{0,1}=1, {1}⊆{0,1}=1, {0,1}⊆{0,1}=1
      expect(Phi[1]).toEqual([1, 1, 1, 1]);
    });
  });

  // ===========================================================================
  // GRAM MATRIX PRECOMPUTATION
  // ===========================================================================

  describe('Gram matrix precomputation', () => {
    test('weighted Gram matrix is symmetric', () => {
      const Phi = [[1, 0, 1], [1, 1, 0], [0, 1, 1]];
      const y = [1, 2, 3];
      const weights = [1, 1, 1];

      const { G } = precomputeGram(Phi, y, weights);

      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          expect(G[i][j]).toBeCloseTo(G[j][i], 10);
        }
      }
    });

    test('temporal weights scale contribution correctly', () => {
      const Phi = [[1, 1], [1, 1]];
      const y = [10, 20];

      // Equal weights
      const { PhiTy: eq } = precomputeGram(Phi, y, [1, 1]);
      // PhiTy = [10+20, 10+20] = [30, 30]
      expect(eq[0]).toBeCloseTo(30, 10);

      // Weight second observation 10× more
      const { PhiTy: weighted } = precomputeGram(Phi, y, [1, 10]);
      // PhiTy = [1*10 + 10*20, 1*10 + 10*20] = [210, 210]
      expect(weighted[0]).toBeCloseTo(210, 10);
    });
  });

  // ===========================================================================
  // HIGH-LEVEL API
  // ===========================================================================

  describe('MobiusCharacteristic class', () => {
    test('addObservation stores and prunes correctly', () => {
      const mc = new MobiusCharacteristic(4, { maxObservations: 3 });
      mc.addObservation([0.7, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 1, 0);
      mc.addObservation([0.5, 0.7, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 2, 1);
      mc.addObservation([0.5, 0.5, 0.7, 0.5], [0.5, 0.5, 0.5, 0.5], 3, 2);
      mc.addObservation([0.5, 0.5, 0.5, 0.7], [0.5, 0.5, 0.5, 0.5], 4, 3);

      expect(mc.getState().observations.length).toBe(3); // capped at 3
      expect(mc.getState().observations[0].sessionId).toBe(1); // oldest pruned
    });

    test('updateCoefficients learns from observations', () => {
      const mc = new MobiusCharacteristic(4, {
        regularization: 0.001,
        decayRate: 0,
      });

      const now = Date.now();
      // Add observations from synergistic game
      mc.addObservation([0.7, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 2, 0, now);
      mc.addObservation([0.5, 0.7, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 3, 1, now);
      mc.addObservation([0.7, 0.7, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 10, 2, now);
      mc.addObservation([0.5, 0.5, 0.7, 0.5], [0.5, 0.5, 0.5, 0.5], 1, 3, now);
      mc.addObservation([0.7, 0.5, 0.7, 0.5], [0.5, 0.5, 0.5, 0.5], 3, 4, now);

      mc.updateCoefficients();

      // Should have learned some nonzero coefficients
      expect(mc.getState().coefficients.size).toBeGreaterThan(0);

      // Synergy between 0 and 1 should be detected
      const synergy = mc.getState().coefficients.get(0b0011) ?? 0;
      expect(synergy).toBeGreaterThan(0);
    });

    test('computeShapley returns valid Shapley values', () => {
      const N = 4;
      const mc = new MobiusCharacteristic(N, { regularization: 0.001, decayRate: 0 });

      const now = Date.now();
      mc.addObservation([0.7, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 2, 0, now);
      mc.addObservation([0.5, 0.7, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 3, 1, now);
      mc.addObservation([0.7, 0.7, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 10, 2, now);
      mc.addObservation([0.5, 0.5, 0.7, 0.5], [0.5, 0.5, 0.5, 0.5], 1, 3, now);
      mc.addObservation([0.7, 0.5, 0.7, 0.5], [0.5, 0.5, 0.5, 0.5], 3, 4, now);

      mc.updateCoefficients();

      const shapley = mc.computeShapley();
      expect(shapley.length).toBe(N);

      // Efficiency: Σφ should equal v(N) - v(∅)
      const sumPhi = shapley.reduce((a, b) => a + b, 0);
      const vGrand = mc.evaluate((1 << N) - 1);
      const vEmpty = mc.evaluate(0);
      expect(sumPhi).toBeCloseTo(vGrand - vEmpty, 6);
    });

    test('interactionCount and strongestInteraction', () => {
      const N = 4;
      const mc = new MobiusCharacteristic(N, { regularization: 0.001, decayRate: 0 });

      const now = Date.now();
      mc.addObservation([0.7, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 2, 0, now);
      mc.addObservation([0.5, 0.7, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 3, 1, now);
      mc.addObservation([0.7, 0.7, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 10, 2, now);
      mc.addObservation([0.5, 0.5, 0.7, 0.5], [0.5, 0.5, 0.5, 0.5], 1, 3, now);
      mc.addObservation([0.7, 0.5, 0.7, 0.5], [0.5, 0.5, 0.5, 0.5], 3, 4, now);
      mc.addObservation([0.5, 0.7, 0.7, 0.5], [0.5, 0.5, 0.5, 0.5], 4, 5, now);

      mc.updateCoefficients();

      // Should have at least one interaction
      const strongest = mc.strongestInteraction();
      if (mc.interactionCount() > 0) {
        expect(strongest).not.toBeNull();
        expect(strongest!.dimensions.length).toBeGreaterThanOrEqual(2);
        expect(strongest!.strength).toBeGreaterThan(0);
      }
    });

    test('serialize and deserialize round-trip', () => {
      const mc = new MobiusCharacteristic(4, { regularization: 0.001, decayRate: 0 });

      const now = Date.now();
      mc.addObservation([0.7, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 2, 0, now);
      mc.addObservation([0.5, 0.7, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 3, 1, now);
      mc.addObservation([0.7, 0.7, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], 10, 2, now);
      mc.updateCoefficients();

      const serialized = mc.serialize();
      const restored = MobiusCharacteristic.deserialize(serialized);

      // State should match
      expect(restored.getState().dimensionCount).toBe(4);
      expect(restored.getState().observations.length).toBe(3);
      expect(restored.getState().currentOrder).toBe(mc.getState().currentOrder);
      expect(restored.getState().fitResidual).toBeCloseTo(mc.getState().fitResidual, 10);

      // Coefficients should match
      for (const [T, mT] of mc.getState().coefficients) {
        expect(restored.getState().coefficients.get(T)).toBeCloseTo(mT, 10);
      }
    });
  });

  // ===========================================================================
  // N > 4 SUPPORT (v2 strategy features)
  // ===========================================================================

  describe('N > 4 support', () => {
    test('MobiusCharacteristic works with N=5 (v2 starter features)', () => {
      const N = 5;
      const mc = new MobiusCharacteristic(N, { regularization: 0.001, decayRate: 0 });

      expect(mc.N).toBe(5);

      const baseline = [0.5, 0.5, 0.5, 0.5, 0.5];
      const now = Date.now();

      // Add observations with varying active sets across 5 dimensions
      mc.addObservation([0.7, 0.5, 0.5, 0.5, 0.5], baseline, 2, 0, now);    // dim 0
      mc.addObservation([0.5, 0.7, 0.5, 0.5, 0.5], baseline, 3, 1, now);    // dim 1
      mc.addObservation([0.7, 0.7, 0.5, 0.5, 0.5], baseline, 8, 2, now);    // dims 0+1 (synergy)
      mc.addObservation([0.5, 0.5, 0.7, 0.5, 0.5], baseline, 1, 3, now);    // dim 2
      mc.addObservation([0.5, 0.5, 0.5, 0.7, 0.5], baseline, 1, 4, now);    // dim 3
      mc.addObservation([0.5, 0.5, 0.5, 0.5, 0.7], baseline, 1, 5, now);    // dim 4
      mc.addObservation([0.7, 0.5, 0.7, 0.5, 0.5], baseline, 3, 6, now);    // dims 0+2
      mc.addObservation([0.5, 0.7, 0.5, 0.7, 0.5], baseline, 4, 7, now);    // dims 1+3

      mc.updateCoefficients();

      const shapley = mc.computeShapley();
      expect(shapley.length).toBe(5);

      // Efficiency: Σφ = v(N) - v(∅)
      const sumPhi = shapley.reduce((a, b) => a + b, 0);
      const vGrand = mc.evaluate((1 << N) - 1);
      const vEmpty = mc.evaluate(0);
      expect(sumPhi).toBeCloseTo(vGrand - vEmpty, 6);

      // Dims 0 and 1 should have higher attribution (synergy detected)
      expect(shapley[0]).toBeGreaterThan(shapley[4]);
      expect(shapley[1]).toBeGreaterThan(shapley[4]);
    });

    test('MobiusCharacteristic works with N=10 (v2 expanded features)', () => {
      const N = 10;
      const mc = new MobiusCharacteristic(N, { regularization: 0.01, decayRate: 0 });

      expect(mc.N).toBe(10);

      const baseline = new Array(N).fill(0.5);
      const now = Date.now();

      // Generate diverse observations: each singleton + some pairs
      for (let i = 0; i < N; i++) {
        const w = new Array(N).fill(0.5);
        w[i] = 0.7;
        mc.addObservation(w, baseline, i + 1, i, now);
      }

      // Add some pair observations
      for (let i = 0; i < N - 1; i++) {
        const w = new Array(N).fill(0.5);
        w[i] = 0.7;
        w[i + 1] = 0.7;
        mc.addObservation(w, baseline, (i + 1) + (i + 2) + 2, N + i, now); // slight synergy
      }

      mc.updateCoefficients();

      const shapley = mc.computeShapley();
      expect(shapley.length).toBe(10);

      // Efficiency check
      const sumPhi = shapley.reduce((a, b) => a + b, 0);
      const vGrand = mc.evaluate((1 << N) - 1);
      const vEmpty = mc.evaluate(0);
      expect(sumPhi).toBeCloseTo(vGrand - vEmpty, 4);
    });

    test('N=5 serialize/deserialize round-trip preserves state', () => {
      const N = 5;
      const mc = new MobiusCharacteristic(N, { regularization: 0.001, decayRate: 0 });

      const baseline = [0.5, 0.5, 0.5, 0.5, 0.5];
      const now = Date.now();
      mc.addObservation([0.7, 0.5, 0.5, 0.5, 0.5], baseline, 2, 0, now);
      mc.addObservation([0.5, 0.7, 0.5, 0.5, 0.5], baseline, 3, 1, now);
      mc.addObservation([0.7, 0.7, 0.5, 0.5, 0.5], baseline, 8, 2, now);
      mc.updateCoefficients();

      const serialized = mc.serialize();
      const restored = MobiusCharacteristic.deserialize(serialized);

      expect(restored.getState().dimensionCount).toBe(5);
      expect(restored.getState().observations.length).toBe(3);

      // Shapley values should match after round-trip
      const origShapley = mc.computeShapley();
      const restoredShapley = restored.computeShapley();
      for (let i = 0; i < N; i++) {
        expect(restoredShapley[i]).toBeCloseTo(origShapley[i], 10);
      }
    });
  });

  // ===========================================================================
  // FIT QUALITY
  // ===========================================================================

  describe('fit quality', () => {
    test('perfect fit gives residual ≈ 0', () => {
      // Observations perfectly match an additive model
      const coefficients = new Map<number, number>();
      coefficients.set(0b0001, 2);
      coefficients.set(0b0010, 3);

      const observations: CoalitionObservation[] = [
        makeObs(0b0001, 2),  // v({0}) = 2 ✓
        makeObs(0b0010, 3),  // v({1}) = 3 ✓
        makeObs(0b0011, 5),  // v({0,1}) = 2+3 = 5 ✓
      ];

      const residual = computeFitResidual(observations, coefficients);
      expect(residual).toBeLessThan(0.01);
    });

    test('poor fit gives residual near 1', () => {
      // Model predicts 0 for everything, but outcomes vary
      const coefficients = new Map<number, number>();

      const observations: CoalitionObservation[] = [
        makeObs(0b0001, 5),
        makeObs(0b0010, 10),
        makeObs(0b0011, -3),
      ];

      const residual = computeFitResidual(observations, coefficients);
      expect(residual).toBeGreaterThan(0.9);
    });
  });

  // ===========================================================================
  // PRUNING
  // ===========================================================================

  describe('observation pruning', () => {
    test('pruneObservations keeps most recent', () => {
      const state = createMobiusState(4);
      for (let i = 0; i < 10; i++) {
        state.observations.push(makeObs(0b0001, i, [0.5, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], i));
      }

      pruneObservations(state, 5);

      expect(state.observations.length).toBe(5);
      expect(state.observations[0].sessionId).toBe(5); // oldest kept
      expect(state.observations[4].sessionId).toBe(9); // newest
    });
  });
});
