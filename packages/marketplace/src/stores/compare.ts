/**
 * Compare store — tracks up to 3 agents for side-by-side comparison.
 */

import { atom, computed } from 'nanostores';
import { $agents } from './agents';
import type { AgentListing } from '../lib/types';

const MAX_COMPARE = 3;

export const $compareKeys = atom<string[]>([]);
export const $compareOpen = atom<boolean>(false);

export const $compareAgents = computed([$compareKeys, $agents], (keys, agents) => {
  return keys
    .map((key) => agents.find((a) => a.pubkey === key))
    .filter((a): a is AgentListing => a != null);
});

export function toggleCompare(pubkey: string) {
  const current = $compareKeys.get();
  if (current.includes(pubkey)) {
    $compareKeys.set(current.filter((k) => k !== pubkey));
    if (current.length <= 1) $compareOpen.set(false);
  } else {
    if (current.length >= MAX_COMPARE) return; // silently cap
    $compareKeys.set([...current, pubkey]);
    $compareOpen.set(true);
  }
}

export function removeFromCompare(pubkey: string) {
  const current = $compareKeys.get();
  $compareKeys.set(current.filter((k) => k !== pubkey));
  if (current.length <= 1) $compareOpen.set(false);
}

export function clearCompare() {
  $compareKeys.set([]);
  $compareOpen.set(false);
}
