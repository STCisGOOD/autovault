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

export const VERSION = '0.1.0';
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
