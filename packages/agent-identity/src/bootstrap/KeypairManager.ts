/**
 * KeypairManager.ts
 *
 * Secure keypair generation and storage for agent identity.
 *
 * Handles:
 * - Ed25519 keypair generation
 * - Secure local storage (encrypted)
 * - Environment variable loading
 * - File-based persistence
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import bs58 from 'bs58';

// =============================================================================
// TYPES
// =============================================================================

export interface StoredKeypair {
  publicKey: string;
  encryptedSecretKey?: string;
  secretKey?: string; // Only for unencrypted storage (dev mode)
  network: 'devnet' | 'mainnet';
  createdAt: string;
  did: string;
}

export interface KeypairManagerConfig {
  /** Directory to store identity files */
  storageDir: string;
  /** Whether to encrypt stored keys */
  encrypt: boolean;
  /** Encryption password (required if encrypt=true) */
  password?: string;
  /** Network (devnet or mainnet) */
  network: 'devnet' | 'mainnet';
}

const DEFAULT_CONFIG: KeypairManagerConfig = {
  storageDir: '.agent-identity',
  encrypt: true, // ALWAYS encrypt private keys
  network: 'devnet',
};

// =============================================================================
// MACHINE-DERIVED PASSWORD
// =============================================================================

/**
 * Derive a machine-specific password for encrypting keys.
 *
 * This uses multiple system fingerprints to create a password that:
 * - Is unique to this machine
 * - Cannot be easily guessed
 * - Survives across reboots
 *
 * For additional security, users can set PERSISTENCE_AGENT_PASSWORD env var.
 */
function deriveMachinePassword(): string {
  // Check for explicit password first
  const envPassword = process.env.PERSISTENCE_AGENT_PASSWORD;
  if (envPassword) {
    return envPassword;
  }

  // Derive from machine characteristics
  const os = require('os');
  const fingerprints = [
    os.hostname(),
    os.homedir(),
    os.platform(),
    os.arch(),
    // CPU info (stable across reboots)
    JSON.stringify(os.cpus()[0]?.model || 'unknown'),
    // Network interface MAC addresses (stable)
    Object.values(os.networkInterfaces())
      .flat()
      .filter((iface: any) => !iface?.internal && iface?.mac)
      .map((iface: any) => iface.mac)
      .sort()
      .join(','),
  ].join('|');

  // Hash the fingerprints to create a stable password
  const hash = crypto.createHash('sha256').update(fingerprints).digest('hex');

  // Add a static salt to make rainbow tables useless
  const salted = `persistence-agent-v1:${hash}`;
  return crypto.createHash('sha256').update(salted).digest('base64');
}

// =============================================================================
// DID GENERATION
// =============================================================================

/**
 * Generate a did:persistence DID from a public key.
 *
 * Format: did:persistence:<network>:<base58-public-key>
 */
export function publicKeyToDid(publicKey: PublicKey, network: 'devnet' | 'mainnet'): string {
  return `did:persistence:${network}:${publicKey.toBase58()}`;
}

/**
 * Parse a did:persistence DID back to components.
 */
export function parseDid(did: string): {
  method: string;
  network: 'devnet' | 'mainnet';
  publicKey: string;
} | null {
  const match = did.match(/^did:persistence:(devnet|mainnet):([1-9A-HJ-NP-Za-km-z]+)$/);
  if (!match) return null;

  return {
    method: 'persistence',
    network: match[1] as 'devnet' | 'mainnet',
    publicKey: match[2],
  };
}

// =============================================================================
// ENCRYPTION
// =============================================================================

function encryptSecretKey(secretKey: Uint8Array, password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(secretKey)),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return JSON.stringify({
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    data: encrypted.toString('hex'),
  });
}

function decryptSecretKey(encryptedData: string, password: string): Uint8Array {
  const { salt, iv, authTag, data } = JSON.parse(encryptedData);

  const key = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 32);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(iv, 'hex')
  );

  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(data, 'hex')),
    decipher.final(),
  ]);

  return new Uint8Array(decrypted);
}

// =============================================================================
// KEYPAIR MANAGER
// =============================================================================

export class KeypairManager {
  private readonly config: KeypairManagerConfig;
  private keypair: Keypair | null = null;
  private did: string | null = null;

  constructor(config: Partial<KeypairManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Auto-derive password if encryption enabled and no password provided
    if (this.config.encrypt && !this.config.password) {
      this.config.password = deriveMachinePassword();
    }

    // Warn if someone explicitly disables encryption
    if (!this.config.encrypt) {
      console.warn('[KeypairManager] ⚠️  WARNING: Encryption disabled. Private keys will be stored in PLAINTEXT.');
      console.warn('[KeypairManager] ⚠️  This is a security risk. Set encrypt: true in production.');
    }
  }

  /**
   * Get the storage file path.
   */
  private getStoragePath(): string {
    return path.join(this.config.storageDir, `${this.config.network}.json`);
  }

  /**
   * Ensure storage directory exists.
   */
  private ensureStorageDir(): void {
    if (!fs.existsSync(this.config.storageDir)) {
      fs.mkdirSync(this.config.storageDir, { recursive: true });

      // Add .gitignore to prevent accidental commits
      const gitignorePath = path.join(this.config.storageDir, '.gitignore');
      fs.writeFileSync(gitignorePath, '*\n!.gitignore\n');
    }
  }

  /**
   * Check if a stored identity exists.
   */
  exists(): boolean {
    return fs.existsSync(this.getStoragePath());
  }

  /**
   * Load existing keypair from storage or environment.
   *
   * If a plaintext key is found and encryption is enabled,
   * automatically migrates to encrypted storage.
   */
  load(): Keypair | null {
    // First, try environment variable
    const envKey = process.env.PERSISTENCE_AGENT_SECRET_KEY;
    if (envKey) {
      try {
        this.keypair = Keypair.fromSecretKey(bs58.decode(envKey));
        this.did = publicKeyToDid(this.keypair.publicKey, this.config.network);
        console.log(`[KeypairManager] Loaded from environment: ${this.did}`);
        return this.keypair;
      } catch (error) {
        console.warn('[KeypairManager] Invalid PERSISTENCE_AGENT_SECRET_KEY, trying file storage');
      }
    }

    // Then, try file storage
    const storagePath = this.getStoragePath();
    if (!fs.existsSync(storagePath)) {
      return null;
    }

    try {
      const stored: StoredKeypair = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));

      let secretKey: Uint8Array;
      let needsMigration = false;

      if (stored.encryptedSecretKey) {
        // Decrypt with auto-derived password if none provided
        const password = this.config.password || deriveMachinePassword();
        secretKey = decryptSecretKey(stored.encryptedSecretKey, password);
      } else if (stored.secretKey) {
        // PLAINTEXT KEY FOUND - load it but flag for migration
        console.warn('[KeypairManager] ⚠️  Found PLAINTEXT secret key in storage');
        secretKey = bs58.decode(stored.secretKey);
        needsMigration = this.config.encrypt;
      } else {
        throw new Error('No secret key found in stored keypair');
      }

      this.keypair = Keypair.fromSecretKey(secretKey);
      this.did = stored.did;

      // Verify the stored DID matches
      const expectedDid = publicKeyToDid(this.keypair.publicKey, this.config.network);
      if (this.did !== expectedDid) {
        console.warn(`[KeypairManager] DID mismatch, updating to ${expectedDid}`);
        this.did = expectedDid;
      }

      // Auto-migrate plaintext to encrypted
      if (needsMigration) {
        console.log('[KeypairManager] Auto-migrating to encrypted storage...');
        this.migrateToEncrypted();
      }

      console.log(`[KeypairManager] Loaded from storage: ${this.did}`);
      return this.keypair;
    } catch (error) {
      console.error('[KeypairManager] Failed to load keypair:', error);
      return null;
    }
  }

  /**
   * Generate a new keypair.
   */
  generate(): Keypair {
    this.keypair = Keypair.generate();
    this.did = publicKeyToDid(this.keypair.publicKey, this.config.network);

    console.log(`[KeypairManager] Generated new keypair: ${this.did}`);
    return this.keypair;
  }

  /**
   * Save the current keypair to storage.
   *
   * By default, the secret key is encrypted using a machine-derived password.
   * This prevents plaintext exposure of private keys.
   */
  save(): void {
    if (!this.keypair || !this.did) {
      throw new Error('No keypair to save');
    }

    this.ensureStorageDir();

    const stored: StoredKeypair = {
      publicKey: this.keypair.publicKey.toBase58(),
      network: this.config.network,
      createdAt: new Date().toISOString(),
      did: this.did,
    };

    // Always prefer encryption
    if (this.config.encrypt) {
      // Password should always be available (auto-derived if not provided)
      const password = this.config.password || deriveMachinePassword();
      stored.encryptedSecretKey = encryptSecretKey(
        this.keypair.secretKey,
        password
      );
      console.log(`[KeypairManager] Saved encrypted keypair to ${this.getStoragePath()}`);
    } else {
      // Explicit plaintext storage (warn loudly)
      console.warn('[KeypairManager] ⚠️  SECURITY RISK: Storing secret key in PLAINTEXT');
      stored.secretKey = bs58.encode(this.keypair.secretKey);
      console.log(`[KeypairManager] Saved to ${this.getStoragePath()}`);
    }

    fs.writeFileSync(this.getStoragePath(), JSON.stringify(stored, null, 2));
  }

  /**
   * Migrate a plaintext stored key to encrypted storage.
   * Call this to upgrade existing unencrypted keys.
   */
  migrateToEncrypted(): boolean {
    if (!this.keypair || !this.did) {
      console.warn('[KeypairManager] No keypair loaded to migrate');
      return false;
    }

    const storagePath = this.getStoragePath();
    if (!fs.existsSync(storagePath)) {
      return false;
    }

    try {
      const stored: StoredKeypair = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));

      // Check if already encrypted
      if (stored.encryptedSecretKey && !stored.secretKey) {
        console.log('[KeypairManager] Already encrypted');
        return true;
      }

      // Migrate to encrypted
      console.log('[KeypairManager] Migrating to encrypted storage...');
      const password = this.config.password || deriveMachinePassword();

      const migrated: StoredKeypair = {
        publicKey: stored.publicKey,
        encryptedSecretKey: encryptSecretKey(this.keypair.secretKey, password),
        network: stored.network,
        createdAt: stored.createdAt,
        did: stored.did,
      };

      // Write migrated file
      fs.writeFileSync(storagePath, JSON.stringify(migrated, null, 2));
      console.log('[KeypairManager] ✅ Migrated to encrypted storage');
      return true;
    } catch (error) {
      console.error('[KeypairManager] Migration failed:', error);
      return false;
    }
  }

  /**
   * Get the current keypair.
   */
  getKeypair(): Keypair | null {
    return this.keypair;
  }

  /**
   * Get the current DID.
   */
  getDid(): string | null {
    return this.did;
  }

  /**
   * Get the public key.
   */
  getPublicKey(): PublicKey | null {
    return this.keypair?.publicKey ?? null;
  }

  /**
   * Load or generate keypair (convenience method).
   */
  loadOrGenerate(): Keypair {
    const existing = this.load();
    if (existing) {
      return existing;
    }

    const generated = this.generate();
    this.save();
    return generated;
  }

  /**
   * Export secret key as base58 (for environment variable).
   */
  exportSecretKey(): string | null {
    if (!this.keypair) return null;
    return bs58.encode(this.keypair.secretKey);
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createKeypairManager(
  config?: Partial<KeypairManagerConfig>
): KeypairManager {
  return new KeypairManager(config);
}

export default {
  KeypairManager,
  createKeypairManager,
  publicKeyToDid,
  parseDid,
};
