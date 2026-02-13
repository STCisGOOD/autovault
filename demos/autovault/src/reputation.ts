/**
 * Synap-AI Reputation System
 *
 * Forked pattern from AgentRep, adapted for Synap-AI's use case.
 * Reputation calculated from SOLPRISM reasoning traces.
 *
 * Formula (adapted from AgentRep):
 * Score = (WinRate × 40) + (Volume × 30) + (Age × 20) + (Consistency × 10)
 *
 * WinRate: % of REBALANCE decisions that would have improved APY
 * Volume: Total decisions made (normalized)
 * Age: Days since first decision (normalized)
 * Consistency: How consistent are the outcomes (lower variance = higher score)
 *
 * Max score: 100. New agents start at 50 (neutral).
 */

import { recall, type Memory } from './memory';

interface ReputationScore {
  total: number;
  breakdown: {
    winRate: number;
    volume: number;
    age: number;
    consistency: number;
  };
  stats: {
    totalDecisions: number;
    rebalanceDecisions: number;
    holdDecisions: number;
    averageConfidence: number;
    firstDecision: string | null;
    lastDecision: string | null;
  };
  tier: 'unranked' | 'bronze' | 'silver' | 'gold' | 'platinum';
}

/**
 * Calculate reputation score from reasoning memories
 */
export async function calculateReputation(): Promise<ReputationScore> {
  const memories = await recall('reasoning');

  if (memories.length === 0) {
    return {
      total: 50, // Neutral starting score
      breakdown: { winRate: 0, volume: 0, age: 0, consistency: 0 },
      stats: {
        totalDecisions: 0,
        rebalanceDecisions: 0,
        holdDecisions: 0,
        averageConfidence: 0,
        firstDecision: null,
        lastDecision: null,
      },
      tier: 'unranked',
    };
  }

  // Extract decision data from memories
  const decisions = memories.map(m => {
    const trace = m.content?.trace;
    return {
      timestamp: m.timestamp,
      action: trace?.decision?.action || 'UNKNOWN',
      confidence: trace?.decision?.confidence || 50,
      expectedGain: trace?.decision?.expectedApyGain || 0,
      outcome: m.content?.outcome || 'pending',
    };
  });

  // Calculate components
  const rebalances = decisions.filter(d => d.action === 'REBALANCE');
  const holds = decisions.filter(d => d.action === 'HOLD');

  // WinRate: For now, we consider high-confidence rebalances as "wins"
  // In production, this would track actual outcomes
  const wins = rebalances.filter(d => d.confidence >= 80).length;
  const winRate = rebalances.length > 0 ? (wins / rebalances.length) * 100 : 50;

  // Volume: Normalized (100 decisions = max, caps at 30 points)
  const volumeScore = Math.min((decisions.length / 100) * 30, 30);

  // Age: Days since first decision (30 days = max, caps at 20 points)
  const firstTimestamp = decisions[0]?.timestamp;
  const daysSinceFirst = firstTimestamp
    ? (Date.now() - new Date(firstTimestamp).getTime()) / (1000 * 60 * 60 * 24)
    : 0;
  const ageScore = Math.min((daysSinceFirst / 30) * 20, 20);

  // Consistency: Based on confidence variance (lower = more consistent)
  const confidences = decisions.map(d => d.confidence);
  const avgConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
  const variance = confidences.reduce((sum, c) => sum + Math.pow(c - avgConfidence, 2), 0) / confidences.length;
  const stdDev = Math.sqrt(variance);
  // Low stdDev = high consistency. Map stdDev 0-30 to score 10-0
  const consistencyScore = Math.max(10 - (stdDev / 3), 0);

  // Calculate total
  const winRateComponent = (winRate / 100) * 40;
  const total = Math.round(winRateComponent + volumeScore + ageScore + consistencyScore);

  // Determine tier
  const tier = total >= 90 ? 'platinum'
    : total >= 75 ? 'gold'
    : total >= 60 ? 'silver'
    : total >= 40 ? 'bronze'
    : 'unranked';

  return {
    total: Math.min(total, 100),
    breakdown: {
      winRate: Math.round(winRateComponent),
      volume: Math.round(volumeScore),
      age: Math.round(ageScore),
      consistency: Math.round(consistencyScore),
    },
    stats: {
      totalDecisions: decisions.length,
      rebalanceDecisions: rebalances.length,
      holdDecisions: holds.length,
      averageConfidence: Math.round(avgConfidence),
      firstDecision: firstTimestamp || null,
      lastDecision: decisions[decisions.length - 1]?.timestamp || null,
    },
    tier,
  };
}

/**
 * Get reputation summary for display
 */
export async function getReputationSummary(): Promise<{
  score: number;
  tier: string;
  decisions: number;
  note: string;
}> {
  const rep = await calculateReputation();
  return {
    score: rep.total,
    tier: rep.tier,
    decisions: rep.stats.totalDecisions,
    note: rep.stats.totalDecisions === 0
      ? 'No decisions yet. Run /api/cycle to start building reputation.'
      : `Based on ${rep.stats.totalDecisions} decisions. Win rate: ${Math.round((rep.breakdown.winRate / 40) * 100)}%`,
  };
}
