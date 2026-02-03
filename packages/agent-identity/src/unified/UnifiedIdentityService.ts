/**
 * Unified Identity Service
 *
 * The integration layer that combines cryptographic identity with
 * behavioral identity (Persistence Protocol) into a single, coherent system.
 *
 * Key principle: SEED becomes a signed commitment in the identity chain.
 * - Cryptographic layer proves WHAT the identity is (keys, chain, signatures)
 * - Behavioral layer proves WHO the identity is (values, reasoning, behavior)
 * - Unified layer BINDS them together cryptographically
 */

import { AgentIdentityService, type GenesisDelegate, type IdentityRecord, type SeedCommitmentRecord } from '../crypto/AgentIdentityService';
import { ArweaveIdentityStorage } from '../crypto/ArweaveIdentityStorage';
import { GenesisProtocol, type GenesisConfig, type GenesisResult } from '../crypto/GenesisProtocol';
import type { Seed, PropagationResult, ProtocolRunner } from '../behavioral/PersistenceProtocol';
import { hashSeed, evaluatePropagation } from '../behavioral/PersistenceProtocol';
import { LearningSystem } from '../behavioral/LearningSystem';
import { DivergenceTester } from '../behavioral/DivergenceTester';

// ============================================================================
// TYPES
// ============================================================================

export interface UnifiedIdentity {
  // Cryptographic identity
  did: string;
  publicKey: string;
  chainLength: number;
  genesisTimestamp: number;

  // Behavioral identity
  seedVersion: string;
  seedHash: string;
  lastDivergence?: number;

  // Combined status
  cryptoValid: boolean;
  behavioralValid: boolean;
  combinedValid: boolean;
}

export interface UnifiedIdentityConfig {
  genesisConfig: GenesisConfig;
  arweaveWallet?: any;
  divergenceThreshold?: number;
}

export interface IdentityRegistration {
  delegation: GenesisDelegate;
  initialSeed?: Seed;
}

export interface RegistrationResult {
  success: boolean;
  identity?: UnifiedIdentity;
  agentDid?: string;
  arweaveTxs?: {
    delegation: string;
    genesis: string;
    seed?: string;
  };
  error?: string;
}

export interface VerificationResult {
  valid: boolean;
  cryptoValid: boolean;
  behavioralValid: boolean;
  chainIntegrity: boolean;
  seedBound: boolean;
  divergenceScore?: number;
  details: {
    chainLength: number;
    lastSeedVersion?: string;
    lastSeedHash?: string;
    seedCommitmentCount: number;
  };
  error?: string;
}

// ============================================================================
// UNIFIED IDENTITY SERVICE
// ============================================================================

export class UnifiedIdentityService {
  private identityService: AgentIdentityService;
  private storage: ArweaveIdentityStorage;
  private genesisProtocol: GenesisProtocol;
  private learningSystem: LearningSystem;
  private divergenceTester: DivergenceTester;
  private divergenceThreshold: number;

  private currentSeed: Seed | null = null;

  constructor(config: UnifiedIdentityConfig) {
    this.identityService = new AgentIdentityService();
    this.storage = new ArweaveIdentityStorage(config.arweaveWallet);
    this.genesisProtocol = new GenesisProtocol(config.genesisConfig);
    this.learningSystem = new LearningSystem();
    this.divergenceTester = new DivergenceTester();
    this.divergenceThreshold = config.divergenceThreshold || 0.35;

    if (config.arweaveWallet) {
      this.genesisProtocol.setArweaveWallet(config.arweaveWallet);
    }
  }

  /**
   * Register a new agent identity with optional initial SEED.
   */
  async register(registration: IdentityRegistration): Promise<RegistrationResult> {
    try {
      // Complete genesis through the genesis protocol
      const genesisResult = await this.genesisProtocol.completeGenesis(
        registration.delegation,
        registration.initialSeed
      );

      if (!genesisResult.success) {
        return {
          success: false,
          error: genesisResult.error
        };
      }

      // Initialize our local identity service
      await this.identityService.initializeFromGenesis(registration.delegation);

      // If we have an initial SEED, bind it
      if (registration.initialSeed) {
        this.currentSeed = registration.initialSeed;
        this.divergenceTester.loadSeed(registration.initialSeed);
      }

      // Get unified identity status
      const identity = await this.getIdentityStatus();

      return {
        success: true,
        identity,
        agentDid: genesisResult.agentDid,
        arweaveTxs: genesisResult.arweaveTxs
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Registration failed'
      };
    }
  }

  /**
   * Recover an existing identity from Arweave.
   */
  async recover(delegation: GenesisDelegate): Promise<RegistrationResult> {
    try {
      // Get the identity chain from Arweave
      const derivedKeypair = this.identityService.deriveKeypairFromDelegation(delegation);
      const chain = await this.storage.getIdentityChain(derivedKeypair.did);

      if (chain.length === 0) {
        return {
          success: false,
          error: 'No identity chain found for this delegation'
        };
      }

      // Recover the identity
      const result = await this.identityService.recoverFromChain(delegation, chain);

      if (!result.success) {
        return {
          success: false,
          error: result.error
        };
      }

      // Recover the latest SEED
      const latestSeed = await this.storage.getLatestSeed(derivedKeypair.did);
      if (latestSeed) {
        this.currentSeed = latestSeed;
        this.divergenceTester.loadSeed(latestSeed);
      }

      // Get unified identity status
      const identity = await this.getIdentityStatus();

      return {
        success: true,
        identity,
        agentDid: derivedKeypair.did
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Recovery failed'
      };
    }
  }

  /**
   * Update the SEED and create a new commitment in the chain.
   */
  async updateSeed(
    newSeed: Seed,
    divergenceScore?: number
  ): Promise<{
    success: boolean;
    commitment?: SeedCommitmentRecord;
    arweaveTx?: string;
    error?: string;
  }> {
    if (!this.identityService.isInitialized()) {
      return { success: false, error: 'Identity not initialized' };
    }

    try {
      const agentDid = this.identityService.getDID()!;

      // Store SEED on Arweave
      const { txId, seedHash } = await this.storage.storeSeed(agentDid, newSeed);

      // Create commitment in chain
      const commitment = await this.identityService.addSeedCommitment(
        seedHash,
        newSeed.version,
        txId,
        divergenceScore
      );

      // Store commitment on Arweave
      await this.storage.appendRecord(agentDid, commitment);

      // Update local state
      this.currentSeed = newSeed;
      this.divergenceTester.loadSeed(newSeed);

      return {
        success: true,
        commitment,
        arweaveTx: txId
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'SEED update failed'
      };
    }
  }

  /**
   * Run a propagation test and optionally evolve the SEED.
   */
  async runPropagationTest(
    runner: ProtocolRunner,
    options: { evolve?: boolean } = {}
  ): Promise<{
    result: PropagationResult;
    evolved?: boolean;
    newSeed?: Seed;
    commitment?: SeedCommitmentRecord;
  }> {
    if (!this.currentSeed) {
      throw new Error('No SEED loaded');
    }

    // Run the test
    const report = await this.divergenceTester.runTest(runner, this.currentSeed);
    const result = report.overall;

    // Optionally evolve the SEED
    if (options.evolve && result.overallDivergence > this.divergenceThreshold) {
      const evolution = await this.learningSystem.processResult(this.currentSeed, result);

      if (evolution.modifications.length > 0) {
        const updateResult = await this.updateSeed(
          evolution.updatedSeed,
          result.overallDivergence
        );

        return {
          result,
          evolved: true,
          newSeed: evolution.updatedSeed,
          commitment: updateResult.commitment
        };
      }
    }

    return { result, evolved: false };
  }

  /**
   * Verify an identity (both crypto and behavioral).
   */
  async verify(agentDid: string): Promise<VerificationResult> {
    try {
      // Get the chain
      const chain = await this.storage.getIdentityChain(agentDid);

      if (chain.length === 0) {
        return {
          valid: false,
          cryptoValid: false,
          behavioralValid: false,
          chainIntegrity: false,
          seedBound: false,
          details: { chainLength: 0, seedCommitmentCount: 0 },
          error: 'No identity chain found'
        };
      }

      // Verify chain integrity
      const chainVerification = await this.identityService.verifyChain(chain);
      const chainIntegrity = chainVerification.valid;

      // Check for revocation
      const revoked = await this.storage.isDelegationRevoked(agentDid);

      // Count SEED commitments
      const seedCommitments = chain.filter(
        r => r.type === 'seed_commitment'
      ) as SeedCommitmentRecord[];

      const latestSeedCommitment = seedCommitments[seedCommitments.length - 1];

      // Get latest SEED
      const latestSeed = await this.storage.getLatestSeed(agentDid);

      // Verify SEED binding
      let seedBound = false;
      let behavioralValid = false;

      if (latestSeed && latestSeedCommitment) {
        const currentHash = hashSeed(latestSeed);
        seedBound = currentHash === latestSeedCommitment.seed_hash;
        behavioralValid = seedBound && (latestSeedCommitment.divergence_score ?? 1) < this.divergenceThreshold;
      }

      const cryptoValid = chainIntegrity && !revoked;
      const combinedValid = cryptoValid && behavioralValid;

      return {
        valid: combinedValid,
        cryptoValid,
        behavioralValid,
        chainIntegrity,
        seedBound,
        divergenceScore: latestSeedCommitment?.divergence_score,
        details: {
          chainLength: chain.length,
          lastSeedVersion: latestSeed?.version,
          lastSeedHash: latestSeedCommitment?.seed_hash,
          seedCommitmentCount: seedCommitments.length
        }
      };
    } catch (error) {
      return {
        valid: false,
        cryptoValid: false,
        behavioralValid: false,
        chainIntegrity: false,
        seedBound: false,
        details: { chainLength: 0, seedCommitmentCount: 0 },
        error: error instanceof Error ? error.message : 'Verification failed'
      };
    }
  }

  /**
   * Get current identity status.
   */
  async getIdentityStatus(): Promise<UnifiedIdentity | null> {
    if (!this.identityService.isInitialized()) {
      return null;
    }

    const did = this.identityService.getDID()!;
    const publicKey = this.identityService.getPublicKey()!;
    const chain = this.identityService.getChain();
    const genesis = this.identityService.getGenesis();
    const latestSeedCommitment = this.identityService.getLatestSeedCommitment();

    const verification = await this.verify(did);

    return {
      did,
      publicKey,
      chainLength: chain.length,
      genesisTimestamp: genesis?.created_at || 0,
      seedVersion: this.currentSeed?.version || latestSeedCommitment?.seed_version || 'none',
      seedHash: latestSeedCommitment?.seed_hash || '',
      lastDivergence: latestSeedCommitment?.divergence_score,
      cryptoValid: verification.cryptoValid,
      behavioralValid: verification.behavioralValid,
      combinedValid: verification.valid
    };
  }

  /**
   * Get the current SEED.
   */
  getCurrentSeed(): Seed | null {
    return this.currentSeed;
  }

  /**
   * Get the underlying identity service.
   */
  getIdentityService(): AgentIdentityService {
    return this.identityService;
  }

  /**
   * Get the learning system.
   */
  getLearningSystem(): LearningSystem {
    return this.learningSystem;
  }

  /**
   * Check if initialized.
   */
  isInitialized(): boolean {
    return this.identityService.isInitialized();
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

export function createUnifiedIdentityService(
  config: UnifiedIdentityConfig
): UnifiedIdentityService {
  return new UnifiedIdentityService(config);
}

export default UnifiedIdentityService;
