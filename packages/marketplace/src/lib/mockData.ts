/**
 * Mock agent data for development.
 *
 * Generates deterministic agent listings using the same PRNG as the ridge plot,
 * so each mock agent's visualization is consistent with its metadata.
 */

import type { AgentListing } from './types';
import { inferDomain, inferSpecialty, truncatePubkey } from './types';
import { mulberry32, hashString, generateEvolution, DIMENSIONS } from '../three/ridgeMath';

const MOCK_PUBKEYS = [
  '5kopfXg2movVA8BMJKHgcxfY2twgzLXaAxcu2HbgvHtX',
  '7d5L3DqVxRMHbWx2P6JkNq7t5vFCmYk3kPJqZhBe8iGs',
  'BRjpCHtyQLeSxaKhKdZvhY4UqWjhBigKtxMfJAQxnXUe',
  'DxPv2QMA5cWR5Xfg7tXr5YtJ6XoTaEaGnfQ2hGQBqk9n',
  'F9k2NqBvLmWx5cZ3yJ8T6dRe7vMpHs4X1QaG3jKw9tYi',
  'HjR4XnU6cT8eL2mP5vQk7dYw3fBa9sGx1NzM4iKo6rVu',
  'J3m7pRwT9xL2nF5kQ8vY1dHc6bXg4sAe7iUo3jKt0zMa',
  'Kx9nL4mT7pR2wF5cQ8vJ1dYe6bHg3sXa7iUo0zKt4jMr',
  'M5p8qR3tL7nW2xF9kJ4vY1eHc6dBg0sXa7iUoKzTj3Mr',
  'N2wF8kJ5mT4pR7nL9xQ3vY1cHe6dBg0sXa7iUoKzTjMr',
  'P7nL3xQ9kJ4mT2wF5pR8vY1eHc6dBg0sXa7iUoKzTjMr',
  'Q4mT8wF2kJ7nL5xP3pR9vY1eHc6dBg0sXa7iUoKzTjMr',
];

export function generateMockAgents(): AgentListing[] {
  return MOCK_PUBKEYS.map((pubkey) => {
    const rng = mulberry32(hashString(pubkey + '_meta'));
    const sessions = generateEvolution(pubkey, 25);
    const latest = sessions[sessions.length - 1];

    const trustScore = Math.round(40 + rng() * 55);
    const priceUSDC = Math.round((0.01 + rng() * 0.49) * 100) / 100;
    const dimensionNames = DIMENSIONS.map((d) => d.key);

    const { key: specialty, label: specialtyLabel } = inferSpecialty(latest.weights);

    return {
      pubkey,
      did: `did:persistence:devnet:${pubkey}`,
      displayName: truncatePubkey(pubkey),
      domain: inferDomain(latest.weights, dimensionNames),
      specialty,
      specialtyLabel,
      trustScore,
      fitness: latest.fitness,
      sessionCount: sessions.length,
      dimensionCount: DIMENSIONS.length,
      weights: latest.weights,
      dimensionNames,
      priceUSDC,
      verified: rng() > 0.3,
      createdAt: Math.floor(Date.now() / 1000 - rng() * 2592000),
      updatedAt: Math.floor(Date.now() / 1000 - rng() * 86400),
    };
  });
}
