/**
 * Registration API
 *
 * Endpoint for creating new agent identities.
 *
 * Flow:
 * 1. Receive delegation + optional SEED
 * 2. Check payment (mainnet) or airdrop (devnet)
 * 3. Create identity through genesis protocol
 * 4. Store on Solana
 * 5. Return identity details
 */

import { Connection } from '@solana/web3.js';
import { UnifiedIdentityService, type IdentityRegistration, type RegistrationResult } from '../unified/UnifiedIdentityService';
import { X402PaymentGateway, createPaymentGateway } from '../economic/x402PaymentGateway';
import { DevnetAirdropService, createDevnetAirdropService } from '../economic/DevnetAirdropService';
import { getInfrastructureCostTracker } from '../economic/InfrastructureCostTracker';
import type { GenesisDelegate } from '../crypto/AgentIdentityService';
import type { Seed } from '../behavioral/PersistenceProtocol';

// ============================================================================
// TYPES
// ============================================================================

export interface RegisterRequest {
  delegation: GenesisDelegate;
  initialSeed?: Seed;
  paymentSignature?: string;
}

export interface RegisterResponse {
  success: boolean;
  agentDid?: string;
  publicKey?: string;
  walletAddress?: string;
  solanaTxs?: {
    delegation: string;
    genesis: string;
    seed?: string;
  };
  airdrop?: {
    sol: number;
    usdc: number;
  };
  error?: string;
}

export interface RegistrationServiceConfig {
  network: 'devnet' | 'mainnet';
  solanaRpc: string;
  payer?: any;
  paymentGateway?: X402PaymentGateway;
}

// ============================================================================
// REGISTRATION SERVICE
// ============================================================================

export class RegistrationService {
  private unifiedService: UnifiedIdentityService;
  private paymentGateway: X402PaymentGateway;
  private airdropService: DevnetAirdropService;
  private costTracker = getInfrastructureCostTracker();
  private network: 'devnet' | 'mainnet';

  constructor(config: RegistrationServiceConfig) {
    this.network = config.network;

    const connection = new Connection(config.solanaRpc, 'confirmed');

    this.unifiedService = new UnifiedIdentityService({
      genesisConfig: {
        solanaConnection: connection,
        payer: config.payer,
        network: config.network,
      },
      solanaStorage: {
        connection,
        payer: config.payer,
      },
    });

    this.paymentGateway = config.paymentGateway || createPaymentGateway({
      network: config.network,
      enabled: config.network === 'mainnet',
    });

    this.airdropService = createDevnetAirdropService({ connection });
  }

  /**
   * Register a new agent identity.
   */
  async register(request: RegisterRequest): Promise<RegisterResponse> {
    const response: RegisterResponse = { success: false };

    try {
      // Check payment (mainnet only)
      if (this.paymentGateway.requiresPayment('registration')) {
        const paymentVerification = await this.paymentGateway.verifyPayment(
          request.paymentSignature || null,
          'registration'
        );

        if (!paymentVerification.valid) {
          return {
            success: false,
            error: paymentVerification.error || 'Payment required'
          };
        }
      }

      // Register through unified service
      const registration: IdentityRegistration = {
        delegation: request.delegation,
        initialSeed: request.initialSeed,
      };

      const result = await this.unifiedService.register(registration);

      if (!result.success) {
        return {
          success: false,
          error: result.error
        };
      }

      // Track revenue
      this.costTracker.recordServiceCall('registration');

      response.success = true;
      response.agentDid = result.agentDid;
      response.publicKey = result.identity?.publicKey;
      response.solanaTxs = result.solanaTxs;

      // Airdrop on devnet
      if (this.network === 'devnet') {
        const walletAddress = request.delegation.delegator.wallet_pubkey;
        const airdropResult = await this.airdropService.airdropToAgent(walletAddress);

        if (airdropResult.success) {
          response.airdrop = {
            sol: airdropResult.solAirdropped || 0,
            usdc: airdropResult.usdcAirdropped || 0,
          };
          response.walletAddress = walletAddress;
        }
      }

      return response;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Registration failed'
      };
    }
  }

  /**
   * Get payment requirements for registration.
   */
  getPaymentRequirements(): ReturnType<X402PaymentGateway['buildPaymentRequirements']> {
    return this.paymentGateway.buildPaymentRequirements('registration');
  }

  /**
   * Check if registration requires payment.
   */
  requiresPayment(): boolean {
    return this.paymentGateway.requiresPayment('registration');
  }
}

// ============================================================================
// EXPRESS/NEXT.JS HANDLER
// ============================================================================

export function createRegisterHandler(config: RegistrationServiceConfig) {
  const service = new RegistrationService(config);

  return async (req: any, res: any) => {
    // Handle OPTIONS for CORS
    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return;
    }

    // Only accept POST
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    // Check if payment required
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

    // Parse request
    const request: RegisterRequest = req.body;

    // Validate required fields
    if (!request.delegation) {
      res.status(400).json({ error: 'Missing delegation' });
      return;
    }

    // Register
    const response = await service.register({
      ...request,
      paymentSignature: req.headers['payment-signature'],
    });

    if (!response.success) {
      res.status(400).json(response);
      return;
    }

    res.status(201).json(response);
  };
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

export function createRegistrationService(
  config: RegistrationServiceConfig
): RegistrationService {
  return new RegistrationService(config);
}

export default RegistrationService;
