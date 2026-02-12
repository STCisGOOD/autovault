/**
 * GalleryGrid — Responsive grid of agent cards.
 *
 * Uses nanostores for filtering/sorting. CSS Grid with comfortable spacing.
 */

import { useStore } from '@nanostores/react';
import { $filteredAgents, $loading, $error } from '../stores/agents';
import { toggleCompare } from '../stores/compare';
import AgentCard from './AgentCard';
import FilterBar from './FilterBar';

export default function GalleryGrid() {
  const agents = useStore($filteredAgents);
  const loading = useStore($loading);
  const error = useStore($error);

  return (
    <div>
      <FilterBar />

      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="text-vault-accent-dim text-xs uppercase tracking-widest animate-pulse">
            Loading agents from devnet...
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-center justify-center py-20">
          <div className="text-red-400 text-xs">
            Error: {error}
          </div>
        </div>
      )}

      {!loading && !error && agents.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <div className="text-vault-accent-faint text-2xl">---</div>
          <div className="text-vault-accent-dim text-xs uppercase tracking-widest">
            No agents found matching filters
          </div>
        </div>
      )}

      {!loading && agents.length > 0 && (
        <>
          <div className="px-4 py-2 text-[10px] text-vault-accent-dim uppercase tracking-widest">
            {agents.length} agent{agents.length !== 1 ? 's' : ''}
          </div>
          <div
            className="grid gap-4 px-4"
            style={{
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
            }}
          >
            {agents.map((agent) => (
              <AgentCard
                key={agent.pubkey}
                agent={agent}
                onCompare={toggleCompare}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
