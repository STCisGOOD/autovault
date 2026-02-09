/**
 * persistence-agent-identity
 *
 * Self-Sustaining Agent Identity System
 *
 * Combines cryptographic identity with behavioral identity through the Persistence Protocol,
 * creating a unified, economically self-sustaining system.
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                 UNIFIED AGENT IDENTITY                          │
 * ├─────────────────────────────────────────────────────────────────┤
 * │  CRYPTOGRAPHIC LAYER           │  BEHAVIORAL LAYER              │
 * │  - Ed25519 keypairs            │  - N-dimensional weights       │
 * │  - Genesis delegation          │  - Extended vocabulary         │
 * │  - Anchor program storage      │  - PDE-based evolution         │
 * ├─────────────────────────────────────────────────────────────────┤
 * │  ON-CHAIN STORAGE (Anchor Program)                              │
 * │  - PDA-based identity accounts                                  │
 * │  - Declaration chain with signatures                            │
 * │  - Pivotal experience hashes                                    │
 * │  - Continuity proofs                                            │
 * ├─────────────────────────────────────────────────────────────────┤
 * │  ECONOMIC LAYER (x402)                                          │
 * │  - Devnet: Free + auto-airdrop tokens                          │
 * │  - Mainnet: Micropayments → infrastructure costs               │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * @example Basic usage:
 * ```typescript
 * import { createUnifiedIdentityService } from 'persistence-agent-identity';
 *
 * const identity = createUnifiedIdentityService({
 *   genesisConfig: {
 *     solanaConnection: connection,
 *     network: 'devnet',
 *   },
 * });
 *
 * // Register new agent
 * const result = await identity.register({
 *   delegation: signedDelegation,
 *   initialSeed: mySeed,
 * });
 *
 * // Verify an agent
 * const verified = await identity.verify(agentDid);
 * ```
 */

// =============================================================================
// LOCAL IMPORTS (for helper functions)
// =============================================================================

import { createUnifiedIdentityService } from './unified/UnifiedIdentityService';
import { createPaymentGateway } from './economic/x402PaymentGateway';
import { getInfrastructureCostTracker } from './economic/InfrastructureCostTracker';
import type { Seed } from './behavioral/PersistenceProtocol';

// =============================================================================
// CORE - Agent Runtime Interface & Identity Manager (LIBRARY API)
// =============================================================================

export {
  // Agent runtime interface (what agents implement)
  type AgentRuntime,
  type ContextModifier,
  type IdentityLifecycle,
  type IdentityUpdateResult,
  AgentAdapter,
  // Experience mapping (ActionLog ↔ Weights semantics)
  actionLogToExperience,
  weightsToContextModifier,
  // Identity manager (session lifecycle)
  IdentityManager,
  createIdentityManager,
  type IdentityManagerConfig,
} from './core';

// =============================================================================
// BOOTSTRAP - Zero-friction identity initialization (RECOMMENDED ENTRY POINT)
// =============================================================================

export {
  // Main bootstrap
  AgentIdentityBootstrap,
  initializeAgentIdentity,
  // Keypair management
  KeypairManager,
  createKeypairManager,
  publicKeyToDid,
  parseDid,
  // Devnet funding
  DevnetFunder,
  createDevnetFunder,
  // Solana storage backend (blockchain persistence)
  SolanaStorageBackend,
  createSolanaStorageBackend,
  // Types
  type BootstrapConfig,
  type BootstrappedIdentity,
  type KeypairManagerConfig,
  type StoredKeypair,
  type DevnetFunderConfig,
  type FundingResult,
  type SolanaStorageBackendConfig,
} from './bootstrap';

// =============================================================================
// CRYPTO LAYER - Cryptographic identity
// =============================================================================

export {
  // Core service
  AgentIdentityService,
  // Storage (Solana-based)
  SolanaIdentityStorage,
  createSolanaStorage,
  agentIdentityExists,
  agentIdentityActive,
  // Genesis protocol
  GenesisProtocol,
  generateAgentSubdomain,
  hashDelegation,
  // Types
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
  type GenesisConfig,
  type GenesisResult,
} from './crypto';

// =============================================================================
// BEHAVIORAL LAYER - Behavioral identity (Persistence Protocol)
// =============================================================================

export {
  // Identity persistence (save/load behavioral state)
  IdentityPersistence,
  createIdentityPersistence,
  // Core protocol
  calculateDivergence,
  evaluatePropagation,
  computeGradient,
  proposeModifications,
  runProtocol,
  autonomousLoop,
  hashSeed,
  PROTOCOL_VERSION,
  // Divergence testing
  DivergenceTester,
  createDivergenceTester,
  DEFAULT_TEST_PROMPTS,
  // Learning system
  LearningSystem,
  createLearningSystem,
  createMinimalSeed,
  mergSeeds,
  // Extended vocabulary (N-dimensional identity)
  DEFAULT_DIMENSIONS,
  DEFI_DIMENSIONS,
  createDefaultExtendedVocabulary,
  createExtendedVocabulary,
  extendVocabulary,
  createDeFiVocabulary,
  extractDimensionMetrics,
  dimensionMetricsToExperience,
  toSEEDFormat,
  fromSEEDFormat,
  validateVocabulary,
  createExtendedIdentityBridge,
  createExtendedBehavioralVocabulary,
  isExtendedVocabulary,
  // Types
  type Seed,
  type Weight,
  type TestPrompt,
  type Reference,
  type DivergenceResult,
  type DivergenceSignal,
  type PropagationResult,
  type SeedModification,
  type ProtocolRunner,
  type DivergenceTestConfig,
  type DetailedDivergenceReport,
  type LearningConfig,
  type LearningState,
  type EvolutionRecord,
  type DimensionDefinition,
  type DimensionCategory,
  type MetricExtractor,
  type DimensionMetricResult,
  type ExtendedVocabulary,
  type SEEDWeight,
  type SEEDFormat,
  // ARIL core (behavioral identity learning)
  createUnifiedIdentity,
  type UnifiedIdentityConfig as BehavioralUnifiedIdentityConfig,
  type ObservationResult,
  type StorageBackend,
  // Strategy features (ARIL v2)
  extractStrategyFeatures,
  featuresToArray,
  arrayToFeatures,
  renderStrategies,
  STRATEGY_FEATURE_NAMES,
  DEFAULT_STRATEGY_FEATURE_CONFIG,
  DEFAULT_RENDER_CONFIG,
  type StrategyFeatures,
  type StrategyFeatureName,
  type StrategyFeatureConfig,
  type StrategyRenderInput,
  type StrategyRenderConfig,
  type StrategyDocument,
  type RenderedStrategy,
  type InteractionTerm,
  type DimensionAttribution,
} from './behavioral';

// =============================================================================
// UNIFIED LAYER - Combined identity (Crypto + Behavioral)
// =============================================================================

export {
  // Unified service
  UnifiedIdentityService,
  createUnifiedIdentityService,
  // Combined verification
  CombinedVerifier,
  createCombinedVerifier,
  quickVerify,
  // SEED commitment
  SeedCommitmentManager,
  createSeedCommitmentManager,
  // Types
  type UnifiedIdentity,
  type UnifiedIdentityConfig,
  type IdentityRegistration,
  type RegistrationResult,
  type VerificationResult,
  type VerificationLevel,
  type CombinedChallenge,
  type CombinedProof,
  type CombinedVerificationResult,
  type VerificationConfig,
  type SeedCommitmentConfig,
  type CommitmentResult,
  type SeedHistory,
} from './unified';

// =============================================================================
// ECONOMIC LAYER - Payments and sustainability
// =============================================================================

export {
  // Payment gateway
  X402PaymentGateway,
  createPaymentGateway,
  // Devnet airdrop
  DevnetAirdropService,
  createDevnetAirdropService,
  quickDevnetAirdrop,
  // Cost tracking
  InfrastructureCostTracker,
  createInfrastructureCostTracker,
  getInfrastructureCostTracker,
  // Types
  type ServiceType,
  type NetworkMode,
  type ServicePrice,
  type PaymentConfig,
  type PaymentRequirement,
  type PaymentVerification,
  type AirdropConfig,
  type AirdropResult,
  type WalletBalance,
  type CostCategory,
  type RevenueCategory,
  type CostTrackerState,
  type UsageEvent,
} from './economic';

// =============================================================================
// API LAYER - HTTP endpoints
// =============================================================================

export {
  // Registration
  RegistrationService,
  createRegistrationService,
  createRegisterHandler,
  // Verification
  VerificationService,
  BatchVerificationService,
  createVerificationService,
  createBatchVerificationService,
  createVerifyHandler,
  // Challenge-response
  ChallengeService,
  ChallengeResponder,
  createChallengeService,
  createChallengeResponder,
  createChallengeHandlers,
  // Types
  type RegisterRequest,
  type RegisterResponse,
  type RegistrationServiceConfig,
  type VerifyRequest,
  type VerifyResponse,
  type BatchVerifyRequest,
  type BatchVerifyResponse,
  type VerificationServiceConfig,
  type CreateChallengeRequest,
  type CreateChallengeResponse,
  type SubmitProofRequest,
  type SubmitProofResponse,
  type ChallengeServiceConfig,
} from './api';

// =============================================================================
// PACKAGE INFO
// =============================================================================

export const VERSION = '0.3.0';
export const PACKAGE_NAME = 'persistence-agent-identity';

/**
 * Quick start helper - creates a complete identity system for devnet.
 */
export async function createDevnetIdentitySystem(
  solanaRpcUrl: string = 'https://api.devnet.solana.com'
) {
  const { Connection } = await import('@solana/web3.js');
  const connection = new Connection(solanaRpcUrl, 'confirmed');

  return createUnifiedIdentityService({
    genesisConfig: {
      solanaConnection: connection,
      network: 'devnet',
    },
    solanaStorage: {
      connection,
    },
    divergenceThreshold: 0.35,
  });
}

/**
 * Quick start helper - creates a complete identity system for mainnet.
 */
export async function createMainnetIdentitySystem(
  solanaRpcUrl: string,
  payerKeypair: any,
  payToAddress: string
) {
  const { Connection } = await import('@solana/web3.js');
  const connection = new Connection(solanaRpcUrl, 'confirmed');

  const paymentGateway = createPaymentGateway({
    network: 'mainnet',
    enabled: true,
    payToAddress,
  });

  return {
    identity: createUnifiedIdentityService({
      genesisConfig: {
        solanaConnection: connection,
        payer: payerKeypair,
        network: 'mainnet',
      },
      solanaStorage: {
        connection,
        payer: payerKeypair,
      },
      divergenceThreshold: 0.35,
    }),
    payments: paymentGateway,
    costs: getInfrastructureCostTracker(),
  };
}

// =============================================================================
// TRUE QUICK START - One function to persistent identity (Solana-only)
// =============================================================================

export interface QuickStartConfig {
  /** Agent name (used to generate subdomain) */
  name: string;
  /** Optional initial SEED for behavioral identity */
  seed?: Seed;
  /** Solana RPC URL (default: devnet) */
  rpcUrl?: string;
}

export interface QuickStartResult {
  /** Agent's decentralized identifier */
  did: string;
  /** Agent's public key (base58) */
  publicKey: string;
  /** Solana signature of genesis transaction */
  genesisTx: string;
  /** Store a SEED on Solana */
  storeSeed: (seed: Seed) => Promise<{ txId: string; seedHash: string }>;
  /** Get stored SEED from Solana */
  getSeed: () => Promise<Seed | null>;
  /** Get identity chain from Solana */
  getChain: () => Promise<any[]>;
  /** Check balance */
  getBalance: () => Promise<number>;
}

/**
 * TRUE QUICK START - Get persistent identity in one function call.
 *
 * Uses ONLY Solana (no Arweave). Perfect for hackathons.
 *
 * @example
 * ```typescript
 * import { quickStart } from 'persistence-agent-identity';
 *
 * const identity = await quickStart({ name: 'my-agent' });
 * console.log(identity.did);  // did:persistence:ABC123...
 *
 * // Store your SEED
 * await identity.storeSeed(mySeed);
 * ```
 *
 * This handles EVERYTHING:
 * - Creates Solana devnet connection
 * - Airdrops SOL for transactions
 * - Generates keypair & self-signed delegation
 * - Stores genesis on Solana
 * - Returns simple interface for SEED storage
 */
export async function quickStart(config: QuickStartConfig): Promise<QuickStartResult> {
  const { Connection, Keypair, PublicKey } = await import('@solana/web3.js');
  const bs58 = await import('bs58');

  const rpcUrl = config.rpcUrl || 'https://api.devnet.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  // Import required modules
  const { AgentIdentityService } = await import('./crypto/AgentIdentityService');
  const { generateAgentSubdomain } = await import('./crypto/GenesisProtocol');
  const { SolanaIdentityStorage } = await import('./crypto/SolanaIdentityStorage');
  const { hashSeed } = await import('./behavioral/PersistenceProtocol');

  // Generate payer wallet and airdrop
  const payerKeypair = Keypair.generate();
  console.log(`[quickStart] Generated payer: ${payerKeypair.publicKey.toBase58()}`);

  // Airdrop 1 SOL for transactions
  console.log('[quickStart] Requesting airdrop...');
  const airdropSig = await connection.requestAirdrop(payerKeypair.publicKey, 1_000_000_000);
  await connection.confirmTransaction(airdropSig, 'confirmed');
  console.log('[quickStart] Airdrop confirmed');

  // Create identity service and derive keypair
  const identityService = new AgentIdentityService();

  // Get current slot for genesis block reference
  const slot = await connection.getSlot();
  const block = await connection.getBlock(slot, { maxSupportedTransactionVersion: 0 });

  if (!block) {
    throw new Error('Failed to fetch Solana block');
  }

  // Create self-signed delegation
  const subdomain = generateAgentSubdomain(config.name);
  const delegatorPubkey = bs58.default.encode(payerKeypair.publicKey.toBytes());

  const delegationWithoutSig = {
    delegator: {
      nft_address: 'self-signed-devnet',
      wallet_pubkey: delegatorPubkey,
      did: 'did:persistence:' + delegatorPubkey,
    },
    agent: {
      name: config.name,
      subdomain,
      purpose: 'Persistent agent identity via Persistence Protocol',
      capabilities: ['persistence-protocol'],
    },
    genesis_block: {
      chain: 'solana' as const,
      block_height: slot,
      block_hash: block.blockhash,
    },
    created_at: Date.now(),
    expires_at: null,
  };

  // Sign delegation
  const { sign } = await import('@noble/ed25519');
  const { utf8ToBytes } = await import('@noble/hashes/utils');
  const message = JSON.stringify(delegationWithoutSig, Object.keys(delegationWithoutSig).sort());
  const signature = await sign(utf8ToBytes(message), payerKeypair.secretKey.slice(0, 32));

  const delegation = {
    ...delegationWithoutSig,
    delegator_signature: bs58.default.encode(signature),
  };

  // Initialize identity from delegation
  const genesisRecord = await identityService.initializeFromGenesis(delegation);
  const agentDid = identityService.getDID()!;
  const agentPubkeyBase58 = identityService.getPublicKey()!;
  const agentPubkey = new PublicKey(agentPubkeyBase58);

  // Create Solana storage
  const storage = new SolanaIdentityStorage({ connection });
  storage.setPayer(payerKeypair);

  // Store genesis on Solana
  console.log('[quickStart] Storing genesis on Solana...');
  const { genesisTx } = await storage.storeGenesis(delegation, genesisRecord);
  console.log(`[quickStart] Genesis stored: ${genesisTx}`);

  // Store initial SEED if provided
  if (config.seed) {
    console.log('[quickStart] Storing initial SEED...');
    await storage.storeSeed(agentDid, config.seed);
    console.log('[quickStart] SEED stored');
  }

  console.log(`[quickStart] Identity created: ${agentDid}`);

  // Return simple interface
  return {
    did: agentDid,
    publicKey: agentPubkeyBase58,
    genesisTx,

    storeSeed: async (seed: Seed) => {
      return storage.storeSeed(agentDid, seed);
    },

    getSeed: async () => {
      return storage.getLatestSeed(agentDid);
    },

    getChain: async () => {
      return storage.getIdentityChain(agentDid);
    },

    getBalance: async () => {
      return storage.getBalance(payerKeypair.publicKey);
    },
  };
}

// =============================================================================
// ANCHOR STORAGE (On-chain PDA-based identity)
// =============================================================================

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
} from './anchor';

// =============================================================================
// SOLANA KIT-FIRST STORAGE (Jan 2026 Stack)
// =============================================================================

export {
  SolanaIdentityStorageKit,
  createSolanaKitStorage,
  agentIdentityExistsKit,
  agentIdentityActiveKit,
  type SolanaKitStorageConfig,
} from './crypto/SolanaIdentityStorageKit';

/**
 * Quick start using @solana/kit (recommended Jan 2026 stack).
 *
 * Uses the official Solana Foundation framework-kit patterns.
 */
export async function quickStartKit(config: QuickStartConfig): Promise<QuickStartResult> {
  const {
    generateKeyPairSigner,
    createSolanaRpc,
    createSolanaRpcSubscriptions,
    address,
    lamports,
  } = await import('@solana/kit');
  const bs58 = await import('bs58');

  const rpcUrl = config.rpcUrl || 'https://api.devnet.solana.com';
  const wsUrl = rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');

  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);

  // Import required modules
  const { AgentIdentityService } = await import('./crypto/AgentIdentityService');
  const { generateAgentSubdomain } = await import('./crypto/GenesisProtocol');
  const { SolanaIdentityStorageKit } = await import('./crypto/SolanaIdentityStorageKit');
  const { hashSeed } = await import('./behavioral/PersistenceProtocol');

  // Generate payer signer
  const payerSigner = await generateKeyPairSigner();
  console.log(`[quickStartKit] Generated payer: ${payerSigner.address}`);

  // Airdrop 1 SOL for transactions
  console.log('[quickStartKit] Requesting airdrop...');
  const airdropSig = await rpc
    .requestAirdrop(payerSigner.address, lamports(1_000_000_000n), { commitment: 'confirmed' })
    .send();

  // Wait for confirmation
  let confirmed = false;
  for (let i = 0; i < 30 && !confirmed; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const { value } = await rpc.getSignatureStatuses([airdropSig]).send();
    if (value[0]?.confirmationStatus === 'confirmed' || value[0]?.confirmationStatus === 'finalized') {
      confirmed = true;
    }
  }
  console.log('[quickStartKit] Airdrop confirmed');

  // Get current slot for genesis block reference
  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send() as bigint;
  const block = await rpc.getBlock(slot, { commitment: 'confirmed' }).send() as {
    blockhash: string;
    blockHeight: bigint;
  } | null;

  if (!block) {
    throw new Error('Failed to fetch Solana block');
  }

  // Create identity service
  const identityService = new AgentIdentityService();

  // Create self-signed delegation
  const subdomain = generateAgentSubdomain(config.name);
  const delegatorPubkey = payerSigner.address;

  const delegationWithoutSig = {
    delegator: {
      nft_address: 'self-signed-devnet',
      wallet_pubkey: delegatorPubkey,
      did: 'did:persistence:' + delegatorPubkey,
    },
    agent: {
      name: config.name,
      subdomain,
      purpose: 'Persistent agent identity via Persistence Protocol (Kit-first)',
      capabilities: ['persistence-protocol', 'solana-kit'],
    },
    genesis_block: {
      chain: 'solana' as const,
      block_height: Number(slot),
      block_hash: block.blockhash,
    },
    created_at: Date.now(),
    expires_at: null,
  };

  // Sign delegation using the signer
  const { sign } = await import('@noble/ed25519');
  const { utf8ToBytes } = await import('@noble/hashes/utils');
  const message = JSON.stringify(delegationWithoutSig, Object.keys(delegationWithoutSig).sort());

  // Extract private key from signer for signing
  const keyPairBytes = await payerSigner.keyPair;
  const signature = await sign(utf8ToBytes(message), keyPairBytes.privateKey.slice(0, 32));

  const delegation = {
    ...delegationWithoutSig,
    delegator_signature: bs58.default.encode(signature),
  };

  // Initialize identity from delegation
  const genesisRecord = await identityService.initializeFromGenesis(delegation);
  const agentDid = identityService.getDID()!;
  const agentPubkeyBase58 = identityService.getPublicKey()!;
  const agentAddress = address(agentPubkeyBase58);

  // Create Kit-based Solana storage
  const storage = new SolanaIdentityStorageKit({
    rpcEndpoint: rpcUrl,
    wsEndpoint: wsUrl,
    payer: payerSigner,
    commitment: 'confirmed',
  });

  // Store genesis on Solana
  console.log('[quickStartKit] Storing genesis on Solana...');
  const { genesisTx } = await storage.storeGenesis(delegation, genesisRecord);
  console.log(`[quickStartKit] Genesis stored: ${genesisTx}`);

  // Store initial SEED if provided
  if (config.seed) {
    console.log('[quickStartKit] Storing initial SEED...');
    await storage.storeSeed(agentDid, config.seed);
    console.log('[quickStartKit] SEED stored');
  }

  console.log(`[quickStartKit] Identity created: ${agentDid}`);

  // Return simple interface
  return {
    did: agentDid,
    publicKey: agentPubkeyBase58,
    genesisTx,

    storeSeed: async (seed: Seed) => {
      return storage.storeSeed(agentDid, seed);
    },

    getSeed: async () => {
      return storage.getLatestSeed(agentDid);
    },

    getChain: async () => {
      return storage.getIdentityChain(agentDid);
    },

    getBalance: async () => {
      return storage.getBalance(agentAddress);
    },
  };
}
