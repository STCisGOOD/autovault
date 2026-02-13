/**
 * Ridge Plot Math — Verbatim port from demos/Synap-AI/api/agent.ts
 *
 * Deterministic waveform generation for Joy Division-style ridge plots.
 * Same algorithm, same output — the renderer changes (Canvas → Three.js).
 */

export const DIMENSIONS = [
  { key: 'curiosity',           label: 'Curiosity',       short: 'CUR' },
  { key: 'precision',           label: 'Precision',       short: 'PRE' },
  { key: 'persistence',         label: 'Persistence',     short: 'PER' },
  { key: 'empathy',             label: 'Empathy',         short: 'EMP' },
  { key: 'read_before_edit',    label: 'Read → Edit',     short: 'R→E' },
  { key: 'test_after_change',   label: 'Test → Change',   short: 'T→C' },
  { key: 'context_gathering',   label: 'Context',         short: 'CTX' },
  { key: 'output_verification', label: 'Verification',    short: 'VER' },
  { key: 'error_recovery',      label: 'Recovery',        short: 'REC' },
] as const;

export const NUM_DIMS = DIMENSIONS.length;

export interface SessionData {
  weights: number[];
  fitness: number;
  sessionIndex: number;
}

export interface RGBColor {
  r: number;
  g: number;
  b: number;
}

// ─── Seeded PRNG (mulberry32) ─────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h;
}

// ─── Evolution Generator ──────────────────────────────────────────────────

/**
 * Generate realistic agent evolution data.
 * Deterministic per pubkey — same agent always gets the same visualization.
 */
export function generateEvolution(pubkey: string, numSessions: number): SessionData[] {
  if (!pubkey) return [];

  const rng = mulberry32(hashString(pubkey));
  const sessions: SessionData[] = [];

  // Initial weights near 0.5 with slight randomness
  const weights: number[] = [];
  for (let d = 0; d < NUM_DIMS; d++) {
    weights.push(0.4 + rng() * 0.2);
  }

  // Specialization targets (which dimensions this agent gravitates toward)
  const targets: number[] = [];
  for (let d = 0; d < NUM_DIMS; d++) {
    targets.push(0.3 + rng() * 0.6);
  }

  // Boost 2-3 dimensions to create clear peaks
  const boostCount = 2 + Math.floor(rng() * 2);
  const boostDims: number[] = [];
  while (boostDims.length < boostCount) {
    const d = Math.floor(rng() * NUM_DIMS);
    if (!boostDims.includes(d)) {
      boostDims.push(d);
      targets[d] = 0.75 + rng() * 0.2;
    }
  }

  for (let s = 0; s < numSessions; s++) {
    const progress = s / (numSessions - 1);
    const learningRate = 0.08 * (1 - progress * 0.3);

    for (let d = 0; d < NUM_DIMS; d++) {
      const drift = (targets[d] - weights[d]) * learningRate;
      const noise = (rng() - 0.5) * 0.06;
      weights[d] = Math.max(0.05, Math.min(0.98, weights[d] + drift + noise));
    }

    const convergence =
      weights.reduce((sum, w, d) => sum + (1 - Math.abs(w - targets[d])), 0) / NUM_DIMS;
    const fitness = Math.max(
      0.05,
      Math.min(0.98, 0.2 + convergence * 0.5 + progress * 0.15 + (rng() - 0.5) * 0.12)
    );

    sessions.push({
      weights: [...weights],
      fitness,
      sessionIndex: s,
    });
  }

  return sessions;
}

// ─── Waveform Generation ──────────────────────────────────────────────────

/**
 * Generate smooth waveform points for a single ridge.
 * Weights modulate the amplitude; harmonics add organic variation.
 */
export function generateRidgePoints(
  weights: number[],
  sessionSeed: number,
  numPoints: number
): Float64Array {
  const points = new Float64Array(numPoints);

  for (let i = 0; i < numPoints; i++) {
    const t = i / (numPoints - 1);

    // Cosine-interpolate between weight values
    const dimPos = t * (weights.length - 1);
    const idx = Math.min(Math.floor(dimPos), weights.length - 2);
    const frac = dimPos - idx;
    const mu = (1 - Math.cos(frac * Math.PI)) / 2;
    const baseHeight =
      weights[idx] * (1 - mu) + weights[Math.min(idx + 1, weights.length - 1)] * mu;

    // Layered harmonics for organic texture
    let detail = 0;
    for (let h = 1; h <= 5; h++) {
      const freq = h * 2.7 + sessionSeed * 0.13;
      const amp = baseHeight * (0.18 / h);
      detail += Math.sin(t * freq * Math.PI * 2 + sessionSeed * h * 1.93) * amp;
    }

    // Window function: fade to zero at edges
    const window = Math.sin(t * Math.PI);
    const windowSq = window * window;

    points[i] = Math.max(0, (baseHeight + detail) * windowSq);
  }

  return points;
}

// ─── Fitness → Color ──────────────────────────────────────────────────────

/**
 * Fitness → RGB color. Pale Champagne spectrum (soft cream-gold on dark).
 * Low fitness = muted umber, high fitness = cream silk. Designed for dark canvas backgrounds.
 */
const FITNESS_STOPS = [
  { t: 0.0, r: 100, g: 80, b: 55 },    // muted umber
  { t: 0.25, r: 150, g: 125, b: 85 },  // warm tan
  { t: 0.5, r: 190, g: 165, b: 120 },  // sandy gold
  { t: 0.75, r: 220, g: 200, b: 160 }, // pale gold
  { t: 1.0, r: 245, g: 230, b: 200 },  // cream silk
] as const;

export function fitnessToColor(f: number): RGBColor {
  f = Math.max(0, Math.min(1, f));

  for (let i = 0; i < FITNESS_STOPS.length - 1; i++) {
    if (f <= FITNESS_STOPS[i + 1].t) {
      const range = FITNESS_STOPS[i + 1].t - FITNESS_STOPS[i].t;
      const local = (f - FITNESS_STOPS[i].t) / range;
      return {
        r: Math.round(FITNESS_STOPS[i].r + (FITNESS_STOPS[i + 1].r - FITNESS_STOPS[i].r) * local),
        g: Math.round(FITNESS_STOPS[i].g + (FITNESS_STOPS[i + 1].g - FITNESS_STOPS[i].g) * local),
        b: Math.round(FITNESS_STOPS[i].b + (FITNESS_STOPS[i + 1].b - FITNESS_STOPS[i].b) * local),
      };
    }
  }

  const last = FITNESS_STOPS[FITNESS_STOPS.length - 1];
  return { r: last.r, g: last.g, b: last.b };
}

/** Normalized [0,1] RGB for Three.js Color */
export function fitnessToNormalizedColor(f: number): [number, number, number] {
  const c = fitnessToColor(f);
  return [c.r / 255, c.g / 255, c.b / 255];
}
