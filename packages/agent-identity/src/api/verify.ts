/**
 * Verification API
 *
 * Endpoint for verifying agent identities.
 *
 * Verification levels:
 * - crypto: Chain valid + not revoked
 * - bound: Crypto + SEED hash matches commitment
 * - full: Bound + behavioral test passes (interactive)
 */

import { CombinedVerifier, createCombinedVerifier, type VerificationLevel, type CombinedVerificationResult } from '../unified/CombinedVerification';
import { X402PaymentGateway, createPaymentGateway } from '../economic/x402PaymentGateway';
import { getInfrastructureCostTracker } from '../economic/InfrastructureCostTracker';
import type { SolanaStorageConfig } from '../crypto/SolanaIdentityStorage';

// ============================================================================
// TYPES
// ============================================================================

export interface VerifyRequest {
  agentDid: string;
  level?: VerificationLevel;
  paymentSignature?: string;
}

export interface VerifyResponse {
  success: boolean;
  verified: boolean;
  level: VerificationLevel;
  details?: {
    cryptoValid: boolean;
    behavioralValid?: boolean;
    chainIntegrity: boolean;
    seedBound?: boolean;
    divergenceScore?: number;
    chainLength?: number;
    seedVersion?: string;
  };
  error?: string;
}

export interface VerificationServiceConfig {
  network: 'devnet' | 'mainnet';
  solanaStorage: SolanaStorageConfig;
  divergenceThreshold?: number;
  paymentGateway?: X402PaymentGateway;
}

// ============================================================================
// VERIFICATION SERVICE
// ============================================================================

export class VerificationService {
  private verifier: CombinedVerifier;
  private paymentGateway: X402PaymentGateway;
  private costTracker = getInfrastructureCostTracker();

  constructor(config: VerificationServiceConfig) {
    this.verifier = createCombinedVerifier(config.solanaStorage, {
      divergenceThreshold: config.divergenceThreshold || 0.35,
    });

    this.paymentGateway = config.paymentGateway || createPaymentGateway({
      network: config.network,
      enabled: config.network === 'mainnet',
    });
  }

  /**
   * Verify an agent identity.
   */
  async verify(request: VerifyRequest): Promise<VerifyResponse> {
    const level = request.level || 'bound';

    try {
      // Check payment
      if (this.paymentGateway.requiresPayment('verification')) {
        const paymentVerification = await this.paymentGateway.verifyPayment(
          request.paymentSignature || null,
          'verification'
        );

        if (!paymentVerification.valid) {
          return {
            success: false,
            verified: false,
            level,
            error: paymentVerification.error || 'Payment required'
          };
        }
      }

      // Perform verification
      const result = await this.verifier.verifyAgent(request.agentDid, level);

      // Track usage
      this.costTracker.recordServiceCall('verification');

      return {
        success: true,
        verified: result.passed,
        level: result.level,
        details: {
          cryptoValid: result.cryptoVerification.passed,
          behavioralValid: result.behavioralVerification?.passed,
          chainIntegrity: result.cryptoVerification.chainValid,
          seedBound: result.boundVerification?.seedHashMatches,
          divergenceScore: result.behavioralVerification?.divergenceScore,
          seedVersion: result.boundVerification?.seedVersion,
        },
        error: result.error,
      };
    } catch (error) {
      return {
        success: false,
        verified: false,
        level,
        error: error instanceof Error ? error.message : 'Verification failed'
      };
    }
  }

  /**
   * Quick verification (crypto only).
   */
  async quickVerify(agentDid: string): Promise<boolean> {
    const result = await this.verify({ agentDid, level: 'crypto' });
    return result.verified;
  }

  /**
   * Get payment requirements for verification.
   */
  getPaymentRequirements(): ReturnType<X402PaymentGateway['buildPaymentRequirements']> {
    return this.paymentGateway.buildPaymentRequirements('verification');
  }

  /**
   * Check if verification requires payment.
   */
  requiresPayment(): boolean {
    return this.paymentGateway.requiresPayment('verification');
  }
}

// ============================================================================
// BATCH VERIFICATION
// ============================================================================

export interface BatchVerifyRequest {
  agentDids: string[];
  level?: VerificationLevel;
  paymentSignature?: string;
}

export interface BatchVerifyResponse {
  success: boolean;
  results: Array<{
    agentDid: string;
    verified: boolean;
    error?: string;
  }>;
  summary: {
    total: number;
    verified: number;
    failed: number;
  };
}

export class BatchVerificationService {
  private verificationService: VerificationService;
  private paymentGateway: X402PaymentGateway;
  private costTracker = getInfrastructureCostTracker();

  constructor(config: VerificationServiceConfig) {
    this.verificationService = new VerificationService(config);
    this.paymentGateway = config.paymentGateway || createPaymentGateway({
      network: config.network,
      enabled: config.network === 'mainnet',
    });
  }

  /**
   * Verify multiple agents in batch.
   */
  async verifyBatch(request: BatchVerifyRequest): Promise<BatchVerifyResponse> {
    const level = request.level || 'bound';
    const results: BatchVerifyResponse['results'] = [];

    // Check payment for batch (charges per verification)
    if (this.paymentGateway.requiresPayment('verification')) {
      const paymentVerification = await this.paymentGateway.verifyPayment(
        request.paymentSignature || null,
        'verification'
      );

      // For batch, we'd need to verify the payment covers all requests
      // This is simplified - real implementation would check total amount
      if (!paymentVerification.valid) {
        return {
          success: false,
          results: [],
          summary: { total: request.agentDids.length, verified: 0, failed: request.agentDids.length }
        };
      }
    }

    // Verify each agent
    for (const agentDid of request.agentDids) {
      const result = await this.verificationService.verify({
        agentDid,
        level,
      });

      results.push({
        agentDid,
        verified: result.verified,
        error: result.error,
      });
    }

    const verified = results.filter(r => r.verified).length;

    return {
      success: true,
      results,
      summary: {
        total: results.length,
        verified,
        failed: results.length - verified,
      },
    };
  }
}

// ============================================================================
// EXPRESS/NEXT.JS HANDLER
// ============================================================================

export function createVerifyHandler(config: VerificationServiceConfig) {
  const service = new VerificationService(config);

  return async (req: any, res: any) => {
    // Handle OPTIONS for CORS
    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return;
    }

    // Accept GET or POST
    let agentDid: string;
    let level: VerificationLevel = 'bound';

    if (req.method === 'GET') {
      agentDid = req.query.did || req.query.agentDid;
      level = req.query.level || 'bound';
    } else if (req.method === 'POST') {
      agentDid = req.body.agentDid;
      level = req.body.level || 'bound';
    } else {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    if (!agentDid) {
      res.status(400).json({ error: 'Missing agentDid' });
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

    // Verify
    const response = await service.verify({
      agentDid,
      level,
      paymentSignature: req.headers['payment-signature'],
    });

    res.status(response.success ? 200 : 400).json(response);
  };
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

export function createVerificationService(
  config: VerificationServiceConfig
): VerificationService {
  return new VerificationService(config);
}

export function createBatchVerificationService(
  config: VerificationServiceConfig
): BatchVerificationService {
  return new BatchVerificationService(config);
}

export default VerificationService;
