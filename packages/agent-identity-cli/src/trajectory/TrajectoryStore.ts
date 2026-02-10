/**
 * TrajectoryStore.ts
 *
 * SQLite persistence layer for trajectory metric snapshots (v2.2 spec §10).
 *
 * Uses better-sqlite3 (synchronous, native) for zero-overhead writes during
 * the hot path (PostToolUse handler). WAL mode enables concurrent reads while
 * writes stay fast.
 *
 * Schema: 4 tables
 *   - metric_snapshots: per-edit Tier 0/1 metrics (the trajectory)
 *   - trajectory_features: session-level summary features (for ARIL)
 *   - dep_graph_snapshots: dependency graph state at Tier 1 checkpoints
 *   - analysis_cache: content-hash keyed parse cache (avoids re-parsing)
 */

import Database from 'better-sqlite3';
import type {
  MetricSnapshot,
  Tier1SnapshotData,
  SessionPersistData,
  DepGraphSnapshot,
  QueryOpts,
  MetricTier,
} from './types';
import { TRAJECTORY_SCHEMA_VERSION } from './types';

// =============================================================================
// STORE
// =============================================================================

export class TrajectoryStore {
  private db: Database.Database;
  private pinnedSchemaVersion: number = TRAJECTORY_SCHEMA_VERSION;
  private pendingBatch: MetricSnapshot[] = [];
  private readonly batchSize: number;

  // Prepared statements (lazily initialized after table creation)
  private insertSnapshotStmt!: Database.Statement;
  private queryBySessionStmt!: Database.Statement;
  private queryBySessionAndTierStmt!: Database.Statement;
  private queryBySessionAndFileStmt!: Database.Statement;
  private distinctFilesStmt!: Database.Statement;
  private stepCountStmt!: Database.Statement;
  private tier0CountStmt!: Database.Statement;
  private tier1CountStmt!: Database.Statement;
  private getCacheStmt!: Database.Statement;
  private setCacheStmt!: Database.Statement;
  private latestDepGraphStmt!: Database.Statement;

  constructor(config: { dbPath: string; walMode?: boolean; batchSize?: number }) {
    this.db = new Database(config.dbPath);
    this.batchSize = config.batchSize ?? 50;

    if (config.walMode !== false) {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.pragma('synchronous = NORMAL');
    // Allow 5s for concurrent sessions sharing the same trajectory.db.
    // Under WAL mode, writer contention resolves in <100ms typically.
    this.db.pragma('busy_timeout = 5000');
  }

  /**
   * Create tables and prepare statements.
   * Safe to call multiple times (CREATE IF NOT EXISTS).
   */
  initialize(): void {
    this.db.exec(`
      -- Global schema version tracking
      CREATE TABLE IF NOT EXISTS schema_info (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schema_info VALUES ('schema_version', '${TRAJECTORY_SCHEMA_VERSION}');

      -- Per-edit metric snapshots (the trajectory)
      CREATE TABLE IF NOT EXISTS metric_snapshots (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id     TEXT    NOT NULL,
        step_index     INTEGER NOT NULL,
        timestamp_ms   INTEGER NOT NULL,
        file_path      TEXT    NOT NULL,
        tool_type      TEXT    NOT NULL,
        granularity    TEXT    NOT NULL DEFAULT 'file',
        package        TEXT,
        file_role      TEXT    NOT NULL DEFAULT 'source',
        metrics_json   TEXT    NOT NULL,
        tier           INTEGER NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT ${TRAJECTORY_SCHEMA_VERSION},
        computed_at    TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_session
        ON metric_snapshots(session_id, step_index);
      CREATE INDEX IF NOT EXISTS idx_snapshots_file
        ON metric_snapshots(file_path, session_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_package
        ON metric_snapshots(package, session_id);

      -- Session-level trajectory features (summary for ARIL)
      CREATE TABLE IF NOT EXISTS trajectory_features (
        session_id                          TEXT PRIMARY KEY,
        complexity_shape                    REAL,
        complexity_shape_confidence         REAL,
        coupling_direction                  REAL,
        coupling_direction_confidence       REAL,
        edit_dep_alignment                  REAL,
        edit_dep_alignment_confidence       REAL,
        edit_locality                       REAL,
        edit_locality_confidence            REAL,
        complexity_coupling_corr            REAL,
        complexity_coupling_corr_confidence REAL,
        structural_churn                    REAL,
        structural_churn_confidence         REAL,
        api_surface_delta                   INTEGER,
        api_surface_delta_confidence        REAL,
        refactor_detected                   INTEGER,
        refactor_detected_confidence        REAL,
        step_count                          INTEGER NOT NULL,
        files_touched                       INTEGER NOT NULL,
        packages_touched                    INTEGER,
        test_files_touched                  INTEGER,
        source_files_touched                INTEGER,
        tier0_snapshot_count                INTEGER,
        tier1_snapshot_count                INTEGER,
        tier1_available                     INTEGER,
        tier_coverage_json                  TEXT,
        schema_version                      INTEGER NOT NULL DEFAULT ${TRAJECTORY_SCHEMA_VERSION},
        computed_at                         TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Dependency graph snapshots
      CREATE TABLE IF NOT EXISTS dep_graph_snapshots (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id     TEXT    NOT NULL,
        step_index     INTEGER NOT NULL,
        granularity    TEXT    NOT NULL,
        language       TEXT    NOT NULL,
        edges_json     TEXT    NOT NULL,
        node_count     INTEGER NOT NULL,
        edge_count     INTEGER NOT NULL,
        circular_deps  INTEGER NOT NULL DEFAULT 0,
        git_sha        TEXT,
        computed_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_depgraph_session
        ON dep_graph_snapshots(session_id, step_index);

      -- Analysis cache (content-hash keyed)
      CREATE TABLE IF NOT EXISTS analysis_cache (
        file_path      TEXT    NOT NULL,
        content_hash   TEXT    NOT NULL,
        tier           INTEGER NOT NULL,
        metrics_json   TEXT    NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT ${TRAJECTORY_SCHEMA_VERSION},
        computed_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (file_path, content_hash, tier)
      );
    `);

    this.prepareStatements();
  }

  /**
   * Pin and return schema_version for this session.
   * Subsequent writes use the pinned version (not re-read from DB).
   */
  initSession(): number {
    const row = this.db.prepare(
      `SELECT value FROM schema_info WHERE key = 'schema_version'`
    ).get() as { value: string } | undefined;

    this.pinnedSchemaVersion = row ? parseInt(row.value, 10) : TRAJECTORY_SCHEMA_VERSION;
    return this.pinnedSchemaVersion;
  }

  /**
   * Queue a snapshot for batched write.
   * Flushes automatically when batch reaches batchSize.
   */
  writeSnapshot(snapshot: MetricSnapshot): void {
    this.pendingBatch.push(snapshot);
    if (this.pendingBatch.length >= this.batchSize) {
      this.flush();
    }
  }

  /**
   * Insert multiple snapshots in a single transaction.
   */
  writeBatch(snapshots: MetricSnapshot[]): void {
    if (snapshots.length === 0) return;

    const insertMany = this.db.transaction((rows: MetricSnapshot[]) => {
      for (const s of rows) {
        this.insertSnapshotStmt.run(
          s.sessionId,
          s.stepIndex,
          s.timestampMs,
          s.filePath,
          s.toolType,
          s.granularity,
          s.packageName,
          s.fileRole,
          JSON.stringify(s.metricsJson),
          s.tier,
          this.pinnedSchemaVersion,
        );
      }
    });

    insertMany(snapshots);
  }

  /**
   * Flush all pending writes to disk.
   */
  flush(): void {
    if (this.pendingBatch.length === 0) return;
    this.writeBatch(this.pendingBatch);
    this.pendingBatch = [];
  }

  /**
   * Write a Tier 1 snapshot (dependency graph + per-file metrics).
   */
  writeTier1Snapshot(data: Tier1SnapshotData): void {
    const insertGraph = this.db.prepare(`
      INSERT INTO dep_graph_snapshots
        (session_id, step_index, granularity, language, edges_json, node_count, edge_count, circular_deps, git_sha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const txn = this.db.transaction(() => {
      insertGraph.run(
        data.sessionId,
        data.stepIndex,
        data.granularity,
        data.language,
        JSON.stringify(data.edges),
        data.nodeCount,
        data.edgeCount,
        data.circularDeps,
        data.gitSha ?? null,
      );

      if (data.perFileMetrics) {
        for (const fm of data.perFileMetrics) {
          this.insertSnapshotStmt.run(
            data.sessionId,
            data.stepIndex,
            Date.now(),
            fm.filePath,
            'tier1-batch',
            data.granularity,
            null,
            'source',
            JSON.stringify(fm.metricsJson),
            1,
            this.pinnedSchemaVersion,
          );
        }
      }
    });

    txn();
  }

  /**
   * Persist session-level trajectory features (Path B corpus).
   */
  persistSession(sessionId: string, data: SessionPersistData): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO trajectory_features (
        session_id,
        complexity_shape, complexity_shape_confidence,
        coupling_direction, coupling_direction_confidence,
        edit_dep_alignment, edit_dep_alignment_confidence,
        edit_locality, edit_locality_confidence,
        complexity_coupling_corr, complexity_coupling_corr_confidence,
        structural_churn, structural_churn_confidence,
        api_surface_delta, api_surface_delta_confidence,
        refactor_detected, refactor_detected_confidence,
        step_count, files_touched, packages_touched,
        test_files_touched, source_files_touched,
        tier0_snapshot_count, tier1_snapshot_count, tier1_available,
        schema_version
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    stmt.run(
      sessionId,
      data.features.complexity_shape, data.confidences.complexity_shape ?? 0,
      data.features.coupling_direction, data.confidences.coupling_direction ?? 0,
      data.features.edit_dep_alignment, data.confidences.edit_dep_alignment ?? 0,
      data.features.edit_locality, data.confidences.edit_locality ?? 0,
      data.features.complexity_coupling_corr, data.confidences.complexity_coupling_corr ?? 0,
      data.features.structural_churn, data.confidences.structural_churn ?? 0,
      data.features.api_surface_delta, data.confidences.api_surface_delta ?? 0,
      data.features.refactor_detected, data.confidences.refactor_detected ?? 0,
      data.stepCount,
      data.filesTouched,
      data.packagesTouched ?? null,
      data.testFilesTouched ?? null,
      data.sourceFilesTouched ?? null,
      data.tier0SnapshotCount ?? null,
      data.tier1SnapshotCount ?? null,
      data.tier1Available != null ? (data.tier1Available ? 1 : 0) : null,
      this.pinnedSchemaVersion,
    );
  }

  /**
   * Query snapshots for a session, ordered by step_index.
   */
  queryBySession(sessionId: string, opts?: QueryOpts): MetricSnapshot[] {
    let rows: unknown[];

    if (opts?.tier !== undefined && opts?.filePath) {
      // RT-M5 fix: parameterize LIMIT to prevent SQL injection.
      // SQLite LIMIT -1 = no limit (returns all rows).
      const safeLimit = opts?.limit != null
        ? Math.max(1, Math.floor(Number(opts.limit) || 0))
        : -1;
      rows = this.db.prepare(`
        SELECT * FROM metric_snapshots
        WHERE session_id = ? AND tier = ? AND file_path = ?
        ORDER BY step_index
        LIMIT ?
      `).all(sessionId, opts.tier, opts.filePath, safeLimit);
    } else if (opts?.tier !== undefined) {
      rows = this.queryBySessionAndTierStmt.all(sessionId, opts.tier);
    } else if (opts?.filePath) {
      rows = this.queryBySessionAndFileStmt.all(sessionId, opts.filePath);
    } else {
      rows = this.queryBySessionStmt.all(sessionId);
    }

    return (rows as Record<string, unknown>[]).map(rowToSnapshot);
  }

  /**
   * Get unique file paths touched in a session.
   */
  getDistinctFiles(sessionId: string): string[] {
    const rows = this.distinctFilesStmt.all(sessionId) as Array<{ file_path: string }>;
    return rows.map(r => r.file_path);
  }

  /**
   * Get total step count for a session.
   */
  getStepCount(sessionId: string): number {
    const row = this.stepCountStmt.get(sessionId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  /**
   * Get snapshot counts separated by tier.
   */
  getSnapshotCountByTier(sessionId: string): { tier0: number; tier1: number } {
    const t0 = this.tier0CountStmt.get(sessionId) as { cnt: number } | undefined;
    const t1 = this.tier1CountStmt.get(sessionId) as { cnt: number } | undefined;
    return {
      tier0: t0?.cnt ?? 0,
      tier1: t1?.cnt ?? 0,
    };
  }

  /**
   * Content-hash analysis cache: lookup.
   */
  getCachedAnalysis(
    filePath: string,
    contentHash: string,
    tier: number,
  ): Record<string, unknown> | null {
    const row = this.getCacheStmt.get(filePath, contentHash, tier) as
      { metrics_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.metrics_json);
    } catch {
      return null;
    }
  }

  /**
   * Content-hash analysis cache: store/overwrite.
   */
  setCachedAnalysis(
    filePath: string,
    contentHash: string,
    tier: number,
    metrics: Record<string, unknown>,
  ): void {
    this.setCacheStmt.run(
      filePath,
      contentHash,
      tier,
      JSON.stringify(metrics),
      this.pinnedSchemaVersion,
    );
  }

  /**
   * Load the latest dependency graph snapshot for a language.
   */
  loadLatestDepGraph(language: string): DepGraphSnapshot | null {
    const row = this.latestDepGraphStmt.get(language) as Record<string, unknown> | undefined;
    if (!row) return null;

    try {
      return {
        sessionId: row.session_id as string,
        stepIndex: row.step_index as number,
        granularity: row.granularity as 'file' | 'folder',
        language: row.language as string,
        edges: JSON.parse(row.edges_json as string),
        nodeCount: row.node_count as number,
        edgeCount: row.edge_count as number,
        circularDeps: row.circular_deps as number,
        gitSha: row.git_sha as string | undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Delete all data for a session.
   */
  deleteSession(sessionId: string): void {
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM metric_snapshots WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM trajectory_features WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM dep_graph_snapshots WHERE session_id = ?').run(sessionId);
    });
    txn();
  }

  /**
   * Close the database. Safe to call multiple times.
   */
  close(): void {
    try {
      this.flush();
    } catch { /* ignore flush errors on close */ }
    try {
      // RT-M6 fix: checkpoint WAL to prevent unbounded growth.
      // TRUNCATE mode resets the WAL file to zero bytes after checkpoint.
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch { /* WAL checkpoint failure is non-fatal */ }
    try {
      this.db.close();
    } catch { /* already closed */ }
  }

  // ===========================================================================
  // PRIVATE
  // ===========================================================================

  private prepareStatements(): void {
    this.insertSnapshotStmt = this.db.prepare(`
      INSERT INTO metric_snapshots
        (session_id, step_index, timestamp_ms, file_path, tool_type, granularity,
         package, file_role, metrics_json, tier, schema_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.queryBySessionStmt = this.db.prepare(`
      SELECT * FROM metric_snapshots WHERE session_id = ? ORDER BY step_index ASC
    `);

    this.queryBySessionAndTierStmt = this.db.prepare(`
      SELECT * FROM metric_snapshots WHERE session_id = ? AND tier = ? ORDER BY step_index
    `);

    this.queryBySessionAndFileStmt = this.db.prepare(`
      SELECT * FROM metric_snapshots WHERE session_id = ? AND file_path = ? ORDER BY step_index
    `);

    this.distinctFilesStmt = this.db.prepare(`
      SELECT DISTINCT file_path FROM metric_snapshots WHERE session_id = ?
    `);

    this.stepCountStmt = this.db.prepare(`
      SELECT MAX(step_index) + 1 AS cnt FROM metric_snapshots WHERE session_id = ?
    `);

    this.tier0CountStmt = this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM metric_snapshots WHERE session_id = ? AND tier = 0
    `);

    this.tier1CountStmt = this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM metric_snapshots WHERE session_id = ? AND tier = 1
    `);

    this.getCacheStmt = this.db.prepare(`
      SELECT metrics_json FROM analysis_cache
      WHERE file_path = ? AND content_hash = ? AND tier = ?
    `);

    this.setCacheStmt = this.db.prepare(`
      INSERT OR REPLACE INTO analysis_cache
        (file_path, content_hash, tier, metrics_json, schema_version)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.latestDepGraphStmt = this.db.prepare(`
      SELECT * FROM dep_graph_snapshots
      WHERE language = ?
      ORDER BY computed_at DESC
      LIMIT 1
    `);
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function rowToSnapshot(row: Record<string, unknown>): MetricSnapshot {
  return {
    id: row.id as number,
    sessionId: row.session_id as string,
    stepIndex: row.step_index as number,
    timestampMs: row.timestamp_ms as number,
    filePath: row.file_path as string,
    toolType: row.tool_type as string,
    granularity: (row.granularity as string) as 'file' | 'folder',
    packageName: row.package as string | null,
    fileRole: (row.file_role as string) as 'source' | 'test' | 'config',
    metricsJson: JSON.parse(row.metrics_json as string),
    tier: row.tier as MetricTier,
    schemaVersion: row.schema_version as number,
  };
}
