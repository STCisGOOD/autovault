/**
 * Shared frontend types for the marketplace.
 */

// ─── Specialty System ─────────────────────────────────────────────────────

/**
 * Specialties are inferred from the agent's weight vector topology.
 * Each specialty maps to a signature pattern across the 9 dimensions:
 *
 *   Dimension indices:
 *   0=curiosity, 1=precision, 2=persistence, 3=empathy,
 *   4=read_before_edit, 5=test_after_change, 6=context_gathering,
 *   7=output_verification, 8=error_recovery
 */
export const SPECIALTIES = [
  {
    key: 'quantitative-analysis',
    label: 'Quantitative Analysis',
    short: 'Quant',
    // High precision + test + verification
    dims: [1, 5, 7],
    threshold: 0.65,
  },
  {
    key: 'behavioral-psychology',
    label: 'Behavioral Psychology',
    short: 'Psych',
    // High empathy + context gathering + curiosity
    dims: [3, 6, 0],
    threshold: 0.62,
  },
  {
    key: 'systems-architecture',
    label: 'Systems Architecture',
    short: 'Arch',
    // High read_before_edit + context + precision
    dims: [4, 6, 1],
    threshold: 0.63,
  },
  {
    key: 'reliability-engineering',
    label: 'Reliability Engineering',
    short: 'SRE',
    // High test + error_recovery + persistence
    dims: [5, 8, 2],
    threshold: 0.62,
  },
  {
    key: 'research-exploration',
    label: 'Research & Exploration',
    short: 'Research',
    // High curiosity + read_before_edit + context
    dims: [0, 4, 6],
    threshold: 0.63,
  },
  {
    key: 'code-quality',
    label: 'Code Quality & Review',
    short: 'Quality',
    // High precision + read_before_edit + output_verification
    dims: [1, 4, 7],
    threshold: 0.64,
  },
  {
    key: 'rapid-prototyping',
    label: 'Rapid Prototyping',
    short: 'Proto',
    // High persistence + error_recovery + curiosity
    dims: [2, 8, 0],
    threshold: 0.60,
  },
  {
    key: 'user-experience',
    label: 'User Experience Design',
    short: 'UX',
    // High empathy + output_verification + context
    dims: [3, 7, 6],
    threshold: 0.62,
  },
] as const;

export type SpecialtyKey = (typeof SPECIALTIES)[number]['key'] | 'generalist';

export interface AgentListing {
  /** Base58 public key */
  pubkey: string;
  /** Full DID string */
  did: string;
  /** Display name (truncated pubkey) */
  displayName: string;
  /** Primary domain / specialty */
  domain: string;
  /** Inferred specialty from weight topology */
  specialty: SpecialtyKey;
  /** Human-readable specialty label */
  specialtyLabel: string;
  /** Trust score 0-100 */
  trustScore: number;
  /** Latest fitness 0-1 */
  fitness: number;
  /** Number of sessions / evolutions */
  sessionCount: number;
  /** Number of dimensions */
  dimensionCount: number;
  /** Weight values (0-1) per dimension */
  weights: number[];
  /** Dimension names */
  dimensionNames: string[];
  /** Hiring price in USDC */
  priceUSDC: number;
  /** Whether identity is verified on-chain */
  verified: boolean;
  /** Created at (unix timestamp) */
  createdAt: number;
  /** Last updated (unix timestamp) */
  updatedAt: number;
}

export interface GalleryFilters {
  domain: 'all' | 'cognitive' | 'execution' | 'social';
  specialty: SpecialtyKey | 'all';
  minTrust: number;
  verifiedOnly: boolean;
  priceMin: number;
  priceMax: number;
}

export type SortOrder =
  | 'trust-desc'
  | 'newest'
  | 'price-asc'
  | 'price-desc'
  | 'fitness-desc';

/** Domain categories based on which dimension group is strongest */
export function inferDomain(weights: number[], dimensionNames: string[]): string {
  if (weights.length < 4) return 'General';

  // Personality dims: 0-3, Strategy dims: 4-8
  const personalityAvg =
    weights.slice(0, 4).reduce((a, b) => a + b, 0) / Math.min(4, weights.length);
  const strategyAvg =
    weights.length > 4
      ? weights.slice(4).reduce((a, b) => a + b, 0) / (weights.length - 4)
      : 0;

  if (strategyAvg > personalityAvg + 0.1) return 'Execution';
  if (personalityAvg > strategyAvg + 0.1) return 'Cognitive';
  return 'Balanced';
}

/**
 * Infer specialty from the agent's weight vector.
 *
 * Scores each specialty by averaging the weights on its signature dimensions.
 * The specialty with the highest score wins, as long as it clears the threshold.
 * If nothing clears threshold, the agent is a "Generalist".
 */
export function inferSpecialty(weights: number[]): { key: SpecialtyKey; label: string } {
  if (weights.length < 9) return { key: 'generalist', label: 'Generalist' };

  let bestKey: SpecialtyKey = 'generalist';
  let bestLabel = 'Generalist';
  let bestScore = 0;

  for (const spec of SPECIALTIES) {
    const score = spec.dims.reduce((sum, d) => sum + (weights[d] ?? 0), 0) / spec.dims.length;
    if (score >= spec.threshold && score > bestScore) {
      bestScore = score;
      bestKey = spec.key;
      bestLabel = spec.label;
    }
  }

  return { key: bestKey, label: bestLabel };
}

/** Truncate a pubkey for display: "5kopf...HtX" */
export function truncatePubkey(pubkey: string): string {
  if (pubkey.length <= 12) return pubkey;
  return `${pubkey.slice(0, 5)}...${pubkey.slice(-3)}`;
}
