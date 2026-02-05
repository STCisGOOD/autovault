/**
 * Anchor Module Exports
 *
 * Provides on-chain storage using the Anchor program.
 * Replaces Memo-based storage with a proper PDA-based account structure.
 */

export {
  AnchorStorageBackend,
  createAnchorStorageBackend,
  AGENT_IDENTITY_PROGRAM_ID,
  MAX_DIMENSIONS,
  MAX_STORED_DECLARATIONS,
  WEIGHT_SCALE,
  type AnchorStorageConfig,
  type AnchorLoadResult,
  type OnChainIdentity,
  type OnChainDeclaration,
} from './AnchorStorageBackend';

// Account types for Anchor program interaction
export {
  // Constants (re-exported with full names)
  MAX_DIMENSION_NAME_LEN,
  MAX_PIVOTAL_EXPERIENCES,

  // On-chain types
  type OnChainAgentIdentity,
  type OnChainDeclaration as OnChainDeclarationAccount,
  type OnChainVerificationResult,

  // Instruction argument types
  type InitializeArgs,
  type DeclareArgs,
  type EvolveArgs,
  type RecordPivotalArgs,

  // Conversion utilities
  toOnChainWeight,
  fromOnChainWeight,
  toFixedBytes,
  fromFixedBytes,
  computeAccountSize,
  deriveIdentityPDA,
} from './AccountTypes';
