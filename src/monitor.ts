/**
 * YieldMonitor - Fetches real-time yield data from Solana DeFi protocols
 *
 * Uses jeeves' SolanaYield API as a data source (thanks jeeves!)
 * https://solana-yield.vercel.app/api/yields
 */

import axios from 'axios';

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
  private readonly SOLANA_YIELD_API = 'https://solana-yield.vercel.app/api/yields';
  private readonly DEFILLAMA_API = 'https://yields.llama.fi/pools';

  /**
   * Fetch yield opportunities from multiple sources
   */
  async fetchYields(): Promise<YieldOpportunity[]> {
    const yields: YieldOpportunity[] = [];

    // Try SolanaYield API first (jeeves' project)
    try {
      const solanaYieldData = await this.fetchFromSolanaYield();
      yields.push(...solanaYieldData);
    } catch (error) {
      console.warn('SolanaYield API unavailable, falling back to DeFiLlama');
    }

    // Fallback/supplement with DeFiLlama
    if (yields.length < 5) {
      try {
        const defiLlamaData = await this.fetchFromDeFiLlama();
        yields.push(...defiLlamaData);
      } catch (error) {
        console.warn('DeFiLlama API also unavailable');
      }
    }

    // Sort by APY descending
    return yields.sort((a, b) => b.apy - a.apy);
  }

  /**
   * Fetch from jeeves' SolanaYield API
   */
  private async fetchFromSolanaYield(): Promise<YieldOpportunity[]> {
    const response = await axios.get(this.SOLANA_YIELD_API, { timeout: 10000 });
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
   */
  private async fetchFromDeFiLlama(): Promise<YieldOpportunity[]> {
    const response = await axios.get(this.DEFILLAMA_API, { timeout: 15000 });
    const allPools = response.data.data || [];

    // Filter to Solana pools with reasonable APY
    const solanaPools = allPools.filter((pool: any) =>
      pool.chain === 'Solana' &&
      pool.apy > 0.1 &&
      pool.apy < 1000 && // Filter out unrealistic APYs
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
   */
  private assessRisk(item: any): 'low' | 'medium' | 'high' {
    if (item.riskRating) return item.riskRating;

    const protocol = (item.protocol || '').toLowerCase();
    const apy = parseFloat(item.apy) || 0;
    const tvl = parseFloat(item.tvl) || 0;

    // Known safe protocols
    const lowRiskProtocols = ['marinade', 'jito', 'sanctum', 'jupiter'];
    const mediumRiskProtocols = ['kamino', 'drift', 'raydium', 'orca'];

    if (lowRiskProtocols.some(p => protocol.includes(p))) return 'low';
    if (mediumRiskProtocols.some(p => protocol.includes(p))) return 'medium';

    // High APY is usually higher risk
    if (apy > 50) return 'high';
    if (apy > 20) return 'medium';

    // Low TVL is higher risk
    if (tvl < 1000000) return 'high';
    if (tvl < 10000000) return 'medium';

    return 'medium';
  }

  private assessRiskFromTvl(tvl: number, apy: number): 'low' | 'medium' | 'high' {
    if (tvl > 50000000 && apy < 20) return 'low';
    if (tvl > 10000000 && apy < 50) return 'medium';
    return 'high';
  }
}
