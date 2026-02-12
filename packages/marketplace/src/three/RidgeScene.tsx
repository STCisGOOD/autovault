/**
 * RidgeScene — Full Three.js scene for ridge plot visualization.
 *
 * Two modes:
 * - Gallery: Fixed camera, no controls, 12 ridges, 100 points. Static.
 * - Detail: OrbitControls, 25 ridges, 300 points.
 */

import { useRef, useState, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera } from '@react-three/drei';
import RidgeMesh from './RidgeMesh';
import { generateEvolution, type SessionData } from './ridgeMath';

interface RidgeSceneProps {
  pubkey: string;
  mode: 'gallery' | 'detail';
  sessions?: SessionData[];
  cameraPosition?: [number, number, number];
}

/** Animated ridge group: fades in ridges one by one */
function AnimatedRidges({
  sessions,
  mode,
  animate,
}: {
  sessions: SessionData[];
  mode: 'gallery' | 'detail';
  animate: boolean;
}) {
  const [progress, setProgress] = useState(animate ? 0 : 1);
  const startTime = useRef(Date.now());

  const numPoints = mode === 'gallery' ? 100 : 300;
  const plotWidth = mode === 'gallery' ? 4 : 6;
  const amplitude = mode === 'gallery' ? 1.2 : 2.0;
  const spacing = mode === 'gallery' ? 0.25 : 0.35;

  useFrame(() => {
    if (progress >= 1) return;
    const elapsed = (Date.now() - startTime.current) / 2000; // 2s animation
    const t = Math.min(1, elapsed);
    // Ease-out cubic (matching existing Canvas behavior)
    setProgress(1 - Math.pow(1 - t, 3));
  });

  const visibleCount = Math.min(sessions.length, Math.ceil(progress * sessions.length));

  return (
    <group position={[0, -amplitude * 0.5, -(sessions.length * spacing) / 2]}>
      {sessions.slice(0, visibleCount).map((session, i) => {
        const ridgeProgress =
          i === visibleCount - 1 ? progress * sessions.length - i : 1.0;
        const opacity = Math.min(1, Math.max(0, ridgeProgress));

        return (
          <RidgeMesh
            key={i}
            session={session}
            index={i}
            totalRidges={sessions.length}
            numPoints={numPoints}
            plotWidth={plotWidth}
            amplitude={amplitude}
            spacing={spacing}
            opacity={opacity}
          />
        );
      })}
    </group>
  );
}

export default function RidgeScene({ pubkey, mode, sessions: sessionsProp, cameraPosition: cameraProp }: RidgeSceneProps) {
  const sessions = useMemo(() => {
    if (sessionsProp) return sessionsProp;
    const numSessions = mode === 'gallery' ? 12 : 25;
    return generateEvolution(pubkey, numSessions);
  }, [pubkey, mode, sessionsProp]);

  if (sessions.length === 0) return null;

  const cameraPosition: [number, number, number] =
    cameraProp ?? (mode === 'gallery' ? [0, 2.5, 3.5] : [0, 3.5, 5]);

  const cameraLookAt: [number, number, number] = [0, 0, 0];

  return (
    <Canvas
      gl={{
        antialias: mode === 'detail',
        alpha: true,
        powerPreference: mode === 'gallery' ? 'low-power' : 'high-performance',
      }}
      dpr={mode === 'gallery' ? [1, 1.5] : [1, 2]}
      style={{ background: '#241c16' }}
      frameloop={mode === 'gallery' ? 'demand' : 'always'}
    >
      <PerspectiveCamera
        makeDefault
        position={cameraPosition}
        fov={50}
        near={0.1}
        far={100}
      />

      <color attach="background" args={['#241c16']} />

      {/* Subtle ambient + directional for depth */}
      <ambientLight intensity={0.3} />
      <directionalLight position={[5, 5, 5]} intensity={0.2} />

      <AnimatedRidges sessions={sessions} mode={mode} animate={true} />

      {/* Detail mode: interactive controls + bloom */}
      {mode === 'detail' && (
        <>
          <OrbitControls
            enablePan={false}
            enableZoom={true}
            minDistance={2}
            maxDistance={12}
            target={cameraLookAt}
            autoRotate={true}
            autoRotateSpeed={0.4}
          />
          {/* Bloom disabled — vellum bg luminance exceeds threshold */}
        </>
      )}
    </Canvas>
  );
}
