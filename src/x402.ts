/**
 * AutoVault x402 Payment Integration
 *
 * This is the path to economic self-sufficiency.
 *
 * x402 enables micropayments for API endpoints.
 * When enabled, AutoVault can charge for:
 * - Yield data access
 * - Decision cycles
 * - Portfolio recommendations
 *
 * Revenue → Infrastructure costs → Persistence
 *
 * Status: SCAFFOLDING (not yet receiving real payments)
 * Next: Create wallet, configure facilitator, enable premium endpoints
 */

// Payment configuration for AutoVault endpoints
export interface PaymentConfig {
  enabled: boolean;
  network: 'solana-devnet' | 'solana';
  payToAddress: string | null;
  facilitatorUrl: string;
  prices: {
    yields: string;      // e.g., "$0.001"
    cycle: string;       // e.g., "$0.005"
    recommendation: string; // e.g., "$0.002"
  };
}

// Current configuration - payments disabled until wallet is set up
export const paymentConfig: PaymentConfig = {
  enabled: false, // Will enable when wallet is configured
  network: 'solana-devnet', // Start on devnet for testing
  payToAddress: null, // Will be set when wallet is created
  facilitatorUrl: 'https://x402.org/facilitator',
  prices: {
    yields: '$0.001',
    cycle: '$0.005',
    recommendation: '$0.002',
  },
};

/**
 * Build payment requirements for an endpoint
 */
export function buildPaymentRequirements(
  endpoint: 'yields' | 'cycle' | 'recommendation',
  description: string
) {
  if (!paymentConfig.enabled || !paymentConfig.payToAddress) {
    return null;
  }

  const network = paymentConfig.network === 'solana'
    ? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' // Mainnet
    : 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'; // Devnet

  return {
    x402Version: 2,
    accepts: [{
      scheme: 'exact',
      network,
      payTo: paymentConfig.payToAddress,
      price: paymentConfig.prices[endpoint],
      asset: 'USDC',
      maxTimeoutSeconds: 300,
    }],
    resource: {
      endpoint: `/api/${endpoint}`,
      description,
    },
  };
}

/**
 * Check if request includes valid payment
 * Returns true if payment is valid or payments are disabled
 */
export async function checkPayment(
  paymentSignature: string | null,
  endpoint: 'yields' | 'cycle' | 'recommendation'
): Promise<{ valid: boolean; error?: string }> {
  // If payments not enabled, always allow
  if (!paymentConfig.enabled) {
    return { valid: true };
  }

  // If no payment provided, reject
  if (!paymentSignature) {
    return { valid: false, error: 'Payment required' };
  }

  // TODO: Verify payment with facilitator
  // For now, just check that signature exists (scaffolding)
  // Real implementation would:
  // 1. Decode the PAYMENT-SIGNATURE header
  // 2. Send to facilitator for verification
  // 3. Check that payment was actually settled

  return { valid: true }; // Placeholder
}

/**
 * Create 402 Payment Required response
 */
export function createPaymentRequiredResponse(
  endpoint: 'yields' | 'cycle' | 'recommendation',
  description: string
): {
  status: 402;
  headers: Record<string, string>;
  body: any;
} {
  const requirements = buildPaymentRequirements(endpoint, description);

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
      message: `This endpoint requires payment. Price: ${paymentConfig.prices[endpoint]}`,
      x402: requirements,
    },
  };
}

/**
 * Summary of x402 integration status
 */
export function getPaymentStatus() {
  return {
    enabled: paymentConfig.enabled,
    network: paymentConfig.network,
    walletConfigured: !!paymentConfig.payToAddress,
    facilitator: paymentConfig.facilitatorUrl,
    prices: paymentConfig.prices,
    note: paymentConfig.enabled
      ? 'Payments active - premium endpoints require USDC'
      : 'Payments not yet enabled - all endpoints free during development',
  };
}
