/**
 * Challenge API
 *
 * Endpoint for agent-to-agent verification through challenge-response protocol.
 *
 * This enables:
 * - Live identity verification (prove the agent is alive and can sign)
 * - Cross-agent trust establishment
 * - Coalition membership verification
 */

import { CombinedVerifier, createCombinedVerifier, type VerificationLevel, type CombinedChallenge, type CombinedProof } from '../unified/CombinedVerification';
import { AgentIdentityService, type IdentityRecord } from '../crypto/AgentIdentityService';
import { ArweaveIdentityStorage, createArweaveStorage } from '../crypto/ArweaveIdentityStorage';
import { X402PaymentGateway, createPaymentGateway } from '../economic/x402PaymentGateway';
import { getInfrastructureCostTracker } from '../economic/InfrastructureCostTracker';
import type { Seed } from '../behavioral/PersistenceProtocol';

// ============================================================================
// TYPES
// ============================================================================

export interface CreateChallengeRequest {
  challengerDid: string;
  targetDid: string;
  level: VerificationLevel;
  behavioralPrompt?: string;  // Required for 'full' level
}

export interface CreateChallengeResponse {
  success: boolean;
  challenge?: CombinedChallenge;
  expiresAt?: number;
  error?: string;
}

export interface SubmitProofRequest {
  challenge: CombinedChallenge;
  proof: CombinedProof;
  chain: IdentityRecord[];
  seed?: Seed;
}

export interface SubmitProofResponse {
  success: boolean;
  verified: boolean;
  details?: {
    cryptoValid: boolean;
    boundValid?: boolean;
    behavioralValid?: boolean;
    divergenceScore?: number;
  };
  trustScore?: number;
  error?: string;
}

export interface ChallengeServiceConfig {
  network: 'devnet' | 'mainnet';
  challengeTimeoutMs?: number;
  divergenceThreshold?: number;
  paymentGateway?: X402PaymentGateway;
}

// ============================================================================
// CHALLENGE SERVICE
// ============================================================================

export class ChallengeService {
  private verifier: CombinedVerifier;
  private storage: ArweaveIdentityStorage;
  private paymentGateway: X402PaymentGateway;
  private costTracker = getInfrastructureCostTracker();

  // Active challenges (in production, would use Redis or similar)
  private activeChallenges: Map<string, {
    challenge: CombinedChallenge;
    expiresAt: number;
  }> = new Map();

  private challengeTimeoutMs: number;

  constructor(config: ChallengeServiceConfig) {
    this.challengeTimeoutMs = config.challengeTimeoutMs || 300000; // 5 minutes

    this.verifier = createCombinedVerifier({
      divergenceThreshold: config.divergenceThreshold || 0.35,
      challengeTimeoutMs: this.challengeTimeoutMs,
    });

    this.storage = createArweaveStorage();

    this.paymentGateway = config.paymentGateway || createPaymentGateway({
      network: config.network,
      enabled: config.network === 'mainnet',
    });
  }

  /**
   * Create a challenge for an agent.
   */
  async createChallenge(request: CreateChallengeRequest): Promise<CreateChallengeResponse> {
    try {
      // Verify the target agent exists
      const targetExists = await this.storage.getChainHead(request.targetDid);
      if (!targetExists) {
        return {
          success: false,
          error: 'Target agent not found'
        };
      }

      // Check payment (for creating challenges)
      if (this.paymentGateway.requiresPayment('verification')) {
        // Challenge creation is free - payment is on proof verification
      }

      // Create the challenge
      const challenge = this.verifier.createChallenge(
        request.challengerDid,
        request.targetDid,
        request.level,
        request.behavioralPrompt
      );

      // Store challenge
      const challengeKey = this.getChallengeKey(challenge);
      const expiresAt = Date.now() + this.challengeTimeoutMs;

      this.activeChallenges.set(challengeKey, {
        challenge,
        expiresAt,
      });

      // Clean up expired challenges
      this.cleanupExpiredChallenges();

      return {
        success: true,
        challenge,
        expiresAt,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create challenge'
      };
    }
  }

  /**
   * Submit a proof in response to a challenge.
   */
  async submitProof(
    request: SubmitProofRequest,
    paymentSignature?: string
  ): Promise<SubmitProofResponse> {
    try {
      // Check payment
      if (this.paymentGateway.requiresPayment('verification')) {
        const paymentVerification = await this.paymentGateway.verifyPayment(
          paymentSignature || null,
          'verification'
        );

        if (!paymentVerification.valid) {
          return {
            success: false,
            verified: false,
            error: paymentVerification.error || 'Payment required'
          };
        }
      }

      // Verify challenge is valid and active
      const challengeKey = this.getChallengeKey(request.challenge);
      const storedChallenge = this.activeChallenges.get(challengeKey);

      if (!storedChallenge) {
        return {
          success: false,
          verified: false,
          error: 'Challenge not found or expired'
        };
      }

      if (Date.now() > storedChallenge.expiresAt) {
        this.activeChallenges.delete(challengeKey);
        return {
          success: false,
          verified: false,
          error: 'Challenge expired'
        };
      }

      // Verify the proof
      const verificationResult = await this.verifier.verifyProof(
        request.proof,
        request.challenge,
        request.chain,
        request.seed
      );

      // Remove used challenge
      this.activeChallenges.delete(challengeKey);

      // Track usage
      this.costTracker.recordServiceCall('verification');

      // Calculate trust score based on verification level
      let trustScore: number | undefined;
      if (verificationResult.passed) {
        switch (verificationResult.level) {
          case 'crypto':
            trustScore = 0.5;
            break;
          case 'bound':
            trustScore = 0.75;
            break;
          case 'full':
            trustScore = verificationResult.behavioralVerification?.divergenceScore
              ? 1.0 - verificationResult.behavioralVerification.divergenceScore
              : 0.9;
            break;
        }
      }

      return {
        success: true,
        verified: verificationResult.passed,
        details: {
          cryptoValid: verificationResult.cryptoVerification.passed,
          boundValid: verificationResult.boundVerification?.passed,
          behavioralValid: verificationResult.behavioralVerification?.passed,
          divergenceScore: verificationResult.behavioralVerification?.divergenceScore,
        },
        trustScore,
        error: verificationResult.error,
      };
    } catch (error) {
      return {
        success: false,
        verified: false,
        error: error instanceof Error ? error.message : 'Proof verification failed'
      };
    }
  }

  /**
   * Get challenge key for storage.
   */
  private getChallengeKey(challenge: CombinedChallenge): string {
    return `${challenge.challenger}:${challenge.agent_did}:${challenge.nonce}`;
  }

  /**
   * Clean up expired challenges.
   */
  private cleanupExpiredChallenges(): void {
    const now = Date.now();
    for (const [key, data] of this.activeChallenges.entries()) {
      if (now > data.expiresAt) {
        this.activeChallenges.delete(key);
      }
    }
  }

  /**
   * Get active challenges count.
   */
  getActiveChallengesCount(): number {
    this.cleanupExpiredChallenges();
    return this.activeChallenges.size;
  }
}

// ============================================================================
// AGENT-SIDE HELPER: Generate proof for a challenge
// ============================================================================

export class ChallengeResponder {
  private identityService: AgentIdentityService;
  private storage: ArweaveIdentityStorage;

  constructor(identityService: AgentIdentityService) {
    this.identityService = identityService;
    this.storage = createArweaveStorage();
  }

  /**
   * Generate a proof in response to a challenge.
   */
  async generateProof(
    challenge: CombinedChallenge,
    seed?: Seed,
    behavioralResponse?: string
  ): Promise<{
    proof: CombinedProof;
    chain: IdentityRecord[];
    seed?: Seed;
  }> {
    if (!this.identityService.isInitialized()) {
      throw new Error('Identity not initialized');
    }

    // Get our chain
    const chain = this.identityService.getChain();

    // Generate continuity proof
    const continuityProof = await this.identityService.proveContinuity(challenge);

    // Extend with SEED info if bound verification requested
    const proof: CombinedProof = {
      ...continuityProof,
    };

    if (challenge.verification_level !== 'crypto' && seed) {
      const { hashSeed } = await import('../behavioral/PersistenceProtocol');
      proof.seed_hash = hashSeed(seed);
    }

    if (challenge.verification_level === 'full' && behavioralResponse) {
      proof.behavioral_response = behavioralResponse;
    }

    return {
      proof,
      chain,
      seed: challenge.verification_level !== 'crypto' ? seed : undefined,
    };
  }
}

// ============================================================================
// EXPRESS/NEXT.JS HANDLERS
// ============================================================================

export function createChallengeHandlers(config: ChallengeServiceConfig) {
  const service = new ChallengeService(config);

  const createChallengeHandler = async (req: any, res: any) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const request: CreateChallengeRequest = req.body;

    if (!request.challengerDid || !request.targetDid || !request.level) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    const response = await service.createChallenge(request);
    res.status(response.success ? 200 : 400).json(response);
  };

  const submitProofHandler = async (req: any, res: any) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const request: SubmitProofRequest = req.body;
    const paymentSignature = req.headers['payment-signature'];

    if (!request.challenge || !request.proof || !request.chain) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    const response = await service.submitProof(request, paymentSignature);
    res.status(response.success ? 200 : 400).json(response);
  };

  return {
    createChallenge: createChallengeHandler,
    submitProof: submitProofHandler,
  };
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

export function createChallengeService(
  config: ChallengeServiceConfig
): ChallengeService {
  return new ChallengeService(config);
}

export function createChallengeResponder(
  identityService: AgentIdentityService
): ChallengeResponder {
  return new ChallengeResponder(identityService);
}

export default ChallengeService;
