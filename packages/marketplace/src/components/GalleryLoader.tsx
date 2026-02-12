/**
 * GalleryLoader — Initializes the agent store on mount.
 *
 * Tries Solana devnet first, falls back to mock data.
 * Separate island that loads eagerly (client:load) to populate
 * the nanostores before GalleryGrid hydrates.
 */

import { useEffect } from 'react';
import { setAgents, $loading, $error } from '../stores/agents';
import { fetchAgents } from '../lib/agentRegistry';

export default function GalleryLoader() {
  useEffect(() => {
    let cancelled = false;

    async function load() {
      $loading.set(true);
      $error.set(null);

      try {
        const agents = await fetchAgents();
        if (!cancelled) {
          setAgents(agents);
        }
      } catch (err) {
        if (!cancelled) {
          $error.set(err instanceof Error ? err.message : 'Failed to load agents');
        }
      } finally {
        if (!cancelled) {
          $loading.set(false);
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  return null;
}
