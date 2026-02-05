/**
 * YieldMonitor - Fetches real-time yield data from Solana DeFi protocols
 *
 * Uses jeeves' SolanaYield API as a data source (thanks jeeves!)
 * https://solana-yield.vercel.app/api/yields
 *
 * Security Hardening:
 * - Circuit breaker protection for external APIs
 * - Centralized configuration for endpoints and timeouts
 */

import axios from 'axios';
import {
  API_ENDPOINTS,
  REQUEST_TIMEOUTS,
  LOW_RISK_PROTOCOLS,
  MEDIUM_RISK_PROTOCOLS,
  RISK_THRESHOLDS
} from './config';
import { withCircuitBreaker, CircuitOpenError, circuitBreakerManager } from './circuit-breaker';

export interface YieldOpportunity {
  protocol: string;
  pool: string;
  asset: string;
  apy: number;
  tvl: number;
  riskRating: 'low' | 'medium' | 'high';
  source: string;
}

export class YieldMonitor {
  // Use centralized API endpoints
  private readonly SOLANA_YIELD_API = API_ENDPOINTS.solanaYield;
  private readonly DEFILLAMA_API = API_ENDPOINTS.defiLlama;

  /**
   * Fetch yield opportunities from multiple sources with circuit breaker protection
   *
   * Circuit breakers prevent cascading failures when external APIs are unavailable.
   * Each API has independent failure tracking.
   */
  async fetchYields(): Promise<YieldOpportunity[]> {
    const yields: YieldOpportunity[] = [];
    const errors: string[] = [];

    // Try SolanaYield API first (jeeves' project) with circuit breaker
    const solanaYieldBreaker = circuitBreakerManager.getBreaker('solanaYield');
    if (solanaYieldBreaker.canRequest()) {
      try {
        const solanaYieldData = await this.fetchFromSolanaYield();
        yields.push(...solanaYieldData);
        solanaYieldBreaker.recordSuccess();
      } catch (error) {
        solanaYieldBreaker.recordFailure();
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push(`SolanaYield: ${errorMsg}`);
        console.warn('[YieldMonitor] SolanaYield API failed:', errorMsg);
      }
    } else {
      errors.push('SolanaYield: Circuit breaker open');
      console.warn('[YieldMonitor] SolanaYield circuit breaker is open, skipping');
    }

    // Fallback/supplement with DeFiLlama (with its own circuit breaker)
    if (yields.length < 5) {
      const defiLlamaBreaker = circuitBreakerManager.getBreaker('defiLlama');
      if (defiLlamaBreaker.canRequest()) {
        try {
          const defiLlamaData = await this.fetchFromDeFiLlama();
          yields.push(...defiLlamaData);
          defiLlamaBreaker.recordSuccess();
        } catch (error) {
          defiLlamaBreaker.recordFailure();
          const errorMsg = error instanceof Error ? error.message : String(error);
          errors.push(`DeFiLlama: ${errorMsg}`);
          console.warn('[YieldMonitor] DeFiLlama API failed:', errorMsg);
        }
      } else {
        errors.push('DeFiLlama: Circuit breaker open');
        console.warn('[YieldMonitor] DeFiLlama circuit breaker is open, skipping');
      }
    }

    // Log warning if no data available from any source
    if (yields.length === 0 && errors.length > 0) {
      console.error('[YieldMonitor] All yield sources failed:', errors.join('; '));
    }

    // Sort by APY descending
    return yields.sort((a, b) => b.apy - a.apy);
  }

  /**
   * Fetch from jeeves' SolanaYield API
   *
   * Uses centralized timeout configuration
   */
  private async fetchFromSolanaYield(): Promise<YieldOpportunity[]> {
    const response = await axios.get(this.SOLANA_YIELD_API, {
      timeout: REQUEST_TIMEOUTS.solanaYield
    });
    const data = response.data;

    // Map to our internal format
    if (Array.isArray(data)) {
      return data.map((item: any) => ({
        protocol: item.protocol || item.project || 'Unknown',
        pool: item.pool || item.symbol || 'Unknown',
        asset: item.asset || item.symbol || 'Unknown',
        apy: parseFloat(item.apy) || 0,
        tvl: parseFloat(item.tvl) || 0,
        riskRating: this.assessRisk(item),
        source: 'SolanaYield'
      }));
    }

    return [];
  }

  /**
   * Fetch from DeFiLlama yields API (Solana pools only)
   *
   * Uses centralized timeout and risk threshold configuration
   */
  private async fetchFromDeFiLlama(): Promise<YieldOpportunity[]> {
    const response = await axios.get(this.DEFILLAMA_API, {
      timeout: REQUEST_TIMEOUTS.defiLlama
    });
    const allPools = response.data.data || [];

    // Filter to Solana pools with reasonable APY (using config thresholds)
    const solanaPools = allPools.filter((pool: any) =>
      pool.chain === 'Solana' &&
      pool.apy > 0.1 &&
      pool.apy < RISK_THRESHOLDS.apy.suspicious && // Filter out unrealistic APYs
      pool.tvlUsd > 100000 // Minimum $100k TVL
    );

    return solanaPools.slice(0, 20).map((pool: any) => ({
      protocol: pool.project || 'Unknown',
      pool: pool.symbol || 'Unknown',
      asset: pool.symbol?.split('-')[0] || 'Unknown',
      apy: pool.apy,
      tvl: pool.tvlUsd,
      riskRating: this.assessRiskFromTvl(pool.tvlUsd, pool.apy),
      source: 'DeFiLlama'
    }));
  }

  /**
   * Assess risk based on protocol and metrics
   *
   * Uses centralized risk thresholds and protocol lists
   */
  private assessRisk(item: any): 'low' | 'medium' | 'high' {
    if (item.riskRating) return item.riskRating;

    const protocol = (item.protocol || '').toLowerCase();
    const apy = parseFloat(item.apy) || 0;
    const tvl = parseFloat(item.tvl) || 0;

    // Known safe protocols (from config)
    if (LOW_RISK_PROTOCOLS.some(p => protocol.includes(p))) return 'low';
    if (MEDIUM_RISK_PROTOCOLS.some(p => protocol.includes(p))) return 'medium';

    // High APY is usually higher risk (using config thresholds)
    if (apy > RISK_THRESHOLDS.apy.elevated) return 'high';
    if (apy > RISK_THRESHOLDS.apy.normal) return 'medium';

    // Low TVL is higher risk (using config thresholds)
    if (tvl < 1_000_000) return 'high';
    if (tvl < RISK_THRESHOLDS.tvl.medium) return 'medium';

    return 'medium';
  }

  /**
   * Assess risk based on TVL and APY (for DeFiLlama data)
   *
   * Uses centralized risk thresholds
   */
  private assessRiskFromTvl(tvl: number, apy: number): 'low' | 'medium' | 'high' {
    if (tvl > RISK_THRESHOLDS.tvl.high && apy < RISK_THRESHOLDS.apy.normal) return 'low';
    if (tvl > RISK_THRESHOLDS.tvl.medium && apy < RISK_THRESHOLDS.apy.elevated) return 'medium';
    return 'high';
  }

  /**
   * Get circuit breaker status for monitoring
   */
  getCircuitBreakerStatus(): Record<string, { state: string; failures: number }> {
    return {
      solanaYield: circuitBreakerManager.getBreaker('solanaYield').getStatus(),
      defiLlama: circuitBreakerManager.getBreaker('defiLlama').getStatus()
    } as Record<string, { state: string; failures: number }>;
  }
}
