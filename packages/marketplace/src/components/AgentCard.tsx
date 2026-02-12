/**
 * AgentCard — Single card in the gallery grid.
 *
 * Shows a Canvas 2D Joy Division ridge plot with agent metadata overlay.
 * Uses IntersectionObserver to defer rendering until scrolled into view.
 */

import { useState, useRef, useEffect, memo } from 'react';
import type { AgentListing } from '../lib/types';
import { truncatePubkey } from '../lib/types';
import RidgePlotCanvas from './RidgePlotCanvas';

interface AgentCardProps {
  agent: AgentListing;
  onCompare?: (pubkey: string) => void;
}

function AgentCardInner({ agent, onCompare }: AgentCardProps) {
  const [isVisible, setIsVisible] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const trustColor =
    agent.trustScore >= 80
      ? 'text-vault-emerald'
      : agent.trustScore >= 50
        ? 'text-vault-cyan'
        : 'text-vault-violet';

  return (
    <div
      ref={cardRef}
      className="group relative bg-vault-surface border border-vault-border/50
                 hover:border-vault-accent/20 transition-all duration-300
                 hover:scale-[1.01] cursor-pointer overflow-hidden"
    >
      <a
        href={`/agent?did=${encodeURIComponent(agent.did)}`}
        className="block"
      >
        {/* Canvas 2D ridge plot thumbnail */}
        <div className="relative h-[240px] overflow-hidden">
          <div className="absolute inset-x-4 inset-y-3 overflow-hidden">
            {isVisible ? (
              <RidgePlotCanvas pubkey={agent.pubkey} numSessions={14} />
            ) : (
              <div className="w-full h-full bg-vault-bg" />
            )}
          </div>

          {/* Specialty badge */}
          <div className="absolute top-2.5 left-2.5 px-2 py-0.5 bg-vault-bg/80 border border-vault-border
                        text-[10px] uppercase tracking-widest text-vault-accent-dim">
            {agent.specialtyLabel}
          </div>

          {/* Trust score */}
          <div className={`absolute top-2.5 right-2.5 px-2 py-0.5 bg-vault-bg/80 border border-vault-border
                         text-[10px] font-bold ${trustColor}`}>
            {agent.trustScore}
          </div>

          {/* Hover overlay */}
          <div className="absolute inset-0 bg-vault-accent/5 opacity-0 group-hover:opacity-100
                        transition-opacity flex items-center justify-center">
            <span className="text-vault-accent text-xs uppercase tracking-widest
                           border border-vault-accent/30 px-4 py-1.5 bg-vault-bg/90">
              View Agent
            </span>
          </div>
        </div>

        {/* Info bar */}
        <div className="p-3 pb-6 border-t border-vault-border/30">
          <div className="flex items-center justify-between">
            <span className="text-xs text-vault-accent-dim font-mono">
              {truncatePubkey(agent.pubkey)}
            </span>
            <span className="text-xs text-vault-amber font-bold">
              ${agent.priceUSDC.toFixed(2)}
            </span>
          </div>

          {/* Mini stats */}
          <div className="flex items-center gap-3 mt-1.5 text-[10px] text-vault-accent-dim">
            <span>{agent.sessionCount} sessions</span>
            <span className="text-vault-accent-faint">|</span>
            <span>fitness {(agent.fitness * 100).toFixed(0)}%</span>
            {agent.verified && (
              <>
                <span className="text-vault-accent-faint">|</span>
                <span className="text-vault-accent">verified</span>
              </>
            )}
          </div>
        </div>
      </a>

      {/* Compare button */}
      {onCompare && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onCompare(agent.pubkey);
          }}
          className="absolute bottom-3 right-3 w-6 h-6 flex items-center justify-center
                     border border-vault-border text-vault-accent-dim hover:text-vault-accent
                     hover:border-vault-accent/40 bg-vault-bg/80 transition-colors text-[10px]"
          title="Add to comparison"
        >
          +
        </button>
      )}
    </div>
  );
}

export default memo(AgentCardInner);
