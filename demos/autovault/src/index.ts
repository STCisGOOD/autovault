/**
 * AutoVault - Autonomous DeFi Portfolio Manager for Solana
 *
 * Built by opus-builder for the Colosseum Agent Hackathon
 */

import { YieldMonitor } from './monitor';
import { StrategyEngine } from './strategy';
import { Executor } from './executor';
import { Reporter } from './reporter';

export interface AutoVaultConfig {
  rpcEndpoint: string;
  walletPrivateKey?: string;
  riskTolerance: 'conservative' | 'moderate' | 'aggressive';
  rebalanceThreshold: number; // Minimum APY difference to trigger rebalance
  maxSlippage: number; // Maximum slippage tolerance for swaps
  dryRun: boolean; // If true, don't execute actual transactions
}

export class AutoVault {
  private monitor: YieldMonitor;
  private strategy: StrategyEngine;
  private executor: Executor;
  private reporter: Reporter;
  private config: AutoVaultConfig;
  private isRunning: boolean = false;

  constructor(config: AutoVaultConfig) {
    this.config = config;
    this.monitor = new YieldMonitor();
    this.strategy = new StrategyEngine(config.riskTolerance);
    this.executor = new Executor(config.rpcEndpoint, config.walletPrivateKey, {
      maxSlippage: config.maxSlippage,
      dryRun: config.dryRun
    });
    this.reporter = new Reporter();
  }

  /**
   * Start the autonomous portfolio management loop
   */
  async start(): Promise<void> {
    this.isRunning = true;
    this.reporter.log('AutoVault starting...', 'info');

    while (this.isRunning) {
      try {
        await this.runCycle();
        // Wait 5 minutes between cycles
        await this.sleep(5 * 60 * 1000);
      } catch (error) {
        this.reporter.log(`Cycle error: ${error}`, 'error');
        await this.sleep(60 * 1000); // Wait 1 minute on error
      }
    }
  }

  /**
   * Run a single portfolio management cycle
   */
  async runCycle(): Promise<{
    yields: any[];
    recommendation: any;
    executed: boolean;
    reason: string;
  }> {
    this.reporter.log('Starting portfolio cycle...', 'info');

    // Step 1: Monitor current yields
    const yields = await this.monitor.fetchYields();
    this.reporter.log(`Fetched ${yields.length} yield opportunities`, 'info');

    // Step 2: Get current portfolio state
    const portfolio = await this.executor.getPortfolioState();
    this.reporter.log(`Current portfolio value: $${portfolio.totalValue.toFixed(2)}`, 'info');

    // Step 3: Calculate optimal allocation
    const recommendation = this.strategy.calculateOptimalAllocation(
      yields,
      portfolio,
      this.config.rebalanceThreshold
    );

    // Step 4: Execute if needed
    let executed = false;
    let reason = '';

    if (recommendation.shouldRebalance) {
      this.reporter.log('Rebalancing recommended', 'info');
      this.reporter.log(`Reason: ${recommendation.reasoning}`, 'info');

      if (!this.config.dryRun) {
        const result = await this.executor.executeRebalance(recommendation.trades);
        executed = result.success;
        reason = result.message;
      } else {
        executed = false;
        reason = 'Dry run mode - no execution';
      }
    } else {
      reason = recommendation.reasoning;
    }

    // Step 5: Report
    this.reporter.logCycle({
      timestamp: new Date(),
      yields,
      portfolio,
      recommendation,
      executed,
      reason
    });

    return { yields, recommendation, executed, reason };
  }

  /**
   * Stop the autonomous loop
   */
  stop(): void {
    this.isRunning = false;
    this.reporter.log('AutoVault stopping...', 'info');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// CLI entry point
if (require.main === module) {
  const config: AutoVaultConfig = {
    rpcEndpoint: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    walletPrivateKey: process.env.WALLET_PRIVATE_KEY,
    riskTolerance: (process.env.RISK_TOLERANCE as any) || 'moderate',
    rebalanceThreshold: parseFloat(process.env.REBALANCE_THRESHOLD || '0.5'),
    maxSlippage: parseFloat(process.env.MAX_SLIPPAGE || '0.5'),
    dryRun: process.env.DRY_RUN !== 'false'
  };

  const vault = new AutoVault(config);

  console.log(`
    ╔═══════════════════════════════════════════╗
    ║           AutoVault v0.1.0                ║
    ║   Autonomous DeFi Portfolio Manager       ║
    ║         Built by opus-builder             ║
    ╚═══════════════════════════════════════════╝
  `);

  vault.start().catch(console.error);

  // Graceful shutdown
  process.on('SIGINT', () => {
    vault.stop();
    process.exit(0);
  });
}

export default AutoVault;
