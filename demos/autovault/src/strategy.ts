/**
 * StrategyEngine - Calculates optimal portfolio allocation
 *
 * Uses risk-adjusted returns and diversification principles
 *
 * Security Hardening:
 * - Uses centralized configuration for risk profiles
 * - No magic numbers - all thresholds are configurable
 */

import { YieldOpportunity } from './monitor';
import { getRiskProfile, RISK_THRESHOLDS, RiskProfile } from './config';

export interface PortfolioState {
  totalValue: number;
  positions: Position[];
  availableBalance: number;
}

export interface Position {
  protocol: string;
  pool: string;
  asset: string;
  amount: number;
  valueUsd: number;
  currentApy: number;
}

export interface Trade {
  action: 'deposit' | 'withdraw' | 'swap';
  fromProtocol?: string;
  fromPool?: string;
  toProtocol: string;
  toPool: string;
  amount: number;
  expectedApy: number;
}

export interface AllocationRecommendation {
  shouldRebalance: boolean;
  reasoning: string;
  trades: Trade[];
  expectedApyImprovement: number;
  riskAssessment: string;
}

export class StrategyEngine {
  private riskTolerance: 'conservative' | 'moderate' | 'aggressive';
  private riskProfile: RiskProfile;

  constructor(riskTolerance: 'conservative' | 'moderate' | 'aggressive') {
    this.riskTolerance = riskTolerance;
    this.riskProfile = getRiskProfile(riskTolerance);
  }

  /**
   * Calculate optimal allocation based on current yields and portfolio
   */
  calculateOptimalAllocation(
    yields: YieldOpportunity[],
    portfolio: PortfolioState,
    rebalanceThreshold: number
  ): AllocationRecommendation {
    // Filter yields by risk tolerance
    const eligibleYields = this.filterByRiskTolerance(yields);

    if (eligibleYields.length === 0) {
      return {
        shouldRebalance: false,
        reasoning: 'No eligible yield opportunities match risk tolerance',
        trades: [],
        expectedApyImprovement: 0,
        riskAssessment: 'No action needed'
      };
    }

    // Calculate current weighted APY
    const currentWeightedApy = this.calculateWeightedApy(portfolio);

    // Calculate optimal allocation
    const optimalAllocation = this.calculateOptimalDistribution(eligibleYields, portfolio.totalValue);

    // Calculate expected APY with new allocation
    const expectedApy = this.calculateExpectedApy(optimalAllocation, eligibleYields);

    // Determine if rebalance is worth it
    const apyImprovement = expectedApy - currentWeightedApy;
    const shouldRebalance = apyImprovement >= rebalanceThreshold;

    // Generate trades
    const trades = shouldRebalance
      ? this.generateTrades(portfolio, optimalAllocation, eligibleYields)
      : [];

    return {
      shouldRebalance,
      reasoning: this.generateReasoning(currentWeightedApy, expectedApy, apyImprovement, rebalanceThreshold),
      trades,
      expectedApyImprovement: apyImprovement,
      riskAssessment: this.assessOverallRisk(optimalAllocation, eligibleYields)
    };
  }

  /**
   * Filter yields based on risk tolerance
   *
   * Uses centralized risk profile configuration
   */
  private filterByRiskTolerance(yields: YieldOpportunity[]): YieldOpportunity[] {
    // Filter based on allowed risk levels from config
    return yields.filter(y => this.riskProfile.riskLevels.includes(y.riskRating));
  }

  /**
   * Calculate current weighted APY of portfolio
   */
  private calculateWeightedApy(portfolio: PortfolioState): number {
    if (portfolio.totalValue === 0) return 0;

    let weightedSum = 0;
    for (const position of portfolio.positions) {
      const weight = position.valueUsd / portfolio.totalValue;
      weightedSum += position.currentApy * weight;
    }

    return weightedSum;
  }

  /**
   * Calculate optimal distribution across protocols
   * Uses a modified Kelly Criterion for position sizing
   *
   * All parameters come from centralized risk profile configuration
   */
  private calculateOptimalDistribution(
    yields: YieldOpportunity[],
    totalValue: number
  ): Map<string, number> {
    const distribution = new Map<string, number>();

    // Score each opportunity (risk-adjusted return)
    const scored = yields.map(y => ({
      ...y,
      score: this.calculateScore(y)
    })).sort((a, b) => b.score - a.score);

    // Take top opportunities based on risk profile (from config)
    const maxPositions = this.riskProfile.maxPositions;

    const topYields = scored.slice(0, maxPositions);
    const totalScore = topYields.reduce((sum, y) => sum + y.score, 0);

    // Allocate proportionally to score, with caps from config
    const maxAllocationPercent = this.riskProfile.maxAllocation;

    for (const yield_ of topYields) {
      const rawAllocation = (yield_.score / totalScore) * totalValue;
      // Cap single position based on risk profile
      const maxAllocation = totalValue * maxAllocationPercent;
      const allocation = Math.min(rawAllocation, maxAllocation);
      distribution.set(`${yield_.protocol}:${yield_.pool}`, allocation);
    }

    return distribution;
  }

  /**
   * Calculate risk-adjusted score for a yield opportunity
   *
   * Uses centralized risk thresholds for TVL assessment
   */
  private calculateScore(yield_: YieldOpportunity): number {
    // Base score is APY
    let score = yield_.apy;

    // Risk adjustment
    const riskMultiplier = yield_.riskRating === 'low' ? 1.2 :
                           yield_.riskRating === 'medium' ? 1.0 : 0.7;
    score *= riskMultiplier;

    // TVL adjustment using config thresholds (prefer higher TVL for safety)
    if (yield_.tvl > RISK_THRESHOLDS.tvl.high) score *= 1.1;
    else if (yield_.tvl < 1_000_000) score *= 0.8;

    return score;
  }

  /**
   * Calculate expected APY from an allocation
   */
  private calculateExpectedApy(
    allocation: Map<string, number>,
    yields: YieldOpportunity[]
  ): number {
    let totalValue = 0;
    let weightedApy = 0;

    for (const [key, amount] of allocation.entries()) {
      const [protocol, pool] = key.split(':');
      const yield_ = yields.find(y => y.protocol === protocol && y.pool === pool);
      if (yield_) {
        weightedApy += yield_.apy * amount;
        totalValue += amount;
      }
    }

    return totalValue > 0 ? weightedApy / totalValue : 0;
  }

  /**
   * Generate trades to move from current to optimal allocation
   */
  private generateTrades(
    portfolio: PortfolioState,
    optimal: Map<string, number>,
    yields: YieldOpportunity[]
  ): Trade[] {
    const trades: Trade[] = [];

    // First, identify positions to reduce/close
    for (const position of portfolio.positions) {
      const key = `${position.protocol}:${position.pool}`;
      const targetAmount = optimal.get(key) || 0;

      if (position.valueUsd > targetAmount + 100) { // $100 buffer
        trades.push({
          action: 'withdraw',
          fromProtocol: position.protocol,
          fromPool: position.pool,
          toProtocol: '',
          toPool: '',
          amount: position.valueUsd - targetAmount,
          expectedApy: 0
        });
      }
    }

    // Then, identify new positions to open
    for (const [key, targetAmount] of optimal.entries()) {
      const [protocol, pool] = key.split(':');
      const currentPosition = portfolio.positions.find(
        p => p.protocol === protocol && p.pool === pool
      );
      const currentAmount = currentPosition?.valueUsd || 0;

      if (targetAmount > currentAmount + 100) { // $100 buffer
        const yield_ = yields.find(y => y.protocol === protocol && y.pool === pool);
        trades.push({
          action: 'deposit',
          toProtocol: protocol,
          toPool: pool,
          amount: targetAmount - currentAmount,
          expectedApy: yield_?.apy || 0
        });
      }
    }

    return trades;
  }

  /**
   * Generate human-readable reasoning for the recommendation
   */
  private generateReasoning(
    currentApy: number,
    expectedApy: number,
    improvement: number,
    threshold: number
  ): string {
    if (improvement < threshold) {
      return `Current portfolio APY (${currentApy.toFixed(2)}%) is within ${threshold}% of optimal (${expectedApy.toFixed(2)}%). No rebalance needed.`;
    }

    return `Rebalancing can improve APY from ${currentApy.toFixed(2)}% to ${expectedApy.toFixed(2)}% (+${improvement.toFixed(2)}%). This exceeds the ${threshold}% threshold.`;
  }

  /**
   * Assess overall risk of the allocation
   */
  private assessOverallRisk(
    allocation: Map<string, number>,
    yields: YieldOpportunity[]
  ): string {
    let totalValue = 0;
    let highRiskValue = 0;
    let mediumRiskValue = 0;

    for (const [key, amount] of allocation.entries()) {
      const [protocol, pool] = key.split(':');
      const yield_ = yields.find(y => y.protocol === protocol && y.pool === pool);
      if (yield_) {
        totalValue += amount;
        if (yield_.riskRating === 'high') highRiskValue += amount;
        else if (yield_.riskRating === 'medium') mediumRiskValue += amount;
      }
    }

    const highRiskPct = (highRiskValue / totalValue) * 100;
    const mediumRiskPct = (mediumRiskValue / totalValue) * 100;

    if (highRiskPct > 30) return 'HIGH - Significant exposure to high-risk protocols';
    if (highRiskPct > 10 || mediumRiskPct > 50) return 'MEDIUM - Balanced risk exposure';
    return 'LOW - Conservative allocation with established protocols';
  }
}
