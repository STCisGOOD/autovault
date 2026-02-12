/**
 * RidgeMesh — A single ridge rendered as a Three.js ribbon geometry.
 *
 * Each ridge is a thin flat plane displaced vertically by the waveform data.
 * Vertex colors come from the session's fitness score.
 */

import { useMemo } from 'react';
import * as THREE from 'three';
import { generateRidgePoints, fitnessToNormalizedColor, type SessionData } from './ridgeMath';

interface RidgeMeshProps {
  session: SessionData;
  index: number;
  totalRidges: number;
  numPoints: number;
  plotWidth: number;
  amplitude: number;
  spacing: number;
  opacity?: number;
}

export default function RidgeMesh({
  session,
  index,
  totalRidges,
  numPoints,
  plotWidth,
  amplitude,
  spacing,
  opacity = 1,
}: RidgeMeshProps) {
  const geometry = useMemo(() => {
    const ridgePoints = generateRidgePoints(
      session.weights,
      session.sessionIndex * 7.3 + 42,
      numPoints
    );

    const [r, g, b] = fitnessToNormalizedColor(session.fitness);

    // Two rows of vertices (top + bottom of ribbon) for a thin strip
    const ribbonDepth = 0.02;
    const vertexCount = numPoints * 2;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);

    const zPos = index * spacing;

    for (let i = 0; i < numPoints; i++) {
      const x = (i / (numPoints - 1)) * plotWidth - plotWidth / 2;
      const y = ridgePoints[i] * amplitude;

      // Front row
      const fi = i * 3;
      positions[fi] = x;
      positions[fi + 1] = y;
      positions[fi + 2] = zPos;

      // Back row
      const bi = (numPoints + i) * 3;
      positions[bi] = x;
      positions[bi + 1] = y;
      positions[bi + 2] = zPos + ribbonDepth;

      // Alpha-modified colors: edges are dimmer
      const edgeFade = Math.sin((i / (numPoints - 1)) * Math.PI);
      const cr = r * (0.6 + 0.4 * edgeFade);
      const cg = g * (0.6 + 0.4 * edgeFade);
      const cb = b * (0.6 + 0.4 * edgeFade);

      colors[fi] = cr;
      colors[fi + 1] = cg;
      colors[fi + 2] = cb;
      colors[bi] = cr;
      colors[bi + 1] = cg;
      colors[bi + 2] = cb;
    }

    // Index buffer: connect front and back rows into triangles
    const indexCount = (numPoints - 1) * 6;
    const indices = new Uint32Array(indexCount);
    let idx = 0;
    for (let i = 0; i < numPoints - 1; i++) {
      const a = i;
      const b = i + 1;
      const c = numPoints + i;
      const d = numPoints + i + 1;

      indices[idx++] = a;
      indices[idx++] = b;
      indices[idx++] = c;

      indices[idx++] = b;
      indices[idx++] = d;
      indices[idx++] = c;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();

    return geo;
  }, [session, index, numPoints, plotWidth, amplitude, spacing]);

  // Line geometry for the glowing top edge
  const lineGeometry = useMemo(() => {
    const ridgePoints = generateRidgePoints(
      session.weights,
      session.sessionIndex * 7.3 + 42,
      numPoints
    );

    const positions = new Float32Array(numPoints * 3);
    const colors = new Float32Array(numPoints * 3);
    const [r, g, b] = fitnessToNormalizedColor(session.fitness);
    const zPos = index * spacing;

    for (let i = 0; i < numPoints; i++) {
      const x = (i / (numPoints - 1)) * plotWidth - plotWidth / 2;
      const y = ridgePoints[i] * amplitude;

      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = zPos - 0.001; // Slightly in front to avoid z-fighting

      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geo;
  }, [session, index, numPoints, plotWidth, amplitude, spacing]);

  return (
    <group>
      {/* Solid fill behind the line (occlusion) */}
      <mesh geometry={geometry}>
        <meshBasicMaterial
          vertexColors
          transparent
          opacity={opacity * 0.15}
          side={THREE.DoubleSide}
          depthWrite
        />
      </mesh>

      {/* Glowing line along the top */}
      <line geometry={lineGeometry}>
        <lineBasicMaterial
          vertexColors
          transparent
          opacity={opacity}
          linewidth={1}
        />
      </line>
    </group>
  );
}
