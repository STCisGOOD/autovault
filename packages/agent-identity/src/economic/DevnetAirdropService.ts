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

import { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair } from '@solana/web3.js';

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
const DEVNET_USDC_MINT = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr'; // Devnet USDC

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
   * Airdrop devnet USDC.
   * Note: This is a simplified implementation. Real devnet USDC requires
   * a faucet or mint authority.
   */
  private async airdropDevnetUSDC(walletAddress: string): Promise<{
    success: boolean;
    signature?: string;
  }> {
    // In a real implementation, this would:
    // 1. Call a devnet USDC faucet API
    // 2. Or use a mint authority to mint tokens
    // 3. Or transfer from a funded test wallet

    // For now, we'll attempt to use the SPL token faucet if available
    try {
      const response = await fetch('https://api.devnet.solana.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'requestAirdrop',
          params: [walletAddress, LAMPORTS_PER_SOL]
        })
      });

      // This is a placeholder - real USDC airdrop would need faucet integration
      return { success: false };
    } catch {
      return { success: false };
    }
  }

  /**
   * Check wallet balance and determine if airdrop is needed.
   */
  async checkBalance(walletAddress: string): Promise<WalletBalance> {
    const pubkey = new PublicKey(walletAddress);

    // Get SOL balance
    const solBalance = await this.connection.getBalance(pubkey);
    const solAmount = solBalance / LAMPORTS_PER_SOL;

    // Get USDC balance (simplified - would need token account lookup)
    let usdcAmount = 0;
    try {
      // In a real implementation, this would look up the associated token account
      // and get the balance. For now, we'll assume 0.
      usdcAmount = 0;
    } catch {
      // Token account might not exist
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
