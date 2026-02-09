/**
 * PrivateStorage.ts
 *
 * Local filesystem storage for private behavioral data (ActionLogs).
 *
 * Architecture:
 * - On-chain (Solana): weights, hashes, proofs (public, verifiable)
 * - Off-chain (here): full ActionLogs, decision reasoning (private, trainable)
 *
 * The hash of each ActionLog is stored on-chain, creating a verifiable
 * commitment to the private data without exposing it.
 *
 * Directory structure:
 * ~/.agent-identity/
 * └── <agent-did>/
 *     └── private/
 *         ├── action-logs/
 *         │   ├── <hash>.json
 *         │   └── ...
 *         ├── index.json  (metadata + ordering)
 *         └── corpus/     (aggregated training data)
 */

import * as fs from 'fs';
import * as path from 'path';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import type { ActionLog } from '../behavioral/BehavioralObserver';
import type { Insight } from '../behavioral/ReflectionEngine';

// =============================================================================
// TYPES
// =============================================================================

export interface PrivateStorageConfig {
  /** Base directory for storage (default: ~/.agent-identity) */
  baseDir?: string;
  /** Agent DID (used as subdirectory) */
  agentDid: string;
  /** Whether to pretty-print JSON (default: false for space efficiency) */
  prettyPrint?: boolean;
}

export interface StoredActionLog {
  /** SHA-256 hash of the ActionLog (also used as filename) */
  hash: string;
  /** The full ActionLog data */
  log: ActionLog;
  /** When this was stored */
  storedAt: number;
  /** Sequence number for ordering */
  seq: number;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
  /** Insights extracted from this ActionLog (if any) */
  insights?: Insight[];
}

export interface StoredInsight {
  /** The insight data */
  insight: Insight;
  /** Hash of the ActionLog this insight came from */
  actionLogHash: string;
  /** When this was stored */
  storedAt: number;
}

export interface ActionLogIndex {
  /** Agent DID */
  agentDid: string;
  /** Total number of logs stored */
  totalLogs: number;
  /** Ordered list of hashes (oldest first) */
  hashes: string[];
  /** Total number of insights stored */
  totalInsights: number;
  /** Count of pivotal insights */
  pivotalInsightCount: number;
  /** Last updated timestamp */
  lastUpdated: number;
  /** Version for future migrations */
  version: number;
}

export interface PrivateStorageStats {
  totalLogs: number;
  totalInsights: number;
  pivotalInsightCount: number;
  totalSizeBytes: number;
  oldestLog: number | null;
  newestLog: number | null;
  storageDir: string;
}

// =============================================================================
// PRIVATE STORAGE BACKEND INTERFACE
// =============================================================================

export interface PrivateStorageBackend {
  /** Store an ActionLog, returns its hash */
  storeActionLog(log: ActionLog, metadata?: Record<string, unknown>): Promise<string>;

  /** Store an ActionLog with associated insights, returns its hash */
  storeActionLogWithInsights(
    log: ActionLog,
    insights: Insight[],
    metadata?: Record<string, unknown>
  ): Promise<string>;

  /** Retrieve an ActionLog by its hash */
  getActionLog(hash: string): Promise<StoredActionLog | null>;

  /** Get all ActionLogs (for training) */
  getAllActionLogs(): Promise<StoredActionLog[]>;

  /** Get ActionLogs in a time range */
  getActionLogsByTimeRange(startTime: number, endTime: number): Promise<StoredActionLog[]>;

  /** Get all pivotal insights (for identity evolution analysis) */
  getPivotalInsights(): Promise<StoredInsight[]>;

  /** Verify that a hash matches an ActionLog */
  verify(hash: string, log: ActionLog): boolean;

  /** Get storage statistics */
  getStats(): Promise<PrivateStorageStats>;

  /** Export all data for backup/migration */
  exportAll(): Promise<{ index: ActionLogIndex; logs: StoredActionLog[] }>;
}

// =============================================================================
// FILESYSTEM PRIVATE STORAGE
// =============================================================================

export class FileSystemPrivateStorage implements PrivateStorageBackend {
  private readonly baseDir: string;
  private readonly agentDir: string;
  private readonly logsDir: string;
  private readonly indexPath: string;
  private readonly prettyPrint: boolean;
  private index: ActionLogIndex | null = null;

  constructor(config: PrivateStorageConfig) {
    this.baseDir = config.baseDir || this.getDefaultBaseDir();
    this.prettyPrint = config.prettyPrint ?? false;

    // Sanitize DID for filesystem — colons are illegal in Windows paths
    const safeDid = config.agentDid.replace(/[^a-zA-Z0-9-_]/g, '_');
    this.agentDir = path.join(this.baseDir, safeDid, 'private');
    this.logsDir = path.join(this.agentDir, 'action-logs');
    this.indexPath = path.join(this.agentDir, 'index.json');

    this.ensureDirectories();
  }

  /**
   * Store an ActionLog and return its hash.
   */
  async storeActionLog(
    log: ActionLog,
    metadata?: Record<string, unknown>
  ): Promise<string> {
    return this.storeActionLogWithInsights(log, [], metadata);
  }

  /**
   * Store an ActionLog with associated insights and return its hash.
   */
  async storeActionLogWithInsights(
    log: ActionLog,
    insights: Insight[],
    metadata?: Record<string, unknown>
  ): Promise<string> {
    const hash = this.computeHash(log);
    const index = await this.loadIndex();

    // Check if already stored
    if (index.hashes.includes(hash)) {
      console.log(`[PrivateStorage] ActionLog ${hash.slice(0, 8)}... already stored`);
      return hash;
    }

    const stored: StoredActionLog = {
      hash,
      log,
      storedAt: Date.now(),
      seq: index.totalLogs + 1,
      metadata,
      insights: insights.length > 0 ? insights : undefined,
    };

    // Write the log file
    const logPath = path.join(this.logsDir, `${hash}.json`);
    const content = this.prettyPrint
      ? JSON.stringify(stored, null, 2)
      : JSON.stringify(stored);
    fs.writeFileSync(logPath, content, { encoding: 'utf-8', mode: 0o600 });

    // Update index
    index.hashes.push(hash);
    index.totalLogs++;
    index.lastUpdated = Date.now();

    // Track insights
    if (insights.length > 0) {
      index.totalInsights += insights.length;
      index.pivotalInsightCount += insights.filter(i => i.isPivotal).length;
    }

    await this.saveIndex(index);

    const insightSummary = insights.length > 0
      ? ` with ${insights.length} insight(s)`
      : '';
    console.log(`[PrivateStorage] Stored ActionLog ${hash.slice(0, 8)}...${insightSummary} (seq: ${stored.seq})`);
    return hash;
  }

  /**
   * Retrieve an ActionLog by its hash.
   */
  async getActionLog(hash: string): Promise<StoredActionLog | null> {
    const logPath = path.join(this.logsDir, `${hash}.json`);

    if (!fs.existsSync(logPath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(logPath, 'utf-8');
      return JSON.parse(content) as StoredActionLog;
    } catch (err) {
      console.error(`[PrivateStorage] Failed to read ${hash}:`, err);
      return null;
    }
  }

  /**
   * Get all ActionLogs (for training).
   */
  async getAllActionLogs(): Promise<StoredActionLog[]> {
    const index = await this.loadIndex();
    const logs: StoredActionLog[] = [];

    for (const hash of index.hashes) {
      const log = await this.getActionLog(hash);
      if (log) {
        logs.push(log);
      }
    }

    // Sort by sequence number
    return logs.sort((a, b) => a.seq - b.seq);
  }

  /**
   * Get ActionLogs in a time range.
   */
  async getActionLogsByTimeRange(
    startTime: number,
    endTime: number
  ): Promise<StoredActionLog[]> {
    const all = await this.getAllActionLogs();
    return all.filter(
      (log) => log.log.startTime >= startTime && log.log.endTime <= endTime
    );
  }

  /**
   * Get all pivotal insights (for identity evolution analysis).
   */
  async getPivotalInsights(): Promise<StoredInsight[]> {
    const allLogs = await this.getAllActionLogs();
    const pivotalInsights: StoredInsight[] = [];

    for (const storedLog of allLogs) {
      if (storedLog.insights) {
        for (const insight of storedLog.insights) {
          if (insight.isPivotal) {
            pivotalInsights.push({
              insight,
              actionLogHash: storedLog.hash,
              storedAt: storedLog.storedAt,
            });
          }
        }
      }
    }

    // Sort by timestamp (oldest first)
    return pivotalInsights.sort((a, b) => a.insight.timestamp - b.insight.timestamp);
  }

  /**
   * Verify that a hash matches an ActionLog.
   */
  verify(hash: string, log: ActionLog): boolean {
    const computed = this.computeHash(log);
    return computed === hash;
  }

  /**
   * Get storage statistics.
   */
  async getStats(): Promise<PrivateStorageStats> {
    const index = await this.loadIndex();
    const logs = await this.getAllActionLogs();

    let totalSizeBytes = 0;
    for (const hash of index.hashes) {
      const logPath = path.join(this.logsDir, `${hash}.json`);
      if (fs.existsSync(logPath)) {
        totalSizeBytes += fs.statSync(logPath).size;
      }
    }

    const timestamps = logs.map((l) => l.storedAt).sort((a, b) => a - b);

    return {
      totalLogs: index.totalLogs,
      totalInsights: index.totalInsights,
      pivotalInsightCount: index.pivotalInsightCount,
      totalSizeBytes,
      oldestLog: timestamps[0] || null,
      newestLog: timestamps[timestamps.length - 1] || null,
      storageDir: this.agentDir,
    };
  }

  /**
   * Export all data for backup/migration.
   */
  async exportAll(): Promise<{ index: ActionLogIndex; logs: StoredActionLog[] }> {
    const index = await this.loadIndex();
    const logs = await this.getAllActionLogs();
    return { index, logs };
  }

  /**
   * Compute SHA-256 hash of an ActionLog.
   */
  computeHash(log: ActionLog): string {
    // Deterministic JSON serialization
    const json = JSON.stringify(log, Object.keys(log).sort());
    return bytesToHex(sha256(new TextEncoder().encode(json)));
  }

  /**
   * Get the storage directory path.
   */
  getStorageDir(): string {
    return this.agentDir;
  }

  // ===========================================================================
  // INTERNAL METHODS
  // ===========================================================================

  private getDefaultBaseDir(): string {
    const home = process.env.HOME || process.env.USERPROFILE || '.';
    return path.join(home, '.agent-identity');
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }

    // Create .gitignore to protect private data
    const gitignorePath = path.join(this.agentDir, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, '*\n!.gitignore\n', 'utf-8');
    }
  }

  private async loadIndex(): Promise<ActionLogIndex> {
    if (this.index) {
      return this.index;
    }

    if (fs.existsSync(this.indexPath)) {
      try {
        const content = fs.readFileSync(this.indexPath, 'utf-8');
        const loaded = JSON.parse(content) as ActionLogIndex;

        // Migrate older indices that don't have insight tracking
        if (loaded.totalInsights === undefined) {
          loaded.totalInsights = 0;
        }
        if (loaded.pivotalInsightCount === undefined) {
          loaded.pivotalInsightCount = 0;
        }

        this.index = loaded;
        return this.index;
      } catch (err) {
        console.error('[PrivateStorage] Failed to load index, creating new:', err);
      }
    }

    // Create new index
    this.index = {
      agentDid: path.basename(path.dirname(this.agentDir)),
      totalLogs: 0,
      hashes: [],
      totalInsights: 0,
      pivotalInsightCount: 0,
      lastUpdated: Date.now(),
      version: 1,
    };

    await this.saveIndex(this.index);
    return this.index;
  }

  private async saveIndex(index: ActionLogIndex): Promise<void> {
    this.index = index;
    const content = this.prettyPrint
      ? JSON.stringify(index, null, 2)
      : JSON.stringify(index);
    fs.writeFileSync(this.indexPath, content, { encoding: 'utf-8', mode: 0o600 });
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createFileSystemPrivateStorage(
  config: PrivateStorageConfig
): FileSystemPrivateStorage {
  return new FileSystemPrivateStorage(config);
}

export default FileSystemPrivateStorage;
