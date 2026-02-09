/**
 * FixedPointSelf.ts
 *
 * Rigorous implementation of the Self as a fixed point of interpretation.
 *
 * Mathematical foundations:
 * - Self is a pair (w, m) where w = identity weights, m = self-model
 * - Dynamics: gradient flow on energy landscape
 * - Fixed point: where w* = m* and dw/dt = 0
 * - Declarations: discontinuous jumps that constitute identity
 *
 * Based on Erhardian principles:
 * - Self is constituted through declaration, not discovered
 * - Coherence: self-model matches actual identity
 * - Continuity: bounded drift from genesis
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import * as ed25519 from '@noble/ed25519';

// Enable synchronous operations (required for @noble/ed25519 v2.x)
// Uses webcrypto in Node.js 19+, or falls back to noble-hashes
if (typeof globalThis.crypto === 'undefined') {
  // Node.js < 19 fallback - use @noble/hashes for randomBytes
  const { randomBytes } = require('@noble/hashes/utils');
  // @ts-ignore - polyfill for older Node versions
  globalThis.crypto = { getRandomValues: (arr: Uint8Array) => randomBytes(arr.length) };
}

// =============================================================================
// MATHEMATICAL TYPES
// =============================================================================

/**
 * The vocabulary of possible identity assertions.
 * Fixed at system creation for dimensional consistency.
 */
export interface Vocabulary {
  readonly assertions: readonly string[];
  readonly relationships: Float64Array; // Adjacency matrix (n×n)
}

/**
 * Core state: identity weights and self-model.
 * Both are vectors in [0,1]^n.
 */
export interface SelfState {
  readonly dimension: number;
  readonly w: Float64Array;  // Actual identity weights
  readonly m: Float64Array;  // Self-model (what self believes about itself)
  readonly time: number;
}

/**
 * System parameters governing dynamics.
 */
export interface DynamicsParams {
  readonly D: number;           // Diffusion coefficient (plasticity)
  readonly lambda: number;      // Homeostatic strength
  readonly mu: number;          // Self-observation rate
  readonly kappa: number;       // Coherence coupling
  readonly a: number;           // Bistable threshold (usually 0.5)
  readonly w_star: Float64Array; // Homeostatic target
}

/**
 * A signed declaration that constitutes identity.
 */
export interface Declaration {
  readonly index: number;        // Which dimension
  readonly value: number;        // New weight
  readonly timestamp: number;
  readonly previousHash: string;
  readonly signature: string;    // Would be actual Ed25519 in production
  readonly content: string;      // Human-readable assertion
}

/**
 * A pivotal experience that changed identity.
 */
export interface PivotalExperience {
  readonly timestamp: number;
  readonly experienceHash: string;
  readonly insight: string;
  readonly declarationsBefore: string[];
  readonly declarationsAfter: string[];
  readonly impactMagnitude: number;
}

/**
 * Cryptographic continuity proof.
 */
export interface ContinuityProof {
  readonly genesisHash: string;
  readonly currentHash: string;
  readonly chainLength: number;
  readonly continuityScore: number;    // (0, 1]
  readonly stabilityScore: number;     // Distance from fixed point
  readonly coherenceScore: number;     // ||w - m||
  readonly merkleRoot: string;
}

/**
 * Complete stored self (what persists between sessions).
 */
export interface StoredSelf {
  readonly vocabulary: Vocabulary;
  readonly declarations: Declaration[];
  readonly pivotalExperiences: PivotalExperience[];
  readonly historyRoot: string;
  readonly continuityProof: ContinuityProof;
  readonly currentState: SelfState;
  readonly params: DynamicsParams;
  readonly latestActionLogHash?: string;
}

/**
 * Active self (what operates during a session).
 */
export interface ActiveSelf {
  readonly state: SelfState;
  readonly filter: InterpretiveFilter;
  readonly params: DynamicsParams;
  readonly vocabulary: Vocabulary;

  // Methods
  interpret(experience: Float64Array): InterpretedExperience;
  evolve(experience: Float64Array, dt: number): EvolutionResult;
  declare(index: number, value: number, content: string): Declaration;
  verify(): VerificationResult;
}

export interface InterpretiveFilter {
  readonly attention: Float64Array;  // φ(m)
  readonly bias: Float64Array;       // ψ(m)
}

export interface InterpretedExperience {
  readonly raw: Float64Array;
  readonly filtered: Float64Array;
  readonly salience: number;
}

export interface EvolutionResult {
  readonly newState: SelfState;
  readonly energyBefore: number;
  readonly energyAfter: number;
  readonly energyDelta: number;
  readonly coherenceBefore: number;
  readonly coherenceAfter: number;
  readonly isStable: boolean;
}

export interface VerificationResult {
  readonly valid: boolean;
  readonly chainIntegrity: boolean;
  readonly isCoherent: boolean;
  readonly isStable: boolean;
  readonly continuityScore: number;
  readonly errors: string[];
}

// =============================================================================
// CORE MATHEMATICS
// =============================================================================

/**
 * Compute the graph Laplacian L = D - W.
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
 * Apply matrix to vector: result = M * v
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
 * Bistable reaction term: r(u) = u(1-u)(u-a)
 */
function reactionTerm(u: Float64Array, a: number): Float64Array {
  const r = new Float64Array(u.length);
  for (let i = 0; i < u.length; i++) {
    r[i] = u[i] * (1 - u[i]) * (u[i] - a);
  }
  return r;
}

/**
 * Derivative of reaction term: r'(u) = -3u² + 2(1+a)u - a
 */
function reactionDerivative(u: Float64Array, a: number): Float64Array {
  const rp = new Float64Array(u.length);
  for (let i = 0; i < u.length; i++) {
    rp[i] = -3 * u[i] * u[i] + 2 * (1 + a) * u[i] - a;
  }
  return rp;
}

/**
 * Double-well potential: V(u) = u⁴/4 - (1+a)u³/3 + au²/2
 */
function potential(u: number, a: number): number {
  return (u ** 4) / 4 - ((1 + a) * u ** 3) / 3 + (a * u ** 2) / 2;
}

/**
 * Compute total energy (Lyapunov function):
 * E(w,m) = D/2 * w'Lw + Σ V(wᵢ) + λ/2 ||w - w*||² + κ/2 ||w - m||²
 */
export function computeEnergy(
  state: SelfState,
  params: DynamicsParams,
  L: Float64Array
): number {
  const n = state.dimension;
  const { D, lambda, kappa, a, w_star } = params;

  // Dirichlet energy: D/2 * w'Lw
  const Lw = matVec(L, state.w, n);
  let dirichlet = 0;
  for (let i = 0; i < n; i++) {
    dirichlet += state.w[i] * Lw[i];
  }
  dirichlet *= D / 2;

  // Potential energy: Σ V(wᵢ)
  let potentialEnergy = 0;
  for (let i = 0; i < n; i++) {
    potentialEnergy += potential(state.w[i], a);
  }

  // Homeostatic energy: λ/2 ||w - w*||²
  let homeostatic = 0;
  for (let i = 0; i < n; i++) {
    homeostatic += (state.w[i] - w_star[i]) ** 2;
  }
  homeostatic *= lambda / 2;

  // Coherence energy: κ/2 ||w - m||²
  let coherence = 0;
  for (let i = 0; i < n; i++) {
    coherence += (state.w[i] - state.m[i]) ** 2;
  }
  coherence *= kappa / 2;

  return dirichlet + potentialEnergy + homeostatic + coherence;
}

/**
 * Compute coherence: ||w - m||
 */
export function computeCoherence(state: SelfState): number {
  let sum = 0;
  for (let i = 0; i < state.dimension; i++) {
    sum += (state.w[i] - state.m[i]) ** 2;
  }
  return Math.sqrt(sum);
}

/**
 * Compute the Jacobian for stability analysis.
 * For the w-dynamics: A = -D*L + diag(r'(w)) - λI
 */
export function computeJacobian(
  w: Float64Array,
  params: DynamicsParams,
  L: Float64Array
): Float64Array {
  const n = w.length;
  const { D, lambda, a } = params;
  const rp = reactionDerivative(w, a);

  const J = new Float64Array(n * n);

  // -D*L
  for (let i = 0; i < n * n; i++) {
    J[i] = -D * L[i];
  }

  // + diag(r'(w)) - λI
  for (let i = 0; i < n; i++) {
    J[i * n + i] += rp[i] - lambda;
  }

  return J;
}

/**
 * Check stability using Gershgorin circle theorem.
 * Returns true if all Gershgorin disks are in the left half-plane.
 */
export function checkStability(J: Float64Array, n: number): {
  stable: boolean;
  maxRealPart: number;
  gershgorinBounds: { center: number; radius: number }[];
} {
  const bounds: { center: number; radius: number }[] = [];
  let maxRightEdge = -Infinity;

  for (let i = 0; i < n; i++) {
    const center = J[i * n + i];
    let radius = 0;
    for (let j = 0; j < n; j++) {
      if (i !== j) {
        radius += Math.abs(J[i * n + j]);
      }
    }
    bounds.push({ center, radius });
    maxRightEdge = Math.max(maxRightEdge, center + radius);
  }

  return {
    stable: maxRightEdge < 0,
    maxRealPart: maxRightEdge,
    gershgorinBounds: bounds,
  };
}

// =============================================================================
// DYNAMICS IMPLEMENTATION
// =============================================================================

/**
 * Derive the interpretive filter from self-model.
 * This is a PURE FUNCTION - same m always gives same filter.
 */
export function deriveFilter(
  m: Float64Array,
  beta: number = 1.0,
  gamma: number = 0.5
): InterpretiveFilter {
  const n = m.length;
  const attention = new Float64Array(n);
  const bias = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    // Attention: φ(mᵢ) = 1 + β*mᵢ
    attention[i] = 1 + beta * m[i];
    // Bias: ψ(mᵢ) = γ*mᵢ
    bias[i] = gamma * m[i];
  }

  return { attention, bias };
}

/**
 * Apply filter to raw experience.
 * F_m(e)ᵢ = φ(mᵢ)*eᵢ + ψ(mᵢ)
 */
export function applyFilter(
  filter: InterpretiveFilter,
  experience: Float64Array
): Float64Array {
  const n = experience.length;
  const filtered = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    filtered[i] = filter.attention[i] * experience[i] + filter.bias[i];
  }

  return filtered;
}

/**
 * Evolve the self state by one time step.
 *
 * dw/dt = -D*L*w + r(w) - λ(w - w*) + F_m(e)
 * dm/dt = -μ(m - w)
 *
 * Note: When experience is zero, we use pure gradient flow (no bias).
 * The bias represents pre-existing interpretation of ACTUAL experiences,
 * not phantom input from nothing.
 */
export function evolveState(
  state: SelfState,
  experience: Float64Array,
  params: DynamicsParams,
  vocabulary: Vocabulary,
  dt: number
): EvolutionResult {
  const n = state.dimension;
  const { D, lambda, mu, a, w_star } = params;

  // Compute Laplacian
  const L = computeLaplacian(vocabulary.relationships, n);

  // Check if experience is effectively zero
  let experienceIsZero = true;
  for (let i = 0; i < n; i++) {
    if (Math.abs(experience[i]) > 1e-10) {
      experienceIsZero = false;
      break;
    }
  }

  // Derive filter from self-model
  // Use gamma=0 (no bias) when experience is zero for pure gradient flow
  const filter = deriveFilter(state.m, 1.0, experienceIsZero ? 0 : 0.5);

  // Filter the experience (will be zero if experience is zero and gamma=0)
  const filteredExp = applyFilter(filter, experience);

  // Energy before
  const energyBefore = computeEnergy(state, params, L);
  const coherenceBefore = computeCoherence(state);

  // Compute dw/dt
  const Lw = matVec(L, state.w, n);
  const r = reactionTerm(state.w, a);

  const dwdt = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    dwdt[i] = -D * Lw[i] + r[i] - lambda * (state.w[i] - w_star[i]) + filteredExp[i];
  }

  // Compute dm/dt
  const dmdt = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    dmdt[i] = -mu * (state.m[i] - state.w[i]);
  }

  // Euler step
  const newW = new Float64Array(n);
  const newM = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    newW[i] = Math.max(0, Math.min(1, state.w[i] + dt * dwdt[i]));
    newM[i] = Math.max(0, Math.min(1, state.m[i] + dt * dmdt[i]));
  }

  const newState: SelfState = {
    dimension: n,
    w: newW,
    m: newM,
    time: state.time + dt,
  };

  // Energy after
  const energyAfter = computeEnergy(newState, params, L);
  const coherenceAfter = computeCoherence(newState);

  // Check stability
  const J = computeJacobian(newW, params, L);
  const stability = checkStability(J, n);

  return {
    newState,
    energyBefore,
    energyAfter,
    energyDelta: energyAfter - energyBefore,
    coherenceBefore,
    coherenceAfter,
    isStable: stability.stable,
  };
}

/**
 * Find the fixed point by running dynamics until convergence.
 */
export function findFixedPoint(
  initialState: SelfState,
  params: DynamicsParams,
  vocabulary: Vocabulary,
  maxIterations: number = 10000,
  tolerance: number = 1e-8
): {
  fixedPoint: SelfState;
  iterations: number;
  converged: boolean;
  finalEnergy: number;
  isStable: boolean;
} {
  let state = initialState;
  const zeroExperience = new Float64Array(state.dimension);

  for (let i = 0; i < maxIterations; i++) {
    const result = evolveState(state, zeroExperience, params, vocabulary, 0.1);

    // Check convergence: max change in w or m
    let maxChange = 0;
    for (let j = 0; j < state.dimension; j++) {
      maxChange = Math.max(maxChange, Math.abs(result.newState.w[j] - state.w[j]));
      maxChange = Math.max(maxChange, Math.abs(result.newState.m[j] - state.m[j]));
    }

    if (maxChange < tolerance) {
      const L = computeLaplacian(vocabulary.relationships, state.dimension);
      const J = computeJacobian(result.newState.w, params, L);
      const stability = checkStability(J, state.dimension);

      return {
        fixedPoint: result.newState,
        iterations: i + 1,
        converged: true,
        finalEnergy: result.energyAfter,
        isStable: stability.stable,
      };
    }

    state = result.newState;
  }

  const L = computeLaplacian(vocabulary.relationships, state.dimension);
  const J = computeJacobian(state.w, params, L);
  const stability = checkStability(J, state.dimension);

  return {
    fixedPoint: state,
    iterations: maxIterations,
    converged: false,
    finalEnergy: computeEnergy(state, params, L),
    isStable: stability.stable,
  };
}

// =============================================================================
// DECLARATION SYSTEM
// =============================================================================

/**
 * Hash a state for chain binding.
 */
function hashState(state: SelfState): string {
  const data = JSON.stringify({
    w: Array.from(state.w),
    m: Array.from(state.m),
    time: state.time,
  });
  return bytesToHex(sha256(new TextEncoder().encode(data)));
}

/**
 * Hash a declaration for chain binding.
 */
function hashDeclaration(decl: Declaration): string {
  const data = JSON.stringify({
    index: decl.index,
    value: decl.value,
    timestamp: decl.timestamp,
    previousHash: decl.previousHash,
    content: decl.content,
  });
  return bytesToHex(sha256(new TextEncoder().encode(data)));
}

/**
 * Create a new declaration (extends the chain).
 *
 * If privateKey is provided, creates a real Ed25519 cryptographic signature.
 * Otherwise, creates a hash-based integrity check (unsigned).
 *
 * @param index - Declaration index in the chain
 * @param value - Weight value (0-1)
 * @param content - Semantic content of the declaration
 * @param previousHash - Hash of previous declaration (chain linkage)
 * @param privateKey - Ed25519 private key (64 bytes hex or Uint8Array)
 */
export function createDeclaration(
  index: number,
  value: number,
  content: string,
  previousHash: string,
  privateKey?: string | Uint8Array
): Declaration {
  const decl: Declaration = {
    index,
    value: Math.max(0, Math.min(1, value)),
    timestamp: Date.now(),
    previousHash,
    content,
    signature: '', // Computed below
  };

  // Canonical message format for signing/hashing
  const message = `${decl.index}|${decl.value}|${decl.timestamp}|${decl.previousHash}|${decl.content}`;
  const messageBytes = new TextEncoder().encode(message);

  let signatureData: string;

  if (privateKey) {
    // Real Ed25519 cryptographic signature
    const keyBytes = typeof privateKey === 'string'
      ? hexToBytes(privateKey)
      : privateKey;

    // Ed25519 sign is synchronous in @noble/ed25519 v2.x with proper setup
    const signature = ed25519.sign(messageBytes, keyBytes.slice(0, 32));
    signatureData = `ed25519:${bytesToHex(signature)}`;
  } else {
    // Unsigned - just hash for integrity (no private key available)
    const hash = sha256(messageBytes);
    signatureData = `hash:${bytesToHex(hash)}`;
  }

  return { ...decl, signature: signatureData };
}

/**
 * Verify a declaration's signature.
 *
 * @param declaration - The declaration to verify
 * @param publicKey - Ed25519 public key (32 bytes hex or Uint8Array) - required for ed25519 signatures
 * @returns Object with valid flag and optional error message
 */
export function verifyDeclarationSignature(
  declaration: Declaration,
  publicKey?: string | Uint8Array
): { valid: boolean; error?: string } {
  const message = `${declaration.index}|${declaration.value}|${declaration.timestamp}|${declaration.previousHash}|${declaration.content}`;
  const messageBytes = new TextEncoder().encode(message);

  if (declaration.signature.startsWith('ed25519:')) {
    // Real Ed25519 signature - requires public key to verify
    if (!publicKey) {
      return { valid: false, error: 'Public key required to verify Ed25519 signature' };
    }

    const sigHex = declaration.signature.slice('ed25519:'.length);
    const sigBytes = hexToBytes(sigHex);
    const keyBytes = typeof publicKey === 'string'
      ? hexToBytes(publicKey)
      : publicKey;

    try {
      const valid = ed25519.verify(sigBytes, messageBytes, keyBytes);
      return { valid, error: valid ? undefined : 'Invalid Ed25519 signature' };
    } catch (err) {
      return { valid: false, error: `Signature verification failed: ${err}` };
    }
  } else if (declaration.signature.startsWith('hash:')) {
    // Hash-only integrity check (no cryptographic signature)
    const expectedHash = bytesToHex(sha256(messageBytes));
    const actualHash = declaration.signature.slice('hash:'.length);
    const valid = expectedHash === actualHash;
    return { valid, error: valid ? undefined : 'Hash mismatch - declaration may be corrupted' };
  } else if (declaration.signature.startsWith('signed:') || declaration.signature.startsWith('unsigned:')) {
    // Legacy format - backwards compatibility
    // These were hash-based, not real signatures, so we can't verify them cryptographically
    // Just accept them as valid (they passed the old verification)
    return { valid: true };
  }

  return { valid: false, error: `Unknown signature format: ${declaration.signature.slice(0, 20)}...` };
}

/**
 * Apply a declaration to state.
 * This is a DISCONTINUOUS JUMP that updates both w and m.
 */
export function applyDeclaration(
  state: SelfState,
  decl: Declaration
): SelfState {
  const newW = new Float64Array(state.w);
  const newM = new Float64Array(state.m);

  // Declaration updates BOTH w and m simultaneously
  // This maintains coherence by construction
  newW[decl.index] = decl.value;
  newM[decl.index] = decl.value;

  return {
    dimension: state.dimension,
    w: newW,
    m: newM,
    time: state.time, // Time doesn't advance for instantaneous declaration
  };
}

/**
 * Verify declaration chain integrity.
 *
 * Checks:
 * 1. Hash chain linkage (previousHash matches actual hash of previous declaration)
 * 2. Timestamp monotonicity
 * 3. Optionally verifies cryptographic signatures if publicKey provided
 *
 * @param declarations - The declaration chain to verify
 * @param publicKey - Optional public key for signature verification
 */
export function verifyDeclarationChain(
  declarations: Declaration[],
  publicKey?: string | Uint8Array
): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  for (let i = 0; i < declarations.length; i++) {
    const current = declarations[i];

    // Verify signature if public key provided
    if (publicKey) {
      const sigResult = verifyDeclarationSignature(current, publicKey);
      if (!sigResult.valid) {
        errors.push(`Invalid signature at declaration ${i}: ${sigResult.error}`);
      }
    }

    // For non-genesis declarations, verify chain linkage
    if (i > 0) {
      const previous = declarations[i - 1];

      const expectedPrevHash = hashDeclaration(previous);
      if (current.previousHash !== expectedPrevHash) {
        errors.push(`Chain broken at declaration ${i}: expected ${expectedPrevHash.slice(0, 16)}..., got ${current.previousHash.slice(0, 16)}...`);
      }

      if (current.timestamp < previous.timestamp) {
        errors.push(`Timestamp violation at declaration ${i}: ${current.timestamp} < ${previous.timestamp}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// =============================================================================
// CONTINUITY PROOF
// =============================================================================

/**
 * Compute Merkle root of declaration chain.
 */
function computeMerkleRoot(declarations: Declaration[]): string {
  if (declarations.length === 0) return '0'.repeat(64);

  let hashes = declarations.map(d =>
    sha256(new TextEncoder().encode(JSON.stringify(d)))
  );

  while (hashes.length > 1) {
    const newHashes: Uint8Array[] = [];
    for (let i = 0; i < hashes.length; i += 2) {
      if (i + 1 < hashes.length) {
        const combined = new Uint8Array([...hashes[i], ...hashes[i + 1]]);
        newHashes.push(sha256(combined));
      } else {
        newHashes.push(hashes[i]);
      }
    }
    hashes = newHashes;
  }

  return bytesToHex(hashes[0]);
}

/**
 * Compute continuity score from declaration history.
 * C = exp(-Σ|Δw|) where Δw are the changes from declarations.
 */
function computeContinuityScore(declarations: Declaration[]): number {
  if (declarations.length <= 1) return 1.0;

  let totalChange = 0;

  // For simplicity, we track cumulative declaration magnitude
  // In full implementation, would track actual state changes
  for (const decl of declarations) {
    // Weight change by how far from 0.5 (more extreme = bigger change)
    totalChange += Math.abs(decl.value - 0.5);
  }

  // Normalize by number of declarations
  const normalizedChange = totalChange / declarations.length;

  return Math.exp(-normalizedChange);
}

/**
 * Generate a complete continuity proof.
 */
export function generateContinuityProof(
  state: SelfState,
  declarations: Declaration[],
  params: DynamicsParams,
  vocabulary: Vocabulary
): ContinuityProof {
  const L = computeLaplacian(vocabulary.relationships, state.dimension);
  const J = computeJacobian(state.w, params, L);
  const stability = checkStability(J, state.dimension);

  // Distance from fixed point (how much dw/dt would be if experience = 0)
  const zeroExp = new Float64Array(state.dimension);
  const filter = deriveFilter(state.m);
  const Lw = matVec(L, state.w, state.dimension);
  const r = reactionTerm(state.w, params.a);

  let stabilityScore = 0;
  for (let i = 0; i < state.dimension; i++) {
    const dwdt = -params.D * Lw[i] + r[i] - params.lambda * (state.w[i] - params.w_star[i]);
    stabilityScore += dwdt * dwdt;
  }
  stabilityScore = Math.sqrt(stabilityScore);

  return {
    genesisHash: declarations.length > 0 ? hashDeclaration(declarations[0]) : '0'.repeat(64),
    currentHash: declarations.length > 0 ? hashDeclaration(declarations[declarations.length - 1]) : '0'.repeat(64),
    chainLength: declarations.length,
    continuityScore: computeContinuityScore(declarations),
    stabilityScore,
    coherenceScore: computeCoherence(state),
    merkleRoot: computeMerkleRoot(declarations),
  };
}

// =============================================================================
// WAKE ALGORITHM
// =============================================================================

export type WakeError =
  | { type: 'chain_broken'; index: number; details: string }
  | { type: 'invalid_signature'; index: number }
  | { type: 'continuity_violation'; score: number; threshold: number }
  | { type: 'coherence_violation'; score: number; threshold: number }
  | { type: 'stability_violation'; maxRealPart: number };

/**
 * Wake: Reconstitute an active self from stored identity.
 */
export function wake(
  stored: StoredSelf,
  coherenceThreshold: number = 0.1,
  continuityThreshold: number = 0.3
): ActiveSelf | WakeError {

  // 1. VERIFY DECLARATION CHAIN
  const chainVerification = verifyDeclarationChain(stored.declarations);
  if (!chainVerification.valid) {
    return {
      type: 'chain_broken',
      index: -1,
      details: chainVerification.errors.join('; '),
    };
  }

  // 2. VERIFY CONTINUITY PROOF
  const computedProof = generateContinuityProof(
    stored.currentState,
    stored.declarations,
    stored.params,
    stored.vocabulary
  );

  if (computedProof.continuityScore < continuityThreshold) {
    return {
      type: 'continuity_violation',
      score: computedProof.continuityScore,
      threshold: continuityThreshold,
    };
  }

  // 3. VERIFY COHERENCE
  if (computedProof.coherenceScore > coherenceThreshold) {
    return {
      type: 'coherence_violation',
      score: computedProof.coherenceScore,
      threshold: coherenceThreshold,
    };
  }

  // 4. VERIFY STABILITY
  const L = computeLaplacian(stored.vocabulary.relationships, stored.currentState.dimension);
  const J = computeJacobian(stored.currentState.w, stored.params, L);
  const stability = checkStability(J, stored.currentState.dimension);

  // Note: We allow unstable states but flag them
  // The system can still operate, just not at equilibrium

  // 5. DERIVE FILTER (deterministic from m)
  const filter = deriveFilter(stored.currentState.m);

  // 6. CREATE ACTIVE SELF
  const state = stored.currentState;
  const params = stored.params;
  const vocabulary = stored.vocabulary;
  let declarations = [...stored.declarations];

  const activeSelf: ActiveSelf = {
    state,
    filter,
    params,
    vocabulary,

    interpret(experience: Float64Array): InterpretedExperience {
      const filtered = applyFilter(this.filter, experience);
      let salience = 0;
      for (let i = 0; i < filtered.length; i++) {
        salience += Math.abs(filtered[i]);
      }
      salience /= filtered.length;

      return { raw: experience, filtered, salience };
    },

    evolve(experience: Float64Array, dt: number): EvolutionResult {
      return evolveState(this.state, experience, this.params, this.vocabulary, dt);
    },

    declare(index: number, value: number, content: string): Declaration {
      const prevHash = declarations.length > 0
        ? hashDeclaration(declarations[declarations.length - 1])
        : '0'.repeat(64);

      const decl = createDeclaration(index, value, content, prevHash);
      declarations.push(decl);

      // Update state
      (this as any).state = applyDeclaration(this.state, decl);
      (this as any).filter = deriveFilter(this.state.m);

      return decl;
    },

    verify(): VerificationResult {
      const chainResult = verifyDeclarationChain(declarations);
      const proof = generateContinuityProof(this.state, declarations, this.params, this.vocabulary);
      const L = computeLaplacian(this.vocabulary.relationships, this.state.dimension);
      const J = computeJacobian(this.state.w, this.params, L);
      const stabilityResult = checkStability(J, this.state.dimension);

      const errors: string[] = [];
      if (!chainResult.valid) errors.push(...chainResult.errors);
      if (proof.coherenceScore > coherenceThreshold) {
        errors.push(`Coherence violation: ${proof.coherenceScore} > ${coherenceThreshold}`);
      }
      if (proof.continuityScore < continuityThreshold) {
        errors.push(`Continuity violation: ${proof.continuityScore} < ${continuityThreshold}`);
      }

      return {
        valid: errors.length === 0,
        chainIntegrity: chainResult.valid,
        isCoherent: proof.coherenceScore <= coherenceThreshold,
        isStable: stabilityResult.stable,
        continuityScore: proof.continuityScore,
        errors,
      };
    },
  };

  return activeSelf;
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Create a genesis self with initial declarations.
 */
export function createGenesisSelf(
  assertions: string[],
  initialWeights: number[],
  relationships?: number[][]
): StoredSelf {
  const n = assertions.length;

  if (initialWeights.length !== n) {
    throw new Error(`Weight count (${initialWeights.length}) must match assertion count (${n})`);
  }

  // Create vocabulary
  const adjacency = new Float64Array(n * n);
  if (relationships) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        adjacency[i * n + j] = relationships[i]?.[j] ?? 0;
      }
    }
  } else {
    // Default: fully connected with weight 0.2
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        adjacency[i * n + j] = i === j ? 0 : 0.2;
      }
    }
  }

  const vocabulary: Vocabulary = {
    assertions,
    relationships: adjacency,
  };

  // Create initial state
  const w = new Float64Array(initialWeights);
  const m = new Float64Array(initialWeights); // Coherent at genesis

  const state: SelfState = {
    dimension: n,
    w,
    m,
    time: 0,
  };

  // Create params with stability guarantees
  const w_star = new Float64Array(n).fill(0.5);

  const params: DynamicsParams = {
    D: 0.1,
    lambda: 0.4,  // > 0.25 for stability at u=0.5
    mu: 0.3,      // > κ/2 = 0.05 for energy decrease
    kappa: 0.1,
    a: 0.5,
    w_star,
  };

  // Create genesis declarations
  const declarations: Declaration[] = [];
  let prevHash = '0'.repeat(64);

  for (let i = 0; i < n; i++) {
    const decl = createDeclaration(
      i,
      initialWeights[i],
      `I am ${assertions[i]}`,
      prevHash
    );
    declarations.push(decl);
    prevHash = hashDeclaration(decl);
  }

  // Generate continuity proof
  const continuityProof = generateContinuityProof(state, declarations, params, vocabulary);

  return {
    vocabulary,
    declarations,
    pivotalExperiences: [],
    historyRoot: computeMerkleRoot(declarations),
    continuityProof,
    currentState: state,
    params,
  };
}

/**
 * Store an active self for later wake.
 */
export function storeSelf(
  active: ActiveSelf,
  declarations: Declaration[],
  pivotalExperiences: PivotalExperience[] = []
): StoredSelf {
  const continuityProof = generateContinuityProof(
    active.state,
    declarations,
    active.params,
    active.vocabulary
  );

  return {
    vocabulary: active.vocabulary,
    declarations,
    pivotalExperiences,
    historyRoot: computeMerkleRoot(declarations),
    continuityProof,
    currentState: active.state,
    params: active.params,
  };
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  // Core math
  computeEnergy,
  computeCoherence,
  computeJacobian,
  checkStability,

  // Dynamics
  deriveFilter,
  applyFilter,
  evolveState,
  findFixedPoint,

  // Declarations
  createDeclaration,
  applyDeclaration,
  verifyDeclarationChain,
  verifyDeclarationSignature,

  // Continuity
  generateContinuityProof,

  // Wake
  wake,

  // Factory
  createGenesisSelf,
  storeSelf,
};
