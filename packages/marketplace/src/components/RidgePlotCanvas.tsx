/**
 * RidgePlotCanvas — Gallery card ridge plot visualization.
 *
 * Clean, high-fidelity Canvas 2D renderer with smooth bezier curves,
 * multi-pass glow, and gradient fills. No paper texture — crisp and modern.
 */

import { useRef, useEffect, memo } from 'react';
import {
  generateEvolution,
  generateRidgePoints,
  fitnessToColor,
  type SessionData,
} from '../three/ridgeMath';

interface RidgePlotCanvasProps {
  pubkey: string;
  numSessions?: number;
  className?: string;
}

/** Trace a smooth quadratic bezier curve through the ridge points */
function traceRidgePath(
  ctx: CanvasRenderingContext2D,
  pathX: number[],
  pathY: number[]
) {
  ctx.moveTo(pathX[0], pathY[0]);
  for (let p = 1; p < pathX.length - 1; p++) {
    const cpX = (pathX[p] + pathX[p + 1]) / 2;
    const cpY = (pathY[p] + pathY[p + 1]) / 2;
    ctx.quadraticCurveTo(pathX[p], pathY[p], cpX, cpY);
  }
  // Final point
  ctx.lineTo(pathX[pathX.length - 1], pathY[pathY.length - 1]);
}

function drawRidgePlot(
  canvas: HTMLCanvasElement,
  sessions: SessionData[],
  animProgress: number
) {
  const dpr = window.devicePixelRatio || 1;
  const parent = canvas.parentElement;
  if (!parent) return;

  const displayW = parent.clientWidth;
  const displayH = parent.clientHeight;

  canvas.width = displayW * dpr;
  canvas.height = displayH * dpr;
  canvas.style.width = displayW + 'px';
  canvas.style.height = displayH + 'px';

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  const W = displayW;
  const H = displayH;
  const padX = Math.round(W * 0.12);
  const padTop = 12;
  const padBot = 6;
  const plotW = W - padX * 2;
  const plotH = H - padTop - padBot;

  // Clear — deep dark background
  ctx.fillStyle = '#1a1410';
  ctx.fillRect(0, 0, W, H);

  if (sessions.length === 0) return;

  const numRidges = sessions.length;
  const ridgeSpacing = plotH / (numRidges + 1);
  const amplitude = ridgeSpacing * 1.1;
  const numPoints = Math.min(250, Math.max(150, plotW * 1.5));

  const visibleRidges = Math.min(numRidges, Math.ceil(animProgress * numRidges));

  // Draw oldest first (bottom) so newer ridges occlude older ones
  for (let i = 0; i < visibleRidges; i++) {
    const session = sessions[i];
    const baseY = H - padBot - (i + 1) * ridgeSpacing;
    const color = fitnessToColor(session.fitness);

    const ridgeProgress =
      i === visibleRidges - 1 ? animProgress * numRidges - i : 1.0;
    const alpha = Math.min(1, ridgeProgress);

    const ridgePoints = generateRidgePoints(
      session.weights,
      session.sessionIndex * 7.3 + 42,
      numPoints
    );

    // Build path arrays
    const pathX: number[] = [];
    const pathY: number[] = [];
    for (let p = 0; p < numPoints; p++) {
      const t = p / (numPoints - 1);
      pathX.push(padX + t * plotW);
      pathY.push(baseY - ridgePoints[p] * amplitude * alpha);
    }

    // 1. Opaque occlusion fill — hides ridges behind this one
    ctx.beginPath();
    ctx.moveTo(padX, baseY + 2);
    traceRidgePath(ctx, pathX, pathY);
    ctx.lineTo(padX + plotW, baseY + 2);
    ctx.closePath();
    ctx.fillStyle = '#1a1410';
    ctx.fill();

    // 2. Gradient fill below ridge — subtle color wash that fades into bg
    const gradFill = ctx.createLinearGradient(0, baseY - amplitude, 0, baseY + 4);
    gradFill.addColorStop(0, `rgba(${color.r},${color.g},${color.b},${0.12 * alpha})`);
    gradFill.addColorStop(0.6, `rgba(${color.r},${color.g},${color.b},${0.04 * alpha})`);
    gradFill.addColorStop(1, 'rgba(26,20,16,0)');
    ctx.beginPath();
    ctx.moveTo(padX, baseY + 2);
    traceRidgePath(ctx, pathX, pathY);
    ctx.lineTo(padX + plotW, baseY + 2);
    ctx.closePath();
    ctx.fillStyle = gradFill;
    ctx.fill();

    // 3. Crisp main stroke
    ctx.beginPath();
    traceRidgePath(ctx, pathX, pathY);
    ctx.strokeStyle = `rgba(${color.r},${color.g},${color.b},${alpha})`;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // Subtle vignette — just darken edges, no grain/fiber
  if (animProgress >= 1) {
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
    vg.addColorStop(0, 'rgba(26,20,16,0)');
    vg.addColorStop(1, 'rgba(26,20,16,0.4)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
  }
}

function RidgePlotCanvasInner({ pubkey, numSessions = 12, className }: RidgePlotCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawnRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || drawnRef.current) return;

    const sessions = generateEvolution(pubkey, numSessions);

    // Animate in over 1.2s
    const duration = 1200;
    const start = performance.now();

    function animate(now: number) {
      const elapsed = now - start;
      const progress = Math.min(1, elapsed / duration);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      drawRidgePlot(canvas!, sessions, eased);
      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        drawnRef.current = true;
      }
    }

    requestAnimationFrame(animate);
  }, [pubkey, numSessions]);

  return (
    <div className={`w-full h-full ${className ?? ''}`} style={{ background: '#1a1410' }}>
      <canvas
        ref={canvasRef}
        className="block w-full h-full"
      />
    </div>
  );
}

export default memo(RidgePlotCanvasInner);
