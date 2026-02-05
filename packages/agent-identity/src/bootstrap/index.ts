/**
 * Bootstrap Module Exports
 *
 * Zero-friction identity initialization for autonomous agents.
 */

export {
  AgentIdentityBootstrap,
  initializeAgentIdentity,
  type BootstrapConfig,
  type BootstrappedIdentity,
} from './AgentIdentityBootstrap';

export {
  KeypairManager,
  createKeypairManager,
  publicKeyToDid,
  parseDid,
  type KeypairManagerConfig,
  type StoredKeypair,
} from './KeypairManager';

export {
  DevnetFunder,
  createDevnetFunder,
  type DevnetFunderConfig,
  type FundingResult,
} from './DevnetFunder';

export {
  SolanaStorageBackend,
  createSolanaStorageBackend,
  type SolanaStorageBackendConfig,
  type OffChainStorage,
  type OffChainCommitment,
} from './SolanaStorageBackend';

export {
  FileSystemPrivateStorage,
  createFileSystemPrivateStorage,
  type PrivateStorageBackend,
  type PrivateStorageConfig,
  type StoredActionLog,
  type ActionLogIndex,
  type PrivateStorageStats,
} from './PrivateStorage';
