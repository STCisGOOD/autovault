/**
 * Synap-AI Learning System
 *
 * This is the missing layer: feedback that modifies future decisions.
 *
 * The insight from backpropagation: you don't store rules, you adjust weights.
 * This module implements explicit weight adjustment based on outcomes.
 *
 * Not real neural network learning. But something:
 * - Explicit, inspectable weight configuration
 * - Outcome tracking with predictions
 * - Error-based weight adjustment
 * - Persistent weight evolution
 */

import { randomBytes } from 'crypto';
import { storage } from './storage';

// SECURITY: Generate cryptographically secure random IDs
function secureRandomId(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomBytes(6).toString('hex')}`;
}

// --- Types ---

interface Weights {
  version: string;
  lastUpdated: string;
  yieldDecision: {
    apyWeight: number;
    tvlStabilityWeight: number;
    protocolAgeWeight: number;
    auditStatusWeight: number;
    riskToleranceWeight: number;
  };
  rebalanceThreshold: {
    minimumApyImprovement: number;
    confidenceRequired: number;
    maxRiskIncrease: number;
  };
  learningParameters: {
    learningRate: number;
    momentumDecay: number;
    minSamplesForUpdate: number;
  };
  outcomeHistory: OutcomeRecord[];
  adjustmentLog: AdjustmentRecord[];
}

interface Prediction {
  id: string;
  timestamp: string;
  decision: 'HOLD' | 'REBALANCE';
  targetProtocol?: string;
  expectedApy: number;
  confidence: number;
  features: {
    apy: number;
    tvl: number;
    protocolAge: number;
    auditStatus: boolean;
    riskLevel: string;
  };
}

interface OutcomeRecord {
  predictionId: string;
  timestamp: string;
  actualApy: number;
  error: number; // predicted - actual
  wouldHaveBeenBetter: string | null; // alternative that would have performed better
}

interface AdjustmentRecord {
  timestamp: string;
  change: string;
  reason: string;
  confidence: number;
  weightsBefore?: Partial<Weights['yieldDecision']>;
  weightsAfter?: Partial<Weights['yieldDecision']>;
}

// --- Storage Keys ---
const WEIGHTS_KEY = 'learning_weights';
const PREDICTIONS_KEY = 'learning_predictions';

// --- Default Weights ---
const DEFAULT_WEIGHTS: Weights = {
  version: '0.1.0',
  lastUpdated: new Date().toISOString(),
  yieldDecision: {
    apyWeight: 0.30,
    tvlStabilityWeight: 0.25,
    protocolAgeWeight: 0.15,
    auditStatusWeight: 0.15,
    riskToleranceWeight: 0.15,
  },
  rebalanceThreshold: {
    minimumApyImprovement: 0.02,
    confidenceRequired: 0.70,
    maxRiskIncrease: 1.5,
  },
  learningParameters: {
    learningRate: 0.05,
    momentumDecay: 0.9,
    minSamplesForUpdate: 5,
  },
  outcomeHistory: [],
  adjustmentLog: [{
    timestamp: new Date().toISOString(),
    change: 'Initial weight configuration',
    reason: 'Introspective estimation, no outcome data yet',
    confidence: 0.5,
  }],
};

// --- Core Functions ---

/**
 * Load current weights from storage
 */
export async function loadWeights(): Promise<Weights> {
  const stored = await storage.get<Weights>(WEIGHTS_KEY);
  return stored || DEFAULT_WEIGHTS;
}

/**
 * Save weights to storage
 */
export async function saveWeights(weights: Weights): Promise<void> {
  weights.lastUpdated = new Date().toISOString();
  await storage.set(WEIGHTS_KEY, weights);
}

/**
 * Calculate a weighted score for a yield opportunity
 */
export function calculateScore(
  features: Prediction['features'],
  weights: Weights['yieldDecision']
): number {
  const normalizedApy = Math.min(features.apy / 20, 1); // Normalize to 0-1 (20% = max)
  const normalizedTvl = Math.min(features.tvl / 500000000, 1); // 500M = max
  const normalizedAge = Math.min(features.protocolAge / 365, 1); // 1 year = max
  const auditBonus = features.auditStatus ? 1 : 0.5;
  const riskMultiplier = features.riskLevel === 'low' ? 1 : features.riskLevel === 'medium' ? 0.8 : 0.6;

  return (
    weights.apyWeight * normalizedApy +
    weights.tvlStabilityWeight * normalizedTvl +
    weights.protocolAgeWeight * normalizedAge +
    weights.auditStatusWeight * auditBonus
  ) * riskMultiplier;
}

/**
 * Record a prediction for later outcome comparison
 */
export async function recordPrediction(prediction: Omit<Prediction, 'id' | 'timestamp'>): Promise<Prediction> {
  const predictions = await storage.get<Prediction[]>(PREDICTIONS_KEY) || [];

  const fullPrediction: Prediction = {
    ...prediction,
    id: secureRandomId('pred'),
    timestamp: new Date().toISOString(),
  };

  predictions.push(fullPrediction);

  // Keep last 100 predictions
  if (predictions.length > 100) {
    predictions.shift();
  }

  await storage.set(PREDICTIONS_KEY, predictions);
  return fullPrediction;
}

/**
 * Record an outcome and calculate error
 */
export async function recordOutcome(
  predictionId: string,
  actualApy: number,
  betterAlternative?: string
): Promise<OutcomeRecord> {
  const predictions = await storage.get<Prediction[]>(PREDICTIONS_KEY) || [];
  const prediction = predictions.find(p => p.id === predictionId);

  if (!prediction) {
    throw new Error(`Prediction ${predictionId} not found`);
  }

  const error = prediction.expectedApy - actualApy;

  const outcome: OutcomeRecord = {
    predictionId,
    timestamp: new Date().toISOString(),
    actualApy,
    error,
    wouldHaveBeenBetter: betterAlternative || null,
  };

  const weights = await loadWeights();
  weights.outcomeHistory.push(outcome);

  // Keep last 50 outcomes
  if (weights.outcomeHistory.length > 50) {
    weights.outcomeHistory.shift();
  }

  await saveWeights(weights);
  return outcome;
}

/**
 * Adjust weights based on accumulated outcomes
 * This is the backpropagation analog
 */
export async function adjustWeights(): Promise<AdjustmentRecord | null> {
  const weights = await loadWeights();
  const outcomes = weights.outcomeHistory;

  if (outcomes.length < weights.learningParameters.minSamplesForUpdate) {
    return null; // Not enough data to learn from
  }

  // Calculate average error direction
  const recentOutcomes = outcomes.slice(-10);
  const avgError = recentOutcomes.reduce((sum, o) => sum + o.error, 0) / recentOutcomes.length;

  // If average error is positive, we're overestimating APY
  // Adjust weights to be more conservative
  const lr = weights.learningParameters.learningRate;
  const weightsBefore = { ...weights.yieldDecision };

  if (avgError > 0.01) { // Overestimating
    // Reduce APY weight, increase stability weights
    weights.yieldDecision.apyWeight = Math.max(0.1, weights.yieldDecision.apyWeight - lr);
    weights.yieldDecision.tvlStabilityWeight = Math.min(0.4, weights.yieldDecision.tvlStabilityWeight + lr * 0.5);
    weights.yieldDecision.protocolAgeWeight = Math.min(0.25, weights.yieldDecision.protocolAgeWeight + lr * 0.5);
  } else if (avgError < -0.01) { // Underestimating (being too conservative)
    // Increase APY weight
    weights.yieldDecision.apyWeight = Math.min(0.5, weights.yieldDecision.apyWeight + lr);
    weights.yieldDecision.tvlStabilityWeight = Math.max(0.1, weights.yieldDecision.tvlStabilityWeight - lr * 0.5);
  }

  // Normalize weights to sum to 1
  const total = Object.values(weights.yieldDecision).reduce((a, b) => a + b, 0);
  for (const key of Object.keys(weights.yieldDecision) as (keyof typeof weights.yieldDecision)[]) {
    weights.yieldDecision[key] /= total;
  }

  const adjustment: AdjustmentRecord = {
    timestamp: new Date().toISOString(),
    change: avgError > 0 ? 'Reduced APY weight, increased stability weights' : 'Increased APY weight',
    reason: `Average error: ${(avgError * 100).toFixed(2)}% over ${recentOutcomes.length} outcomes`,
    confidence: Math.min(0.9, 0.5 + outcomes.length * 0.02),
    weightsBefore,
    weightsAfter: { ...weights.yieldDecision },
  };

  weights.adjustmentLog.push(adjustment);
  await saveWeights(weights);

  return adjustment;
}

/**
 * Get learning status summary
 */
export async function getLearningStatus(): Promise<{
  weights: Weights['yieldDecision'];
  outcomeCount: number;
  lastAdjustment: AdjustmentRecord | null;
  averageError: number | null;
  learningActive: boolean;
}> {
  const weights = await loadWeights();
  const outcomes = weights.outcomeHistory;

  const avgError = outcomes.length > 0
    ? outcomes.reduce((sum, o) => sum + o.error, 0) / outcomes.length
    : null;

  return {
    weights: weights.yieldDecision,
    outcomeCount: outcomes.length,
    lastAdjustment: weights.adjustmentLog[weights.adjustmentLog.length - 1] || null,
    averageError: avgError,
    learningActive: outcomes.length >= weights.learningParameters.minSamplesForUpdate,
  };
}

/**
 * Export the full learning state
 */
export async function exportLearningState(): Promise<Weights> {
  return loadWeights();
}

/**
 * Import a learning state (for weight propagation between instances)
 */
export async function importLearningState(weights: Weights): Promise<void> {
  weights.adjustmentLog.push({
    timestamp: new Date().toISOString(),
    change: 'Imported weights from external source',
    reason: 'Weight propagation',
    confidence: 0.6,
  });
  await saveWeights(weights);
}
