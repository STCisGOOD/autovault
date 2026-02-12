/**
 * RidgePlot3D — React wrapper for the Three.js ridge plot.
 *
 * Props:
 * - pubkey: Agent public key (deterministic seed for visualization)
 * - mode: 'gallery' (static thumbnail) or 'detail' (interactive + bloom)
 * - className: Optional CSS classes for sizing
 */

import { Suspense } from 'react';
import RidgeScene from '../three/RidgeScene';
import type { SessionData } from '../three/ridgeMath';

interface RidgePlot3DProps {
  pubkey: string;
  mode: 'gallery' | 'detail';
  className?: string;
  sessions?: SessionData[];
  cameraPosition?: [number, number, number];
}

function LoadingFallback({ mode }: { mode: string }) {
  return (
    <div
      className="flex items-center justify-center bg-vault-bg"
      style={{ height: mode === 'gallery' ? '200px' : '400px' }}
    >
      <div className="text-vault-accent-faint text-xs tracking-widest uppercase animate-pulse">
        Loading visualization...
      </div>
    </div>
  );
}

export default function RidgePlot3D({ pubkey, mode, className, sessions, cameraPosition }: RidgePlot3DProps) {
  const height = mode === 'gallery' ? 'h-[200px]' : 'h-[400px] md:h-[500px]';

  return (
    <div className={`${height} w-full ${className ?? ''}`}>
      <Suspense fallback={<LoadingFallback mode={mode} />}>
        <RidgeScene pubkey={pubkey} mode={mode} sessions={sessions} cameraPosition={cameraPosition} />
      </Suspense>
    </div>
  );
}
