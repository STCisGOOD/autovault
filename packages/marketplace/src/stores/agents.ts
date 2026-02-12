/**
 * Agent store — nanostores for agent list, filters, sort order.
 */

import { atom, computed } from 'nanostores';
import type { AgentListing, GalleryFilters, SortOrder } from '../lib/types';

// ─── State atoms ──────────────────────────────────────────────────────────

export const $agents = atom<AgentListing[]>([]);
export const $loading = atom<boolean>(false);
export const $error = atom<string | null>(null);

export const $filters = atom<GalleryFilters>({
  domain: 'all',
  specialty: 'all',
  minTrust: 0,
  verifiedOnly: false,
  priceMin: 0,
  priceMax: 100,
});

export const $sortOrder = atom<SortOrder>('trust-desc');

// ─── Derived state ────────────────────────────────────────────────────────

export const $filteredAgents = computed([$agents, $filters, $sortOrder], (agents, filters, sort) => {
  let result = agents.filter((agent) => {
    if (filters.domain !== 'all') {
      const domainLower = agent.domain.toLowerCase();
      if (filters.domain === 'cognitive' && domainLower !== 'cognitive') return false;
      if (filters.domain === 'execution' && domainLower !== 'execution') return false;
      if (filters.domain === 'social' && domainLower !== 'balanced') return false;
    }
    if (filters.specialty !== 'all' && agent.specialty !== filters.specialty) return false;
    if (agent.trustScore < filters.minTrust) return false;
    if (filters.verifiedOnly && !agent.verified) return false;
    if (agent.priceUSDC < filters.priceMin || agent.priceUSDC > filters.priceMax) return false;
    return true;
  });

  // Sort
  switch (sort) {
    case 'trust-desc':
      result.sort((a, b) => b.trustScore - a.trustScore);
      break;
    case 'newest':
      result.sort((a, b) => b.createdAt - a.createdAt);
      break;
    case 'price-asc':
      result.sort((a, b) => a.priceUSDC - b.priceUSDC);
      break;
    case 'price-desc':
      result.sort((a, b) => b.priceUSDC - a.priceUSDC);
      break;
    case 'fitness-desc':
      result.sort((a, b) => b.fitness - a.fitness);
      break;
  }

  return result;
});

// ─── Actions ──────────────────────────────────────────────────────────────

export function setAgents(agents: AgentListing[]) {
  $agents.set(agents);
}

export function updateFilter<K extends keyof GalleryFilters>(key: K, value: GalleryFilters[K]) {
  $filters.set({ ...$filters.get(), [key]: value });
}

export function setSortOrder(order: SortOrder) {
  $sortOrder.set(order);
}
