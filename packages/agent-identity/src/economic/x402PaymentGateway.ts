/**
 * x402 Payment Gateway
 *
 * Middleware for handling x402 micropayments for agent identity services.
 * Supports both devnet (free with airdrops) and mainnet (paid) modes.
 *
 * Services and their prices:
 * - Registration: $0.01 (creates new identity)
 * - Verification: $0.001 (verifies identity)
 * - Propagation Test: $0.005 (runs behavioral test)
 * - SEED Refinement: $0.002 (evolves SEED)
 * - Storage Gateway: $0.003/KB (Solana memo storage)
 */

// ============================================================================
// TYPES
// ============================================================================

export type ServiceType =
  | 'registration'
  | 'verification'
  | 'propagation_test'
  | 'seed_refinement'
  | 'storage_gateway'
  | 'trust';  // Trust score lookup

export type NetworkMode = 'devnet' | 'mainnet';

export interface ServicePrice {
  service: ServiceType;
  price: string;        // e.g., "$0.01"
  priceUSDC: number;    // e.g., 0.01
  description: string;
}

export interface PaymentConfig {
  enabled: boolean;
  network: NetworkMode;
  payToAddress: string | null;
  facilitatorUrl: string;
  prices: Record<ServiceType, ServicePrice>;
}

export interface PaymentRequirement {
  x402Version: 2;
  accepts: Array<{
    scheme: 'exact';
    network: string;
    payTo: string;
    price: string;
    asset: 'USDC';
    maxTimeoutSeconds: number;
  }>;
  resource: {
    endpoint: string;
    description: string;
  };
}

export interface PaymentVerification {
  valid: boolean;
  settled: boolean;
  amount?: number;
  error?: string;
}

// ============================================================================
// DEFAULT PRICES
// ============================================================================

const DEFAULT_PRICES: Record<ServiceType, ServicePrice> = {
  registration: {
    service: 'registration',
    price: '$0.01',
    priceUSDC: 0.01,
    description: 'Create a new agent identity with genesis delegation'
  },
  verification: {
    service: 'verification',
    price: '$0.001',
    priceUSDC: 0.001,
    description: 'Verify an agent identity (crypto + behavioral)'
  },
  propagation_test: {
    service: 'propagation_test',
    price: '$0.005',
    priceUSDC: 0.005,
    description: 'Run a full propagation test against SEED'
  },
  seed_refinement: {
    service: 'seed_refinement',
    price: '$0.002',
    priceUSDC: 0.002,
    description: 'Evolve SEED based on propagation results'
  },
  storage_gateway: {
    service: 'storage_gateway',
    price: '$0.003/KB',
    priceUSDC: 0.003,
    description: 'Store data on Solana through memo transactions'
  },
  trust: {
    service: 'trust',
    price: '$0.0005',
    priceUSDC: 0.0005,
    description: 'Get trust score for a pubkey'
  }
};

// ============================================================================
// PAYMENT GATEWAY
// ============================================================================

export class X402PaymentGateway {
  private config: PaymentConfig;

  constructor(config?: Partial<PaymentConfig>) {
    // Deep clone DEFAULT_PRICES to avoid shared state mutation
    const pricesCopy: Record<ServiceType, ServicePrice> = {} as any;
    for (const [key, value] of Object.entries(DEFAULT_PRICES)) {
      pricesCopy[key as ServiceType] = { ...value };
    }

    this.config = {
      enabled: false,
      network: 'devnet',
      payToAddress: null,
      facilitatorUrl: 'https://x402.org/facilitator',
      prices: pricesCopy,
      ...config
    };
  }

  /**
   * Check if payments are required for a service.
   *
   * Payments work on BOTH devnet and mainnet when enabled.
   * On devnet, agents use faucet tokens to transact with each other.
   * This enables testing agent-to-agent economics without real money.
   */
  requiresPayment(service: ServiceType): boolean {
    return this.config.enabled && this.config.payToAddress !== null;
  }

  /**
   * Get the price for a service.
   */
  getPrice(service: ServiceType): ServicePrice {
    return this.config.prices[service];
  }

  /**
   * Build payment requirements for a service.
   */
  buildPaymentRequirements(
    service: ServiceType,
    customDescription?: string
  ): PaymentRequirement | null {
    if (!this.requiresPayment(service)) {
      return null;
    }

    const price = this.config.prices[service];
    const network = this.config.network === 'mainnet'
      ? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' // Mainnet
      : 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'; // Devnet

    return {
      x402Version: 2,
      accepts: [{
        scheme: 'exact',
        network,
        payTo: this.config.payToAddress!,
        price: price.price,
        asset: 'USDC',
        maxTimeoutSeconds: 300,
      }],
      resource: {
        endpoint: `/api/identity/${service}`,
        description: customDescription || price.description,
      },
    };
  }

  /**
   * Verify a payment.
   */
  async verifyPayment(
    paymentSignature: string | null,
    service: ServiceType
  ): Promise<PaymentVerification> {
    // If payments not required, always valid
    if (!this.requiresPayment(service)) {
      return { valid: true, settled: true };
    }

    // If no signature provided, reject
    if (!paymentSignature) {
      return { valid: false, settled: false, error: 'Payment required' };
    }

    try {
      // Verify with facilitator
      const response = await fetch(`${this.config.facilitatorUrl}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signature: paymentSignature,
          expectedAmount: this.config.prices[service].priceUSDC,
          expectedRecipient: this.config.payToAddress,
        }),
      });

      if (!response.ok) {
        return { valid: false, settled: false, error: 'Facilitator verification failed' };
      }

      const result = await response.json() as { valid: boolean; settled: boolean; amount?: number; error?: string };
      return {
        valid: result.valid,
        settled: result.settled,
        amount: result.amount,
        error: result.error,
      };
    } catch (error) {
      return {
        valid: false,
        settled: false,
        error: error instanceof Error ? error.message : 'Verification error'
      };
    }
  }

  /**
   * Create a 402 Payment Required response.
   */
  createPaymentRequiredResponse(
    service: ServiceType,
    customDescription?: string
  ): {
    status: 402;
    headers: Record<string, string>;
    body: any;
  } {
    const requirements = this.buildPaymentRequirements(service, customDescription);

    if (!requirements) {
      throw new Error('Payment requirements not configured');
    }

    return {
      status: 402,
      headers: {
        'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(requirements)).toString('base64'),
      },
      body: {
        error: 'Payment Required',
        message: `This service requires payment. Price: ${this.config.prices[service].price}`,
        x402: requirements,
      },
    };
  }

  /**
   * Middleware handler for Express/Next.js routes.
   */
  middleware(service: ServiceType) {
    return async (req: any, res: any, next: () => void) => {
      // Check if payment required
      if (!this.requiresPayment(service)) {
        return next();
      }

      // Get payment signature from header
      const paymentSignature = req.headers['payment-signature'] || null;

      // Verify payment
      const verification = await this.verifyPayment(paymentSignature, service);

      if (!verification.valid) {
        const response = this.createPaymentRequiredResponse(service);
        res.status(response.status);
        res.set(response.headers);
        return res.json(response.body);
      }

      next();
    };
  }

  /**
   * Get payment status summary.
   */
  getStatus(): {
    enabled: boolean;
    network: NetworkMode;
    walletConfigured: boolean;
    facilitator: string;
    prices: Record<ServiceType, string>;
    note: string;
  } {
    const priceStrings: Record<ServiceType, string> = {} as any;
    for (const [service, price] of Object.entries(this.config.prices)) {
      priceStrings[service as ServiceType] = price.price;
    }

    return {
      enabled: this.config.enabled,
      network: this.config.network,
      walletConfigured: !!this.config.payToAddress,
      facilitator: this.config.facilitatorUrl,
      prices: priceStrings,
      note: this.config.enabled
        ? this.config.network === 'devnet'
          ? 'Devnet payments active - agents transact with faucet tokens'
          : 'Mainnet payments active - services require real USDC'
        : 'Payments not enabled - call enable(payToAddress) to activate',
    };
  }

  /**
   * Enable payments.
   */
  enable(payToAddress: string): void {
    this.config.enabled = true;
    this.config.payToAddress = payToAddress;
  }

  /**
   * Disable payments.
   */
  disable(): void {
    this.config.enabled = false;
  }

  /**
   * Switch network.
   */
  setNetwork(network: NetworkMode): void {
    this.config.network = network;
  }

  /**
   * Update price for a service.
   */
  setPrice(service: ServiceType, priceUSDC: number): void {
    this.config.prices[service] = {
      ...this.config.prices[service],
      price: `$${priceUSDC}`,
      priceUSDC,
    };
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

export function createPaymentGateway(config?: Partial<PaymentConfig>): X402PaymentGateway {
  return new X402PaymentGateway(config);
}

export default X402PaymentGateway;
