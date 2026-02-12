/**
 * Agent Registry — discovers agents from on-chain program accounts.
 *
 * Uses getProgramAccounts with caching to avoid hammering the RPC.
 * Falls back to mock data if RPC is unreachable.
 */

import { PublicKey } from '@solana/web3.js';
import { getConnection, PROGRAM_ID, parseAgentIdentity } from './solana';
import { generateMockAgents } from './mockData';
import { inferDomain, inferSpecialty, truncatePubkey } from './types';
import type { AgentListing } from './types';
import { mulberry32, hashString, generateEvolution, DIMENSIONS } from '../three/ridgeMath';

// ─── Cache ────────────────────────────────────────────────────────────────

let cachedAgents: AgentListing[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000; // 60 seconds

// ─── Fetcher ──────────────────────────────────────────────────────────────

/**
 * Fetch all agent identity accounts from devnet.
 * Returns cached results if within TTL.
 */
export async function fetchAgents(): Promise<AgentListing[]> {
  const now = Date.now();
  if (cachedAgents && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedAgents;
  }

  try {
    const connection = getConnection();
    const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
      commitment: 'confirmed',
    });

    const agents: AgentListing[] = [];

    for (const { pubkey: accountPubkey, account } of accounts) {
      const parsed = parseAgentIdentity(Buffer.from(account.data));
      if (!parsed || parsed.dimensionCount === 0) continue;

      const authorityKey = parsed.authority.toBase58();
      const rng = mulberry32(hashString(authorityKey + '_meta'));

      // Compute trust score from on-chain metrics
      const trustScore = Math.round(
        Math.min(100, Math.max(0,
          parsed.continuityScore * 40 +
          (1 - parsed.coherenceScore) * 30 +
          parsed.stabilityScore * 30
        ))
      );

      // Use deterministic data for fitness (from evolution sim)
      const sessions = generateEvolution(authorityKey, 25);
      const latestFitness = sessions.length > 0 ? sessions[sessions.length - 1].fitness : 0.5;

      // Price: deterministic from pubkey
      const priceUSDC = Math.round((0.01 + rng() * 0.49) * 100) / 100;

      const { key: specialty, label: specialtyLabel } = inferSpecialty(parsed.weights);

      agents.push({
        pubkey: authorityKey,
        did: `did:persistence:devnet:${authorityKey}`,
        displayName: truncatePubkey(authorityKey),
        domain: inferDomain(parsed.weights, parsed.dimensionNames),
        specialty,
        specialtyLabel,
        trustScore,
        fitness: latestFitness,
        sessionCount: sessions.length,
        dimensionCount: parsed.dimensionCount,
        weights: parsed.weights,
        dimensionNames: parsed.dimensionNames,
        priceUSDC,
        verified: parsed.declarationCount > 0,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
      });
    }

    // If we got results, cache them
    if (agents.length > 0) {
      cachedAgents = agents;
      cacheTimestamp = now;
      return agents;
    }

    // No on-chain agents found — fall back to mock data
    console.warn('No on-chain agents found, using mock data');
    return generateMockAgents();
  } catch (error) {
    console.warn('Failed to fetch from Solana, using mock data:', error);
    return generateMockAgents();
  }
}

/**
 * Fetch a single agent by authority pubkey.
 */
export async function fetchAgent(authorityPubkey: string): Promise<AgentListing | null> {
  const agents = await fetchAgents();
  return agents.find((a) => a.pubkey === authorityPubkey) ?? null;
}

/**
 * Clear the cache (for manual refresh).
 */
export function clearCache() {
  cachedAgents = null;
  cacheTimestamp = 0;
}
