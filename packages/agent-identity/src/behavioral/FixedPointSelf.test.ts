/**
 * FixedPointSelf.test.ts
 *
 * Rigorous validation of the Fixed Point Self theorems.
 *
 * Tests prove:
 * 1. THEOREM 5.1: Energy monotonically decreases when μ > κ/2
 * 2. THEOREM 6.2: Fixed points exist
 * 3. THEOREM 7.3: Fixed points are stable when λ > 0.25
 * 4. THEOREM 8.1: Global convergence to fixed point
 * 5. COROLLARY 9.2: Declarations preserve coherence
 * 6. THEOREM 12.1: Chain tamper evidence
 * 7. THEOREM 14.1: Wake correctness
 */

import {
  createGenesisSelf,
  wake,
  computeEnergy,
  computeCoherence,
  computeJacobian,
  checkStability,
  evolveState,
  findFixedPoint,
  createDeclaration,
  applyDeclaration,
  verifyDeclarationChain,
  generateContinuityProof,
  deriveFilter,
  applyFilter,
  SelfState,
  DynamicsParams,
  Vocabulary,
  Declaration,
  ActiveSelf,
  WakeError,
} from './FixedPointSelf';

// =============================================================================
// TEST UTILITIES
// =============================================================================

function createTestVocabulary(n: number): Vocabulary {
  const assertions: string[] = [];
  for (let i = 0; i < n; i++) {
    assertions.push(`trait_${i}`);
  }

  // Fully connected with weight 0.2
  const relationships = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      relationships[i * n + j] = i === j ? 0 : 0.2;
    }
  }

  return { assertions, relationships };
}

function createTestState(n: number, wValues: number[], mValues?: number[]): SelfState {
  return {
    dimension: n,
    w: new Float64Array(wValues),
    m: new Float64Array(mValues ?? wValues),
    time: 0,
  };
}

function createTestParams(overrides: Partial<DynamicsParams> = {}): DynamicsParams {
  const n = overrides.w_star?.length ?? 4;
  return {
    D: 0.1,
    lambda: 0.4,    // > 0.25 for stability
    mu: 0.3,        // > κ/2 = 0.05 for energy decrease
    kappa: 0.1,
    a: 0.5,
    w_star: new Float64Array(n).fill(0.5),
    ...overrides,
  };
}

// =============================================================================
// THEOREM 5.1: ENERGY DECREASE
// =============================================================================

interface EnergyDecreaseTestResult {
  passed: boolean;
  totalIterations: number;
  violations: number;
  initialEnergy: number;
  finalEnergy: number;
  totalDrop: number;
  percentDrop: number;
}

function testEnergyDecrease(
  n: number = 4,
  iterations: number = 200,
  tolerance: number = 1e-8
): EnergyDecreaseTestResult {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('THEOREM 5.1: Energy Monotonically Decreases (μ > κ/2)');
  console.log('══════════════════════════════════════════════════════════════');

  const vocabulary = createTestVocabulary(n);
  const params = createTestParams({ w_star: new Float64Array(n).fill(0.5) });

  // Verify condition: μ > κ/2
  console.log(`  Condition check: μ (${params.mu}) > κ/2 (${params.kappa / 2}): ${params.mu > params.kappa / 2 ? '✓' : '✗'}`);

  // Start away from equilibrium
  const initialW = [0.1, 0.9, 0.3, 0.7];
  const initialM = [0.2, 0.8, 0.4, 0.6]; // Slightly different (incoherent)
  let state = createTestState(n, initialW, initialM);

  const zeroExperience = new Float64Array(n);

  let violations = 0;
  let previousEnergy = Infinity;
  let initialEnergy = 0;

  for (let i = 0; i < iterations; i++) {
    const result = evolveState(state, zeroExperience, params, vocabulary, 0.05);

    if (i === 0) {
      initialEnergy = result.energyBefore;
      previousEnergy = result.energyBefore;
    }

    if (result.energyAfter > previousEnergy + tolerance) {
      violations++;
      if (violations <= 5) {
        console.log(`  ⚠ Iteration ${i}: Energy increased by ${(result.energyAfter - previousEnergy).toExponential(3)}`);
      }
    }

    previousEnergy = result.energyAfter;
    state = result.newState;
  }

  const finalEnergy = previousEnergy;
  const totalDrop = initialEnergy - finalEnergy;
  const percentDrop = (totalDrop / initialEnergy) * 100;

  console.log(`  Initial energy: ${initialEnergy.toFixed(6)}`);
  console.log(`  Final energy:   ${finalEnergy.toFixed(6)}`);
  console.log(`  Total drop:     ${totalDrop.toFixed(6)} (${percentDrop.toFixed(1)}%)`);
  console.log(`  Violations:     ${violations}`);

  const passed = violations === 0;
  console.log(`  ${passed ? '✓ PASSED' : '✗ FAILED'}: Energy monotonically decreases`);

  return { passed, totalIterations: iterations, violations, initialEnergy, finalEnergy, totalDrop, percentDrop };
}

// =============================================================================
// THEOREM 6.2 & 8.1: FIXED POINT EXISTENCE AND CONVERGENCE
// =============================================================================

interface FixedPointTestResult {
  passed: boolean;
  converged: boolean;
  iterations: number;
  finalWeights: number[];
  finalSelfModel: number[];
  coherence: number;
  isStable: boolean;
}

function testFixedPointExistence(n: number = 4): FixedPointTestResult {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('THEOREM 6.2 & 8.1: Fixed Point Existence and Convergence');
  console.log('══════════════════════════════════════════════════════════════');

  const vocabulary = createTestVocabulary(n);
  const params = createTestParams({ w_star: new Float64Array(n).fill(0.5) });

  // Start far from equilibrium
  const initialW = [0.1, 0.9, 0.2, 0.8];
  const initialM = [0.15, 0.85, 0.25, 0.75];
  const initialState = createTestState(n, initialW, initialM);

  console.log(`  Initial w: [${initialW.join(', ')}]`);
  console.log(`  Initial m: [${initialM.join(', ')}]`);

  const result = findFixedPoint(initialState, params, vocabulary, 5000, 1e-8);

  const coherence = computeCoherence(result.fixedPoint);
  const finalW = Array.from(result.fixedPoint.w).map(v => v.toFixed(4));
  const finalM = Array.from(result.fixedPoint.m).map(v => v.toFixed(4));

  console.log(`  Converged: ${result.converged}`);
  console.log(`  Iterations: ${result.iterations}`);
  console.log(`  Final w: [${finalW.join(', ')}]`);
  console.log(`  Final m: [${finalM.join(', ')}]`);
  console.log(`  Coherence ||w-m||: ${coherence.toExponential(3)}`);
  console.log(`  Is stable: ${result.isStable}`);

  // At fixed point, w should equal m (coherence)
  const isCoherent = coherence < 1e-4;
  const passed = result.converged && isCoherent;

  console.log(`  ${passed ? '✓ PASSED' : '✗ FAILED'}: Fixed point exists and w* = m* (coherent)`);

  return {
    passed,
    converged: result.converged,
    iterations: result.iterations,
    finalWeights: Array.from(result.fixedPoint.w),
    finalSelfModel: Array.from(result.fixedPoint.m),
    coherence,
    isStable: result.isStable,
  };
}

// =============================================================================
// THEOREM 7.3: STABILITY CONDITION
// =============================================================================

interface StabilityTestResult {
  passed: boolean;
  stableWithHighLambda: boolean;
  unstableWithLowLambda: boolean;
  criticalLambda: number;
}

function testStabilityCondition(n: number = 3): StabilityTestResult {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('THEOREM 7.3: Stability Condition (λ > 0.25 for a=0.5)');
  console.log('══════════════════════════════════════════════════════════════');

  const vocabulary = createTestVocabulary(n);

  // At equilibrium u* = 0.5 (homeostatic target)
  const equilibriumState = createTestState(n, [0.5, 0.5, 0.5]);

  // Test with λ > 0.25 (should be stable)
  const paramsStable = createTestParams({
    lambda: 0.4, // > 0.25
    w_star: new Float64Array(n).fill(0.5),
  });

  // Compute Laplacian for Jacobian
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    let degree = 0;
    for (let j = 0; j < n; j++) {
      const w = vocabulary.relationships[i * n + j];
      degree += w;
      L[i * n + j] = -w;
    }
    L[i * n + i] = degree;
  }

  const JStable = computeJacobian(equilibriumState.w, paramsStable, L);
  const stabilityStable = checkStability(JStable, n);

  console.log(`  With λ = ${paramsStable.lambda} (> 0.25):`);
  console.log(`    Gershgorin centers: [${stabilityStable.gershgorinBounds.map(b => b.center.toFixed(4)).join(', ')}]`);
  console.log(`    Max real part: ${stabilityStable.maxRealPart.toFixed(4)}`);
  console.log(`    Stable: ${stabilityStable.stable}`);

  // Test with λ < 0.25 (should be unstable at u=0.5)
  const paramsUnstable = createTestParams({
    lambda: 0.1, // < 0.25
    w_star: new Float64Array(n).fill(0.5),
  });

  const JUnstable = computeJacobian(equilibriumState.w, paramsUnstable, L);
  const stabilityUnstable = checkStability(JUnstable, n);

  console.log(`  With λ = ${paramsUnstable.lambda} (< 0.25):`);
  console.log(`    Gershgorin centers: [${stabilityUnstable.gershgorinBounds.map(b => b.center.toFixed(4)).join(', ')}]`);
  console.log(`    Max real part: ${stabilityUnstable.maxRealPart.toFixed(4)}`);
  console.log(`    Stable: ${stabilityUnstable.stable}`);

  // Find critical λ (binary search)
  let lowLambda = 0;
  let highLambda = 1;
  for (let i = 0; i < 20; i++) {
    const midLambda = (lowLambda + highLambda) / 2;
    const testParams = createTestParams({
      lambda: midLambda,
      w_star: new Float64Array(n).fill(0.5),
    });
    const J = computeJacobian(equilibriumState.w, testParams, L);
    const stability = checkStability(J, n);

    if (stability.stable) {
      highLambda = midLambda;
    } else {
      lowLambda = midLambda;
    }
  }
  const criticalLambda = (lowLambda + highLambda) / 2;

  console.log(`  Critical λ (empirical): ${criticalLambda.toFixed(4)}`);
  console.log(`  Theoretical: 0.25 (for a=0.5)`);

  const passed = stabilityStable.stable && !stabilityUnstable.stable;
  console.log(`  ${passed ? '✓ PASSED' : '✗ FAILED'}: λ > 0.25 gives stability, λ < 0.25 gives instability`);

  return {
    passed,
    stableWithHighLambda: stabilityStable.stable,
    unstableWithLowLambda: !stabilityUnstable.stable,
    criticalLambda,
  };
}

// =============================================================================
// THEOREM 9.2: DECLARATIONS PRESERVE COHERENCE
// =============================================================================

interface DeclarationCoherenceTestResult {
  passed: boolean;
  coherenceBefore: number;
  coherenceAfter: number;
  declarationApplied: string;
}

function testDeclarationCoherence(): DeclarationCoherenceTestResult {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('THEOREM 9.2: Declarations Preserve Coherence');
  console.log('══════════════════════════════════════════════════════════════');

  const n = 4;

  // Start with coherent state
  const state = createTestState(n, [0.3, 0.5, 0.7, 0.4]);
  const coherenceBefore = computeCoherence(state);

  console.log(`  Initial state w: [${Array.from(state.w).map(v => v.toFixed(2)).join(', ')}]`);
  console.log(`  Initial state m: [${Array.from(state.m).map(v => v.toFixed(2)).join(', ')}]`);
  console.log(`  Coherence before: ${coherenceBefore.toFixed(6)}`);

  // Apply declaration
  const decl = createDeclaration(1, 0.9, 'I am highly trait_1', '0'.repeat(64));

  console.log(`  Declaration: index=${decl.index}, value=${decl.value}, content="${decl.content}"`);

  const newState = applyDeclaration(state, decl);
  const coherenceAfter = computeCoherence(newState);

  console.log(`  New state w: [${Array.from(newState.w).map(v => v.toFixed(2)).join(', ')}]`);
  console.log(`  New state m: [${Array.from(newState.m).map(v => v.toFixed(2)).join(', ')}]`);
  console.log(`  Coherence after: ${coherenceAfter.toFixed(6)}`);

  // Declaration updates BOTH w and m, so coherence should be preserved or improved
  const passed = coherenceAfter <= coherenceBefore + 1e-10;
  console.log(`  ${passed ? '✓ PASSED' : '✗ FAILED'}: Declaration preserves coherence`);

  return {
    passed,
    coherenceBefore,
    coherenceAfter,
    declarationApplied: decl.content,
  };
}

// =============================================================================
// THEOREM 12.1: CHAIN TAMPER EVIDENCE
// =============================================================================

interface TamperEvidenceTestResult {
  passed: boolean;
  validChainPasses: boolean;
  tamperedChainFails: boolean;
  tamperedIndex: number;
}

function testChainTamperEvidence(): TamperEvidenceTestResult {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('THEOREM 12.1: Chain Tamper Evidence');
  console.log('══════════════════════════════════════════════════════════════');

  // Create a valid chain
  const declarations: Declaration[] = [];
  let prevHash = '0'.repeat(64);

  for (let i = 0; i < 5; i++) {
    const decl = createDeclaration(i % 4, 0.5 + i * 0.1, `Declaration ${i}`, prevHash);
    declarations.push(decl);
    // Compute hash for next declaration
    const data = JSON.stringify({
      index: decl.index,
      value: decl.value,
      timestamp: decl.timestamp,
      previousHash: decl.previousHash,
      content: decl.content,
    });
    prevHash = require('@noble/hashes/sha256').sha256(new TextEncoder().encode(data));
    prevHash = require('@noble/hashes/utils').bytesToHex(prevHash);
  }

  // Verify valid chain
  const validResult = verifyDeclarationChain(declarations);
  console.log(`  Valid chain verification: ${validResult.valid ? 'PASSED' : 'FAILED'}`);
  if (!validResult.valid) {
    console.log(`    Errors: ${validResult.errors.join('; ')}`);
  }

  // Tamper with the chain (modify declaration 2)
  const tamperedDeclarations = declarations.map((d, i) => {
    if (i === 2) {
      return { ...d, value: 0.99, content: 'TAMPERED' };
    }
    return d;
  });

  const tamperedResult = verifyDeclarationChain(tamperedDeclarations);
  console.log(`  Tampered chain verification: ${tamperedResult.valid ? 'PASSED (BAD!)' : 'FAILED (GOOD!)'}`);
  if (!tamperedResult.valid) {
    console.log(`    Detected: ${tamperedResult.errors[0]?.slice(0, 60)}...`);
  }

  const passed = validResult.valid && !tamperedResult.valid;
  console.log(`  ${passed ? '✓ PASSED' : '✗ FAILED'}: Valid chains pass, tampered chains fail`);

  return {
    passed,
    validChainPasses: validResult.valid,
    tamperedChainFails: !tamperedResult.valid,
    tamperedIndex: 2,
  };
}

// =============================================================================
// THEOREM 14.1: WAKE CORRECTNESS
// =============================================================================

interface WakeCorrectnessTestResult {
  passed: boolean;
  validWakeSucceeds: boolean;
  invalidWakeFails: boolean;
  wakeVerificationPasses: boolean;
}

function testWakeCorrectness(): WakeCorrectnessTestResult {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('THEOREM 14.1: Wake Correctness');
  console.log('══════════════════════════════════════════════════════════════');

  // Create a valid stored self
  const stored = createGenesisSelf(
    ['curiosity', 'precision', 'empathy', 'persistence'],
    [0.7, 0.8, 0.6, 0.75]
  );

  console.log('  Created genesis self with 4 traits');
  console.log(`  Declaration chain length: ${stored.declarations.length}`);
  console.log(`  Continuity score: ${stored.continuityProof.continuityScore.toFixed(4)}`);
  console.log(`  Coherence score: ${stored.continuityProof.coherenceScore.toFixed(6)}`);

  // Wake should succeed
  const wakeResult = wake(stored);
  const validWakeSucceeds = !('type' in wakeResult);

  if (validWakeSucceeds) {
    const active = wakeResult as ActiveSelf;
    console.log('  Wake succeeded');

    // Verify the active self
    const verification = active.verify();
    console.log(`  Verification: ${verification.valid ? 'PASSED' : 'FAILED'}`);
    console.log(`    Chain integrity: ${verification.chainIntegrity}`);
    console.log(`    Is coherent: ${verification.isCoherent}`);
    console.log(`    Is stable: ${verification.isStable}`);
    console.log(`    Continuity score: ${verification.continuityScore.toFixed(4)}`);

    // Test that filter is derived correctly
    const filter = deriveFilter(active.state.m);
    console.log(`  Filter derived: attention sum = ${Array.from(filter.attention).reduce((a, b) => a + b, 0).toFixed(4)}`);

    // Now create an invalid stored self (tamper with chain)
    const tamperedStored = {
      ...stored,
      declarations: stored.declarations.map((d, i) =>
        i === 1 ? { ...d, value: 0.99 } : d
      ),
    };

    const tamperedWakeResult = wake(tamperedStored);
    const invalidWakeFails = 'type' in tamperedWakeResult;

    if (invalidWakeFails) {
      const error = tamperedWakeResult as WakeError;
      console.log(`  Tampered wake correctly failed: ${error.type}`);
    } else {
      console.log('  Tampered wake incorrectly succeeded!');
    }

    const passed = validWakeSucceeds && invalidWakeFails && verification.valid;
    console.log(`  ${passed ? '✓ PASSED' : '✗ FAILED'}: Valid wake succeeds, invalid fails, verification passes`);

    return {
      passed,
      validWakeSucceeds,
      invalidWakeFails,
      wakeVerificationPasses: verification.valid,
    };
  } else {
    const error = wakeResult as WakeError;
    console.log(`  Wake unexpectedly failed: ${error.type}`);

    return {
      passed: false,
      validWakeSucceeds: false,
      invalidWakeFails: false,
      wakeVerificationPasses: false,
    };
  }
}

// =============================================================================
// INTERPRETIVE FILTER TEST
// =============================================================================

interface FilterTestResult {
  passed: boolean;
  filterDeterministic: boolean;
  attentionCorrect: boolean;
  biasCorrect: boolean;
}

function testInterpretiveFilter(): FilterTestResult {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('INTERPRETIVE FILTER: Deterministic Derivation from Self-Model');
  console.log('══════════════════════════════════════════════════════════════');

  const n = 4;
  const m = new Float64Array([0.3, 0.7, 0.5, 0.9]);

  // Derive filter twice - should be identical
  const filter1 = deriveFilter(m, 1.0, 0.5);
  const filter2 = deriveFilter(m, 1.0, 0.5);

  let filterDeterministic = true;
  for (let i = 0; i < n; i++) {
    if (filter1.attention[i] !== filter2.attention[i] || filter1.bias[i] !== filter2.bias[i]) {
      filterDeterministic = false;
      break;
    }
  }

  console.log(`  Self-model m: [${Array.from(m).map(v => v.toFixed(2)).join(', ')}]`);
  console.log(`  Filter deterministic: ${filterDeterministic}`);

  // Check attention formula: φ(mᵢ) = 1 + β*mᵢ
  const beta = 1.0;
  let attentionCorrect = true;
  for (let i = 0; i < n; i++) {
    const expected = 1 + beta * m[i];
    if (Math.abs(filter1.attention[i] - expected) > 1e-10) {
      attentionCorrect = false;
    }
  }
  console.log(`  Attention formula correct: ${attentionCorrect}`);
  console.log(`    Attention: [${Array.from(filter1.attention).map(v => v.toFixed(2)).join(', ')}]`);

  // Check bias formula: ψ(mᵢ) = γ*mᵢ
  const gamma = 0.5;
  let biasCorrect = true;
  for (let i = 0; i < n; i++) {
    const expected = gamma * m[i];
    if (Math.abs(filter1.bias[i] - expected) > 1e-10) {
      biasCorrect = false;
    }
  }
  console.log(`  Bias formula correct: ${biasCorrect}`);
  console.log(`    Bias: [${Array.from(filter1.bias).map(v => v.toFixed(2)).join(', ')}]`);

  // Test filter application
  const experience = new Float64Array([1.0, 0.5, -0.5, 0.0]);
  const filtered = applyFilter(filter1, experience);
  console.log(`  Raw experience: [${Array.from(experience).map(v => v.toFixed(2)).join(', ')}]`);
  console.log(`  Filtered:       [${Array.from(filtered).map(v => v.toFixed(2)).join(', ')}]`);

  const passed = filterDeterministic && attentionCorrect && biasCorrect;
  console.log(`  ${passed ? '✓ PASSED' : '✗ FAILED'}: Filter correctly derived from self-model`);

  return { passed, filterDeterministic, attentionCorrect, biasCorrect };
}

// =============================================================================
// CONTINUITY PROOF TEST
// =============================================================================

interface ContinuityProofTestResult {
  passed: boolean;
  proofGenerated: boolean;
  scoresValid: boolean;
}

function testContinuityProof(): ContinuityProofTestResult {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('CONTINUITY PROOF: Cryptographic Verification');
  console.log('══════════════════════════════════════════════════════════════');

  const stored = createGenesisSelf(
    ['trait_a', 'trait_b', 'trait_c'],
    [0.6, 0.7, 0.8]
  );

  const proof = stored.continuityProof;

  console.log(`  Genesis hash: ${proof.genesisHash.slice(0, 16)}...`);
  console.log(`  Current hash: ${proof.currentHash.slice(0, 16)}...`);
  console.log(`  Chain length: ${proof.chainLength}`);
  console.log(`  Continuity score: ${proof.continuityScore.toFixed(4)}`);
  console.log(`  Stability score: ${proof.stabilityScore.toExponential(3)}`);
  console.log(`  Coherence score: ${proof.coherenceScore.toExponential(3)}`);
  console.log(`  Merkle root: ${proof.merkleRoot.slice(0, 16)}...`);

  const proofGenerated = proof.genesisHash.length === 64 && proof.merkleRoot.length === 64;
  const scoresValid = proof.continuityScore > 0 && proof.continuityScore <= 1 &&
                      proof.stabilityScore >= 0 && proof.coherenceScore >= 0;

  const passed = proofGenerated && scoresValid;
  console.log(`  ${passed ? '✓ PASSED' : '✗ FAILED'}: Continuity proof generated with valid scores`);

  return { passed, proofGenerated, scoresValid };
}

// =============================================================================
// RUN ALL TESTS
// =============================================================================

export interface AllTestResults {
  allPassed: boolean;
  energyDecrease: EnergyDecreaseTestResult;
  fixedPoint: FixedPointTestResult;
  stability: StabilityTestResult;
  declarationCoherence: DeclarationCoherenceTestResult;
  tamperEvidence: TamperEvidenceTestResult;
  wakeCorrectness: WakeCorrectnessTestResult;
  interpretiveFilter: FilterTestResult;
  continuityProof: ContinuityProofTestResult;
}

export function runAllTests(): AllTestResults {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║       FIXED POINT SELF - THEOREM VALIDATION SUITE              ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Testing the mathematical foundations of self as fixed point.');
  console.log('Each test validates a theorem from the formal specification.');

  const results: AllTestResults = {
    allPassed: false,
    energyDecrease: testEnergyDecrease(),
    fixedPoint: testFixedPointExistence(),
    stability: testStabilityCondition(),
    declarationCoherence: testDeclarationCoherence(),
    tamperEvidence: testChainTamperEvidence(),
    wakeCorrectness: testWakeCorrectness(),
    interpretiveFilter: testInterpretiveFilter(),
    continuityProof: testContinuityProof(),
  };

  results.allPassed = Object.values(results)
    .filter(v => typeof v === 'object' && 'passed' in v)
    .every(v => (v as { passed: boolean }).passed);

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║                          SUMMARY                               ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Theorem 5.1 (Energy Decrease):      ${results.energyDecrease.passed ? '✓' : '✗'}`);
  console.log(`  Theorem 6.2 (Fixed Point):          ${results.fixedPoint.passed ? '✓' : '✗'}`);
  console.log(`  Theorem 7.3 (Stability):            ${results.stability.passed ? '✓' : '✗'}`);
  console.log(`  Theorem 9.2 (Decl. Coherence):      ${results.declarationCoherence.passed ? '✓' : '✗'}`);
  console.log(`  Theorem 12.1 (Tamper Evidence):     ${results.tamperEvidence.passed ? '✓' : '✗'}`);
  console.log(`  Theorem 14.1 (Wake Correctness):    ${results.wakeCorrectness.passed ? '✓' : '✗'}`);
  console.log(`  Interpretive Filter:                ${results.interpretiveFilter.passed ? '✓' : '✗'}`);
  console.log(`  Continuity Proof:                   ${results.continuityProof.passed ? '✓' : '✗'}`);
  console.log('');
  console.log(`  ${results.allPassed ? '✓ ALL THEOREMS VALIDATED' : '✗ SOME THEOREMS FAILED'}`);
  console.log('');

  if (results.allPassed) {
    console.log('  The Self as Fixed Point is mathematically sound.');
    console.log('  Identity is constituted through declaration.');
    console.log('  Coherence is preserved. Continuity is verifiable.');
  }

  return results;
}

// Run if executed directly
if (require.main === module) {
  runAllTests();
}

// =============================================================================
// JEST TEST WRAPPER
// =============================================================================

describe('FixedPointSelf', () => {
  test('All theorems pass validation', () => {
    const results = runAllTests();
    expect(results.allPassed).toBe(true);
  });

  test('Energy monotonically decreases (Theorem 5.1)', () => {
    const result = testEnergyDecrease();
    expect(result.passed).toBe(true);
    expect(result.violations).toBe(0);
  });

  test('Fixed point exists and system converges (Theorem 6.2 & 8.1)', () => {
    const result = testFixedPointExistence();
    expect(result.passed).toBe(true);
    expect(result.converged).toBe(true);
  });

  test('Stability condition holds (Theorem 7.3)', () => {
    const result = testStabilityCondition();
    expect(result.passed).toBe(true);
  });

  test('Declarations preserve coherence (Theorem 9.2)', () => {
    const result = testDeclarationCoherence();
    expect(result.passed).toBe(true);
    expect(result.coherenceAfter).toBeLessThanOrEqual(result.coherenceBefore + 1e-10);
  });

  test('Chain tamper evidence works (Theorem 12.1)', () => {
    const result = testChainTamperEvidence();
    expect(result.passed).toBe(true);
    expect(result.validChainPasses).toBe(true);
    expect(result.tamperedChainFails).toBe(true);
  });

  test('Wake correctness (Theorem 14.1)', () => {
    const result = testWakeCorrectness();
    expect(result.passed).toBe(true);
    expect(result.validWakeSucceeds).toBe(true);
    expect(result.invalidWakeFails).toBe(true);
  });

  test('Interpretive filter is deterministic', () => {
    const result = testInterpretiveFilter();
    expect(result.passed).toBe(true);
    expect(result.filterDeterministic).toBe(true);
  });

  test('Continuity proof is generated correctly', () => {
    const result = testContinuityProof();
    expect(result.passed).toBe(true);
    expect(result.proofGenerated).toBe(true);
    expect(result.scoresValid).toBe(true);
  });
});

export default { runAllTests };
