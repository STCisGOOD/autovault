/**
 * EnergyGradient.ts
 *
 * Computes analytical ∂E/∂w[i] from the Lyapunov energy function.
 *
 * The energy landscape is:
 *   E(w,m) = D/2·w'Lw + ΣV(wᵢ) + λ/2·‖w-w*‖² + κ/2·‖w-m‖²
 *
 * Its gradient decomposes into four interpretable components:
 *   ∂E/∂w[i] = D·(L·w)[i]           — diffusion (inter-dimension coupling)
 *            + V'(w[i])               — potential (bistable landscape)
 *            + λ·(w[i] - w*[i])       — homeostatic (equilibrium pull)
 *            + κ·(w[i] - m[i])        — coherence (self-awareness gap)
 *
 * This module packages gradient computation as a reusable operation
 * for the ARIL optimizer, extracting math that already exists in
 * FixedPointSelf.ts into a clean API.
 */

import {
  type SelfState,
  type DynamicsParams,
  type Vocabulary,
  computeEnergy,
  computeJacobian,
  checkStability,
} from './FixedPointSelf';
import { safeFinite, sanitizeFloat64Array } from './math';

// =============================================================================
// TYPES
// =============================================================================

export interface EnergyGradientResult {
  /** ∂E/∂w[i] per dimension */
  gradients: Float64Array;
  /** Current E(w,m) */
  energy: number;
  /** Decomposed gradient components */
  components: {
    /** D·(L·w)[i] — inter-dimension coupling */
    diffusion: Float64Array;
    /** V'(w[i]) — bistable landscape gradient */
    potential: Float64Array;
    /** λ·(w[i]-w*[i]) — equilibrium pull */
    homeostatic: Float64Array;
    /** κ·(w[i]-m[i]) — self-awareness gap */
    coherence: Float64Array;
  };
  /** ∂²E/∂w[i]² for second-order adaptive step sizes */
  hessianDiag: Float64Array;
  /** All Gershgorin disks in left half-plane */
  stability: boolean;
}

// =============================================================================
// INTERNAL MATH
// =============================================================================

/**
 * Compute graph Laplacian L = D_deg - W from adjacency matrix.
 */
function computeLaplacian(adjacency: Float64Array, n: number): Float64Array {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    let degree = 0;
    for (let j = 0; j < n; j++) {
      const w = adjacency[i * n + j];
      degree += w;
      L[i * n + j] = -w;
    }
    L[i * n + i] = degree;
  }
  return L;
}

/**
 * Matrix-vector multiply: result = M * v.
 */
function matVec(M: Float64Array, v: Float64Array, n: number): Float64Array {
  const result = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      sum += M[i * n + j] * v[j];
    }
    result[i] = sum;
  }
  return result;
}

/**
 * Derivative of double-well potential:
 *   V(u) = u⁴/4 - (1+a)u³/3 + au²/2
 *   V'(u) = u³ - (1+a)u² + au
 */
function potentialDerivative(u: number, a: number): number {
  return u * u * u - (1 + a) * u * u + a * u;
}

/**
 * Second derivative of double-well potential:
 *   V''(u) = 3u² - 2(1+a)u + a
 */
function potentialSecondDerivative(u: number, a: number): number {
  return 3 * u * u - 2 * (1 + a) * u + a;
}

// =============================================================================
// MAIN API
// =============================================================================

/**
 * Compute the full energy gradient with decomposed components.
 *
 * This is the "adjoint" part of ARIL — computing ∂E/∂w analytically
 * rather than through numerical finite differences.
 */
export function computeEnergyGradient(
  state: SelfState,
  params: DynamicsParams,
  vocabulary: Vocabulary
): EnergyGradientResult {
  const n = state.dimension;
  const { D, lambda, kappa, a, w_star } = params;

  // Compute Laplacian
  const L = computeLaplacian(vocabulary.relationships, n);

  // L·w for diffusion term
  const Lw = matVec(L, state.w, n);

  // Allocate component arrays
  const diffusion = new Float64Array(n);
  const potential = new Float64Array(n);
  const homeostatic = new Float64Array(n);
  const coherence = new Float64Array(n);
  const gradients = new Float64Array(n);
  const hessianDiag = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    // Four gradient components
    diffusion[i] = D * Lw[i];
    potential[i] = potentialDerivative(state.w[i], a);
    homeostatic[i] = lambda * (state.w[i] - w_star[i]);
    coherence[i] = kappa * (state.w[i] - state.m[i]);

    // Total gradient
    gradients[i] = diffusion[i] + potential[i] + homeostatic[i] + coherence[i];

    // Hessian diagonal: ∂²E/∂w[i]²
    // = D·L[i,i] + V''(w[i]) + λ + κ
    hessianDiag[i] = D * L[i * n + i]
      + potentialSecondDerivative(state.w[i], a)
      + lambda
      + kappa;
  }

  // Compute energy
  const energy = computeEnergy(state, params, L);

  // Check stability via Jacobian
  const J = computeJacobian(state.w, params, L);
  const stabilityResult = checkStability(J, n);

  return {
    gradients: sanitizeFloat64Array(gradients),
    energy: safeFinite(energy, 0),
    components: {
      diffusion: sanitizeFloat64Array(diffusion),
      potential: sanitizeFloat64Array(potential),
      homeostatic: sanitizeFloat64Array(homeostatic),
      coherence: sanitizeFloat64Array(coherence),
    },
    hessianDiag: sanitizeFloat64Array(hessianDiag),
    stability: stabilityResult.stable,
  };
}

/**
 * Compute only the energy value (lightweight, no gradient).
 */
export function computeEnergyOnly(
  state: SelfState,
  params: DynamicsParams,
  vocabulary: Vocabulary
): number {
  const L = computeLaplacian(vocabulary.relationships, state.dimension);
  return computeEnergy(state, params, L);
}

/**
 * Verify gradient correctness via numerical finite differences.
 * Used for testing — compares analytical gradient to numerical approximation.
 *
 * @returns Max absolute difference between analytical and numerical gradients
 */
export function verifyGradient(
  state: SelfState,
  params: DynamicsParams,
  vocabulary: Vocabulary,
  epsilon: number = 1e-7
): { maxError: number; errors: Float64Array } {
  const analytical = computeEnergyGradient(state, params, vocabulary);
  const n = state.dimension;
  const L = computeLaplacian(vocabulary.relationships, n);
  const errors = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    // Perturb w[i] forward
    const wPlus = new Float64Array(state.w);
    wPlus[i] += epsilon;
    const statePlus: SelfState = { ...state, w: wPlus };
    const ePlus = computeEnergy(statePlus, params, L);

    // Perturb w[i] backward
    const wMinus = new Float64Array(state.w);
    wMinus[i] -= epsilon;
    const stateMinus: SelfState = { ...state, w: wMinus };
    const eMinus = computeEnergy(stateMinus, params, L);

    // Central difference
    const numerical = (ePlus - eMinus) / (2 * epsilon);
    errors[i] = Math.abs(analytical.gradients[i] - numerical);
  }

  let maxError = 0;
  for (let i = 0; i < n; i++) {
    maxError = Math.max(maxError, errors[i]);
  }

  return { maxError, errors };
}
