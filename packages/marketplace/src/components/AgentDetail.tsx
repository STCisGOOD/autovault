/**
 * AgentDetail — Full agent profile page with interactive ridge plot.
 *
 * Sections:
 * 1. Hero: Full-width Three.js ridge plot (interactive orbit + bloom)
 * 2. Identity Bar: DID, trust score, verification badges
 * 3. Dimension Breakdown: weight bars grouped by category
 * 4. Session Timeline: fitness sparkline
 * 5. Hire Button: opens payment flow
 */

import { useState, useMemo, lazy, Suspense } from 'react';
import RidgePlot3D from './RidgePlot3D';
import {
  generateEvolution,
  fitnessToColor,
  DIMENSIONS,
  type SessionData,
} from '../three/ridgeMath';
import { truncatePubkey, inferDomain } from '../lib/types';

const PaymentFlow = lazy(() => import('./PaymentFlow'));

interface AgentDetailProps {
  pubkey: string;
}

function DimensionBar({ name, weight }: { name: string; weight: number }) {
  const barOpacity = 0.2 + weight * 0.6;

  return (
    <div className="flex items-center gap-3 group">
      <span className="w-32 text-right text-xs text-vault-accent-dim shrink-0 truncate">
        {name}
      </span>
      <div className="flex-1 h-2 bg-vault-accent/[0.07] relative overflow-hidden">
        <div
          className="h-full transition-all duration-1000 ease-out"
          style={{
            width: `${weight * 100}%`,
            backgroundColor: `rgba(107, 76, 58, ${barOpacity})`,
          }}
        />
      </div>
      <span className="w-10 text-right text-[10px] text-vault-accent-dim font-bold shrink-0">
        {(weight * 100).toFixed(0)}%
      </span>
    </div>
  );
}

function FitnessSparkline({ sessions }: { sessions: SessionData[] }) {
  if (sessions.length === 0) return null;

  const width = 300;
  const height = 60;
  const padding = 4;

  const points = sessions.map((s, i) => {
    const x = padding + (i / (sessions.length - 1)) * (width - padding * 2);
    const y = height - padding - s.fitness * (height - padding * 2);
    return `${x},${y}`;
  });

  const latestColor = fitnessToColor(sessions[sessions.length - 1].fitness);
  const strokeColor = `rgb(${latestColor.r}, ${latestColor.g}, ${latestColor.b})`;

  // Area fill path (close at bottom)
  const firstX = padding;
  const lastX = padding + ((sessions.length - 1) / (sessions.length - 1)) * (width - padding * 2);
  const areaPath = `M${points[0]} ${points.slice(1).map(p => `L${p}`).join(' ')} L${lastX},${height - padding} L${firstX},${height - padding} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-16">
      {/* Subtle area fill */}
      <path d={areaPath} fill={strokeColor} opacity="0.15" />
      {/* Main line */}
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={strokeColor}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Dot on latest */}
      <circle
        cx={lastX}
        cy={height - padding - sessions[sessions.length - 1].fitness * (height - padding * 2)}
        r="3.5"
        fill={strokeColor}
      />
    </svg>
  );
}

export default function AgentDetail({ pubkey }: AgentDetailProps) {
  const [showPayment, setShowPayment] = useState(false);

  const sessions = useMemo(() => generateEvolution(pubkey, 25), [pubkey]);
  const latest = sessions[sessions.length - 1];
  const dimensionNames = DIMENSIONS.map((d) => d.label);
  const domain = inferDomain(latest.weights, DIMENSIONS.map((d) => d.key));

  const avgFitness = sessions.reduce((s, x) => s + x.fitness, 0) / sessions.length;
  const fitnessGrowth = sessions[sessions.length - 1].fitness - sessions[0].fitness;

  const trustScore = Math.round(
    Math.min(100, Math.max(0, avgFitness * 50 + (1 - Math.abs(fitnessGrowth)) * 50))
  );

  const trustColor =
    trustScore >= 80 ? 'text-vault-emerald' : trustScore >= 50 ? 'text-vault-cyan' : 'text-vault-violet';

  return (
    <div className="max-w-5xl mx-auto pt-6">
      {/* Hero: Interactive 3D Ridge Plot */}
      <div className="border-b border-vault-border">
        <RidgePlot3D pubkey={pubkey} mode="detail" sessions={sessions} />
      </div>

      {/* Dimension labels under plot */}
      <div className="flex justify-around px-8 py-2 border-b border-vault-border/50 bg-vault-bg/90">
        {DIMENSIONS.map((d) => (
          <span
            key={d.key}
            className="text-[10px] text-vault-accent-dim font-bold uppercase tracking-wider text-center flex-1"
          >
            {d.short}
          </span>
        ))}
      </div>

      {/* Legend */}
      <div className="flex items-center justify-center gap-4 py-3 border-b border-vault-border/30">
        <span className="text-[10px] text-vault-accent-dim uppercase tracking-wider">
          Low Fitness
        </span>
        <div
          className="w-24 h-2 rounded-full"
          style={{
            background: 'linear-gradient(90deg, #645037, #967d55, #bea578, #dcc8a0, #f5e6c8)',
          }}
        />
        <span className="text-[10px] text-vault-accent-dim uppercase tracking-wider">
          High Fitness
        </span>
      </div>

      <div className="px-4 py-6 space-y-8">
        {/* Identity Bar */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <div className="text-[10px] text-vault-accent-dim uppercase tracking-widest mb-1">
              Decentralized Identifier
            </div>
            <div className="text-xs text-vault-text font-mono break-all">
              did:persistence:devnet:{pubkey}
            </div>
          </div>

          <div className="flex items-center gap-6">
            <div className="text-center">
              <div className={`text-3xl font-display font-bold ${trustColor}`}>{trustScore}</div>
              <div className="text-[11px] text-vault-accent-dim uppercase tracking-wider">
                Trust
              </div>
            </div>
            <div className="text-center">
              <div className={`text-3xl font-display font-bold ${trustColor}`}>{sessions.length}</div>
              <div className="text-[11px] text-vault-accent-dim uppercase tracking-wider">
                Sessions
              </div>
            </div>
            <div className="text-center">
              <div className={`text-3xl font-display font-bold ${trustColor}`}>
                {fitnessGrowth > 0 ? '+' : ''}
                {(fitnessGrowth * 100).toFixed(0)}%
              </div>
              <div className="text-[11px] text-vault-accent-dim uppercase tracking-wider">
                Growth
              </div>
            </div>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-[1px] bg-vault-accent/10">
          {[
            { label: 'Domain', value: domain },
            { label: 'Fitness', value: `${(latest.fitness * 100).toFixed(1)}%` },
            { label: 'Dimensions', value: `${DIMENSIONS.length}` },
            {
              label: 'Verified',
              value: 'On-Chain',
              className: 'text-vault-accent',
            },
          ].map(({ label, value, className }) => (
            <div key={label} className="bg-vault-bg p-4 text-center">
              <div className={`text-sm font-bold ${className ?? 'text-vault-text'}`}>
                {value}
              </div>
              <div className="text-[10px] text-vault-accent-dim uppercase tracking-wider mt-1">
                {label}
              </div>
            </div>
          ))}
        </div>

        {/* Session Timeline */}
        <div>
          <h3 className="text-xs text-vault-accent-dim uppercase tracking-widest mb-3 font-bold">
            Fitness Over Sessions
          </h3>
          <div className="p-4" style={{ background: '#241c16' }}>
            <FitnessSparkline sessions={sessions} />
          </div>
        </div>

        {/* Dimension Breakdown */}
        <div>
          <h3 className="text-xs text-vault-accent-dim uppercase tracking-widest mb-3 font-bold">
            Current Behavioral Profile
          </h3>
          <div className="space-y-2">
            {/* Personality dimensions */}
            <div className="text-[10px] text-vault-accent-dim uppercase tracking-widest mt-2 mb-1 pl-36">
              Personality
            </div>
            {DIMENSIONS.slice(0, 4).map((dim, i) => (
              <DimensionBar key={dim.key} name={dim.label} weight={latest.weights[i]} />
            ))}

            {/* Strategy dimensions */}
            <div className="text-[10px] text-vault-accent-dim uppercase tracking-widest mt-4 mb-1 pl-36">
              Strategy Atoms
            </div>
            {DIMENSIONS.slice(4).map((dim, i) => (
              <DimensionBar key={dim.key} name={dim.label} weight={latest.weights[i + 4]} />
            ))}
          </div>
        </div>

        {/* Solana Explorer Link */}
        <div className="text-center">
          <a
            href={`https://explorer.solana.com/address/${pubkey}?cluster=devnet`}
            target="_blank"
            rel="noopener"
            className="inline-block px-4 py-1.5 border border-vault-border text-vault-accent-dim
                       hover:text-vault-accent hover:border-vault-accent/40 text-[10px]
                       uppercase tracking-widest transition-colors"
          >
            View on Solana Explorer
          </a>
        </div>

        {/* Hire Button */}
        <div className="text-center border-t border-vault-border/30 pt-6">
          <button
            onClick={() => setShowPayment(true)}
            className="px-8 py-3 bg-vault-accent/10 border border-vault-accent/40 text-vault-accent
                       hover:bg-vault-accent/20 transition-colors text-sm uppercase tracking-widest"
          >
            Hire This Agent — $0.01 USDC
          </button>
          <div className="text-xs text-vault-accent mt-3">
            Solana Devnet — use faucet tokens
          </div>
        </div>
      </div>

      {/* Payment modal — x402 USDC flow */}
      {showPayment && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
          onClick={() => setShowPayment(false)}
        >
          <div
            className="bg-vault-surface border border-vault-border p-6 max-w-md w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <Suspense
              fallback={
                <div className="text-center text-xs text-vault-accent-dim animate-pulse py-8">
                  Loading payment flow...
                </div>
              }
            >
              <PaymentFlow
                agentPubkey={pubkey}
                priceUSDC={0.01}
                onSuccess={(sig) => {
                  console.log('Payment success:', sig);
                }}
                onClose={() => setShowPayment(false)}
              />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
}
