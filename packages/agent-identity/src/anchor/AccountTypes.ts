/**
 * AccountTypes.ts
 *
 * TypeScript type definitions that map to the Anchor program's on-chain account structures.
 * These types are used for serialization/deserialization and provide type safety
 * when interacting with the Anchor program.
 *
 * Note: On-chain storage uses compact representations:
 * - Strings are stored as fixed-size byte arrays
 * - Floats are stored as scaled u64 (weight * 10000)
 * - Semantic data (descriptions, signals) is NOT stored on-chain
 */

import { PublicKey } from '@solana/web3.js';

// =============================================================================
// CONSTANTS (must match lib.rs)
// =============================================================================

/** Maximum number of identity dimensions supported on-chain */
export const MAX_DIMENSIONS = 16;

/** Maximum length of dimension name in bytes */
export const MAX_DIMENSION_NAME_LEN = 16;

/** Maximum number of declarations stored on-chain */
export const MAX_STORED_DECLARATIONS = 4;

/** Maximum number of pivotal experience hashes */
export const MAX_PIVOTAL_EXPERIENCES = 4;

/** Weight scaling factor (0.5 = 5000, 1.0 = 10000) */
export const WEIGHT_SCALE = 10000;

// =============================================================================
// ON-CHAIN ACCOUNT TYPES
// =============================================================================

/**
 * On-chain AgentIdentity account structure.
 * Maps directly to the Rust AgentIdentity struct.
 */
export interface OnChainAgentIdentity {
  /** Authority (agent's keypair) - can update this identity */
  authority: PublicKey;

  /** PDA bump seed */
  bump: number;

  /** Number of dimensions in vocabulary (1-16) */
  dimensionCount: number;

  /** Hash of the vocabulary definition (for verification) */
  vocabularyHash: Uint8Array; // [u8; 32]

  /** Dimension names (fixed size, null-padded) */
  dimensionNames: string[]; // [MAX_DIMENSION_NAME_LEN; MAX_DIMENSIONS]

  /** Identity weights (w) - scaled by WEIGHT_SCALE */
  weights: bigint[]; // [u64; MAX_DIMENSIONS]

  /** Self-model (m) - what agent believes about itself */
  selfModel: bigint[]; // [u64; MAX_DIMENSIONS]

  /** Logical time (evolution steps) */
  time: bigint;

  /** Number of declarations made */
  declarationCount: number;

  /** Recent declarations (circular buffer) */
  declarations: OnChainDeclaration[];

  /** Hash of genesis declaration */
  genesisHash: Uint8Array; // [u8; 32]

  /** Hash of most recent declaration */
  currentHash: Uint8Array; // [u8; 32]

  /** Merkle root of declaration chain */
  merkleRoot: Uint8Array; // [u8; 32]

  /** Number of pivotal experiences recorded */
  pivotalCount: number;

  /** Pivotal experience hashes */
  pivotalHashes: Uint8Array[]; // [[u8; 32]; MAX_PIVOTAL_EXPERIENCES]

  /** Pivotal experience impact magnitudes */
  pivotalImpacts: bigint[]; // [u64; MAX_PIVOTAL_EXPERIENCES]

  /** Pivotal experience timestamps */
  pivotalTimestamps: bigint[]; // [i64; MAX_PIVOTAL_EXPERIENCES]

  /** Continuity score (scaled by WEIGHT_SCALE) */
  continuityScore: bigint;

  /** Coherence score (scaled, 0 = perfect) */
  coherenceScore: bigint;

  /** Stability score (scaled by WEIGHT_SCALE) */
  stabilityScore: bigint;

  /** Unix timestamp of account creation */
  createdAt: bigint;

  /** Unix timestamp of last update */
  updatedAt: bigint;

  /** Rate limiting: last slot a declaration was made */
  lastDeclarationSlot: bigint;
}

/**
 * On-chain Declaration structure.
 * Maps directly to the Rust Declaration struct.
 * Note: Full content stored off-chain; only hash stored on-chain.
 */
export interface OnChainDeclaration {
  /** Which dimension this declaration updates */
  index: number;

  /** New weight value (scaled by WEIGHT_SCALE) */
  value: bigint;

  /** Unix timestamp */
  timestamp: bigint;

  /** Hash of previous declaration */
  previousHash: Uint8Array; // [u8; 32]

  /** Ed25519 signature (for off-chain verification) */
  signature: Uint8Array; // [u8; 64]

  /** Hash of the full content (content stored off-chain) */
  contentHash: Uint8Array; // [u8; 32]
}

/**
 * Verification result from the verify instruction.
 */
export interface OnChainVerificationResult {
  isValid: boolean;
  /**
   * Error code if not valid:
   * 0 = no error
   * 1 = PDA mismatch
   * 2 = weight out of range
   * 3 = chain broken
   * 4 = current hash mismatch
   * 5 = coherence mismatch
   */
  errorCode: number;
  chainLength: number;
  continuityScore: bigint;
  coherenceScore: bigint;
  stabilityScore: bigint;
  genesisHash: Uint8Array;
  currentHash: Uint8Array;
  merkleRoot: Uint8Array;
}

// =============================================================================
// INSTRUCTION ARGUMENT TYPES
// =============================================================================

/**
 * Arguments for the initialize instruction.
 */
export interface InitializeArgs {
  /** Names of each dimension (max 32 chars each) */
  dimensionNames: string[];

  /** Initial weight values (scaled by WEIGHT_SCALE) */
  initialWeights: bigint[];

  /** Hash of the full vocabulary definition */
  vocabularyHash: Uint8Array;
}

/**
 * Arguments for the declare instruction.
 */
export interface DeclareArgs {
  /** Index of dimension to update (0-based) */
  dimensionIndex: number;

  /** New weight value (scaled by WEIGHT_SCALE) */
  newValue: bigint;

  /** Human-readable declaration content */
  content: string;

  /** Ed25519 signature of the declaration */
  signature: Uint8Array;
}

/**
 * Arguments for the evolve instruction.
 */
export interface EvolveArgs {
  /** Experience signal for each dimension (signed, scaled) */
  experienceSignal: bigint[];

  /** Time step for evolution (scaled by WEIGHT_SCALE) */
  timeStep: bigint;
}

/**
 * Arguments for the record_pivotal instruction.
 */
export interface RecordPivotalArgs {
  /** Hash of the pivotal experience */
  experienceHash: Uint8Array;

  /** Impact magnitude (scaled by WEIGHT_SCALE) */
  impactMagnitude: bigint;
}

// =============================================================================
// CONVERSION UTILITIES
// =============================================================================

/**
 * Convert a float weight (0-1) to on-chain scaled bigint.
 */
export function toOnChainWeight(weight: number): bigint {
  return BigInt(Math.round(weight * WEIGHT_SCALE));
}

/**
 * Convert an on-chain scaled bigint to float weight (0-1).
 */
export function fromOnChainWeight(scaled: bigint): number {
  return Number(scaled) / WEIGHT_SCALE;
}

/**
 * Convert a string to fixed-size bytes (null-padded).
 */
export function toFixedBytes(str: string, maxLen: number): Uint8Array {
  const bytes = new TextEncoder().encode(str.slice(0, maxLen));
  const result = new Uint8Array(maxLen);
  result.set(bytes);
  return result;
}

/**
 * Convert fixed-size bytes to string (trimming nulls).
 */
export function fromFixedBytes(bytes: Uint8Array): string {
  const nullIdx = bytes.indexOf(0);
  const trimmed = nullIdx === -1 ? bytes : bytes.slice(0, nullIdx);
  return new TextDecoder().decode(trimmed);
}

/**
 * Compute account size for AgentIdentity.
 * Must match Rust AgentIdentity::INIT_SPACE.
 */
export function computeAccountSize(): number {
  // Declaration: index(1) + value(8) + timestamp(8) + previous_hash(32) + signature(64) + content_hash(32) = 145
  const DECL_SIZE = 1 + 8 + 8 + 32 + 64 + 32;

  return (
    8 +                                        // Discriminator
    32 +                                       // authority
    1 +                                        // bump
    1 +                                        // dimension_count
    32 +                                       // vocabulary_hash
    (MAX_DIMENSION_NAME_LEN * MAX_DIMENSIONS) + // dimension_names
    (8 * MAX_DIMENSIONS) +                     // weights
    (8 * MAX_DIMENSIONS) +                     // self_model
    8 +                                        // time
    4 +                                        // declaration_count
    (DECL_SIZE * MAX_STORED_DECLARATIONS) +    // declarations
    32 +                                       // genesis_hash
    32 +                                       // current_hash
    32 +                                       // merkle_root
    2 +                                        // pivotal_count
    (32 * MAX_PIVOTAL_EXPERIENCES) +           // pivotal_hashes
    (8 * MAX_PIVOTAL_EXPERIENCES) +            // pivotal_impacts
    (8 * MAX_PIVOTAL_EXPERIENCES) +            // pivotal_timestamps
    8 +                                        // continuity_score
    8 +                                        // coherence_score
    8 +                                        // stability_score
    8 +                                        // created_at
    8 +                                        // updated_at
    8 +                                        // last_declaration_slot
    16                                         // _reserved
  );
}

// =============================================================================
// PDA DERIVATION
// =============================================================================

/**
 * Derive the PDA for an agent identity account.
 */
export function deriveIdentityPDA(
  authority: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('agent-identity'), authority.toBuffer()],
    programId
  );
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  // Constants
  MAX_DIMENSIONS,
  MAX_DIMENSION_NAME_LEN,
  MAX_STORED_DECLARATIONS,
  MAX_PIVOTAL_EXPERIENCES,
  WEIGHT_SCALE,

  // Conversion utilities
  toOnChainWeight,
  fromOnChainWeight,
  toFixedBytes,
  fromFixedBytes,
  computeAccountSize,
  deriveIdentityPDA,
};
