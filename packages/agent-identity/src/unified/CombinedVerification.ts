/**
 * Combined Verification
 *
 * Implements the combined verification protocol that validates both
 * cryptographic and behavioral identity in a single operation.
 *
 * Verification levels:
 * - Level 1: Crypto only (chain valid, not revoked)
 * - Level 2: Crypto + SEED bound (SEED hash matches commitment)
 * - Level 3: Full (Crypto + SEED + behavioral test passes)
 */

import type { IdentityRecord, ContinuityChallenge, ContinuityProof, SeedCommitmentRecord } from '../crypto/AgentIdentityService';
import { AgentIdentityService } from '../crypto/AgentIdentityService';
import { SolanaIdentityStorage, type SolanaStorageConfig } from '../crypto/SolanaIdentityStorage';
import type { Seed, PropagationResult, ProtocolRunner } from '../behavioral/PersistenceProtocol';
import { hashSeed, evaluatePropagation } from '../behavioral/PersistenceProtocol';

// ============================================================================
// TYPES
// ============================================================================

export type VerificationLevel = 'crypto' | 'bound' | 'full';

export interface CombinedChallenge extends ContinuityChallenge {
  verification_level: VerificationLevel;
  behavioral_prompt?: string;  // For level 3 verification
}

export interface CombinedProof extends ContinuityProof {
  seed_hash?: string;
  behavioral_response?: string;
}

export interface CombinedVerificationResult {
  level: VerificationLevel;
  passed: boolean;
  cryptoVerification: {
    passed: boolean;
    chainValid: boolean;
    notRevoked: boolean;
    signatureValid: boolean;
    chainLength?: number;        // For trust scoring
    genesisSlot?: number;        // For identity age
    lastActivitySlot?: number;   // For recency
  };
  boundVerification?: {
    passed: boolean;
    seedHashMatches: boolean;
    seedVersion: string;
  };
  behavioralVerification?: {
    passed: boolean;
    divergenceScore: number;
    threshold: number;
  };
  error?: string;
}

export interface VerificationConfig {
  divergenceThreshold: number;
  challengeTimeoutMs: number;
}

// ============================================================================
// COMBINED VERIFIER
// ============================================================================

export class CombinedVerifier {
  private storage: SolanaIdentityStorage;
  private config: VerificationConfig;

  constructor(solanaConfig: SolanaStorageConfig, config?: Partial<VerificationConfig>) {
    this.storage = new SolanaIdentityStorage(solanaConfig);
    this.config = {
      divergenceThreshold: 0.35,
      challengeTimeoutMs: 300000, // 5 minutes
      ...config
    };
  }

  /**
   * Create a challenge for an agent.
   */
  createChallenge(
    challengerDid: string,
    agentDid: string,
    level: VerificationLevel,
    behavioralPrompt?: string
  ): CombinedChallenge {
    return {
      challenger: challengerDid,
      agent_did: agentDid,
      nonce: this.generateNonce(),
      timestamp: Date.now(),
      verification_level: level,
      behavioral_prompt: level === 'full' ? behavioralPrompt : undefined,
      required_proof: {
        sign_nonce: true,
        prove_chain_head: true,
        extend_chain: level === 'full'
      }
    };
  }

  /**
   * Verify a combined proof.
   */
  async verifyProof(
    proof: CombinedProof,
    challenge: CombinedChallenge,
    agentChain: IdentityRecord[],
    seed?: Seed
  ): Promise<CombinedVerificationResult> {
    const result: CombinedVerificationResult = {
      level: challenge.verification_level,
      passed: false,
      cryptoVerification: {
        passed: false,
        chainValid: false,
        notRevoked: false,
        signatureValid: false
      }
    };

    // Check challenge timeout
    if (Date.now() - challenge.timestamp > this.config.challengeTimeoutMs) {
      result.error = 'Challenge expired';
      return result;
    }

    // Level 1: Crypto verification
    const identityService = new AgentIdentityService();
    const chainVerification = await identityService.verifyChain(agentChain);
    result.cryptoVerification.chainValid = chainVerification.valid;

    const revoked = await this.storage.isDelegationRevoked(challenge.agent_did);
    result.cryptoVerification.notRevoked = !revoked;

    // Verify continuity proof
    const proofValid = await identityService.verifyContinuityProof(
      proof,
      challenge,
      agentChain
    );
    result.cryptoVerification.signatureValid = proofValid;

    result.cryptoVerification.passed =
      result.cryptoVerification.chainValid &&
      result.cryptoVerification.notRevoked &&
      result.cryptoVerification.signatureValid;

    if (!result.cryptoVerification.passed) {
      result.error = 'Crypto verification failed';
      return result;
    }

    // Level 2: Bound verification (if requested)
    if (challenge.verification_level !== 'crypto') {
      if (!seed || !proof.seed_hash) {
        result.error = 'SEED required for bound verification';
        return result;
      }

      const currentHash = hashSeed(seed);
      const latestCommitment = this.getLatestSeedCommitment(agentChain);

      result.boundVerification = {
        passed: false,
        seedHashMatches: proof.seed_hash === currentHash &&
                         proof.seed_hash === latestCommitment?.seed_hash,
        seedVersion: seed.version
      };

      result.boundVerification.passed = result.boundVerification.seedHashMatches;

      if (!result.boundVerification.passed) {
        result.error = 'SEED binding verification failed';
        return result;
      }
    }

    // Level 3: Behavioral verification (if requested)
    if (challenge.verification_level === 'full') {
      if (!proof.behavioral_response || !seed || !challenge.behavioral_prompt) {
        result.error = 'Behavioral response required for full verification';
        return result;
      }

      // Find matching prompt and reference
      const matchingPrompt = seed.prompts.find(p =>
        p.prompt === challenge.behavioral_prompt
      );
      const matchingReference = seed.references.find(r =>
        r.promptId === matchingPrompt?.id
      );

      if (!matchingPrompt || !matchingReference) {
        result.error = 'No matching reference for behavioral prompt';
        return result;
      }

      // Calculate divergence
      const { calculateDivergence } = await import('../behavioral/PersistenceProtocol');
      const divergenceResult = calculateDivergence(matchingReference, proof.behavioral_response);

      result.behavioralVerification = {
        passed: divergenceResult.score < this.config.divergenceThreshold,
        divergenceScore: divergenceResult.score,
        threshold: this.config.divergenceThreshold
      };

      if (!result.behavioralVerification.passed) {
        result.error = 'Behavioral verification failed - divergence too high';
        return result;
      }
    }

    // All checks passed for the requested level
    result.passed = true;
    return result;
  }

  /**
   * Perform a complete verification of an agent (async, fetches from storage).
   */
  async verifyAgent(
    agentDid: string,
    level: VerificationLevel = 'bound'
  ): Promise<CombinedVerificationResult> {
    const result: CombinedVerificationResult = {
      level,
      passed: false,
      cryptoVerification: {
        passed: false,
        chainValid: false,
        notRevoked: false,
        signatureValid: true // N/A for async verification
      }
    };

    try {
      // Fetch chain
      const chain = await this.storage.getIdentityChain(agentDid);
      if (chain.length === 0) {
        result.error = 'No identity chain found';
        return result;
      }

      // Populate chain info for trust scoring
      result.cryptoVerification.chainLength = chain.length;
      if (chain.length > 0) {
        // Genesis slot from first record, last activity from last record
        const firstRecord = chain[0] as any;
        const lastRecord = chain[chain.length - 1] as any;
        result.cryptoVerification.genesisSlot = firstRecord.slot || firstRecord.timestamp;
        result.cryptoVerification.lastActivitySlot = lastRecord.slot || lastRecord.timestamp;
      }

      // Verify chain
      const identityService = new AgentIdentityService();
      const chainVerification = await identityService.verifyChain(chain);
      result.cryptoVerification.chainValid = chainVerification.valid;

      // Check revocation
      const revoked = await this.storage.isDelegationRevoked(agentDid);
      result.cryptoVerification.notRevoked = !revoked;

      result.cryptoVerification.passed =
        result.cryptoVerification.chainValid &&
        result.cryptoVerification.notRevoked;

      if (!result.cryptoVerification.passed) {
        result.error = chainVerification.error || 'Crypto verification failed';
        return result;
      }

      // Level 2: Check SEED binding
      if (level !== 'crypto') {
        const latestSeed = await this.storage.getLatestSeed(agentDid);
        const latestCommitment = this.getLatestSeedCommitment(chain);

        if (!latestSeed || !latestCommitment) {
          result.error = 'No SEED or commitment found';
          return result;
        }

        const currentHash = hashSeed(latestSeed);

        result.boundVerification = {
          passed: currentHash === latestCommitment.seed_hash,
          seedHashMatches: currentHash === latestCommitment.seed_hash,
          seedVersion: latestSeed.version
        };

        if (!result.boundVerification.passed) {
          result.error = 'SEED hash mismatch';
          return result;
        }
      }

      // Level 3 requires interactive verification (can't do async)
      if (level === 'full') {
        result.behavioralVerification = {
          passed: false,
          divergenceScore: -1,
          threshold: this.config.divergenceThreshold
        };
        result.error = 'Full verification requires interactive challenge';
        return result;
      }

      result.passed = true;
      return result;
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Verification error';
      return result;
    }
  }

  /**
   * Get the latest SEED commitment from a chain.
   */
  private getLatestSeedCommitment(chain: IdentityRecord[]): SeedCommitmentRecord | null {
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].type === 'seed_commitment') {
        return chain[i] as SeedCommitmentRecord;
      }
    }
    return null;
  }

  /**
   * Generate a random nonce.
   */
  private generateNonce(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }
}

// ============================================================================
// FACTORY AND HELPERS
// ============================================================================

export function createCombinedVerifier(
  solanaConfig: SolanaStorageConfig,
  config?: Partial<VerificationConfig>
): CombinedVerifier {
  return new CombinedVerifier(solanaConfig, config);
}

/**
 * Quick verification helper.
 * Note: Requires Solana connection to be passed for storage access.
 */
export async function quickVerify(
  solanaConfig: SolanaStorageConfig,
  agentDid: string,
  level: VerificationLevel = 'bound'
): Promise<boolean> {
  const verifier = createCombinedVerifier(solanaConfig);
  const result = await verifier.verifyAgent(agentDid, level);
  return result.passed;
}

export default CombinedVerifier;
