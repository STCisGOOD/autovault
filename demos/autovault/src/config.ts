/**
 * Centralized Configuration - Security Hardening
 *
 * Single source of truth for all configurable values.
 * Eliminates magic numbers and enables environment-aware behavior.
 */

// ============ RISK PROFILES ============

export interface RiskProfile {
  maxPositions: number;
  maxAllocation: number;  // Maximum allocation to a single position (0-1)
  riskLevels: ('low' | 'medium' | 'high')[];  // Acceptable risk levels
}

export const RISK_PROFILES: Record<'conservative' | 'moderate' | 'aggressive', RiskProfile> = {
  conservative: {
    maxPositions: 3,
    maxAllocation: 0.4,
    riskLevels: ['low']
  },
  moderate: {
    maxPositions: 5,
    maxAllocation: 0.5,
    riskLevels: ['low', 'medium']
  },
  aggressive: {
    maxPositions: 7,
    maxAllocation: 0.6,
    riskLevels: ['low', 'medium', 'high']
  }
};

export function getRiskProfile(tolerance: 'conservative' | 'moderate' | 'aggressive'): RiskProfile {
  return RISK_PROFILES[tolerance];
}

// ============ RISK THRESHOLDS ============

export interface RiskThresholds {
  tvl: {
    high: number;    // TVL above this = low risk
    medium: number;  // TVL above this = medium risk
    // Below medium = high risk
  };
  apy: {
    suspicious: number;  // APY above this is likely unsustainable/scam
    elevated: number;    // APY above this warrants caution
    normal: number;      // APY below this is expected for stable protocols
  };
}

export const RISK_THRESHOLDS: RiskThresholds = {
  tvl: {
    high: 50_000_000,    // $50M TVL = established protocol
    medium: 10_000_000,  // $10M TVL = moderate confidence
  },
  apy: {
    suspicious: 500,  // 500% APY is almost certainly unsustainable
    elevated: 50,     // 50% APY warrants extra scrutiny
    normal: 20        // 20% APY is reasonable for DeFi
  }
};

// ============ RATE LIMITING ============

export interface RateLimitConfig {
  windowMs: number;  // Time window in milliseconds
  maxRequests: number;
}

export const RATE_LIMITS: Record<string, RateLimitConfig> = {
  '/api/cycle': { windowMs: 60_000, maxRequests: 10 },
  '/api/yields': { windowMs: 60_000, maxRequests: 30 },
  '/api/recommendation': { windowMs: 60_000, maxRequests: 20 },
  '/api/memory/export': { windowMs: 60_000, maxRequests: 5 },
  '/api/ping': { windowMs: 60_000, maxRequests: 6 },      // 2 pings/session × 3 sessions/min generous cap
  '/api/network': { windowMs: 60_000, maxRequests: 10 },   // Dashboard refresh every 30s = 2/min
  'default': { windowMs: 60_000, maxRequests: 100 }
};

export function getRateLimitConfig(endpoint: string): RateLimitConfig {
  // Normalize endpoint path
  const normalizedPath = endpoint.split('?')[0];
  return RATE_LIMITS[normalizedPath] || RATE_LIMITS['default'];
}

// ============ CIRCUIT BREAKER ============

export interface CircuitBreakerConfig {
  failureThreshold: number;      // Failures before opening circuit
  successThreshold: number;      // Successes in half-open before closing
  timeout: number;               // Time in ms before trying half-open
  monitoringWindow: number;      // Time window for counting failures
}

export const CIRCUIT_BREAKER_CONFIGS: Record<string, CircuitBreakerConfig> = {
  'solanaYield': {
    failureThreshold: 3,
    successThreshold: 2,
    timeout: 30_000,        // 30 seconds before retry
    monitoringWindow: 60_000  // Count failures within 1 minute
  },
  'defiLlama': {
    failureThreshold: 3,
    successThreshold: 2,
    timeout: 30_000,
    monitoringWindow: 60_000
  },
  'jupiter': {
    failureThreshold: 5,     // More tolerant for trading API
    successThreshold: 3,
    timeout: 15_000,         // Faster retry for trading
    monitoringWindow: 60_000
  },
  'coingecko': {
    failureThreshold: 3,
    successThreshold: 2,
    timeout: 60_000,         // Longer timeout (rate limited API)
    monitoringWindow: 120_000
  },
  'default': {
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 30_000,
    monitoringWindow: 60_000
  }
};

export function getCircuitBreakerConfig(service: string): CircuitBreakerConfig {
  return CIRCUIT_BREAKER_CONFIGS[service] || CIRCUIT_BREAKER_CONFIGS['default'];
}

// ============ PRICE CACHE ============

export interface PriceCacheConfig {
  freshTtlMs: number;      // Data considered fresh
  staleTtlMs: number;      // Data usable with warning
  maxAgeMs: number;        // Data too old to use
}

export const PRICE_CACHE_CONFIG: PriceCacheConfig = {
  freshTtlMs: 30_000,      // 30 seconds - price considered current
  staleTtlMs: 300_000,     // 5 minutes - usable but with warning
  maxAgeMs: 600_000        // 10 minutes - refuse to use
};

// ============ CORS CONFIGURATION ============

// Production-approved origins
const PRODUCTION_ORIGINS = [
  'https://autovault-six.vercel.app',
  'https://autovault.vercel.app'
];

// Development origins (only allowed when NODE_ENV !== 'production')
const DEVELOPMENT_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173'
];

/**
 * Get allowed CORS origins based on environment
 */
export function getAllowedOrigins(): string[] {
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    return PRODUCTION_ORIGINS;
  }

  // In development, allow both production and dev origins
  return [...PRODUCTION_ORIGINS, ...DEVELOPMENT_ORIGINS];
}

/**
 * Check if an origin is allowed
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;  // Same-origin requests have no Origin header
  return getAllowedOrigins().includes(origin);
}

/**
 * Get the default origin for responses without Origin header
 */
export function getDefaultOrigin(): string {
  return PRODUCTION_ORIGINS[0];
}

// ============ API ENDPOINTS ============

export const API_ENDPOINTS = {
  solanaYield: 'https://solana-yield.vercel.app/api/yields',
  defiLlama: 'https://yields.llama.fi/pools',
  jupiterQuote: 'https://quote-api.jup.ag/v6/quote',
  jupiterSwap: 'https://quote-api.jup.ag/v6/swap',
  coingecko: 'https://api.coingecko.com/api/v3/simple/price'
};

// ============ REQUEST TIMEOUTS ============

export const REQUEST_TIMEOUTS = {
  solanaYield: 8_000,   // 8 seconds
  defiLlama: 15_000,    // 15 seconds (larger response)
  jupiter: 10_000,      // 10 seconds
  coingecko: 5_000,     // 5 seconds
  default: 10_000
};

// ============ KNOWN PROTOCOLS ============

export const LOW_RISK_PROTOCOLS = ['marinade', 'jito', 'sanctum', 'jupiter'];
export const MEDIUM_RISK_PROTOCOLS = ['kamino', 'drift', 'raydium', 'orca'];

// ============ TOKEN MINTS ============

export const TOKEN_MINTS: Record<string, string> = {
  'SOL': 'So11111111111111111111111111111111111111112',
  'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'mSOL': 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'jitoSOL': 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  'bSOL': 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
};
