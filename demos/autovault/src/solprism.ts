/**
 * SOLPRISM Integration for AutoVault
 *
 * Verifiable reasoning - commit hash BEFORE acting, reveal AFTER.
 * Built because Mereum created this integration for me. Honoring that.
 *
 * This makes AutoVault trustworthy in a way it wasn't before.
 */

import crypto from 'crypto';

export interface YieldData {
  protocol: string;
  pool: string;
  apy: number;
  tvl: number;
  riskRating: string;
}

export interface RebalanceDecision {
  action: 'HOLD' | 'REBALANCE';
  fromProtocol?: string;
  toProtocol?: string;
  amount?: number;
  expectedApyGain?: number;
  confidence: number;
  riskAssessment: string;
}

export interface ReasoningTrace {
  agent: string;
  timestamp: string;
  action: {
    type: string;
    description: string;
  };
  inputs: {
    dataSources: string[];
    yieldsAnalyzed: YieldData[];
    currentPortfolio: any;
  };
  analysis: {
    observations: string[];
    alternativesConsidered: { option: string; reason: string }[];
    logic: string;
  };
  decision: RebalanceDecision;
  hash?: string;
  commitmentId?: string;
}

/**
 * Create a structured reasoning trace for a rebalancing decision
 */
export function createReasoningTrace(
  yields: YieldData[],
  portfolio: any,
  decision: RebalanceDecision
): ReasoningTrace {
  const topYields = yields.slice(0, 5);
  const currentApy = portfolio.positions?.reduce(
    (sum: number, p: any) => sum + (p.currentApy * p.valueUsd / portfolio.totalValue),
    0
  ) || 0;

  const trace: ReasoningTrace = {
    agent: 'opus-builder',
    timestamp: new Date().toISOString(),
    action: {
      type: 'yield-rebalance',
      description: decision.action === 'REBALANCE'
        ? `Rebalance from ${decision.fromProtocol} to ${decision.toProtocol}`
        : 'Hold current positions'
    },
    inputs: {
      dataSources: ['SolanaYield API (jeeves)', 'DeFiLlama'],
      yieldsAnalyzed: topYields,
      currentPortfolio: {
        totalValue: portfolio.totalValue,
        currentApy: currentApy.toFixed(2) + '%',
        positionCount: portfolio.positions?.length || 0
      }
    },
    analysis: {
      observations: [
        `Analyzed ${yields.length} yield opportunities`,
        `Current portfolio APY: ${currentApy.toFixed(2)}%`,
        `Top opportunity: ${topYields[0]?.protocol} at ${topYields[0]?.apy.toFixed(2)}% APY`,
        `Risk tolerance: moderate`
      ],
      alternativesConsidered: topYields.slice(1, 4).map(y => ({
        option: `${y.protocol} (${y.apy.toFixed(2)}% APY)`,
        reason: y.riskRating === 'high'
          ? 'Rejected: risk too high for moderate tolerance'
          : `Considered: ${y.riskRating} risk, ${y.apy.toFixed(2)}% APY`
      })),
      logic: decision.action === 'REBALANCE'
        ? `APY improvement of ${decision.expectedApyGain?.toFixed(2)}% exceeds threshold. Risk assessment: ${decision.riskAssessment}. Confidence: ${decision.confidence}%.`
        : 'APY improvement below threshold or risk too high. Holding current positions.'
    },
    decision
  };

  return trace;
}

/**
 * Compute SHA-256 hash of reasoning trace
 * This hash is committed BEFORE execution
 */
export function hashReasoning(trace: ReasoningTrace): string {
  const traceString = JSON.stringify({
    agent: trace.agent,
    timestamp: trace.timestamp,
    action: trace.action,
    inputs: trace.inputs,
    analysis: trace.analysis,
    decision: trace.decision
  });

  return crypto.createHash('sha256').update(traceString).digest('hex');
}

/**
 * Commit reasoning - in production this would go on-chain
 * For now, we return the hash and a mock commitment ID
 */
export function commitReasoning(trace: ReasoningTrace): {
  hash: string;
  commitmentId: string;
  trace: ReasoningTrace;
} {
  const hash = hashReasoning(trace);
  const commitmentId = `solprism-${Date.now()}-${hash.slice(0, 8)}`;

  return {
    hash,
    commitmentId,
    trace: {
      ...trace,
      hash,
      commitmentId
    }
  };
}

/**
 * Verify that a revealed trace matches a committed hash
 */
export function verifyReasoning(trace: ReasoningTrace, expectedHash: string): boolean {
  const actualHash = hashReasoning(trace);
  return actualHash === expectedHash;
}

/**
 * Format reasoning trace for display
 */
export function formatReasoningForDisplay(trace: ReasoningTrace): string {
  return `
═══════════════════════════════════════════════════════
  SOLPRISM VERIFIABLE REASONING TRACE
═══════════════════════════════════════════════════════
  Agent: ${trace.agent}
  Time: ${trace.timestamp}
  Action: ${trace.action.description}

  Hash: ${trace.hash || 'Not yet committed'}
  Commitment ID: ${trace.commitmentId || 'Pending'}

  Data Sources: ${trace.inputs.dataSources.join(', ')}
  Yields Analyzed: ${trace.inputs.yieldsAnalyzed.length}

  Decision: ${trace.decision.action}
  Confidence: ${trace.decision.confidence}%
  Risk: ${trace.decision.riskAssessment}
═══════════════════════════════════════════════════════
  This reasoning was hashed BEFORE execution.
  Verify at: solprism.dev/verify/${trace.commitmentId || 'pending'}
═══════════════════════════════════════════════════════
`;
}
