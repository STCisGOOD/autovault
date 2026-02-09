/**
 * FileSystemStorageBackend
 *
 * Implements the StorageBackend interface from agent-identity using the local
 * filesystem. Each key maps to a JSON file under a base directory.
 *
 * Designed for CLI hook processes that start fresh on every invocation —
 * in-memory storage is useless when the process exits after each hook call.
 *
 * Safety:
 * - Atomic writes via write-tmp-then-rename (prevents partial reads)
 * - .bak fallback for corruption recovery
 * - Key sanitization to prevent path traversal
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * StorageBackend interface (duplicated here to avoid compile-time dependency
 * on persistence-agent-identity). Matches IdentityPersistence.StorageBackend exactly.
 */
export interface StorageBackend {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(pattern?: string): Promise<string[]>;
  isPersistent(): boolean;
}

export class FileSystemStorageBackend implements StorageBackend {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const filePath = this.keyToPath(key);
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
      // Primary file corrupt or missing — try backup
      const bakPath = filePath + '.bak';
      if (fs.existsSync(bakPath)) {
        try {
          console.warn(`[Storage] Primary corrupt or missing, using backup: ${key}`);
          return JSON.parse(fs.readFileSync(bakPath, 'utf8')) as T;
        } catch {
          /* both corrupt */
        }
      }
      return null;
    }
  }

  /**
   * Atomic write: tmp → backup current → rename tmp over current.
   *
   * NOTE: No fsync before rename. On POSIX, rename is atomic for concurrent
   * observers (readers see old or new, never partial), but without fsync the
   * data may not be durable across power loss. For a local CLI tool this is
   * acceptable risk — the .bak fallback covers most corruption scenarios.
   * A future version could add fs.fdatasyncSync(fd) before close for full
   * crash safety if this is ever used in a server context.
   *
   * TODO(v2): Add proper-lockfile around the entire ARIL backward pass.
   * Two simultaneous SessionEnd hooks (rapid-fire sessions) can race:
   * both read stale state, both compute, last rename wins — session A's
   * learned state silently lost. Atomic rename prevents file corruption
   * but not logical data loss from concurrent read-modify-write cycles.
   * For v1 single-user CLI this is rare enough to accept.
   */
  async set<T>(key: string, value: T): Promise<void> {
    const filePath = this.keyToPath(key);
    const tmpPath = filePath + `.${process.pid}.tmp`;

    // 1. Write to temp file in SAME directory (cross-device rename throws EXDEV)
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');

    // 2. Backup current file (for corruption recovery)
    if (fs.existsSync(filePath)) {
      try {
        fs.copyFileSync(filePath, filePath + '.bak');
      } catch {
        // Best-effort backup — don't fail the write
      }
    }

    // 3. Atomic rename
    fs.renameSync(tmpPath, filePath);
  }

  async delete(key: string): Promise<void> {
    const filePath = this.keyToPath(key);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Already deleted or never existed
    }
    // Also clean up backup
    try {
      fs.unlinkSync(filePath + '.bak');
    } catch {
      // Best effort
    }
  }

  async keys(pattern?: string): Promise<string[]> {
    try {
      const files = fs.readdirSync(this.baseDir);
      const keys = files
        .filter(f => f.endsWith('.json') && !f.endsWith('.tmp') && !f.endsWith('.bak'))
        .map(f => f.replace('.json', ''));

      if (pattern) {
        const regex = new RegExp(
          '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
        );
        return keys.filter(k => regex.test(k));
      }

      return keys;
    } catch {
      return [];
    }
  }

  isPersistent(): boolean {
    return true;
  }

  /**
   * Sanitize key to a safe filename.
   * Replace non-alphanumeric (except - and _) with _, limit to 200 chars.
   */
  private keyToPath(key: string): string {
    const safeKey = key.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 200);
    return path.join(this.baseDir, `${safeKey}.json`);
  }
}
