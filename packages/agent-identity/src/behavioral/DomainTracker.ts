/**
 * DomainTracker.ts
 *
 * Detects which domains the agent operates in and auto-activates
 * vocabulary dimensions. Sessions are weighted by outcome R —
 * quality matters for expertise building.
 *
 * Detection heuristics:
 *   - File extensions (.sol→solana, .rs→rust, .tsx→react)
 *   - Tool patterns (anchor build→solana)
 *   - Keyword frequency in insights
 *
 * Expertise thresholds (weighted by R):
 *   - 5  weighted sessions → novice
 *   - 15 weighted sessions → intermediate
 *   - 30 weighted sessions → expert
 */

import type { ActionLog } from './BehavioralObserver';
import { safeFinite, safeClamp, safeDivide, safeJsonStringify } from './math';

// =============================================================================
// TYPES
// =============================================================================

export interface DomainExposure {
  /** Domain identifier */
  domain: string;
  /** Sessions weighted by outcome R (quality matters) */
  weightedSessionCount: number;
  /** Raw (unweighted) session count */
  rawSessionCount: number;
  /** Tool name patterns seen */
  toolPatterns: string[];
  /** File extension patterns seen */
  filePatterns: string[];
  /** Insight count in this domain */
  insightCount: number;
  /** First session timestamp */
  firstSeen: number;
  /** Most recent session timestamp */
  lastSeen: number;
}

export interface Specialization {
  /** Domain name */
  domain: string;
  /** Expertise level */
  level: 'novice' | 'intermediate' | 'expert';
  /** Dimensions activated for this domain */
  activatedDimensions: string[];
  /** Domain-specific behavioral guidance */
  guidance: string[];
}

export interface DomainProfile {
  /** All tracked domains */
  domains: Map<string, DomainExposure>;
  /** Primary domain (most weighted sessions) */
  primaryDomain: string | null;
  /** Domains that have reached specialization thresholds */
  specializations: Specialization[];
}

export interface DomainTrackerConfig {
  /** Weighted sessions for novice (default: 5) */
  noviceThreshold: number;
  /** Weighted sessions for intermediate (default: 15) */
  intermediateThreshold: number;
  /** Weighted sessions for expert (default: 30) */
  expertThreshold: number;
  /** Max tool patterns to store per domain (default: 20) */
  maxToolPatterns: number;
  /** §5: Curvature midpoint for sigmoid (default: 1.0) */
  kappaMid?: number;
  /** §5: Curvature scale for sigmoid (default: 0.5) */
  kappaScale?: number;
  /** §5: Sessions before curvature fully takes over (default: 10) */
  curvatureBlendSessions?: number;
}

export const DEFAULT_DOMAIN_CONFIG: DomainTrackerConfig = {
  noviceThreshold: 5,
  intermediateThreshold: 15,
  expertThreshold: 30,
  maxToolPatterns: 20,
};

// =============================================================================
// DOMAIN DETECTION RULES
// =============================================================================

interface DomainRule {
  domain: string;
  fileExtensions: string[];
  toolPatterns: RegExp[];
  keywords: string[];
  activatedDimensions: string[];
  guidanceByLevel: {
    novice: string[];
    intermediate: string[];
    expert: string[];
  };
}

const DOMAIN_RULES: DomainRule[] = [
  {
    domain: 'solana',
    fileExtensions: ['.anchor'],
    toolPatterns: [/anchor\s+build/, /anchor\s+deploy/, /solana\s+/, /airdrop/],
    keywords: ['solana', 'anchor', 'devnet', 'lamports', 'pda', 'program'],
    activatedDimensions: ['risk_tolerance', 'protocol_loyalty'],
    guidanceByLevel: {
      novice: ['Verify program IDs before deployment', 'Use devnet for testing'],
      intermediate: ['Monitor account sizes to avoid rent-exempt issues', 'Check PDA seeds carefully'],
      expert: ['Optimize compute units', 'Consider account data layout for performance'],
    },
  },
  {
    domain: 'typescript',
    fileExtensions: ['.ts', '.tsx', '.mts', '.cts'],
    toolPatterns: [/tsc/, /ts-jest/, /tsx?/, /tsconfig/],
    keywords: ['typescript', 'interface', 'generics', 'types'],
    activatedDimensions: ['precision'],
    guidanceByLevel: {
      novice: ['Check tsconfig settings for strictness', 'Use explicit types at boundaries'],
      intermediate: ['Leverage discriminated unions', 'Use type guards for narrowing'],
      expert: ['Design types to make invalid states unrepresentable'],
    },
  },
  {
    domain: 'react',
    fileExtensions: ['.jsx', '.tsx'],
    toolPatterns: [/react/, /next/, /vite/],
    keywords: ['component', 'useState', 'useEffect', 'props', 'jsx', 'render'],
    activatedDimensions: ['empathy'],
    guidanceByLevel: {
      novice: ['Prefer function components', 'Understand the hook rules'],
      intermediate: ['Memoize expensive computations', 'Use proper key props'],
      expert: ['Profile rendering with React DevTools', 'Consider concurrent features'],
    },
  },
  {
    domain: 'rust',
    fileExtensions: ['.rs'],
    toolPatterns: [/cargo/, /rustc/],
    keywords: ['rust', 'cargo', 'borrow', 'lifetime', 'trait', 'impl'],
    activatedDimensions: ['precision', 'persistence'],
    guidanceByLevel: {
      novice: ['Follow the borrow checker', 'Use Result for error handling'],
      intermediate: ['Leverage zero-cost abstractions', 'Use cargo clippy'],
      expert: ['Optimize with unsafe only when proven necessary', 'Design with trait coherence'],
    },
  },
  {
    domain: 'defi',
    fileExtensions: ['.sol'],
    toolPatterns: [/swap/, /pool/, /liquidity/, /yield/],
    keywords: ['defi', 'swap', 'liquidity', 'yield', 'amm', 'vault', 'staking', 'lending'],
    activatedDimensions: ['risk_tolerance', 'yield_focus', 'protocol_loyalty', 'diversification'],
    guidanceByLevel: {
      novice: ['Always check slippage settings', 'Understand impermanent loss'],
      intermediate: ['Monitor gas costs vs yield', 'Diversify across protocols'],
      expert: ['Analyze protocol tokenomics', 'Model risk-adjusted returns'],
    },
  },
];

// =============================================================================
// TRACKER
// =============================================================================

export class DomainTracker {
  private profile: DomainProfile;
  private readonly config: DomainTrackerConfig;
  /** §5: Count of sessions that have provided curvature data */
  private curvatureSessions: number = 0;
  /** §5: Most recent curvature-based expertise value */
  private curvatureExpertise: number = 0;

  constructor(
    config: Partial<DomainTrackerConfig> = {},
    initialProfile?: DomainProfile
  ) {
    this.config = { ...DEFAULT_DOMAIN_CONFIG, ...config };
    this.profile = initialProfile ?? {
      domains: new Map(),
      primaryDomain: null,
      specializations: [],
    };
  }

  /**
   * Update domain tracking with a new session.
   *
   * @param actionLog - Session's action log
   * @param R - Session outcome quality [-1, 1]
   * @param insightDimensions - Dimensions that received insights this session
   */
  update(
    actionLog: ActionLog,
    R: number,
    insightDimensions: string[] = []
  ): void {
    const now = Date.now();
    const detectedDomains = this.detectDomains(actionLog);

    // Guard R against non-finite values — prevents Infinity → instant expert
    const safeR = safeClamp(safeFinite(R, 0), -1, 1, 0);

    // Weight by outcome: good sessions contribute more
    const weight = Math.max(0.1, (safeR + 1) / 2); // Map [-1,1] to [0.1, 1]

    for (const domain of detectedDomains) {
      let exposure = this.profile.domains.get(domain);
      if (!exposure) {
        exposure = {
          domain,
          weightedSessionCount: 0,
          rawSessionCount: 0,
          toolPatterns: [],
          filePatterns: [],
          insightCount: 0,
          firstSeen: now,
          lastSeen: now,
        };
        this.profile.domains.set(domain, exposure);
      }

      exposure.weightedSessionCount += weight;
      exposure.rawSessionCount++;
      exposure.lastSeen = now;

      // Track tool patterns
      for (const tc of actionLog.toolCalls) {
        if (!exposure.toolPatterns.includes(tc.tool)) {
          exposure.toolPatterns.push(tc.tool);
          if (exposure.toolPatterns.length > this.config.maxToolPatterns) {
            exposure.toolPatterns.shift();
          }
        }
      }

      // Count dimension insights
      exposure.insightCount += insightDimensions.length;
    }

    // Update primary domain
    this.updatePrimaryDomain();

    // Update specializations
    this.updateSpecializations();
  }

  /**
   * Detect domains from an action log.
   */
  private detectDomains(actionLog: ActionLog): string[] {
    const detected = new Set<string>();

    for (const rule of DOMAIN_RULES) {
      // Check file extensions in tool call params
      for (const tc of actionLog.toolCalls) {
        const paramStr = safeJsonStringify(tc.args).toLowerCase();

        for (const ext of rule.fileExtensions) {
          if (paramStr.includes(ext)) {
            detected.add(rule.domain);
          }
        }

        for (const pattern of rule.toolPatterns) {
          if (pattern.test(tc.tool.toLowerCase()) || pattern.test(paramStr)) {
            detected.add(rule.domain);
          }
        }

        // Check keywords in result
        const resultLower = String(tc.result ?? '').toLowerCase();
        for (const keyword of rule.keywords) {
          if (resultLower.includes(keyword)) {
            detected.add(rule.domain);
          }
        }
      }
    }

    return [...detected];
  }

  /**
   * Update primary domain (most weighted sessions).
   */
  private updatePrimaryDomain(): void {
    let maxWeight = 0;
    let primary: string | null = null;

    for (const [domain, exposure] of this.profile.domains) {
      if (exposure.weightedSessionCount > maxWeight) {
        maxWeight = exposure.weightedSessionCount;
        primary = domain;
      }
    }

    this.profile.primaryDomain = primary;
  }

  /**
   * Update specializations based on weighted session counts.
   */
  private updateSpecializations(): void {
    const specializations: Specialization[] = [];

    for (const [domain, exposure] of this.profile.domains) {
      const wsc = exposure.weightedSessionCount;
      let level: 'novice' | 'intermediate' | 'expert' | null = null;

      if (wsc >= this.config.expertThreshold) {
        level = 'expert';
      } else if (wsc >= this.config.intermediateThreshold) {
        level = 'intermediate';
      } else if (wsc >= this.config.noviceThreshold) {
        level = 'novice';
      }

      if (level) {
        const rule = DOMAIN_RULES.find(r => r.domain === domain);
        specializations.push({
          domain,
          level,
          activatedDimensions: rule?.activatedDimensions ?? [],
          guidance: rule?.guidanceByLevel[level] ?? [],
        });
      }
    }

    this.profile.specializations = specializations;
  }

  /**
   * Get the current domain profile.
   */
  getProfile(): DomainProfile {
    return {
      domains: new Map(this.profile.domains),
      primaryDomain: this.profile.primaryDomain,
      specializations: [...this.profile.specializations],
    };
  }

  /**
   * Get specializations.
   */
  getSpecializations(): Specialization[] {
    return [...this.profile.specializations];
  }

  /**
   * Get the primary domain.
   */
  getPrimaryDomain(): string | null {
    return this.profile.primaryDomain;
  }

  // ===========================================================================
  // §5 — CURVATURE-BASED EXPERTISE
  // ===========================================================================

  /**
   * §5: Update expertise using Hessian diagonal trace from energy gradient.
   *
   * Calls the existing update() then applies the §5 blended expertise
   * calculation. The Hessian diagonal provides curvature information that
   * tracks how "settled" the agent is in the energy landscape.
   *
   * @param actionLog - Session's action log
   * @param R - Session outcome quality [-1, 1]
   * @param hessianDiag - Hessian diagonal from EnergyGradientResult
   * @param insightDimensions - Dimensions that received insights this session
   */
  updateWithCurvature(
    actionLog: ActionLog,
    R: number,
    hessianDiag: Float64Array,
    insightDimensions: string[] = []
  ): void {
    // First, run the standard update
    this.update(actionLog, R, insightDimensions);

    // Then compute curvature-based expertise
    if (hessianDiag.length > 0) {
      this.curvatureExpertise = this.computeCurvatureExpertise(hessianDiag);
      this.curvatureSessions++;
    }
  }

  /**
   * §5: Compute curvature-based expertise from Hessian diagonal.
   *
   * κ(s) = (1/N) · Σᵢ H[i,i]       (mean curvature)
   * expertise(s) = σ(-(κ - κ_mid) / κ_scale)
   *
   * High curvature → landscape is sharp → novice (low expertise)
   * Low curvature → landscape is flat → expert (high expertise)
   */
  private computeCurvatureExpertise(hessianDiag: Float64Array): number {
    const n = hessianDiag.length;
    if (n === 0) return 0;

    const kappaMid = safeFinite(this.config.kappaMid, 1.0);
    const kappaScale = safeFinite(this.config.kappaScale, 0.5);

    // Mean curvature κ = (1/N) Σ H[i,i]
    let kappa = 0;
    for (let i = 0; i < n; i++) {
      kappa += safeFinite(hessianDiag[i], 0);
    }
    kappa = safeDivide(kappa, n, 0);

    // Sigmoid: σ(-(κ - κ_mid) / κ_scale)
    // Negative sign: higher curvature → lower expertise
    const z = safeDivide(-(kappa - kappaMid), kappaScale, 0);
    const sigmoid = 1 / (1 + Math.exp(-safeClamp(z, -20, 20, 0)));

    return safeFinite(sigmoid, 0);
  }

  /**
   * §5.2: Get blended expertise value for the primary domain.
   *
   * λ_blend = min(1, curvature_sessions / K_blend)
   * expertise = λ · curvature_expertise + (1-λ) · session_expertise
   *
   * Returns continuous expertise ∈ [0, 1].
   */
  getExpertise(): number {
    const K_blend = safeFinite(this.config.curvatureBlendSessions, 10);

    // Session-count expertise: min(1, weighted_session_count / 30)
    const primary = this.profile.primaryDomain;
    let sessionExpertise = 0;
    if (primary) {
      const exposure = this.profile.domains.get(primary);
      if (exposure) {
        sessionExpertise = safeClamp(
          safeDivide(exposure.weightedSessionCount, 30, 0),
          0, 1, 0
        );
      }
    }

    // Blending: transition from session-count to curvature as data accumulates
    const lambda = safeClamp(
      safeDivide(this.curvatureSessions, K_blend, 0),
      0, 1, 0
    );

    return safeFinite(
      lambda * this.curvatureExpertise + (1 - lambda) * sessionExpertise,
      0
    );
  }
}

// =============================================================================
// SERIALIZATION
// =============================================================================

export interface SerializedDomainProfile {
  domains: Record<string, DomainExposure>;
  primaryDomain: string | null;
}

export function serializeDomainProfile(profile: DomainProfile): SerializedDomainProfile {
  const domains: Record<string, DomainExposure> = {};
  for (const [key, val] of profile.domains) {
    domains[key] = val;
  }
  return { domains, primaryDomain: profile.primaryDomain };
}

export function deserializeDomainProfile(data: SerializedDomainProfile): DomainProfile {
  const domains = new Map<string, DomainExposure>();
  for (const [key, val] of Object.entries(data.domains)) {
    domains.set(key, val);
  }
  // Specializations are recomputed from domain data
  const tracker = new DomainTracker({}, {
    domains,
    primaryDomain: data.primaryDomain,
    specializations: [],
  });
  return tracker.getProfile();
}
