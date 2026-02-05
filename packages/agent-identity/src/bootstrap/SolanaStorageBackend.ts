/**
 * SolanaStorageBackend.ts
 *
 * Implements StorageBackend interface using Solana memo transactions.
 * This is the critical bridge that makes behavioral identity actually
 * persist to an immutable blockchain.
 *
 * How it works:
 * - set(key, value) → Writes a memo transaction with { key, value, op: 'set' }
 * - get(key) → Queries memo history, returns latest value for key
 * - delete(key) → Writes a memo with { key, op: 'delete' }
 * - keys() → Queries all memos, extracts unique non-deleted keys
 *
 * Each write is a Solana transaction. Reads query transaction history.
 * This provides:
 * - Immutable audit trail of all identity changes
 * - Cryptographic proof of when changes occurred
 * - No single point of failure (replicated across Solana validators)
 */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { gzip, ungzip } from 'pako';
import * as fs from 'fs/promises';
import * as path from 'path';

import type { StorageBackend } from '../behavioral/IdentityPersistence';

// Memo program ID (Solana's built-in memo program)
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

// Protocol identifier for our memos
const PROTOCOL_ID = 'persistence:kv:v1';

// Max memo size (conservative estimate)
const MAX_MEMO_SIZE = 500;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Off-chain storage backend interface.
 * Implement this to use custom storage (Redis, S3, etc.)
 */
export interface OffChainStorage {
  store(hash: string, data: string): Promise<void>;
  retrieve(hash: string): Promise<string | null>;
  exists(hash: string): Promise<boolean>;
  delete(hash: string): Promise<void>;
}

export interface SolanaStorageBackendConfig {
  /** Solana connection */
  connection: Connection;
  /** Keypair for signing transactions */
  payer: Keypair;
  /** Namespace prefix for keys (e.g., agent DID) */
  namespace: string;
  /** Commitment level (confirmed or finalized only for reads) */
  commitment?: 'confirmed' | 'finalized';
  /** Whether to compress values */
  compress?: boolean;
  /**
   * Off-chain storage directory (for file-based storage).
   * Required for persistent off-chain data.
   * If not provided, off-chain data will only be cached in memory.
   */
  offChainDir?: string;
  /**
   * Custom off-chain storage backend.
   * If provided, overrides file-based storage.
   */
  offChainBackend?: OffChainStorage;
}

/**
 * Result of storing data with off-chain commitment.
 */
export interface OffChainCommitment {
  /** SHA256 hash of the data (stored on-chain) */
  hash: string;
  /** Solana transaction signature */
  solanaTx: string;
  /** Key used for retrieval */
  key: string;
}

interface MemoRecord {
  protocol: string;
  namespace: string;
  key: string;
  op: 'set' | 'delete';
  value?: string;  // Base64-encoded (possibly compressed)
  compressed?: boolean;
  timestamp: number;
  seq: number;  // Sequence number for ordering
}

// =============================================================================
// SOLANA STORAGE BACKEND
// =============================================================================

export class SolanaStorageBackend implements StorageBackend {
  private readonly connection: Connection;
  private readonly payer: Keypair;
  private readonly namespace: string;
  private readonly commitment: 'confirmed' | 'finalized';
  private readonly compress: boolean;
  private readonly offChainDir: string | null;
  private readonly offChainBackend: OffChainStorage | null;
  private sequence: number = 0;

  // Local cache to avoid re-fetching unchanged data
  private cache: Map<string, { value: unknown; seq: number }> = new Map();

  // Hash-to-key index for recovery
  private hashIndex: Map<string, string> = new Map();

  constructor(config: SolanaStorageBackendConfig) {
    this.connection = config.connection;
    this.payer = config.payer;
    this.namespace = config.namespace;
    this.commitment = config.commitment || 'confirmed';
    this.compress = config.compress ?? true;
    this.offChainDir = config.offChainDir || null;
    this.offChainBackend = config.offChainBackend || null;

    // Initialize off-chain storage directory if provided
    if (this.offChainDir) {
      this.initOffChainDir().catch(err => {
        console.error('[SolanaStorage] Failed to initialize off-chain directory:', err);
      });
    }
  }

  /**
   * Initialize the off-chain storage directory.
   */
  private async initOffChainDir(): Promise<void> {
    if (!this.offChainDir) return;

    try {
      await fs.mkdir(this.offChainDir, { recursive: true });

      // Load hash index if it exists
      const indexPath = path.join(this.offChainDir, '_hash_index.json');
      try {
        const indexData = await fs.readFile(indexPath, 'utf-8');
        const index = JSON.parse(indexData);
        this.hashIndex = new Map(Object.entries(index));
        console.log(`[SolanaStorage] Loaded ${this.hashIndex.size} hash entries from index`);
      } catch {
        // Index doesn't exist yet, that's fine
      }
    } catch (err) {
      console.error('[SolanaStorage] Failed to create off-chain directory:', err);
      throw err;
    }
  }

  /**
   * Save the hash index to disk.
   */
  private async saveHashIndex(): Promise<void> {
    if (!this.offChainDir) return;

    const indexPath = path.join(this.offChainDir, '_hash_index.json');
    const indexData = JSON.stringify(Object.fromEntries(this.hashIndex));
    await fs.writeFile(indexPath, indexData, 'utf-8');
  }

  /**
   * Get a value from Solana storage.
   * Automatically handles both on-chain and off-chain data.
   */
  async get<T>(key: string): Promise<T | null> {
    // Check cache first
    const cached = this.cache.get(key);
    if (cached) {
      return cached.value as T;
    }

    // Fetch from chain
    const records = await this.fetchRecords();

    // Find latest record for this key
    const keyRecords = records
      .filter(r => r.key === key)
      .sort((a, b) => b.seq - a.seq);

    if (keyRecords.length === 0) {
      return null;
    }

    const latest = keyRecords[0];

    // Check if deleted
    if (latest.op === 'delete') {
      return null;
    }

    let value: T;

    // Check if this is an off-chain reference
    if (latest.value?.startsWith('offchain:')) {
      const hash = latest.value.replace('offchain:', '');
      const json = await this.retrieveOffChain(hash);

      if (!json) {
        console.error(`[SolanaStorage] Off-chain data not found for hash: ${hash}`);
        return null;
      }

      // Parse the stored record (which contains the original value)
      const storedRecord = JSON.parse(json) as MemoRecord;
      value = this.decodeValue<T>(storedRecord.value!, storedRecord.compressed);
    } else {
      // Decode inline value
      value = this.decodeValue<T>(latest.value!, latest.compressed);
    }

    // Cache it
    this.cache.set(key, { value, seq: latest.seq });

    return value;
  }

  /**
   * Set a value in Solana storage.
   */
  async set<T>(key: string, value: T): Promise<void> {
    this.sequence++;

    const encodedValue = this.encodeValue(value);

    const record: MemoRecord = {
      protocol: PROTOCOL_ID,
      namespace: this.namespace,
      key,
      op: 'set',
      value: encodedValue.data,
      compressed: encodedValue.compressed,
      timestamp: Date.now(),
      seq: this.sequence,
    };

    await this.writeMemo(record);

    // Update cache
    this.cache.set(key, { value, seq: this.sequence });

    console.log(`[SolanaStorage] Committed ${key} to chain (seq: ${this.sequence})`);
  }

  /**
   * Delete a key from Solana storage.
   * Note: This doesn't erase history - it marks the key as deleted.
   */
  async delete(key: string): Promise<void> {
    this.sequence++;

    const record: MemoRecord = {
      protocol: PROTOCOL_ID,
      namespace: this.namespace,
      key,
      op: 'delete',
      timestamp: Date.now(),
      seq: this.sequence,
    };

    await this.writeMemo(record);

    // Remove from cache
    this.cache.delete(key);

    console.log(`[SolanaStorage] Deleted ${key} from chain (seq: ${this.sequence})`);
  }

  /**
   * Get all keys matching a pattern.
   */
  async keys(pattern?: string): Promise<string[]> {
    const records = await this.fetchRecords();

    // Build current state of keys
    const keyState = new Map<string, 'set' | 'delete'>();

    for (const record of records.sort((a, b) => a.seq - b.seq)) {
      keyState.set(record.key, record.op);
    }

    // Filter to non-deleted keys
    let keys = Array.from(keyState.entries())
      .filter(([_, op]) => op === 'set')
      .map(([key]) => key);

    // Apply pattern filter
    if (pattern && pattern !== '*') {
      const regex = new RegExp(pattern.replace(/\*/g, '.*'));
      keys = keys.filter(k => regex.test(k));
    }

    return keys;
  }

  /**
   * Returns true - Solana storage is persistent and immutable.
   */
  isPersistent(): boolean {
    return true;
  }

  // ===========================================================================
  // OFF-CHAIN STORAGE METHODS
  // ===========================================================================

  /**
   * Store data off-chain with only a hash commitment on-chain.
   *
   * Use this for:
   * - ActionLog content (private, trainable)
   * - Decision reasoning (sensitive context)
   * - Full interaction logs (training corpus)
   *
   * The full data is stored off-chain (file or custom backend).
   * Only the SHA256 hash is committed to Solana.
   *
   * @param key - Storage key
   * @param value - Data to store
   * @returns Hash and Solana transaction signature
   */
  async setOffChainWithCommitment<T>(key: string, value: T): Promise<OffChainCommitment> {
    const { sha256 } = await import('@noble/hashes/sha256');
    const { bytesToHex } = await import('@noble/hashes/utils');

    // Serialize the value
    const json = JSON.stringify(value);

    // Compute hash
    const hash = bytesToHex(sha256(json));

    // Store full data off-chain
    await this.storeOffChain(hash, json);

    // Update hash index
    this.hashIndex.set(hash, key);
    await this.saveHashIndex();

    // Store only hash on-chain
    this.sequence++;
    const record: MemoRecord = {
      protocol: PROTOCOL_ID,
      namespace: this.namespace,
      key,
      op: 'set',
      value: `offchain:${hash}`,
      compressed: false,
      timestamp: Date.now(),
      seq: this.sequence,
    };

    const solanaTx = await this.writeMemoRaw(JSON.stringify(record));

    // Update cache with full value
    this.cache.set(key, { value, seq: this.sequence });

    console.log(`[SolanaStorage] Stored ${key} off-chain with hash commitment (${hash.slice(0, 16)}...)`);

    return { hash, solanaTx, key };
  }

  /**
   * Retrieve data that was stored off-chain.
   *
   * First checks the on-chain record for the hash,
   * then retrieves the full data from off-chain storage.
   *
   * @param key - Storage key
   * @returns The stored value, or null if not found
   */
  async getOffChain<T>(key: string): Promise<T | null> {
    // Check cache first
    const cached = this.cache.get(key);
    if (cached) {
      return cached.value as T;
    }

    // Fetch from chain to get the hash
    const records = await this.fetchRecords();
    const keyRecords = records
      .filter(r => r.key === key)
      .sort((a, b) => b.seq - a.seq);

    if (keyRecords.length === 0) {
      return null;
    }

    const latest = keyRecords[0];

    if (latest.op === 'delete') {
      return null;
    }

    // Check if this is an off-chain reference
    if (!latest.value?.startsWith('offchain:')) {
      // Not off-chain, fall back to regular get
      return this.get<T>(key);
    }

    // Extract hash
    const hash = latest.value.replace('offchain:', '');

    // Retrieve from off-chain storage
    const json = await this.retrieveOffChain(hash);
    if (!json) {
      console.error(`[SolanaStorage] Off-chain data not found for hash: ${hash}`);
      return null;
    }

    const value = JSON.parse(json) as T;

    // Cache it
    this.cache.set(key, { value, seq: latest.seq });

    return value;
  }

  /**
   * Retrieve off-chain data directly by hash.
   * Useful for recovery when you have the on-chain hash but lost the key mapping.
   *
   * @param hash - SHA256 hash of the data
   * @returns The stored data, or null if not found
   */
  async getByHash<T>(hash: string): Promise<T | null> {
    const json = await this.retrieveOffChain(hash);
    if (!json) {
      return null;
    }
    return JSON.parse(json) as T;
  }

  /**
   * Verify that off-chain data matches its on-chain hash.
   *
   * @param key - Storage key
   * @returns True if data matches hash, false otherwise
   */
  async verifyOffChain(key: string): Promise<boolean> {
    const { sha256 } = await import('@noble/hashes/sha256');
    const { bytesToHex } = await import('@noble/hashes/utils');

    // Get the on-chain record
    const records = await this.fetchRecords();
    const keyRecords = records
      .filter(r => r.key === key)
      .sort((a, b) => b.seq - a.seq);

    if (keyRecords.length === 0) {
      return false;
    }

    const latest = keyRecords[0];

    if (!latest.value?.startsWith('offchain:')) {
      // Not an off-chain record
      return false;
    }

    const expectedHash = latest.value.replace('offchain:', '');

    // Retrieve off-chain data
    const json = await this.retrieveOffChain(expectedHash);
    if (!json) {
      console.error(`[SolanaStorage] Cannot verify - off-chain data missing for hash: ${expectedHash}`);
      return false;
    }

    // Compute actual hash
    const actualHash = bytesToHex(sha256(json));

    const matches = actualHash === expectedHash;
    if (!matches) {
      console.error(`[SolanaStorage] Hash mismatch! Expected: ${expectedHash}, Actual: ${actualHash}`);
    }

    return matches;
  }

  /**
   * Store data in off-chain storage.
   */
  private async storeOffChain(hash: string, data: string): Promise<void> {
    // Use custom backend if provided
    if (this.offChainBackend) {
      await this.offChainBackend.store(hash, data);
      return;
    }

    // Use file-based storage
    if (this.offChainDir) {
      const filePath = path.join(this.offChainDir, `${hash}.json`);
      await fs.writeFile(filePath, data, 'utf-8');
      return;
    }

    // Fall back to in-memory cache only (with warning)
    console.warn('[SolanaStorage] No off-chain storage configured! Data will be lost on restart.');
    this.cache.set(`offchain:${hash}`, { value: data, seq: 0 });
  }

  /**
   * Retrieve data from off-chain storage.
   */
  private async retrieveOffChain(hash: string): Promise<string | null> {
    // Use custom backend if provided
    if (this.offChainBackend) {
      return this.offChainBackend.retrieve(hash);
    }

    // Use file-based storage
    if (this.offChainDir) {
      const filePath = path.join(this.offChainDir, `${hash}.json`);
      try {
        return await fs.readFile(filePath, 'utf-8');
      } catch {
        return null;
      }
    }

    // Fall back to in-memory cache
    const cached = this.cache.get(`offchain:${hash}`);
    return cached ? (cached.value as string) : null;
  }

  /**
   * Check if off-chain data exists for a hash.
   */
  async hasOffChainData(hash: string): Promise<boolean> {
    if (this.offChainBackend) {
      return this.offChainBackend.exists(hash);
    }

    if (this.offChainDir) {
      const filePath = path.join(this.offChainDir, `${hash}.json`);
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    }

    return this.cache.has(`offchain:${hash}`);
  }

  /**
   * Get the key associated with a hash (from the index).
   */
  getKeyForHash(hash: string): string | undefined {
    return this.hashIndex.get(hash);
  }

  /**
   * Rebuild the hash index from on-chain records.
   * Useful for recovery after losing the local index.
   */
  async rebuildHashIndex(): Promise<number> {
    const records = await this.fetchRecords();
    let count = 0;

    for (const record of records) {
      if (record.value?.startsWith('offchain:')) {
        const hash = record.value.replace('offchain:', '');
        this.hashIndex.set(hash, record.key);
        count++;
      }
    }

    await this.saveHashIndex();
    console.log(`[SolanaStorage] Rebuilt hash index with ${count} entries`);

    return count;
  }

  // ===========================================================================
  // INTERNAL METHODS
  // ===========================================================================

  /**
   * Encode a value for storage.
   */
  private encodeValue<T>(value: T): { data: string; compressed: boolean } {
    const json = JSON.stringify(value);

    // Try compression if enabled and value is large
    if (this.compress && json.length > 200) {
      try {
        const compressed = gzip(json);
        const base64 = Buffer.from(compressed).toString('base64');

        // Only use compression if it actually helps
        if (base64.length < json.length) {
          return { data: base64, compressed: true };
        }
      } catch (err) {
        console.warn('[SolanaStorage] Compression failed, using raw:', err);
      }
    }

    // Use raw JSON (base64 encoded for safety)
    return { data: Buffer.from(json).toString('base64'), compressed: false };
  }

  /**
   * Decode a value from storage.
   */
  private decodeValue<T>(data: string, compressed?: boolean): T {
    const buffer = Buffer.from(data, 'base64');

    if (compressed) {
      const decompressed = ungzip(buffer);
      const json = new TextDecoder().decode(decompressed);
      return JSON.parse(json);
    }

    return JSON.parse(buffer.toString());
  }

  /**
   * Write a memo record to Solana.
   */
  private async writeMemo(record: MemoRecord): Promise<string> {
    const memoData = JSON.stringify(record);

    // Check size
    if (memoData.length > MAX_MEMO_SIZE) {
      // For large data, store full content off-chain with hash commitment on-chain
      console.warn(`[SolanaStorage] Data too large (${memoData.length} bytes), storing off-chain with hash commitment`);

      const { sha256 } = await import('@noble/hashes/sha256');
      const { bytesToHex } = await import('@noble/hashes/utils');
      const hash = bytesToHex(sha256(memoData));

      // Store full data to persistent off-chain storage
      await this.storeOffChain(hash, memoData);

      // Update hash index
      this.hashIndex.set(hash, record.key);
      await this.saveHashIndex();

      const hashRecord: MemoRecord = {
        ...record,
        value: `offchain:${hash}`,
        compressed: false,
      };

      return this.writeMemoRaw(JSON.stringify(hashRecord));
    }

    return this.writeMemoRaw(memoData);
  }

  /**
   * Write raw memo data to Solana.
   */
  private async writeMemoRaw(data: string): Promise<string> {
    const memoInstruction = new TransactionInstruction({
      keys: [{ pubkey: this.payer.publicKey, isSigner: true, isWritable: false }],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(data, 'utf-8'),
    });

    const transaction = new Transaction().add(memoInstruction);

    const signature = await sendAndConfirmTransaction(
      this.connection,
      transaction,
      [this.payer],
      { commitment: this.commitment }
    );

    return signature;
  }

  /**
   * Fetch all records for this namespace from Solana.
   */
  private async fetchRecords(): Promise<MemoRecord[]> {
    const signatures = await this.connection.getSignaturesForAddress(
      this.payer.publicKey,
      { limit: 1000 },
      this.commitment
    );

    const records: MemoRecord[] = [];

    for (const sigInfo of signatures) {
      try {
        const tx = await this.connection.getTransaction(sigInfo.signature, {
          commitment: this.commitment,
          maxSupportedTransactionVersion: 0,
        });

        if (!tx?.meta?.logMessages) continue;

        // Parse memo from logs
        for (const log of tx.meta.logMessages) {
          if (log.startsWith('Program log: Memo')) {
            // Extract memo content - it's logged after the instruction
            continue;
          }

          // Try to parse as JSON
          try {
            // The memo content appears in logs in various formats
            // Check if this looks like our protocol
            if (log.includes(PROTOCOL_ID)) {
              // Extract JSON from the log
              const jsonMatch = log.match(/\{.*\}/);
              if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]) as MemoRecord;
                if (parsed.protocol === PROTOCOL_ID && parsed.namespace === this.namespace) {
                  records.push(parsed);
                }
              }
            }
          } catch {
            // Not our format
          }
        }

        // Also check the transaction data directly
        if (tx.transaction?.message) {
          const instructions = tx.transaction.message.compiledInstructions || [];
          for (const ix of instructions) {
            try {
              const data = Buffer.from(ix.data).toString('utf-8');
              if (data.includes(PROTOCOL_ID)) {
                const parsed = JSON.parse(data) as MemoRecord;
                if (parsed.protocol === PROTOCOL_ID && parsed.namespace === this.namespace) {
                  // Avoid duplicates
                  if (!records.some(r => r.seq === parsed.seq && r.key === parsed.key)) {
                    records.push(parsed);
                  }
                }
              }
            } catch {
              // Not our format
            }
          }
        }
      } catch (err) {
        // Skip failed fetches
      }
    }

    return records;
  }

  /**
   * Get storage statistics.
   */
  async getStats(): Promise<{
    totalRecords: number;
    activeKeys: number;
    oldestRecord: number | null;
    newestRecord: number | null;
  }> {
    const records = await this.fetchRecords();
    const activeKeys = (await this.keys()).length;

    const timestamps = records.map(r => r.timestamp).sort((a, b) => a - b);

    return {
      totalRecords: records.length,
      activeKeys,
      oldestRecord: timestamps[0] || null,
      newestRecord: timestamps[timestamps.length - 1] || null,
    };
  }

  /**
   * Clear the local cache.
   */
  clearCache(): void {
    this.cache.clear();
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createSolanaStorageBackend(
  config: SolanaStorageBackendConfig
): SolanaStorageBackend {
  return new SolanaStorageBackend(config);
}

export default SolanaStorageBackend;
