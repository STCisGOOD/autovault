/**
 * DevnetFunder.ts
 *
 * Automatic devnet SOL funding for agent wallets.
 *
 * Handles:
 * - Airdrop requests with exponential backoff
 * - Rate limit handling (429 errors)
 * - Balance checking
 * - Minimum balance maintenance
 */

import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  clusterApiUrl,
} from '@solana/web3.js';

// =============================================================================
// TYPES
// =============================================================================

export interface DevnetFunderConfig {
  /** RPC endpoint (defaults to Solana devnet) */
  rpcEndpoint: string;
  /** Commitment level */
  commitment: 'processed' | 'confirmed' | 'finalized';
  /** Maximum retry attempts */
  maxRetries: number;
  /** Base delay between retries (ms) */
  baseDelayMs: number;
  /** Maximum delay between retries (ms) */
  maxDelayMs: number;
  /** Default airdrop amount in SOL */
  defaultAirdropSol: number;
  /** Minimum balance to maintain in SOL */
  minBalanceSol: number;
}

const DEFAULT_CONFIG: DevnetFunderConfig = {
  rpcEndpoint: clusterApiUrl('devnet'),
  commitment: 'confirmed',
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  defaultAirdropSol: 1,
  minBalanceSol: 0.1,
};

export interface FundingResult {
  success: boolean;
  signature?: string;
  balanceBefore: number;
  balanceAfter: number;
  error?: string;
}

// =============================================================================
// DEVNET FUNDER
// =============================================================================

export class DevnetFunder {
  private readonly config: DevnetFunderConfig;
  private readonly connection: Connection;

  constructor(config: Partial<DevnetFunderConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Validate we're on devnet
    if (!this.config.rpcEndpoint.includes('devnet')) {
      console.warn('[DevnetFunder] Warning: RPC endpoint does not appear to be devnet');
    }

    this.connection = new Connection(this.config.rpcEndpoint, {
      commitment: this.config.commitment,
      confirmTransactionInitialTimeout: 60000,
    });
  }

  /**
   * Get the current balance of a wallet.
   */
  async getBalance(publicKey: PublicKey): Promise<number> {
    const lamports = await this.connection.getBalance(publicKey);
    return lamports / LAMPORTS_PER_SOL;
  }

  /**
   * Check if wallet needs funding.
   */
  async needsFunding(publicKey: PublicKey): Promise<boolean> {
    const balance = await this.getBalance(publicKey);
    return balance < this.config.minBalanceSol;
  }

  /**
   * Request an airdrop with retry logic.
   */
  async requestAirdrop(
    publicKey: PublicKey,
    amountSol: number = this.config.defaultAirdropSol
  ): Promise<FundingResult> {
    const balanceBefore = await this.getBalance(publicKey);

    console.log(`[DevnetFunder] Requesting ${amountSol} SOL airdrop...`);
    console.log(`[DevnetFunder] Current balance: ${balanceBefore.toFixed(4)} SOL`);

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        // Request airdrop
        const signature = await this.connection.requestAirdrop(
          publicKey,
          amountSol * LAMPORTS_PER_SOL
        );

        console.log(`[DevnetFunder] Airdrop requested: ${signature}`);

        // Get blockhash for confirmation
        const { blockhash, lastValidBlockHeight } =
          await this.connection.getLatestBlockhash(this.config.commitment);

        // Wait for confirmation
        const confirmation = await this.connection.confirmTransaction(
          {
            signature,
            blockhash,
            lastValidBlockHeight,
          },
          this.config.commitment
        );

        if (confirmation.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }

        const balanceAfter = await this.getBalance(publicKey);

        console.log(`[DevnetFunder] Airdrop confirmed!`);
        console.log(`[DevnetFunder] New balance: ${balanceAfter.toFixed(4)} SOL`);

        return {
          success: true,
          signature,
          balanceBefore,
          balanceAfter,
        };
      } catch (error) {
        lastError = error as Error;
        const errorMessage = lastError.message || String(error);

        // Check for rate limiting
        if (errorMessage.includes('429') || errorMessage.includes('Too Many Requests')) {
          console.warn(`[DevnetFunder] Rate limited, attempt ${attempt}/${this.config.maxRetries}`);
        } else if (errorMessage.includes('airdrop request limit')) {
          console.warn(`[DevnetFunder] Airdrop limit reached, attempt ${attempt}/${this.config.maxRetries}`);
        } else {
          console.error(`[DevnetFunder] Attempt ${attempt} failed:`, errorMessage);
        }

        if (attempt < this.config.maxRetries) {
          // Exponential backoff with jitter
          const delay = Math.min(
            this.config.baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 1000,
            this.config.maxDelayMs
          );
          console.log(`[DevnetFunder] Retrying in ${(delay / 1000).toFixed(1)}s...`);
          await this.sleep(delay);
        }
      }
    }

    const balanceAfter = await this.getBalance(publicKey);

    return {
      success: false,
      balanceBefore,
      balanceAfter,
      error: lastError?.message || 'Unknown error',
    };
  }

  /**
   * Ensure wallet has minimum balance, requesting airdrop if needed.
   */
  async ensureFunded(
    publicKey: PublicKey,
    minBalance: number = this.config.minBalanceSol
  ): Promise<FundingResult> {
    const balance = await this.getBalance(publicKey);

    if (balance >= minBalance) {
      console.log(`[DevnetFunder] Balance sufficient: ${balance.toFixed(4)} SOL`);
      return {
        success: true,
        balanceBefore: balance,
        balanceAfter: balance,
      };
    }

    console.log(`[DevnetFunder] Balance low (${balance.toFixed(4)} SOL), requesting airdrop...`);

    // Request enough to get above minimum
    const amountNeeded = Math.max(this.config.defaultAirdropSol, minBalance - balance + 0.1);
    return this.requestAirdrop(publicKey, Math.min(amountNeeded, 2)); // Max 2 SOL per request
  }

  /**
   * Get connection for external use.
   */
  getConnection(): Connection {
    return this.connection;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createDevnetFunder(
  config?: Partial<DevnetFunderConfig>
): DevnetFunder {
  return new DevnetFunder(config);
}

export default {
  DevnetFunder,
  createDevnetFunder,
};
