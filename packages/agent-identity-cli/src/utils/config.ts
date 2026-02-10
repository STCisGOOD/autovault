/**
 * Configuration management for the CLI.
 *
 * Handles loading, saving, and validating CLI configuration.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { sanitizePath, safeParseJson, safeStringifyJson } from './security';

// =============================================================================
// TYPES
// =============================================================================

export interface CLIConfig {
  /** Version of the config format */
  version: number;

  /** Network to use (devnet or mainnet) */
  network: 'devnet' | 'mainnet';

  /** Path to keypair file (relative to storage dir) */
  keypairFile: string;

  /** Whether to auto-fund on devnet */
  autoFund: boolean;

  /** Include domain profile in on-chain sync pushes. Default false.
   *  Domain profiles reveal R&D direction — opt-in for privacy. */
  exposeDomainProfile?: boolean;

  /** Telemetry endpoint URL. Default undefined (disabled).
   *  Must be set explicitly in config file — env vars are not accepted
   *  because any parent process can set them (RT audit finding RT2-2). */
  telemetryUrl?: string;

  /** Last known DID */
  did?: string;

  /** Installed integrations */
  integrations: {
    claudeCode?: {
      installed: boolean;
      installedAt: string;
      settingsPath: string;
    };
    cursor?: {
      installed: boolean;
      installedAt: string;
      settingsPath: string;
    };
    generic?: {
      installed: boolean;
      installedAt: string;
    };
  };

  /** Statistics */
  stats: {
    sessionsRecorded: number;
    insightsDeclared: number;
    lastEvolution?: string;
    lastSync?: string;
  };

  /** Created timestamp */
  createdAt: string;

  /** Last modified timestamp */
  updatedAt: string;
}

const DEFAULT_CONFIG: CLIConfig = {
  version: 1,
  network: 'devnet',
  keypairFile: 'keypair.json',
  autoFund: true,
  integrations: {},
  stats: {
    sessionsRecorded: 0,
    insightsDeclared: 0,
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// =============================================================================
// PATHS
// =============================================================================

/**
 * Get the base storage directory.
 */
export function getStorageDir(): string {
  const envDir = process.env.PERSISTENCE_IDENTITY_DIR;
  if (envDir) {
    return sanitizePath(envDir);
  }
  return path.join(os.homedir(), '.agent-identity');
}

/**
 * Get the config file path.
 */
export function getConfigPath(): string {
  return path.join(getStorageDir(), 'config.json');
}

/**
 * Get the sessions directory.
 */
export function getSessionsDir(): string {
  return path.join(getStorageDir(), 'sessions');
}

/**
 * Get the insights file path.
 */
export function getInsightsPath(): string {
  return path.join(getStorageDir(), 'insights.json');
}

/**
 * Get the logs directory.
 */
export function getLogsDir(): string {
  return path.join(getStorageDir(), 'logs');
}

/**
 * Get the hooks directory.
 */
export function getHooksDir(): string {
  return path.join(getStorageDir(), 'hooks');
}

// =============================================================================
// CONFIG OPERATIONS
// =============================================================================

/**
 * Ensure the storage directory exists with secure permissions.
 */
export function ensureStorageDir(): void {
  const dir = getStorageDir();

  if (!fs.existsSync(dir)) {
    // Create with restrictive permissions (owner only)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Ensure subdirectories exist
  const subdirs = [getSessionsDir(), getLogsDir(), getHooksDir()];
  for (const subdir of subdirs) {
    if (!fs.existsSync(subdir)) {
      fs.mkdirSync(subdir, { recursive: true, mode: 0o700 });
    }
  }
}

/**
 * Load the CLI configuration.
 */
export function loadConfig(): CLIConfig {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const loaded = safeParseJson<Partial<CLIConfig>>(content);

    // Validate and merge with defaults
    const config: CLIConfig = {
      ...DEFAULT_CONFIG,
      ...loaded,
      // Ensure nested objects are merged properly
      integrations: {
        ...DEFAULT_CONFIG.integrations,
        ...loaded.integrations,
      },
      stats: {
        ...DEFAULT_CONFIG.stats,
        ...loaded.stats,
      },
    };

    // Validate network
    if (config.network !== 'devnet' && config.network !== 'mainnet') {
      config.network = 'devnet';
    }

    return config;
  } catch (error) {
    console.error(`Warning: Failed to load config, using defaults: ${error}`);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Save the CLI configuration.
 */
export function saveConfig(config: CLIConfig): void {
  ensureStorageDir();

  const configPath = getConfigPath();
  config.updatedAt = new Date().toISOString();

  const content = safeStringifyJson(config, 2);

  // Write atomically (write to temp file, then rename)
  const tempPath = `${configPath}.tmp`;
  fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, configPath);
}

/**
 * Update specific config fields.
 */
export function updateConfig(updates: Partial<CLIConfig>): CLIConfig {
  const config = loadConfig();

  // Deep merge updates
  const updated: CLIConfig = {
    ...config,
    ...updates,
    integrations: {
      ...config.integrations,
      ...updates.integrations,
    },
    stats: {
      ...config.stats,
      ...updates.stats,
    },
    updatedAt: new Date().toISOString(),
  };

  saveConfig(updated);
  return updated;
}

// =============================================================================
// INSIGHTS STORAGE
// =============================================================================

export interface StoredInsight {
  /** Unique ID */
  id: string;

  /** The insight text */
  text: string;

  /** Associated dimension (if any) */
  dimension?: string;

  /** Whether this is pivotal */
  isPivotal: boolean;

  /** Confidence level (0-1) */
  confidence: number;

  /** Source: cli, marker, or api */
  source: 'cli' | 'marker' | 'api';

  /** When created/declared */
  createdAt: string;

  /** Session it was declared in (if known) */
  sessionId?: string;

  /** Whether it's been processed into the identity */
  processed: boolean;

  /** When it was processed */
  processedAt?: string;
}

/** @deprecated Use StoredInsight instead */
export type StoredCLIInsight = StoredInsight;

/**
 * Load stored insights.
 */
export function loadInsights(): StoredInsight[] {
  const insightsPath = getInsightsPath();

  if (!fs.existsSync(insightsPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(insightsPath, 'utf8');
    const insights = safeParseJson<StoredInsight[]>(content);

    if (!Array.isArray(insights)) {
      return [];
    }

    return insights;
  } catch (error) {
    console.error(`Warning: Failed to load insights: ${error}`);
    return [];
  }
}

/**
 * Save insights to storage.
 */
export function saveInsights(insights: StoredInsight[]): void {
  ensureStorageDir();

  const insightsPath = getInsightsPath();
  const content = safeStringifyJson(insights, 2);

  // Write atomically
  const tempPath = `${insightsPath}.tmp`;
  fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, insightsPath);
}

/**
 * Add a new insight.
 */
export function addInsight(insight: Omit<StoredInsight, 'id' | 'createdAt' | 'processed'>): StoredInsight {
  const insights = loadInsights();

  const newInsight: StoredInsight = {
    ...insight,
    id: `insight_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    processed: false,
  };

  insights.push(newInsight);
  saveInsights(insights);

  // Update stats
  const config = loadConfig();
  config.stats.insightsDeclared++;
  saveConfig(config);

  return newInsight;
}

/**
 * Get unprocessed insights.
 */
export function getUnprocessedInsights(): StoredInsight[] {
  return loadInsights().filter(i => !i.processed);
}

/**
 * Mark insights as processed.
 */
export function markInsightsProcessed(ids: string[]): void {
  const insights = loadInsights();
  const now = new Date().toISOString();

  for (const insight of insights) {
    if (ids.includes(insight.id)) {
      insight.processed = true;
      insight.processedAt = now;
    }
  }

  saveInsights(insights);
}

// =============================================================================
// SESSION STORAGE
// =============================================================================

export interface SessionRecord {
  /** Session ID */
  id: string;

  /** When started */
  startedAt: string;

  /** When ended (if ended) */
  endedAt?: string;

  /** Tool calls recorded */
  toolCalls: Array<{
    tool: string;
    timestamp: string;
    durationMs?: number;
    success?: boolean;
    /** Tool input arguments (from PostToolUse tool_input) */
    args?: Record<string, unknown>;
    /** Stringified tool response, truncated to 4KB */
    result?: string;
  }>;

  /** Markers found in transcript */
  markers: {
    learns: string[];
    pivotals: string[];
  };

  /** Commit SHAs detected during session (from git commit output in Bash results) */
  gitCommits?: string[];

  /** Whether this session has been processed */
  processed: boolean;
}

/**
 * Get session file path.
 */
export function getSessionPath(sessionId: string): string {
  // Sanitize session ID to prevent path traversal
  const safeId = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  return path.join(getSessionsDir(), `${safeId}.json`);
}

/**
 * Load a session record.
 */
export function loadSession(sessionId: string): SessionRecord | null {
  const sessionPath = getSessionPath(sessionId);

  if (!fs.existsSync(sessionPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(sessionPath, 'utf8');
    return safeParseJson<SessionRecord>(content);
  } catch (error) {
    console.error(`Warning: Failed to load session ${sessionId}: ${error}`);
    return null;
  }
}

/**
 * Save a session record.
 */
export function saveSession(session: SessionRecord): void {
  ensureStorageDir();

  const sessionPath = getSessionPath(session.id);
  const content = safeStringifyJson(session, 2);

  // Write atomically
  const tempPath = `${sessionPath}.tmp`;
  fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, sessionPath);
}

/**
 * Create a new session.
 */
export function createSession(sessionId: string): SessionRecord {
  const session: SessionRecord = {
    id: sessionId,
    startedAt: new Date().toISOString(),
    toolCalls: [],
    markers: {
      learns: [],
      pivotals: [],
    },
    processed: false,
  };

  saveSession(session);
  return session;
}

/**
 * Add a tool call to a session.
 */
export function addToolCallToSession(
  sessionId: string,
  toolCall: SessionRecord['toolCalls'][0]
): void {
  let session = loadSession(sessionId);

  if (!session) {
    session = createSession(sessionId);
  }

  session.toolCalls.push(toolCall);
  saveSession(session);
}

/**
 * Get all unprocessed sessions.
 */
export function getUnprocessedSessions(): SessionRecord[] {
  const sessionsDir = getSessionsDir();

  if (!fs.existsSync(sessionsDir)) {
    return [];
  }

  const files = fs.readdirSync(sessionsDir);
  const sessions: SessionRecord[] = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    const sessionId = file.replace('.json', '');
    const session = loadSession(sessionId);

    if (session && !session.processed) {
      sessions.push(session);
    }
  }

  return sessions;
}

/**
 * Mark a session as processed.
 */
export function markSessionProcessed(sessionId: string): void {
  const session = loadSession(sessionId);
  if (session) {
    session.processed = true;
    saveSession(session);
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  getStorageDir,
  getConfigPath,
  getSessionsDir,
  getInsightsPath,
  getLogsDir,
  getHooksDir,
  ensureStorageDir,
  loadConfig,
  saveConfig,
  updateConfig,
  loadInsights,
  saveInsights,
  addInsight,
  getUnprocessedInsights,
  markInsightsProcessed,
  getSessionPath,
  loadSession,
  saveSession,
  createSession,
  addToolCallToSession,
  getUnprocessedSessions,
  markSessionProcessed,
};
