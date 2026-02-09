/**
 * Rate Limiter - Sliding Window Implementation
 *
 * Protects API endpoints from abuse using per-IP, per-endpoint tracking.
 * Uses sliding window algorithm to prevent burst attacks at window boundaries.
 */

import { getRateLimitConfig, RateLimitConfig } from './config';

interface RequestRecord {
  timestamps: number[];  // Timestamps of requests within the window
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;        // Milliseconds until oldest request expires
  retryAfterMs?: number;  // If blocked, when to retry
}

/**
 * Sliding Window Rate Limiter
 *
 * Tracks requests per client (IP) per endpoint and enforces limits
 * using a sliding time window rather than fixed intervals.
 */
export class RateLimiter {
  // Map of "ip:endpoint" -> RequestRecord
  private requests: Map<string, RequestRecord> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Clean up expired entries every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  /**
   * Check if a request is allowed
   *
   * @param clientId - Client identifier (usually IP address)
   * @param endpoint - API endpoint path
   * @returns Result indicating if request is allowed and rate limit info
   */
  check(clientId: string, endpoint: string): RateLimitResult {
    const config = getRateLimitConfig(endpoint);
    const key = this.makeKey(clientId, endpoint);
    const now = Date.now();

    // Get or create request record
    let record = this.requests.get(key);
    if (!record) {
      record = { timestamps: [] };
      this.requests.set(key, record);
    }

    // Remove timestamps outside the current window
    const windowStart = now - config.windowMs;
    record.timestamps = record.timestamps.filter(ts => ts > windowStart);

    // Calculate remaining requests
    const remaining = Math.max(0, config.maxRequests - record.timestamps.length);

    // Calculate reset time (when oldest request in window expires)
    const resetMs = record.timestamps.length > 0
      ? Math.max(0, record.timestamps[0] + config.windowMs - now)
      : 0;

    // Check if request is allowed
    if (record.timestamps.length >= config.maxRequests) {
      // Request denied
      const oldestTimestamp = record.timestamps[0];
      const retryAfterMs = oldestTimestamp + config.windowMs - now;

      return {
        allowed: false,
        remaining: 0,
        resetMs,
        retryAfterMs: Math.max(0, retryAfterMs)
      };
    }

    // Request allowed - record it
    record.timestamps.push(now);

    return {
      allowed: true,
      remaining: remaining - 1,  // After this request
      resetMs
    };
  }

  /**
   * Get current rate limit status without consuming a request
   */
  status(clientId: string, endpoint: string): RateLimitResult {
    const config = getRateLimitConfig(endpoint);
    const key = this.makeKey(clientId, endpoint);
    const now = Date.now();

    const record = this.requests.get(key);
    if (!record) {
      return {
        allowed: true,
        remaining: config.maxRequests,
        resetMs: 0
      };
    }

    // Remove timestamps outside the current window
    const windowStart = now - config.windowMs;
    const validTimestamps = record.timestamps.filter(ts => ts > windowStart);

    const remaining = Math.max(0, config.maxRequests - validTimestamps.length);
    const resetMs = validTimestamps.length > 0
      ? Math.max(0, validTimestamps[0] + config.windowMs - now)
      : 0;

    return {
      allowed: remaining > 0,
      remaining,
      resetMs
    };
  }

  /**
   * Reset rate limit for a client/endpoint (for admin use)
   */
  reset(clientId: string, endpoint: string): void {
    const key = this.makeKey(clientId, endpoint);
    this.requests.delete(key);
  }

  /**
   * Reset all rate limits for a client (for admin use)
   */
  resetClient(clientId: string): void {
    const prefix = `${clientId}:`;
    for (const key of this.requests.keys()) {
      if (key.startsWith(prefix)) {
        this.requests.delete(key);
      }
    }
  }

  /**
   * Clean up expired entries to prevent memory leaks
   */
  private cleanup(): void {
    const now = Date.now();

    for (const [key, record] of this.requests.entries()) {
      // Extract endpoint from key to get its config
      const endpoint = key.split(':').slice(1).join(':');
      const config = getRateLimitConfig(endpoint);
      const windowStart = now - config.windowMs;

      // Remove expired timestamps
      record.timestamps = record.timestamps.filter(ts => ts > windowStart);

      // Remove the record entirely if no timestamps remain
      if (record.timestamps.length === 0) {
        this.requests.delete(key);
      }
    }
  }

  /**
   * Create a unique key for client + endpoint combination
   */
  private makeKey(clientId: string, endpoint: string): string {
    // Normalize endpoint (remove query string)
    const normalizedEndpoint = endpoint.split('?')[0];
    return `${clientId}:${normalizedEndpoint}`;
  }

  /**
   * Stop the cleanup interval (for graceful shutdown)
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Get statistics for monitoring
   */
  getStats(): { totalClients: number; totalEntries: number } {
    const clients = new Set<string>();
    for (const key of this.requests.keys()) {
      const clientId = key.split(':')[0];
      clients.add(clientId);
    }

    return {
      totalClients: clients.size,
      totalEntries: this.requests.size
    };
  }
}

// Global rate limiter instance
export const rateLimiter = new RateLimiter();

/**
 * Express/Vercel middleware helper
 *
 * Extracts client IP from request headers (handles proxies).
 *
 * Security: x-real-ip is preferred because Vercel sets it to the
 * actual client IP and it cannot be spoofed by the client.
 * x-forwarded-for CAN be spoofed — a client can prepend fake IPs,
 * and the code would use the fake one as the "client" IP, bypassing
 * rate limiting entirely. We only fall back to x-forwarded-for when
 * x-real-ip is absent (non-Vercel environments).
 */
export function getClientIp(headers: Record<string, string | string[] | undefined>): string {
  // Prefer x-real-ip — set by Vercel/nginx, not spoofable by clients
  const realIp = headers['x-real-ip'];
  if (realIp) {
    const ip = Array.isArray(realIp) ? realIp[0] : realIp;
    if (ip) return ip.trim();
  }

  // Fallback to x-forwarded-for (take LAST IP — most recently added by trusted proxy)
  const forwardedFor = headers['x-forwarded-for'];
  if (forwardedFor) {
    const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    const parts = ips.split(',').map(s => s.trim()).filter(Boolean);
    // Last IP is added by the edge proxy (trusted), first may be client-spoofed
    if (parts.length > 0) return parts[parts.length - 1];
  }

  return 'unknown';
}

/**
 * Generate rate limit response headers
 */
export function getRateLimitHeaders(result: RateLimitResult, config: RateLimitConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(config.maxRequests),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.ceil(result.resetMs / 1000))
  };

  if (!result.allowed && result.retryAfterMs !== undefined) {
    headers['Retry-After'] = String(Math.ceil(result.retryAfterMs / 1000));
  }

  return headers;
}
