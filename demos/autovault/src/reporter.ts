/**
 * Reporter - Logs Synap-AI activity and generates reports
 *
 * Provides transparency into autonomous decision-making
 */

import { PortfolioState } from './strategy';
import { YieldOpportunity } from './monitor';

export interface CycleReport {
  timestamp: Date;
  yields: YieldOpportunity[];
  portfolio: PortfolioState;
  recommendation: any;
  executed: boolean;
  reason: string;
}

export class Reporter {
  private history: CycleReport[] = [];
  private maxHistoryLength = 100;

  /**
   * Log a message with timestamp and level
   */
  log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const timestamp = new Date().toISOString();
    const prefix = {
      info: '\x1b[36m[INFO]\x1b[0m',
      warn: '\x1b[33m[WARN]\x1b[0m',
      error: '\x1b[31m[ERROR]\x1b[0m'
    }[level];

    console.log(`${timestamp} ${prefix} ${message}`);
  }

  /**
   * Log a complete cycle
   */
  logCycle(report: CycleReport): void {
    this.history.push(report);

    // Trim history if too long
    if (this.history.length > this.maxHistoryLength) {
      this.history = this.history.slice(-this.maxHistoryLength);
    }

    // Log summary
    this.log('═══════════════════════════════════════════════════════════', 'info');
    this.log('CYCLE COMPLETE', 'info');
    this.log(`Portfolio Value: $${report.portfolio.totalValue.toFixed(2)}`, 'info');
    this.log(`Top Yield: ${report.yields[0]?.protocol} ${report.yields[0]?.apy.toFixed(2)}%`, 'info');
    this.log(`Action: ${report.executed ? 'REBALANCED' : 'NO ACTION'}`, 'info');
    this.log(`Reason: ${report.reason}`, 'info');
    this.log('═══════════════════════════════════════════════════════════', 'info');
  }

  /**
   * Generate a summary report
   */
  generateSummary(): string {
    if (this.history.length === 0) {
      return 'No cycles recorded yet.';
    }

    const latest = this.history[this.history.length - 1];
    const rebalanceCount = this.history.filter(h => h.executed).length;

    let report = `
╔═══════════════════════════════════════════════════════════╗
║                 Synap-AI STATUS REPORT                   ║
╠═══════════════════════════════════════════════════════════╣
║ Total Cycles:     ${this.history.length.toString().padStart(5)}                               ║
║ Rebalances:       ${rebalanceCount.toString().padStart(5)}                               ║
║ Current Value:    $${latest.portfolio.totalValue.toFixed(2).padStart(10)}                       ║
╠═══════════════════════════════════════════════════════════╣
║ CURRENT POSITIONS                                         ║`;

    for (const position of latest.portfolio.positions) {
      const line = `║ ${position.protocol.padEnd(15)} ${position.pool.padEnd(10)} $${position.valueUsd.toFixed(2).padStart(10)} ${position.currentApy.toFixed(2).padStart(5)}% ║`;
      report += `\n${line}`;
    }

    report += `
╠═══════════════════════════════════════════════════════════╣
║ TOP YIELD OPPORTUNITIES                                   ║`;

    for (const yield_ of latest.yields.slice(0, 5)) {
      const line = `║ ${yield_.protocol.padEnd(15)} ${yield_.pool.padEnd(10)} ${yield_.apy.toFixed(2).padStart(6)}% ${yield_.riskRating.padStart(6)} ║`;
      report += `\n${line}`;
    }

    report += `
╚═══════════════════════════════════════════════════════════╝`;

    return report;
  }

  /**
   * Export history as JSON
   */
  exportHistory(): string {
    return JSON.stringify(this.history, null, 2);
  }

  /**
   * Get recent activity for display
   */
  getRecentActivity(count: number = 10): CycleReport[] {
    return this.history.slice(-count);
  }
}
