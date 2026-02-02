/**
 * Executor - Executes trades on Solana via Jupiter and protocol SDKs
 *
 * Handles swaps, deposits, and withdrawals across DeFi protocols
 */

import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import axios from 'axios';
import { PortfolioState, Position, Trade } from './strategy';

export interface ExecutorConfig {
  maxSlippage: number;
  dryRun: boolean;
}

export interface ExecutionResult {
  success: boolean;
  message: string;
  txSignature?: string;
  error?: string;
}

export class Executor {
  private connection: Connection;
  private wallet: Keypair | null = null;
  private config: ExecutorConfig;

  // Jupiter API for swaps
  private readonly JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
  private readonly JUPITER_SWAP_API = 'https://quote-api.jup.ag/v6/swap';

  // Common token mints on Solana
  private readonly TOKEN_MINTS: Record<string, string> = {
    'SOL': 'So11111111111111111111111111111111111111112',
    'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    'mSOL': 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
    'jitoSOL': 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    'bSOL': 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
  };

  constructor(rpcEndpoint: string, privateKey?: string, config: ExecutorConfig = { maxSlippage: 0.5, dryRun: true }) {
    this.connection = new Connection(rpcEndpoint, 'confirmed');
    this.config = config;

    if (privateKey) {
      try {
        // Support both base58 and array formats
        if (privateKey.startsWith('[')) {
          const keyArray = JSON.parse(privateKey);
          this.wallet = Keypair.fromSecretKey(new Uint8Array(keyArray));
        } else {
          // Assume base58
          const bs58 = require('bs58');
          this.wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
        }
      } catch (error) {
        console.warn('Failed to parse wallet private key:', error);
      }
    }
  }

  /**
   * Get current portfolio state from on-chain data
   */
  async getPortfolioState(): Promise<PortfolioState> {
    if (!this.wallet) {
      // Return mock portfolio for dry run
      return this.getMockPortfolio();
    }

    try {
      const publicKey = this.wallet.publicKey;

      // Get SOL balance
      const solBalance = await this.connection.getBalance(publicKey);
      const solValueUsd = (solBalance / 1e9) * await this.getSolPrice();

      // Get token accounts
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        publicKey,
        { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
      );

      const positions: Position[] = [];
      let totalValue = solValueUsd;

      // Add SOL position
      if (solBalance > 0) {
        positions.push({
          protocol: 'native',
          pool: 'SOL',
          asset: 'SOL',
          amount: solBalance / 1e9,
          valueUsd: solValueUsd,
          currentApy: 0
        });
      }

      // Process token accounts
      for (const account of tokenAccounts.value) {
        const tokenInfo = account.account.data.parsed.info;
        const mint = tokenInfo.mint;
        const amount = tokenInfo.tokenAmount.uiAmount || 0;

        if (amount > 0) {
          const price = await this.getTokenPrice(mint);
          const valueUsd = amount * price;
          totalValue += valueUsd;

          // Identify protocol from mint
          const { protocol, pool, apy } = this.identifyProtocol(mint);

          positions.push({
            protocol,
            pool,
            asset: tokenInfo.tokenAmount.decimals === 9 ? 'SOL-derivative' : 'stablecoin',
            amount,
            valueUsd,
            currentApy: apy
          });
        }
      }

      return {
        totalValue,
        positions,
        availableBalance: solValueUsd
      };
    } catch (error) {
      console.error('Error fetching portfolio state:', error);
      return this.getMockPortfolio();
    }
  }

  /**
   * Execute a rebalance based on trade recommendations
   */
  async executeRebalance(trades: Trade[]): Promise<ExecutionResult> {
    if (this.config.dryRun) {
      return {
        success: true,
        message: `Dry run: Would execute ${trades.length} trades`
      };
    }

    if (!this.wallet) {
      return {
        success: false,
        message: 'No wallet configured',
        error: 'WALLET_NOT_CONFIGURED'
      };
    }

    const results: ExecutionResult[] = [];

    for (const trade of trades) {
      try {
        const result = await this.executeTrade(trade);
        results.push(result);

        if (!result.success) {
          // Stop on first failure
          return {
            success: false,
            message: `Trade failed: ${result.message}`,
            error: result.error
          };
        }
      } catch (error) {
        return {
          success: false,
          message: `Trade execution error: ${error}`,
          error: 'EXECUTION_ERROR'
        };
      }
    }

    return {
      success: true,
      message: `Successfully executed ${results.length} trades`
    };
  }

  /**
   * Execute a single trade
   */
  private async executeTrade(trade: Trade): Promise<ExecutionResult> {
    switch (trade.action) {
      case 'swap':
        return this.executeSwap(trade);
      case 'deposit':
        return this.executeDeposit(trade);
      case 'withdraw':
        return this.executeWithdraw(trade);
      default:
        return { success: false, message: 'Unknown trade action', error: 'UNKNOWN_ACTION' };
    }
  }

  /**
   * Execute a swap via Jupiter
   */
  private async executeSwap(trade: Trade): Promise<ExecutionResult> {
    if (!this.wallet) {
      return { success: false, message: 'No wallet', error: 'NO_WALLET' };
    }

    try {
      // Get quote from Jupiter
      const inputMint = this.TOKEN_MINTS['USDC']; // Default to USDC
      const outputMint = this.TOKEN_MINTS['SOL'];
      const amount = Math.floor(trade.amount * 1e6); // USDC has 6 decimals

      const quoteUrl = `${this.JUPITER_QUOTE_API}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${this.config.maxSlippage * 100}`;
      const quoteResponse = await axios.get(quoteUrl);
      const quote = quoteResponse.data;

      // Get swap transaction
      const swapResponse = await axios.post(this.JUPITER_SWAP_API, {
        quoteResponse: quote,
        userPublicKey: this.wallet.publicKey.toString(),
        wrapAndUnwrapSol: true
      });

      const { swapTransaction } = swapResponse.data;

      // Deserialize and sign
      const txBuffer = Buffer.from(swapTransaction, 'base64');
      const transaction = Transaction.from(txBuffer);
      transaction.sign(this.wallet);

      // Send transaction
      const signature = await this.connection.sendRawTransaction(transaction.serialize());
      await this.connection.confirmTransaction(signature);

      return {
        success: true,
        message: `Swap executed`,
        txSignature: signature
      };
    } catch (error) {
      return {
        success: false,
        message: `Swap failed: ${error}`,
        error: 'SWAP_FAILED'
      };
    }
  }

  /**
   * Execute a deposit to a protocol (simplified)
   */
  private async executeDeposit(trade: Trade): Promise<ExecutionResult> {
    // In a full implementation, this would interact with protocol-specific SDKs
    // For now, return a simulated success
    return {
      success: true,
      message: `Deposit of $${trade.amount.toFixed(2)} to ${trade.toProtocol}:${trade.toPool} simulated`
    };
  }

  /**
   * Execute a withdrawal from a protocol (simplified)
   */
  private async executeWithdraw(trade: Trade): Promise<ExecutionResult> {
    return {
      success: true,
      message: `Withdrawal of $${trade.amount.toFixed(2)} from ${trade.fromProtocol}:${trade.fromPool} simulated`
    };
  }

  /**
   * Get SOL price in USD
   */
  private async getSolPrice(): Promise<number> {
    try {
      const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      return response.data.solana.usd;
    } catch {
      return 100; // Fallback price
    }
  }

  /**
   * Get token price by mint address
   */
  private async getTokenPrice(mint: string): Promise<number> {
    // Simplified - would use Jupiter price API in production
    const stablecoins = [this.TOKEN_MINTS['USDC'], this.TOKEN_MINTS['USDT']];
    if (stablecoins.includes(mint)) return 1;

    const solDerivatives = [this.TOKEN_MINTS['mSOL'], this.TOKEN_MINTS['jitoSOL'], this.TOKEN_MINTS['bSOL']];
    if (solDerivatives.includes(mint)) return await this.getSolPrice();

    return 0;
  }

  /**
   * Identify protocol from token mint
   */
  private identifyProtocol(mint: string): { protocol: string; pool: string; apy: number } {
    const protocolMap: Record<string, { protocol: string; pool: string; apy: number }> = {
      [this.TOKEN_MINTS['mSOL']]: { protocol: 'Marinade', pool: 'mSOL', apy: 7.5 },
      [this.TOKEN_MINTS['jitoSOL']]: { protocol: 'Jito', pool: 'jitoSOL', apy: 8.2 },
      [this.TOKEN_MINTS['bSOL']]: { protocol: 'BlazeStake', pool: 'bSOL', apy: 7.8 },
    };

    return protocolMap[mint] || { protocol: 'Unknown', pool: 'Unknown', apy: 0 };
  }

  /**
   * Return mock portfolio for dry run mode
   */
  private getMockPortfolio(): PortfolioState {
    return {
      totalValue: 1000,
      positions: [
        {
          protocol: 'Marinade',
          pool: 'mSOL',
          asset: 'mSOL',
          amount: 5,
          valueUsd: 500,
          currentApy: 7.5
        },
        {
          protocol: 'native',
          pool: 'USDC',
          asset: 'USDC',
          amount: 500,
          valueUsd: 500,
          currentApy: 0
        }
      ],
      availableBalance: 500
    };
  }
}
