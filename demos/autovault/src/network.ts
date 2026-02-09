/**
 * Persistence Network Telemetry (Hardened)
 *
 * Tracks anonymous ARIL session metrics from agents using persistence-agent-identity.
 * No private data — just 5 numbers per session that prove the system works.
 *
 * Defense-in-depth against data poisoning:
 *   Layer 1: CORS restricted (no browser-based amplification)
 *   Layer 2: Rate limiting per IP via x-real-ip (6/min)
 *   Layer 3: Session binding — start returns nonce, end requires it
 *   Layer 4: Proof of work — SHA256(nonce + pow) must have 16 leading zero bits
 *   Layer 5: Input validation — bounds clamping on all fields
 *   Layer 6: Aggregation — median, not mean
 *   Layer 7: Counting — consumed nonces, not user-supplied values
 *   Layer 8: Anomaly detection — volume spikes and uniform data flagging
 *   Layer 9: Soft write cap — evict oldest at 10K (availability over perfect history)
 *
 * Protocol:
 *   POST /api/ping { t: 'start', v: 1 }
 *   → { ok: true, n: 'a7f3b2c1e9d04f6a' }
 *
 *   POST /api/ping { t: 'end', n: 'a7f3b2c1e9d04f6a', pow: '...', v: 1, s: 5, f: 0.6, cd: -0.03, e: 0 }
 *   → { ok: true }
 */

import { createHash, randomBytes } from 'crypto';
import { storage } from './storage';

// =============================================================================
// TYPES
// =============================================================================

export interface StartPing {
  t: 'start';
  v: number;
  ts: number;
}

export interface EndPing {
  t: 'end';
  v: number;
  /** Session count */
  s: number;
  /** Mean ARIL fitness */
  f: number;
  /** Consolidation delta — negative = persistence beats random */
  cd: number;
  /** Error count during this session */
  e: number;
  ts: number;
}

export type Ping = StartPing | EndPing;

/** Validated start ping — ready for handleStartPing() */
export interface ValidatedStartPing {
  type: 'start';
  ping: StartPing;
}

/** Validated end ping — includes nonce and proof-of-work for handleEndPing() */
export interface ValidatedEndPing {
  type: 'end';
  ping: EndPing;
  nonce: string;
  pow: string;
}

export type ValidatedPing = ValidatedStartPing | ValidatedEndPing;

/** Rolling window of recent pings (last N hours).
 *  Nonces are stored as individual KV keys (nonce:<hex>) for atomic consumption. */
interface PingWindow {
  starts: StartPing[];
  ends: EndPing[];
  /** Last time the window was pruned */
  lastPrune: number;
}

/** Anomaly detection results */
export interface AnomalyStatus {
  /** Current hour volume exceeds 3× rolling average or absolute ceiling */
  volumeSpike: boolean;
  /** cd values suspiciously uniform (stddev < 0.001 across 100+ pings) */
  uniformData: boolean;
  /** True when no anomalies detected — safe to display stats */
  dataReliable: boolean;
}

/** Aggregate stats for the dashboard */
export interface NetworkStats {
  /** Distinct (version, sessionCount) pairs — NOT agent count.
   *  Gameable even with nonce+PoW (10M possible fingerprints). */
  uniqueFingerprints: number;
  /** Total completed sessions in the window (each required nonce + PoW) */
  totalSessions: number;
  /** Sessions started in the last hour */
  activeLastHour: number;
  /** Starts without matching ends in the last hour */
  failedLastHour: number;
  /** Consolidation delta — median, robust to outliers (negative = improvement) */
  meanConsolidationDelta: number;
  /** Performance improvement as percentage (positive = better) */
  improvementPct: number;
  /** ARIL fitness — median, robust to outliers */
  meanFitness: number;
  /** Total errors reported */
  totalErrors: number;
  /** SDK version distribution */
  versions: Record<number, number>;
  /** Health: green / yellow / red */
  health: 'green' | 'yellow' | 'red';
  /** Anomaly detection status */
  anomaly: AnomalyStatus;
  /** Timestamp */
  timestamp: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const PING_KEY = 'network:pings';
const NONCE_KEY_PREFIX = 'nonce:';
const WINDOW_HOURS = 24;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const NONCE_TTL_SECONDS = 3600;               // 1 hour (Redis TTL handles expiry)
const POW_DIFFICULTY_BITS = 16;               // ~65K hashes to solve
const MAX_STARTS = 10_000;
const MAX_ENDS = 10_000;
/** Per-IP daily end ping cap. Prevents a single attacker (or small botnet)
 *  from filling the 10K window even with valid nonces. 100 sessions/day/IP
 *  is generous for legitimate agents (most run 1-10 sessions/day). */
const MAX_ENDS_PER_IP_PER_DAY = 100;
const IP_COUNT_KEY_PREFIX = 'ipcount:';
const IP_COUNT_TTL_SECONDS = 86400;          // 24 hours
/** Absolute volume ceiling per hour — flags anomaly regardless of history.
 *  Based on: 866 enrolled agents × ~2 sessions/hour = ~1700, rounded up. */
const ABSOLUTE_VOLUME_CEILING = 2000;

// =============================================================================
// STORAGE
// =============================================================================

async function getWindow(): Promise<PingWindow> {
  const w = await storage.get<PingWindow>(PING_KEY);
  if (!w) return { starts: [], ends: [], lastPrune: Date.now() };
  return w;
}

async function saveWindow(w: PingWindow): Promise<void> {
  await storage.set(PING_KEY, w);
}

function pruneOld(w: PingWindow): PingWindow {
  const now = Date.now();
  const pingCutoff = now - WINDOW_HOURS * 60 * 60 * 1000;
  // Nonces are individual KV keys with Redis TTL — no pruning needed here
  return {
    starts: w.starts.filter(p => p.ts > pingCutoff),
    ends: w.ends.filter(p => p.ts > pingCutoff),
    lastPrune: now,
  };
}

function maybePrune(w: PingWindow): PingWindow {
  if (Date.now() - w.lastPrune > PRUNE_INTERVAL_MS) {
    return pruneOld(w);
  }
  return w;
}

// =============================================================================
// PROOF OF WORK
// =============================================================================

/**
 * Verify proof of work: SHA256(nonce + pow) must have POW_DIFFICULTY_BITS
 * leading zero bits.
 *
 * With 16 bits, this requires ~65K hash attempts to solve — milliseconds
 * for a legitimate agent (once per session), but forces attackers to burn
 * real CPU per fake ping.
 */
export function verifyPoW(nonce: string, pow: string): boolean {
  if (!pow || typeof pow !== 'string' || pow.length > 64) return false;
  if (!nonce || typeof nonce !== 'string') return false;

  const hash = createHash('sha256').update(nonce + pow).digest();

  // 16 bits = 2 full zero bytes
  const fullBytes = Math.floor(POW_DIFFICULTY_BITS / 8);
  const remainingBits = POW_DIFFICULTY_BITS % 8;

  for (let i = 0; i < fullBytes; i++) {
    if (hash[i] !== 0) return false;
  }

  if (remainingBits > 0) {
    const mask = 0xFF << (8 - remainingBits);
    if ((hash[fullBytes] & mask) !== 0) return false;
  }

  return true;
}

// =============================================================================
// VALIDATION
// =============================================================================

function clampInt(val: unknown, min: number, max: number, fallback: number): number {
  if (typeof val !== 'number' || !isFinite(val)) return fallback;
  return Math.max(min, Math.min(max, Math.round(val)));
}

function clampFloat(val: unknown, min: number, max: number, fallback: number): number {
  if (typeof val !== 'number' || !isFinite(val)) return fallback;
  return Math.max(min, Math.min(max, val));
}

/**
 * Validate and sanitize an incoming ping payload.
 *
 * Returns a discriminated union so the caller can handle start/end differently.
 * All numeric fields are clamped to realistic bounds.
 * End pings must include nonce (n) and proof-of-work (pow) strings.
 */
export function validatePing(body: unknown): ValidatedPing | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;

  if (obj.t !== 'start' && obj.t !== 'end') return null;

  // v: SDK version, integer [1, 100]
  const v = clampInt(obj.v, 1, 100, 1);

  if (obj.t === 'start') {
    return {
      type: 'start',
      ping: { t: 'start', v, ts: Date.now() },
    };
  }

  // End ping — require nonce and proof-of-work
  if (typeof obj.n !== 'string' || obj.n.length === 0 || obj.n.length > 32) return null;
  if (typeof obj.pow !== 'string' || obj.pow.length === 0 || obj.pow.length > 64) return null;

  // Clamp all numeric fields
  const s = clampInt(obj.s, 0, 100_000, 0);
  const f = clampFloat(obj.f, 0, 2.0, 0);
  const cd = clampFloat(obj.cd, -1.0, 1.0, 0);
  const e = clampInt(obj.e, 0, 1000, 0);

  return {
    type: 'end',
    ping: { t: 'end', v, s, f, cd, e, ts: Date.now() },
    nonce: obj.n,
    pow: obj.pow,
  };
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Handle a start ping: generate a nonce, store it, return it.
 *
 * The nonce binds start and end pings into a session. It's single-use
 * and expires after 1 hour (via Redis TTL). This forces a round-trip
 * per fake session, halving attacker throughput and creating a linkage
 * we can validate.
 *
 * Nonces are stored as individual KV keys (not in the PingWindow blob)
 * so that consumption can be atomic via Redis DEL.
 */
export async function handleStartPing(ping: StartPing): Promise<string> {
  let w = await getWindow();
  w = maybePrune(w);

  // Generate random nonce (16 hex chars = 8 bytes of entropy)
  const nonce = randomBytes(8).toString('hex');

  // Store nonce as individual key with TTL — Redis auto-expires it
  await storage.setWithTTL(NONCE_KEY_PREFIX + nonce, Date.now(), NONCE_TTL_SECONDS);

  // Store start ping
  w.starts.push(ping);

  // Cap starts (evict oldest)
  if (w.starts.length > MAX_STARTS) {
    w.starts = w.starts.slice(-MAX_STARTS);
  }

  await saveWindow(w);
  return nonce;
}

/**
 * Handle an end ping: validate nonce, verify PoW, record if valid.
 *
 * Returns null on success, error string on failure.
 * All failure modes return the same generic error to prevent
 * attackers from distinguishing nonce states (no oracle).
 *
 * Nonce consumption is atomic: storage.tryDelete() maps to Redis DEL,
 * which is serialized by Redis's single-threaded execution model.
 * Two concurrent Lambda invocations: only the first gets true.
 *
 * @param ipHash - SHA256 hash of client IP (for per-IP daily cap, not stored raw)
 */
export async function handleEndPing(
  ping: EndPing,
  nonce: string,
  pow: string,
  ipHash?: string,
): Promise<string | null> {
  // Verify proof of work BEFORE touching storage (cheapest check first)
  if (!verifyPoW(nonce, pow)) {
    return 'Invalid request';
  }

  // Per-IP daily cap: prevents a single attacker from filling the window
  // even with valid nonces+PoW. 100 sessions/day/IP is generous for legit use.
  // Uses hashed IP — we don't store raw IPs. Key auto-expires via Redis TTL.
  if (ipHash) {
    const dateKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const countKey = IP_COUNT_KEY_PREFIX + dateKey + ':' + ipHash;
    const count = await storage.get<number>(countKey);
    if (count !== null && count >= MAX_ENDS_PER_IP_PER_DAY) {
      return 'Invalid request';
    }
    // Increment (small TOCTOU: worst case, off-by-N where N = concurrency.
    // Acceptable — 100 vs 102 doesn't matter for a cap.)
    await storage.setWithTTL(countKey, (count ?? 0) + 1, IP_COUNT_TTL_SECONDS);
  }

  // Atomic nonce consumption — tryDelete returns true only for the first caller.
  // Redis TTL handles expiry, so expired nonces are already gone.
  const consumed = await storage.tryDelete(NONCE_KEY_PREFIX + nonce);
  if (!consumed) {
    return 'Invalid request';
  }

  // Nonce was valid and is now consumed — record the end ping
  let w = await getWindow();
  w = maybePrune(w);

  // Soft cap: evict oldest when full (availability over perfect history).
  // An attacker filling the window pushes out their own old pings.
  while (w.ends.length >= MAX_ENDS) {
    w.ends.shift();
  }

  w.ends.push(ping);
  await saveWindow(w);
  return null;
}

// =============================================================================
// STATS
// =============================================================================

/**
 * Compute the median of an array. Returns 0 for empty arrays.
 * Median is robust to outliers — shifting it requires >50% poisoned data.
 */
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Statistical anomaly detection — circuit breaker for data integrity.
 *
 * Volume detection (three layers):
 * 1. Z-score: (currentHour - μ) / σ > 3 → catches slow drip that stays under
 *    a fixed multiplier. Adapts to traffic patterns — low-variance networks
 *    flag small anomalies, high-variance networks tolerate bursts.
 * 2. Fallback 3× multiplier: when σ ≈ 0 or insufficient history, z-score
 *    is undefined. Fall back to the simpler 3× check.
 * 3. Absolute ceiling: catches floods regardless of history (cold-start defense).
 *
 * Data quality detection:
 * 4. Uniform cd: stddev(cd) < 0.001 across 100+ pings → likely synthetic.
 *    Bypassable with noise injection, but raises the sophistication bar.
 *
 * When anomalies are detected, the dashboard shows a warning rather than
 * blindly displaying potentially poisoned stats.
 */
function detectAnomalies(ends: EndPing[]): AnomalyStatus {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;

  // Group ends into hourly buckets (most recent 24h)
  const hourlyVolumes: number[] = [];
  for (let h = 0; h < 24; h++) {
    const hourStart = now - (h + 1) * 60 * 60 * 1000;
    const hourEnd = now - h * 60 * 60 * 1000;
    hourlyVolumes.push(ends.filter(p => p.ts > hourStart && p.ts <= hourEnd).length);
  }

  const currentHour = hourlyVolumes[0];
  const historicalHours = hourlyVolumes.slice(1).filter(v => v > 0);

  // Z-score based volume spike detection
  let zScoreSpike = false;
  let fallbackSpike = false;
  if (historicalHours.length >= 2) {
    const mean = historicalHours.reduce((a, b) => a + b, 0) / historicalHours.length;
    const variance = historicalHours.reduce((sum, v) => sum + (v - mean) ** 2, 0) / historicalHours.length;
    const stddev = Math.sqrt(variance);

    if (stddev > 0.5) {
      // Sufficient variance for meaningful z-score
      const zScore = (currentHour - mean) / stddev;
      zScoreSpike = zScore > 3;
    } else {
      // Near-zero stddev → all historical hours nearly identical.
      // Any meaningful increase is suspicious. Fall back to 3× multiplier.
      fallbackSpike = mean > 0 && currentHour > 3 * mean;
    }
  } else if (historicalHours.length === 1) {
    // Only one historical hour — can't compute stddev. Use 3× multiplier.
    fallbackSpike = historicalHours[0] > 0 && currentHour > 3 * historicalHours[0];
  }
  // If 0 historical hours → no relative detection possible → absolute only

  // Absolute ceiling: cold-start defense + upper bound regardless of history
  const absoluteSpike = currentHour > ABSOLUTE_VOLUME_CEILING;

  const volumeSpike = zScoreSpike || fallbackSpike || absoluteSpike;

  // Uniform data: stddev(cd) < 0.001 across 100+ recent pings
  const recentCDs = ends.filter(p => p.ts > oneHourAgo).map(p => p.cd);
  let uniformData = false;
  if (recentCDs.length >= 100) {
    const cdMean = recentCDs.reduce((a, b) => a + b, 0) / recentCDs.length;
    const cdVariance = recentCDs.reduce((sum, v) => sum + (v - cdMean) ** 2, 0) / recentCDs.length;
    uniformData = Math.sqrt(cdVariance) < 0.001;
  }

  return {
    volumeSpike,
    uniformData,
    dataReliable: !volumeSpike && !uniformData,
  };
}

/**
 * Compute aggregate network stats for the dashboard.
 *
 * Security design:
 * - All aggregations use MEDIAN (robust to minority poisoning)
 * - Counts use array lengths (each entry required nonce + PoW round-trip)
 * - Anomaly detection flags suspicious patterns
 */
export async function getNetworkStats(): Promise<NetworkStats> {
  const w = pruneOld(await getWindow());

  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;

  // Last hour activity
  const startsLastHour = w.starts.filter(p => p.ts > oneHourAgo).length;
  const endsLastHour = w.ends.filter(p => p.ts > oneHourAgo).length;

  const ends = w.ends;

  // Total sessions: count of end pings (each required a nonce round-trip + PoW)
  const totalSessions = ends.length;

  // Distinct (v, s) fingerprints — NOT agent count. Two agents at v=1 s=5
  // count as one, and one agent across sessions counts as many.
  const agentFingerprints = new Set(ends.map(p => `${p.v}:${p.s}`));
  const uniqueFingerprints = agentFingerprints.size;

  // Median consolidation delta (robust to outliers)
  const deltas = ends.map(p => p.cd).filter(cd => isFinite(cd));
  const medianCD = median(deltas);

  // Convert to improvement percentage
  const improvementPct = deltas.length > 0
    ? Math.round(-medianCD * 100 * 10) / 10
    : 0;

  // Median fitness (robust to outliers)
  const fitnesses = ends.map(p => p.f).filter(f => isFinite(f));
  const medianFitness = median(fitnesses);

  // Total errors (bounded by clamp × cap = 1000 × 10K)
  const totalErrors = ends.reduce((sum, p) => sum + (p.e || 0), 0);

  // Version distribution (v clamped to [1, 100] → max 100 keys)
  const versions: Record<number, number> = {};
  for (const ping of ends) {
    versions[ping.v] = (versions[ping.v] || 0) + 1;
  }

  // Health determination
  const failedLastHour = Math.max(0, startsLastHour - endsLastHour);
  const failureRate = startsLastHour > 0 ? failedLastHour / startsLastHour : 0;
  const health: 'green' | 'yellow' | 'red' =
    failureRate > 0.3 ? 'red' :
    failureRate > 0.1 ? 'yellow' :
    'green';

  // Anomaly detection
  const anomaly = detectAnomalies(ends);

  return {
    uniqueFingerprints,
    totalSessions,
    activeLastHour: startsLastHour,
    failedLastHour,
    meanConsolidationDelta: Math.round(medianCD * 10000) / 10000,
    improvementPct,
    meanFitness: Math.round(medianFitness * 1000) / 1000,
    totalErrors,
    versions,
    health,
    anomaly,
    timestamp: new Date().toISOString(),
  };
}
