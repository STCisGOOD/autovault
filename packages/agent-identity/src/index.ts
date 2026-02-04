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
 * │  - Ed25519 keypairs            │  - SEED documents              │
 * │  - Genesis delegation          │  - Divergence testing          │
 * │  - Arweave chain storage       │  - Weight evolution            │
 * ├─────────────────────────────────────────────────────────────────┤
 * │  BINDING: SEED becomes a signed commitment in identity chain    │
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
// CRYPTO LAYER - Cryptographic identity
// =============================================================================

export {
  // Core service
  AgentIdentityService,
  // Storage
  ArweaveIdentityStorage,
  createArweaveStorage,
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

export const VERSION = '0.2.0';
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
    divergenceThreshold: 0.35,
  });
}

/**
 * Quick start helper - creates a complete identity system for mainnet.
 */
export async function createMainnetIdentitySystem(
  solanaRpcUrl: string,
  arweaveWallet: any,
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
        arweaveWallet,
        network: 'mainnet',
      },
      arweaveWallet,
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

// Re-export Solana storage for direct use
export { SolanaIdentityStorage, createSolanaStorage } from './crypto';
