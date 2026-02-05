/**
 * Crypto Layer Exports
 *
 * The cryptographic foundation of agent identity.
 */

export {
  AgentIdentityService,
  type DelegatorInfo,
  type AgentInfo,
  type BlockReference,
  type GenesisDelegate,
  type StorageReference,
  type ChainAnchor,
  type GenesisRecord,
  type CommitmentData,
  type CommitmentRecord,
  type SessionEnvironment,
  type SessionData,
  type SessionRecord,
  type RevocationRecord,
  type SelfTerminationRecord,
  type SeedCommitmentRecord,
  type IdentityRecord,
  type ContinuityChallenge,
  type ContinuityProof,
  type AgentVerification,
  type AgentKeypair,
} from './AgentIdentityService';

// Solana-native storage
export {
  SolanaIdentityStorage,
  createSolanaStorage,
  agentIdentityExists,
  agentIdentityActive,
  type SolanaStorageConfig,
} from './SolanaIdentityStorage';

export {
  GenesisProtocol,
  generateAgentSubdomain,
  hashDelegation,
  type GenesisConfig,
  type GenesisResult,
} from './GenesisProtocol';

// Solana Kit-first storage (Jan 2026 recommended stack)
export {
  SolanaIdentityStorageKit,
  createSolanaKitStorage,
  agentIdentityExistsKit,
  agentIdentityActiveKit,
  type SolanaKitStorageConfig,
} from './SolanaIdentityStorageKit';
