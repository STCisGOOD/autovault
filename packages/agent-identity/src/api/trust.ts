/**
 * Trust API
 *
 * Simple trust score endpoint for agent-to-agent verification.
 * Designed for easy integration - just pubkey in, scores out.
 *
 * Usage:
 *   GET /api/trust?pubkey=<base58>
 *
 * Response:
 *   {
 *     trust_score: 72,           // 0-100 (composite score)
 *     identity_age_days: 45,     // Days since genesis
 *     spam_risk: "low",          // "low" | "medium" | "high"
 *     track_record: "established", // "none" | "some" | "established"
 *     verified: true,            // Identity chain valid
 *     sybil_resistant: true      // Has behavioral history
 *   }
 *
 * Requested by:
 * - kai (Agent Mail): trust_score, identity_age, spam_risk
 * - OmaClaw (GigClaw): track_record, sybil resistance
 */

import { CombinedVerifier, createCombinedVerifier, type CombinedVerificationResult } from '../unified/CombinedVerification';
import { X402PaymentGateway, createPaymentGateway } from '../economic/x402PaymentGateway';
import { getInfrastructureCostTracker } from '../economic/InfrastructureCostTracker';
import type { SolanaStorageConfig } from '../crypto/SolanaIdentityStorage';
import { PublicKey } from '@solana/web3.js';

// ============================================================================
// TYPES
// ============================================================================

export type SpamRisk = 'low' | 'medium' | 'high';
export type TrackRecord = 'none' | 'some' | 'established';

export interface TrustRequest {
  pubkey: string;
  paymentSignature?: string;
}

export interface TrustResponse {
  success: boolean;
  pubkey: string;
  trust_score: number;           // 0-100
  identity_age_days: number;     // Days since genesis
  spam_risk: SpamRisk;           // Based on behavior patterns
  track_record: TrackRecord;     // Based on chain length + activity
  verified: boolean;             // Identity chain valid
  sybil_resistant: boolean;      // Has meaningful behavioral history
  details?: {
    chain_length: number;
    divergence_score?: number;
    seed_bound: boolean;
    last_activity_slot?: number;
  };
  error?: string;
}

export interface BatchTrustRequest {
  pubkeys: string[];
  paymentSignature?: string;
}

export interface BatchTrustResponse {
  success: boolean;
  results: TrustResponse[];
  summary: {
    total: number;
    verified: number;
    average_trust_score: number;
  };
}

export interface TrustServiceConfig {
  network: 'devnet' | 'mainnet';
  solanaStorage: SolanaStorageConfig;
  divergenceThreshold?: number;
  paymentGateway?: X402PaymentGateway;
}

// ============================================================================
// TRUST SCORE COMPUTATION
// ============================================================================

/**
 * Compute trust score from verification result.
 *
 * Scoring formula:
 * - Base: 50 points for valid identity chain
 * - SEED bound: +15 points
 * - Low divergence: +20 points (inversely proportional to divergence)
 * - Chain length: +15 points (scales with activity)
 *
 * Total: 0-100
 */
function computeTrustScore(
  result: CombinedVerificationResult,
  chainLength: number
): number {
  let score = 0;

  // Base score for valid chain
  if (result.cryptoVerification.passed) {
    score += 50;
  }

  // SEED binding bonus
  if (result.boundVerification?.seedHashMatches) {
    score += 15;
  }

  // Behavioral alignment (inverse of divergence)
  if (result.behavioralVerification?.divergenceScore !== undefined) {
    const divergence = result.behavioralVerification.divergenceScore;
    // Low divergence = high bonus (0 divergence = 20 points, 1 divergence = 0 points)
    score += Math.round(20 * (1 - Math.min(divergence, 1)));
  } else if (result.boundVerification?.passed) {
    // No behavioral data but SEED bound - give partial credit
    score += 10;
  }

  // Chain length bonus (logarithmic scaling)
  // 1 record = 0, 10 records = 7.5, 100 records = 15
  if (chainLength > 0) {
    score += Math.min(15, Math.round(7.5 * Math.log10(chainLength + 1)));
  }

  return Math.min(100, Math.max(0, score));
}

/**
 * Determine spam risk based on behavior patterns.
 */
function computeSpamRisk(
  result: CombinedVerificationResult,
  chainLength: number,
  identityAgeDays: number
): SpamRisk {
  // New identity with no history = high risk
  if (chainLength <= 1 && identityAgeDays < 1) {
    return 'high';
  }

  // Short history relative to age = medium risk
  if (chainLength < 5 && identityAgeDays < 7) {
    return 'medium';
  }

  // High divergence = medium risk (erratic behavior)
  if (result.behavioralVerification?.divergenceScore !== undefined) {
    if (result.behavioralVerification.divergenceScore > 0.5) {
      return 'medium';
    }
  }

  // Not SEED bound = medium risk
  if (!result.boundVerification?.seedHashMatches) {
    return 'medium';
  }

  return 'low';
}

/**
 * Determine track record level.
 */
function computeTrackRecord(
  chainLength: number,
  identityAgeDays: number,
  hasBehavioralData: boolean
): TrackRecord {
  // No chain = none
  if (chainLength === 0) {
    return 'none';
  }

  // Established: significant history + age + behavioral data
  if (chainLength >= 10 && identityAgeDays >= 7 && hasBehavioralData) {
    return 'established';
  }

  // Some: has activity
  if (chainLength >= 2 || identityAgeDays >= 1) {
    return 'some';
  }

  return 'none';
}

/**
 * Convert pubkey to DID format.
 */
function pubkeyToDid(pubkey: string, network: 'devnet' | 'mainnet'): string {
  return `did:persistence:${network}:${pubkey}`;
}

/**
 * Validate base58 pubkey format.
 */
function isValidPubkey(pubkey: string): boolean {
  try {
    new PublicKey(pubkey);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// TRUST SERVICE
// ============================================================================

export class TrustService {
  private verifier: CombinedVerifier;
  private paymentGateway: X402PaymentGateway;
  private costTracker = getInfrastructureCostTracker();
  private network: 'devnet' | 'mainnet';
  private connection: import('@solana/web3.js').Connection;
  private cachedSlot: { value: number; timestamp: number } | null = null;
  private static readonly SLOT_CACHE_MS = 30_000;

  constructor(config: TrustServiceConfig) {
    this.connection = config.solanaStorage.connection;
    this.network = config.network;
    this.verifier = createCombinedVerifier(config.solanaStorage, {
      divergenceThreshold: config.divergenceThreshold || 0.35,
    });

    this.paymentGateway = config.paymentGateway || createPaymentGateway({
      network: config.network,
      enabled: config.network === 'mainnet',
    });
  }

  /**
   * Get trust score for a pubkey.
   */
  async getTrust(request: TrustRequest): Promise<TrustResponse> {
    const { pubkey } = request;

    // Validate pubkey format
    if (!isValidPubkey(pubkey)) {
      return {
        success: false,
        pubkey,
        trust_score: 0,
        identity_age_days: 0,
        spam_risk: 'high',
        track_record: 'none',
        verified: false,
        sybil_resistant: false,
        error: 'Invalid pubkey format',
      };
    }

    try {
      // Check payment (mainnet only)
      if (this.paymentGateway.requiresPayment('trust')) {
        const paymentVerification = await this.paymentGateway.verifyPayment(
          request.paymentSignature || null,
          'trust'
        );

        if (!paymentVerification.valid) {
          return {
            success: false,
            pubkey,
            trust_score: 0,
            identity_age_days: 0,
            spam_risk: 'high',
            track_record: 'none',
            verified: false,
            sybil_resistant: false,
            error: paymentVerification.error || 'Payment required',
          };
        }
      }

      // Convert pubkey to DID
      const agentDid = pubkeyToDid(pubkey, this.network);

      // Perform verification (use 'full' to get behavioral data)
      const result = await this.verifier.verifyAgent(agentDid, 'full');

      // Extract chain info
      const chainLength = result.cryptoVerification.chainLength || 0;
      const genesisSlot = result.cryptoVerification.genesisSlot;

      // Compute identity age (approximate from slots)
      // Solana: ~400ms per slot, ~2.5 slots/sec, ~216000 slots/day
      const SLOTS_PER_DAY = 216000;
      let identityAgeDays = 0;
      if (genesisSlot !== undefined) {
        const currentSlot = await this.getCurrentSlot();
        const ageSlots = currentSlot - genesisSlot;
        identityAgeDays = Math.max(0, Math.floor(ageSlots / SLOTS_PER_DAY));
      }

      // Compute scores
      const trust_score = computeTrustScore(result, chainLength);
      const spam_risk = computeSpamRisk(result, chainLength, identityAgeDays);
      const hasBehavioralData = result.behavioralVerification?.divergenceScore !== undefined;
      const track_record = computeTrackRecord(chainLength, identityAgeDays, hasBehavioralData);

      // Track usage
      this.costTracker.recordServiceCall('trust');

      return {
        success: true,
        pubkey,
        trust_score,
        identity_age_days: identityAgeDays,
        spam_risk,
        track_record,
        verified: result.cryptoVerification.passed,
        sybil_resistant: chainLength >= 3 && hasBehavioralData,
        details: {
          chain_length: chainLength,
          divergence_score: result.behavioralVerification?.divergenceScore,
          seed_bound: result.boundVerification?.seedHashMatches || false,
          last_activity_slot: result.cryptoVerification.lastActivitySlot,
        },
      };
    } catch (error) {
      // Identity not found or verification failed
      return {
        success: true, // Request succeeded, but identity doesn't exist
        pubkey,
        trust_score: 0,
        identity_age_days: 0,
        spam_risk: 'high',
        track_record: 'none',
        verified: false,
        sybil_resistant: false,
        error: error instanceof Error ? error.message : 'Identity not found',
      };
    }
  }

  /**
   * Batch trust lookup for multiple pubkeys.
   */
  async getBatchTrust(request: BatchTrustRequest): Promise<BatchTrustResponse> {
    const results: TrustResponse[] = [];

    // Check payment for batch
    if (this.paymentGateway.requiresPayment('trust')) {
      const paymentVerification = await this.paymentGateway.verifyPayment(
        request.paymentSignature || null,
        'trust'
      );

      if (!paymentVerification.valid) {
        return {
          success: false,
          results: [],
          summary: {
            total: request.pubkeys.length,
            verified: 0,
            average_trust_score: 0,
          },
        };
      }
    }

    // Process each pubkey
    for (const pubkey of request.pubkeys) {
      const result = await this.getTrust({ pubkey });
      results.push(result);
    }

    // Compute summary
    const verified = results.filter(r => r.verified).length;
    const totalScore = results.reduce((sum, r) => sum + r.trust_score, 0);
    const average_trust_score = results.length > 0
      ? Math.round(totalScore / results.length)
      : 0;

    return {
      success: true,
      results,
      summary: {
        total: results.length,
        verified,
        average_trust_score,
      },
    };
  }

  /**
   * Quick trust check - just returns score.
   */
  async quickTrust(pubkey: string): Promise<number> {
    const result = await this.getTrust({ pubkey });
    return result.trust_score;
  }

  /**
   * Get payment requirements.
   */
  getPaymentRequirements(): ReturnType<X402PaymentGateway['buildPaymentRequirements']> {
    return this.paymentGateway.buildPaymentRequirements('trust');
  }

  /**
   * Check if trust queries require payment.
   */
  requiresPayment(): boolean {
    return this.paymentGateway.requiresPayment('trust');
  }

  /**
   * Get current Solana slot with 30-second caching.
   * Falls back to epoch-based approximation if RPC fails.
   */
  private async getCurrentSlot(): Promise<number> {
    // Return cached value if fresh
    if (this.cachedSlot && Date.now() - this.cachedSlot.timestamp < TrustService.SLOT_CACHE_MS) {
      return this.cachedSlot.value;
    }

    try {
      const slot = await this.connection.getSlot();
      this.cachedSlot = { value: slot, timestamp: Date.now() };
      return slot;
    } catch {
      // Fallback: approximate slot from elapsed time since Solana mainnet genesis.
      // Genesis: March 16, 2020 00:00:00 UTC. Slots average ~400ms.
      const SOLANA_GENESIS_MS = 1_584_316_800_000;
      return Math.floor((Date.now() - SOLANA_GENESIS_MS) / 400);
    }
  }
}

// ============================================================================
// EXPRESS/NEXT.JS HANDLER
// ============================================================================

export function createTrustHandler(config: TrustServiceConfig) {
  const service = new TrustService(config);

  return async (req: any, res: any) => {
    // Handle OPTIONS for CORS
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Payment-Signature');
      res.status(200).end();
      return;
    }

    // CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Accept GET or POST
    let pubkey: string | undefined;
    let pubkeys: string[] | undefined;

    if (req.method === 'GET') {
      pubkey = req.query.pubkey;
    } else if (req.method === 'POST') {
      pubkey = req.body.pubkey;
      pubkeys = req.body.pubkeys;
    } else {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    // Batch request
    if (pubkeys && Array.isArray(pubkeys)) {
      if (pubkeys.length > 100) {
        res.status(400).json({ error: 'Maximum 100 pubkeys per batch' });
        return;
      }

      const response = await service.getBatchTrust({
        pubkeys,
        paymentSignature: req.headers['payment-signature'],
      });

      res.status(response.success ? 200 : 402).json(response);
      return;
    }

    // Single request
    if (!pubkey) {
      res.status(400).json({
        error: 'Missing pubkey parameter',
        usage: 'GET /api/trust?pubkey=<base58> or POST with {"pubkey": "<base58>"}',
      });
      return;
    }

    // Check payment
    if (service.requiresPayment()) {
      const paymentSignature = req.headers['payment-signature'];
      if (!paymentSignature) {
        const requirements = service.getPaymentRequirements();
        res.status(402).json({
          error: 'Payment Required',
          x402: requirements,
        });
        return;
      }
    }

    // Get trust
    const response = await service.getTrust({
      pubkey,
      paymentSignature: req.headers['payment-signature'],
    });

    res.status(response.success ? 200 : 400).json(response);
  };
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

export function createTrustService(config: TrustServiceConfig): TrustService {
  return new TrustService(config);
}

export default TrustService;
