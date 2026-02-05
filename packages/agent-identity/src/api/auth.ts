/**
 * API Authentication Middleware
 *
 * Security hardening for the agent identity API.
 *
 * Features:
 * - API key authentication (hashed storage, timing-safe comparison)
 * - Environment-aware (devnet = optional, mainnet = required)
 * - Rate limiting integration
 * - Request logging for security audit
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

// =============================================================================
// TYPES
// =============================================================================

export interface AuthConfig {
  /** Environment - devnet is more permissive */
  network: 'devnet' | 'mainnet';

  /** Whether auth is required (mainnet: always, devnet: configurable) */
  requireAuth?: boolean;

  /** Hashed API keys (sha256 of actual key) */
  apiKeyHashes?: Set<string>;

  /** Rate limit per API key (requests per minute) */
  rateLimitPerKey?: number;

  /** Enable request logging for security audit */
  enableAuditLog?: boolean;
}

export interface AuthResult {
  authenticated: boolean;
  keyId?: string;           // Truncated key for logging (first 8 chars of hash)
  error?: string;
  rateLimitRemaining?: number;
}

export interface AuthenticatedRequest {
  keyId: string;
  timestamp: number;
  endpoint: string;
  method: string;
  ip: string;
}

// =============================================================================
// API KEY MANAGEMENT
// =============================================================================

/**
 * Hash an API key for storage.
 * NEVER store plaintext API keys.
 */
export function hashApiKey(key: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(key)));
}

/**
 * Generate a new API key (returns both plaintext and hash).
 * The plaintext should be shown to the user ONCE, then discarded.
 */
export function generateApiKey(): { key: string; hash: string } {
  // Generate 32 random bytes (256 bits of entropy)
  const randomBytes = new Uint8Array(32);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(randomBytes);
  } else {
    // Fallback for Node.js without webcrypto
    const nodeCrypto = require('crypto');
    const buffer = nodeCrypto.randomBytes(32);
    randomBytes.set(new Uint8Array(buffer));
  }

  // Encode as base64url (URL-safe)
  const key = bytesToHex(randomBytes);
  const hash = hashApiKey(key);

  return { key: `ak_${key}`, hash };
}

/**
 * Timing-safe comparison of API key hashes.
 * Prevents timing attacks on authentication.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

// =============================================================================
// RATE LIMITING PER API KEY
// =============================================================================

interface KeyRateLimit {
  requests: number[];  // Timestamps of recent requests
  windowMs: number;
}

const keyRateLimits = new Map<string, KeyRateLimit>();

function checkKeyRateLimit(
  keyHash: string,
  limitPerMinute: number
): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const windowMs = 60_000;  // 1 minute

  let limit = keyRateLimits.get(keyHash);
  if (!limit) {
    limit = { requests: [], windowMs };
    keyRateLimits.set(keyHash, limit);
  }

  // Remove expired timestamps
  limit.requests = limit.requests.filter(ts => ts > now - windowMs);

  const remaining = Math.max(0, limitPerMinute - limit.requests.length);

  if (limit.requests.length >= limitPerMinute) {
    return { allowed: false, remaining: 0 };
  }

  // Record this request
  limit.requests.push(now);

  return { allowed: true, remaining: remaining - 1 };
}

// =============================================================================
// AUDIT LOGGING
// =============================================================================

const auditLog: AuthenticatedRequest[] = [];
const MAX_AUDIT_LOG_SIZE = 10000;

function logRequest(request: AuthenticatedRequest): void {
  auditLog.push(request);

  // Keep log bounded
  if (auditLog.length > MAX_AUDIT_LOG_SIZE) {
    auditLog.shift();
  }
}

/**
 * Get recent audit log entries.
 */
export function getAuditLog(limit: number = 100): AuthenticatedRequest[] {
  return auditLog.slice(-limit);
}

/**
 * Get audit log entries for a specific key.
 */
export function getAuditLogForKey(keyId: string, limit: number = 100): AuthenticatedRequest[] {
  return auditLog
    .filter(r => r.keyId === keyId)
    .slice(-limit);
}

// =============================================================================
// AUTH MIDDLEWARE
// =============================================================================

/**
 * AuthMiddleware: Validates API key authentication.
 */
export class AuthMiddleware {
  private config: Required<AuthConfig>;

  constructor(config: AuthConfig) {
    this.config = {
      network: config.network,
      requireAuth: config.requireAuth ?? (config.network === 'mainnet'),
      apiKeyHashes: config.apiKeyHashes ?? new Set(),
      rateLimitPerKey: config.rateLimitPerKey ?? 100,
      enableAuditLog: config.enableAuditLog ?? true,
    };
  }

  /**
   * Authenticate a request.
   *
   * @param headers - Request headers (looks for x-api-key or Authorization: Bearer)
   * @param endpoint - Endpoint being accessed (for logging)
   * @param method - HTTP method (for logging)
   * @param ip - Client IP (for logging)
   */
  authenticate(
    headers: Record<string, string | string[] | undefined>,
    endpoint: string,
    method: string,
    ip: string
  ): AuthResult {
    // Extract API key from headers
    const apiKey = this.extractApiKey(headers);

    // If no key and auth not required, allow
    if (!apiKey && !this.config.requireAuth) {
      return { authenticated: true, keyId: 'anonymous' };
    }

    // If no key and auth required, reject
    if (!apiKey) {
      return {
        authenticated: false,
        error: 'API key required. Provide via x-api-key header or Authorization: Bearer token.',
      };
    }

    // Hash the provided key
    const keyHash = hashApiKey(apiKey);
    const keyId = keyHash.slice(0, 8);  // Truncated for logging

    // Check if key is valid (timing-safe comparison)
    let keyValid = false;
    const keyHashArray = Array.from(this.config.apiKeyHashes);
    for (let i = 0; i < keyHashArray.length; i++) {
      if (timingSafeEqual(keyHash, keyHashArray[i])) {
        keyValid = true;
        break;
      }
    }

    if (!keyValid) {
      // Log failed attempt
      if (this.config.enableAuditLog) {
        logRequest({
          keyId: `invalid:${keyId}`,
          timestamp: Date.now(),
          endpoint,
          method,
          ip,
        });
      }

      return {
        authenticated: false,
        error: 'Invalid API key.',
      };
    }

    // Check rate limit for this key
    const rateLimit = checkKeyRateLimit(keyHash, this.config.rateLimitPerKey);
    if (!rateLimit.allowed) {
      return {
        authenticated: false,
        keyId,
        error: 'Rate limit exceeded for this API key.',
        rateLimitRemaining: 0,
      };
    }

    // Log successful request
    if (this.config.enableAuditLog) {
      logRequest({
        keyId,
        timestamp: Date.now(),
        endpoint,
        method,
        ip,
      });
    }

    return {
      authenticated: true,
      keyId,
      rateLimitRemaining: rateLimit.remaining,
    };
  }

  /**
   * Extract API key from request headers.
   */
  private extractApiKey(headers: Record<string, string | string[] | undefined>): string | null {
    // Check x-api-key header
    const xApiKey = headers['x-api-key'];
    if (xApiKey) {
      return Array.isArray(xApiKey) ? xApiKey[0] : xApiKey;
    }

    // Check Authorization: Bearer header
    const auth = headers['authorization'] || headers['Authorization'];
    if (auth) {
      const authStr = Array.isArray(auth) ? auth[0] : auth;
      if (authStr.startsWith('Bearer ')) {
        return authStr.slice(7);
      }
    }

    return null;
  }

  /**
   * Add a new API key (store only the hash).
   */
  addApiKey(keyHash: string): void {
    this.config.apiKeyHashes.add(keyHash);
  }

  /**
   * Remove an API key.
   */
  removeApiKey(keyHash: string): void {
    this.config.apiKeyHashes.delete(keyHash);
  }

  /**
   * Check if auth is required.
   */
  isAuthRequired(): boolean {
    return this.config.requireAuth;
  }

  /**
   * Get the number of registered API keys.
   */
  getKeyCount(): number {
    return this.config.apiKeyHashes.size;
  }
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Create an AuthMiddleware with default configuration.
 */
export function createAuthMiddleware(config: AuthConfig): AuthMiddleware {
  return new AuthMiddleware(config);
}

/**
 * Create a devnet auth middleware (optional auth, permissive).
 */
export function createDevnetAuthMiddleware(
  apiKeyHashes?: Set<string>
): AuthMiddleware {
  return new AuthMiddleware({
    network: 'devnet',
    requireAuth: false,  // Optional for devnet
    apiKeyHashes: apiKeyHashes || new Set(),
    rateLimitPerKey: 200,  // More permissive for devnet
    enableAuditLog: true,
  });
}

/**
 * Create a mainnet auth middleware (required auth, strict).
 */
export function createMainnetAuthMiddleware(
  apiKeyHashes: Set<string>
): AuthMiddleware {
  if (apiKeyHashes.size === 0) {
    console.warn('[AuthMiddleware] WARNING: Creating mainnet auth with no API keys registered!');
  }

  return new AuthMiddleware({
    network: 'mainnet',
    requireAuth: true,  // Always required for mainnet
    apiKeyHashes,
    rateLimitPerKey: 100,  // Stricter for mainnet
    enableAuditLog: true,
  });
}

// =============================================================================
// EXPRESS/VERCEL MIDDLEWARE HELPER
// =============================================================================

/**
 * Create an Express/Vercel-compatible middleware function.
 *
 * Usage:
 * ```typescript
 * const authMiddleware = createAuthMiddleware({ network: 'mainnet', apiKeyHashes });
 * const middleware = createExpressMiddleware(authMiddleware);
 *
 * // Express
 * app.use('/api', middleware);
 *
 * // Vercel
 * export default async function handler(req, res) {
 *   const authResult = middleware(req, res);
 *   if (!authResult.authenticated) {
 *     return res.status(401).json({ error: authResult.error });
 *   }
 *   // ... handle request
 * }
 * ```
 */
export function createExpressMiddleware(
  authMiddleware: AuthMiddleware
): (req: any, res: any, next?: () => void) => AuthResult {
  return (req: any, res: any, next?: () => void): AuthResult => {
    const headers = req.headers || {};
    const endpoint = req.url || req.path || '/';
    const method = req.method || 'GET';
    const ip = headers['x-forwarded-for']?.split(',')[0] ||
               headers['x-real-ip'] ||
               req.ip ||
               req.socket?.remoteAddress ||
               'unknown';

    const result = authMiddleware.authenticate(headers, endpoint, method, ip);

    // Add rate limit headers
    if (result.rateLimitRemaining !== undefined) {
      res.setHeader('X-RateLimit-Remaining', String(result.rateLimitRemaining));
    }

    if (!result.authenticated) {
      // Don't automatically send response - let caller handle it
      // This allows for custom error responses
    }

    // Call next if provided and authenticated
    if (next && result.authenticated) {
      next();
    }

    return result;
  };
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  // Core classes
  AuthMiddleware,

  // Factory functions
  createAuthMiddleware,
  createDevnetAuthMiddleware,
  createMainnetAuthMiddleware,
  createExpressMiddleware,

  // Key management
  hashApiKey,
  generateApiKey,

  // Audit log
  getAuditLog,
  getAuditLogForKey,
};
