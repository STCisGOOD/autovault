/**
 * Price Cache - TTL-based caching for price data
 *
 * Implements a stale-while-revalidate pattern with three freshness levels:
 * - Fresh: Data is current, use without concern
 * - Stale: Data is old but usable, log a warning
 * - Expired: Data is too old, refuse to use
 */

import { PRICE_CACHE_CONFIG } from './config';

export type PriceFreshness = 'fresh' | 'stale' | 'expired';

interface CacheEntry {
  price: number;
  fetchedAt: number;
  source: string;
}

interface CacheResult {
  price: number;
  freshness: PriceFreshness;
  ageMs: number;
  source: string;
}

/**
 * Price Cache with TTL management
 */
export class PriceCache {
  private cache: Map<string, CacheEntry> = new Map();
  private config = PRICE_CACHE_CONFIG;

  /**
   * Get a cached price if available and not expired
   *
   * @param key - Cache key (e.g., "SOL", "coingecko:solana")
   * @returns Cache result or null if not found/expired
   */
  get(key: string): CacheResult | null {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    const now = Date.now();
    const ageMs = now - entry.fetchedAt;
    const freshness = this.calculateFreshness(ageMs);

    if (freshness === 'expired') {
      // Data too old, remove from cache
      this.cache.delete(key);
      return null;
    }

    return {
      price: entry.price,
      freshness,
      ageMs,
      source: entry.source
    };
  }

  /**
   * Store a price in the cache
   *
   * @param key - Cache key
   * @param price - Price value
   * @param source - Source of the price (e.g., "coingecko", "jupiter")
   */
  set(key: string, price: number, source: string): void {
    this.cache.set(key, {
      price,
      fetchedAt: Date.now(),
      source
    });
  }

  /**
   * Check if a cached price exists and is not expired
   */
  has(key: string): boolean {
    const result = this.get(key);
    return result !== null;
  }

  /**
   * Get price with automatic staleness handling
   *
   * Returns the price if fresh or stale (with warning logged).
   * Returns null if expired or not found.
   */
  getWithWarning(key: string): { price: number; isStale: boolean } | null {
    const result = this.get(key);

    if (!result) {
      return null;
    }

    if (result.freshness === 'stale') {
      console.warn(
        `[PriceCache] Using stale price for ${key}: ` +
        `$${result.price} (${Math.round(result.ageMs / 1000)}s old, source: ${result.source})`
      );
    }

    return {
      price: result.price,
      isStale: result.freshness === 'stale'
    };
  }

  /**
   * Clear all cached prices
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Remove a specific key from cache
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    entries: number;
    fresh: number;
    stale: number;
    keys: string[];
  } {
    let fresh = 0;
    let stale = 0;
    const now = Date.now();

    for (const entry of this.cache.values()) {
      const ageMs = now - entry.fetchedAt;
      const freshness = this.calculateFreshness(ageMs);

      if (freshness === 'fresh') fresh++;
      else if (freshness === 'stale') stale++;
      // expired entries are removed on access, so shouldn't be counted
    }

    return {
      entries: this.cache.size,
      fresh,
      stale,
      keys: Array.from(this.cache.keys())
    };
  }

  /**
   * Prune expired entries (call periodically)
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [key, entry] of this.cache.entries()) {
      const ageMs = now - entry.fetchedAt;
      if (ageMs > this.config.maxAgeMs) {
        this.cache.delete(key);
        pruned++;
      }
    }

    return pruned;
  }

  /**
   * Calculate freshness level based on age
   */
  private calculateFreshness(ageMs: number): PriceFreshness {
    if (ageMs <= this.config.freshTtlMs) {
      return 'fresh';
    } else if (ageMs <= this.config.staleTtlMs) {
      return 'stale';
    } else if (ageMs <= this.config.maxAgeMs) {
      return 'stale';  // Still usable but very stale
    } else {
      return 'expired';
    }
  }
}

// Global price cache instance
export const priceCache = new PriceCache();

/**
 * Utility: Get price with cache-first strategy
 *
 * 1. Check cache first
 * 2. If cache miss or expired, fetch fresh data
 * 3. Store fresh data in cache
 * 4. Return result
 *
 * @param key - Cache key
 * @param fetchFn - Function to fetch fresh price if cache miss
 * @param source - Source identifier for logging
 */
export async function getCachedPrice(
  key: string,
  fetchFn: () => Promise<number>,
  source: string
): Promise<{ price: number; fromCache: boolean; isStale: boolean }> {
  // Check cache first
  const cached = priceCache.get(key);

  if (cached && cached.freshness === 'fresh') {
    return {
      price: cached.price,
      fromCache: true,
      isStale: false
    };
  }

  // Try to fetch fresh data
  try {
    const freshPrice = await fetchFn();
    priceCache.set(key, freshPrice, source);

    return {
      price: freshPrice,
      fromCache: false,
      isStale: false
    };
  } catch (error) {
    // Fetch failed - fall back to stale cache if available
    if (cached && cached.freshness === 'stale') {
      console.warn(
        `[PriceCache] Fetch failed for ${key}, using stale cache: ` +
        `$${cached.price} (${Math.round(cached.ageMs / 1000)}s old)`
      );

      return {
        price: cached.price,
        fromCache: true,
        isStale: true
      };
    }

    // No cache available, rethrow
    throw error;
  }
}

/**
 * Error thrown when no valid price is available
 */
export class PriceUnavailableError extends Error {
  constructor(asset: string, reason: string) {
    super(`Price unavailable for ${asset}: ${reason}`);
    this.name = 'PriceUnavailableError';
  }
}
