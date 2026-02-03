/**
 * AutoVault Heartbeat System
 *
 * Forked pattern from Ace-Strategist's "Ghost in the Machine" concept.
 * Heartbeats prove the agent is running and accountable.
 *
 * Current: In-memory tracking (resets on cold start)
 * Future: On-chain heartbeats with Clockwork + slashing
 *
 * The pattern:
 * 1. Agent pings /api/heartbeat periodically
 * 2. Heartbeats are logged with timestamp
 * 3. Missed heartbeats trigger alerts
 * 4. (Future) Staked SOL gets slashed on missed beats
 *
 * This is runtime accountability without central authority.
 */

import { storage } from './storage';

interface Heartbeat {
  timestamp: string;
  uptimeSeconds: number;
  cyclesSinceStart: number;
  memoryPersistent: boolean;
}

interface HeartbeatStatus {
  alive: boolean;
  lastHeartbeat: Heartbeat | null;
  heartbeatCount: number;
  uptimeSeconds: number;
  startTime: string | null;
  missedBeats: number;
  healthScore: number; // 0-100
}

const HEARTBEAT_KEY = 'heartbeats';
const START_TIME_KEY = 'start_time';
const EXPECTED_INTERVAL_SECONDS = 300; // 5 minutes

let cycleCount = 0;
let inMemoryStartTime: string | null = null;

/**
 * Record a heartbeat
 */
export async function recordHeartbeat(): Promise<Heartbeat> {
  // Get or set start time
  let startTime = await storage.get<string>(START_TIME_KEY);
  if (!startTime) {
    startTime = new Date().toISOString();
    inMemoryStartTime = startTime;
    await storage.set(START_TIME_KEY, startTime);
  }

  const uptimeSeconds = Math.floor(
    (Date.now() - new Date(startTime).getTime()) / 1000
  );

  const heartbeat: Heartbeat = {
    timestamp: new Date().toISOString(),
    uptimeSeconds,
    cyclesSinceStart: cycleCount,
    memoryPersistent: storage.isPersistent(),
  };

  // Get existing heartbeats
  const heartbeats = await storage.get<Heartbeat[]>(HEARTBEAT_KEY) || [];
  heartbeats.push(heartbeat);

  // Keep last 100 heartbeats
  if (heartbeats.length > 100) {
    heartbeats.shift();
  }

  await storage.set(HEARTBEAT_KEY, heartbeats);

  return heartbeat;
}

/**
 * Increment cycle count (called when /api/cycle runs)
 */
export function incrementCycleCount(): void {
  cycleCount++;
}

/**
 * Get heartbeat status
 */
export async function getHeartbeatStatus(): Promise<HeartbeatStatus> {
  const heartbeats = await storage.get<Heartbeat[]>(HEARTBEAT_KEY) || [];
  const startTime = await storage.get<string>(START_TIME_KEY) || inMemoryStartTime;

  if (heartbeats.length === 0) {
    return {
      alive: true, // We're running if this code executes
      lastHeartbeat: null,
      heartbeatCount: 0,
      uptimeSeconds: 0,
      startTime: null,
      missedBeats: 0,
      healthScore: 50, // Neutral - no data yet
    };
  }

  const lastHeartbeat = heartbeats[heartbeats.length - 1];
  const lastBeatTime = new Date(lastHeartbeat.timestamp).getTime();
  const secondsSinceLastBeat = (Date.now() - lastBeatTime) / 1000;

  // Calculate missed beats (how many 5-minute intervals were missed)
  const missedBeats = Math.max(
    0,
    Math.floor(secondsSinceLastBeat / EXPECTED_INTERVAL_SECONDS) - 1
  );

  // Health score based on heartbeat regularity
  // 100 = no missed beats, -10 per missed beat
  const healthScore = Math.max(0, 100 - (missedBeats * 10));

  const uptimeSeconds = startTime
    ? Math.floor((Date.now() - new Date(startTime).getTime()) / 1000)
    : 0;

  return {
    alive: secondsSinceLastBeat < EXPECTED_INTERVAL_SECONDS * 2,
    lastHeartbeat,
    heartbeatCount: heartbeats.length,
    uptimeSeconds,
    startTime,
    missedBeats,
    healthScore,
  };
}

/**
 * Get heartbeat history
 */
export async function getHeartbeatHistory(limit: number = 10): Promise<Heartbeat[]> {
  const heartbeats = await storage.get<Heartbeat[]>(HEARTBEAT_KEY) || [];
  return heartbeats.slice(-limit);
}

/**
 * Format uptime for display
 */
export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else {
    return `${minutes}m`;
  }
}
