/**
 * CompareDrawer — Side-by-side agent comparison panel.
 *
 * Slides in from the right. Shows up to 3 agents with
 * their ridge plots and dimension comparison table.
 */

import { useStore } from '@nanostores/react';
import { $compareAgents, $compareOpen, removeFromCompare, clearCompare } from '../stores/compare';
import { DIMENSIONS, fitnessToColor } from '../three/ridgeMath';
import { truncatePubkey } from '../lib/types';
import RidgePlot3D from './RidgePlot3D';

export default function CompareDrawer() {
  const agents = useStore($compareAgents);
  const open = useStore($compareOpen);

  if (!open || agents.length === 0) return null;

  return (
    <div
      className="fixed inset-0 z-40"
      onClick={() => clearCompare()}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" />

      {/* Drawer */}
      <div
        className="absolute right-0 top-0 h-full w-full max-w-2xl bg-vault-bg border-l border-vault-border
                   overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-vault-border">
          <h2 className="text-sm uppercase tracking-widest text-vault-accent">
            Compare Agents ({agents.length}/3)
          </h2>
          <button
            onClick={clearCompare}
            className="px-3 py-1 border border-vault-border text-vault-accent-dim
                       hover:text-vault-accent text-[10px] uppercase tracking-widest transition-colors"
          >
            Close
          </button>
        </div>

        {/* Ridge plots side by side */}
        <div className={`grid gap-[1px] bg-vault-border/30 grid-cols-${agents.length}`}>
          {agents.map((agent) => (
            <div key={agent.pubkey} className="bg-vault-bg">
              <div className="relative">
                <RidgePlot3D pubkey={agent.pubkey} mode="gallery" className="h-[150px]" />
                <button
                  onClick={() => removeFromCompare(agent.pubkey)}
                  className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center
                             bg-vault-bg/80 border border-vault-border text-vault-accent-dim
                             hover:text-red-400 text-[10px] transition-colors"
                >
                  x
                </button>
              </div>
              <div className="text-center py-2 text-[10px] text-vault-accent-dim">
                {truncatePubkey(agent.pubkey)}
              </div>
            </div>
          ))}
        </div>

        {/* Dimension comparison table */}
        <div className="p-4">
          <h3 className="text-[10px] text-vault-accent-faint uppercase tracking-widest mb-3">
            Dimension Comparison
          </h3>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-vault-border/30">
                <th className="text-left py-2 text-vault-accent-faint font-normal uppercase tracking-wider text-[9px]">
                  Dimension
                </th>
                {agents.map((agent) => (
                  <th
                    key={agent.pubkey}
                    className="text-right py-2 text-vault-accent-faint font-normal uppercase tracking-wider text-[9px]"
                  >
                    {truncatePubkey(agent.pubkey)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DIMENSIONS.map((dim, i) => (
                <tr key={dim.key} className="border-b border-vault-border/10">
                  <td className="py-1.5 text-vault-accent-dim">{dim.label}</td>
                  {agents.map((agent) => {
                    const w = agent.weights[i] ?? 0;
                    const color = fitnessToColor(w);
                    const highest = Math.max(...agents.map((a) => a.weights[i] ?? 0));
                    const isBest = w === highest && agents.length > 1;
                    return (
                      <td
                        key={agent.pubkey}
                        className="text-right py-1.5 font-mono"
                        style={{ color: `rgb(${color.r}, ${color.g}, ${color.b})` }}
                      >
                        {isBest && <span className="text-vault-accent mr-1">*</span>}
                        {(w * 100).toFixed(0)}%
                      </td>
                    );
                  })}
                </tr>
              ))}
              {/* Summary row */}
              <tr className="border-t border-vault-border/30">
                <td className="py-2 text-vault-accent-dim font-bold">Trust</td>
                {agents.map((agent) => (
                  <td
                    key={agent.pubkey}
                    className="text-right py-2 font-bold text-vault-accent"
                  >
                    {agent.trustScore}
                  </td>
                ))}
              </tr>
              <tr>
                <td className="py-1.5 text-vault-accent-dim font-bold">Fitness</td>
                {agents.map((agent) => (
                  <td
                    key={agent.pubkey}
                    className="text-right py-1.5 font-bold text-vault-accent"
                  >
                    {(agent.fitness * 100).toFixed(0)}%
                  </td>
                ))}
              </tr>
              <tr>
                <td className="py-1.5 text-vault-accent-dim font-bold">Price</td>
                {agents.map((agent) => (
                  <td
                    key={agent.pubkey}
                    className="text-right py-1.5 font-bold text-vault-amber"
                  >
                    ${agent.priceUSDC.toFixed(2)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
