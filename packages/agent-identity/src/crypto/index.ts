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

export {
  ArweaveIdentityStorage,
  createArweaveStorage,
} from './ArweaveIdentityStorage';

// Solana-native storage (recommended for hackathon)
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
