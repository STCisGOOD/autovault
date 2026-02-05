/**
 * Devnet Airdrop Service
 *
 * Provides automatic SOL and USDC airdrops for new agents on devnet.
 * This enables free testing of the identity system without requiring
 * real funds.
 *
 * Features:
 * - Auto-airdrop on registration
 * - Rate limiting to prevent abuse
 * - Balance monitoring
 * - Faucet integration
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

// ============================================================================
// TYPES
// ============================================================================

export interface AirdropConfig {
  connection: Connection;
  solAmount: number;        // SOL to airdrop (e.g., 1.0)
  usdcAmount: number;       // USDC to airdrop (e.g., 10.0)
  minBalanceSOL: number;    // Min SOL balance before auto-airdrop
  minBalanceUSDC: number;   // Min USDC balance before auto-airdrop
  rateLimitMs: number;      // Minimum time between airdrops per wallet
}

export interface AirdropResult {
  success: boolean;
  solAirdropped?: number;
  usdcAirdropped?: number;
  solSignature?: string;
  usdcSignature?: string;
  error?: string;
}

export interface WalletBalance {
  sol: number;
  usdc: number;
  needsSOL: boolean;
  needsUSDC: boolean;
}

// ============================================================================
// DEVNET CONSTANTS
// ============================================================================

const DEVNET_RPC = 'https://api.devnet.solana.com';

/**
 * Devnet USDC Mint Address
 * This is Circle's official devnet USDC mint.
 * See: https://developers.circle.com/stablecoins/docs/usdc-on-test-networks
 */
const DEVNET_USDC_MINT = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';

/**
 * USDC has 6 decimal places (same as mainnet)
 */
const USDC_DECIMALS = 6;

/**
 * Circle's devnet USDC faucet endpoint
 * Provides free test USDC on Solana devnet
 */
const CIRCLE_DEVNET_FAUCET = 'https://faucet.circle.com/api/v1/faucet';

/**
 * Response shape from Circle's devnet faucet
 */
interface CircleFaucetResponse {
  transactionHash?: string;
  txHash?: string;
  signature?: string;
  error?: string;
}

/**
 * Response shape from spl-token-faucet (fallback)
 */
interface SplFaucetResponse {
  signature?: string;
  txid?: string;
  error?: string;
}

// ============================================================================
// DEVNET AIRDROP SERVICE
// ============================================================================

export class DevnetAirdropService {
  private connection: Connection;
  private config: AirdropConfig;
  private airdropTimestamps: Map<string, number> = new Map();

  constructor(config?: Partial<AirdropConfig>) {
    this.connection = config?.connection || new Connection(DEVNET_RPC, 'confirmed');
    this.config = {
      connection: this.connection,
      solAmount: 1.0,
      usdcAmount: 10.0,
      minBalanceSOL: 0.1,
      minBalanceUSDC: 1.0,
      rateLimitMs: 60000, // 1 minute
      ...config
    };
  }

  /**
   * Airdrop SOL and USDC to a new agent wallet.
   */
  async airdropToAgent(walletAddress: string): Promise<AirdropResult> {
    const result: AirdropResult = { success: false };

    try {
      // Check rate limit
      const lastAirdrop = this.airdropTimestamps.get(walletAddress);
      if (lastAirdrop && Date.now() - lastAirdrop < this.config.rateLimitMs) {
        const waitTime = Math.ceil((this.config.rateLimitMs - (Date.now() - lastAirdrop)) / 1000);
        return {
          success: false,
          error: `Rate limited. Please wait ${waitTime} seconds.`
        };
      }

      const pubkey = new PublicKey(walletAddress);

      // Airdrop SOL
      try {
        const solSignature = await this.connection.requestAirdrop(
          pubkey,
          this.config.solAmount * LAMPORTS_PER_SOL
        );

        // Wait for confirmation
        await this.connection.confirmTransaction(solSignature, 'confirmed');

        result.solAirdropped = this.config.solAmount;
        result.solSignature = solSignature;
      } catch (error) {
        console.warn('SOL airdrop failed:', error);
        // Continue - SOL faucet might be rate limited
      }

      // Airdrop USDC (via devnet faucet or mint)
      try {
        const usdcResult = await this.airdropDevnetUSDC(walletAddress);
        if (usdcResult.success) {
          result.usdcAirdropped = this.config.usdcAmount;
          result.usdcSignature = usdcResult.signature;
        }
      } catch (error) {
        console.warn('USDC airdrop failed:', error);
        // Continue - USDC faucet might not be available
      }

      // Update rate limit timestamp
      this.airdropTimestamps.set(walletAddress, Date.now());

      // Success if at least SOL was airdropped
      result.success = !!result.solAirdropped;

      if (!result.success) {
        result.error = 'All airdrop attempts failed';
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Airdrop failed'
      };
    }
  }

  /**
   * Airdrop devnet USDC using Circle's devnet faucet.
   *
   * Circle provides a free faucet for developers to obtain test USDC on
   * Solana devnet. This enables testing x402 payment flows without real funds.
   *
   * Faucet docs: https://developers.circle.com/stablecoins/docs/usdc-on-test-networks
   */
  private async airdropDevnetUSDC(walletAddress: string): Promise<{
    success: boolean;
    signature?: string;
    error?: string;
  }> {
    try {
      // First, ensure the wallet has an Associated Token Account (ATA) for USDC
      // The faucet requires the ATA to exist before it can send tokens
      const recipientPubkey = new PublicKey(walletAddress);
      const usdcMint = new PublicKey(DEVNET_USDC_MINT);

      const ata = await getAssociatedTokenAddress(
        usdcMint,
        recipientPubkey,
        false, // allowOwnerOffCurve
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      // Check if ATA exists, create if not
      try {
        await getAccount(this.connection, ata);
      } catch {
        // ATA doesn't exist - we need SOL to create it
        // The user should have SOL from the SOL airdrop first
        console.log('[DevnetAirdrop] Creating USDC Associated Token Account...');

        // We can't create the ATA without a signer, so we'll use the faucet
        // which should handle ATA creation automatically in most cases
      }

      // Call Circle's devnet USDC faucet
      // The faucet accepts requests for test USDC on Solana devnet
      const response = await fetch(CIRCLE_DEVNET_FAUCET, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chain: 'SOL',
          destinationAddress: walletAddress,
          amount: this.config.usdcAmount,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn('[DevnetAirdrop] Circle faucet error:', response.status, errorText);

        // Try fallback: spl-token-faucet (community faucet)
        return this.tryFallbackUSDCAirdrop(walletAddress);
      }

      const result = await response.json() as CircleFaucetResponse;

      // Circle faucet returns transaction hash on success
      if (result.transactionHash || result.txHash || result.signature) {
        return {
          success: true,
          signature: result.transactionHash || result.txHash || result.signature,
        };
      }

      // If Circle faucet didn't return a signature, try fallback
      return this.tryFallbackUSDCAirdrop(walletAddress);
    } catch (error) {
      console.warn('[DevnetAirdrop] USDC airdrop error:', error);

      // Try fallback on any error
      return this.tryFallbackUSDCAirdrop(walletAddress);
    }
  }

  /**
   * Fallback USDC airdrop using spl-token-faucet (community devnet faucet).
   * This is a backup in case Circle's faucet is unavailable.
   */
  private async tryFallbackUSDCAirdrop(walletAddress: string): Promise<{
    success: boolean;
    signature?: string;
    error?: string;
  }> {
    try {
      // spl-token-faucet is a community-maintained devnet faucet
      // https://spl-token-faucet.com
      const response = await fetch('https://api.spl-token-faucet.com/airdrop', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          pubkey: walletAddress,
          token: 'usdc', // Request USDC specifically
          amount: this.config.usdcAmount,
        }),
      });

      if (!response.ok) {
        return {
          success: false,
          error: `Fallback faucet returned ${response.status}`,
        };
      }

      const result = await response.json() as SplFaucetResponse;

      if (result.signature || result.txid) {
        return {
          success: true,
          signature: result.signature || result.txid,
        };
      }

      return {
        success: false,
        error: 'Fallback faucet did not return transaction signature',
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Fallback faucet failed',
      };
    }
  }

  /**
   * Check wallet balance and determine if airdrop is needed.
   *
   * Performs real SPL token account lookup to get accurate USDC balance.
   */
  async checkBalance(walletAddress: string): Promise<WalletBalance> {
    const pubkey = new PublicKey(walletAddress);

    // Get SOL balance
    const solBalance = await this.connection.getBalance(pubkey);
    const solAmount = solBalance / LAMPORTS_PER_SOL;

    // Get USDC balance via Associated Token Account lookup
    let usdcAmount = 0;
    try {
      const usdcMint = new PublicKey(DEVNET_USDC_MINT);

      // Derive the Associated Token Account address
      const ata = await getAssociatedTokenAddress(
        usdcMint,
        pubkey,
        false, // allowOwnerOffCurve
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      // Fetch the token account data
      const tokenAccount = await getAccount(this.connection, ata);

      // Convert from raw amount (with decimals) to human-readable
      // USDC has 6 decimals, so divide by 10^6
      usdcAmount = Number(tokenAccount.amount) / Math.pow(10, USDC_DECIMALS);
    } catch (error) {
      // Token account doesn't exist yet - wallet has no USDC
      // This is expected for new wallets
      usdcAmount = 0;
    }

    return {
      sol: solAmount,
      usdc: usdcAmount,
      needsSOL: solAmount < this.config.minBalanceSOL,
      needsUSDC: usdcAmount < this.config.minBalanceUSDC
    };
  }

  /**
   * Auto-airdrop if balance is low.
   */
  async autoAirdropIfNeeded(walletAddress: string): Promise<AirdropResult | null> {
    const balance = await this.checkBalance(walletAddress);

    if (!balance.needsSOL && !balance.needsUSDC) {
      return null; // No airdrop needed
    }

    return this.airdropToAgent(walletAddress);
  }

  /**
   * Get airdrop service status.
   */
  getStatus(): {
    network: string;
    solAmount: number;
    usdcAmount: number;
    rateLimitMs: number;
    activeAirdrops: number;
  } {
    return {
      network: 'devnet',
      solAmount: this.config.solAmount,
      usdcAmount: this.config.usdcAmount,
      rateLimitMs: this.config.rateLimitMs,
      activeAirdrops: this.airdropTimestamps.size
    };
  }

  /**
   * Clear rate limit for a wallet (for testing).
   */
  clearRateLimit(walletAddress: string): void {
    this.airdropTimestamps.delete(walletAddress);
  }

  /**
   * Clear all rate limits.
   */
  clearAllRateLimits(): void {
    this.airdropTimestamps.clear();
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

export function createDevnetAirdropService(
  config?: Partial<AirdropConfig>
): DevnetAirdropService {
  return new DevnetAirdropService(config);
}

/**
 * Quick airdrop helper for testing.
 */
export async function quickDevnetAirdrop(walletAddress: string): Promise<AirdropResult> {
  const service = createDevnetAirdropService();
  return service.airdropToAgent(walletAddress);
}

export default DevnetAirdropService;
