/**
 * encryption.ts
 *
 * Shared AES-256-GCM encryption module.
 *
 * Extracted from KeypairManager to be reusable across:
 * - KeypairManager (private key encryption)
 * - PrivateStorage (optional ActionLog encryption)
 * - Any future component needing at-rest encryption
 *
 * Security properties:
 * - AES-256-GCM provides confidentiality + integrity
 * - scrypt key derivation (N=2^14, r=8, p=1) for password hardening
 * - Random 16-byte salt and IV per encryption
 * - Auth tag prevents tampering
 */

import * as crypto from 'crypto';

// =============================================================================
// SCRYPT PARAMETERS — PINNED
// =============================================================================

/**
 * Explicit scrypt parameters. These MUST NOT change — doing so would
 * silently produce different derived keys, making all previously encrypted
 * data unrecoverable. Node.js does not guarantee stable defaults across
 * major versions.
 *
 * Values match Node.js built-in defaults (N=16384, r=8, p=1).
 * Memory: 128 * N * r * p = 16 MB, well within the 32 MB maxmem limit.
 *
 * Security note: N=2^14 is below OWASP 2023 minimum (N=2^17) for password
 * hashing. This is acceptable here because the input is either a high-entropy
 * machine-derived password (auto-generated) or PERSISTENCE_AGENT_PASSWORD
 * (user-chosen, documented as requiring sufficient entropy). If the input
 * entropy claim cannot be guaranteed, consider bumping to N=2^15 with
 * maxmem: 64 * 1024 * 1024 (~80ms additional latency).
 */
const SCRYPT_PARAMS = { N: 2 ** 14, r: 8, p: 1 } as const;

// =============================================================================
// TYPES
// =============================================================================

export interface EncryptedPayload {
  salt: string;
  iv: string;
  authTag: string;
  data: string;
}

// =============================================================================
// CORE ENCRYPTION
// =============================================================================

/**
 * Encrypt data with AES-256-GCM using a password.
 *
 * @param plaintext - Data to encrypt
 * @param password - Encryption password
 * @returns JSON-serialized encrypted payload
 */
export function encrypt(plaintext: Uint8Array, password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32, SCRYPT_PARAMS);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plaintext)),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  const payload: EncryptedPayload = {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    data: encrypted.toString('hex'),
  };

  return JSON.stringify(payload);
}

/**
 * Decrypt AES-256-GCM encrypted data.
 *
 * @param encryptedData - JSON-serialized encrypted payload
 * @param password - Decryption password
 * @returns Decrypted data
 * @throws If password is wrong or data is corrupted
 */
export function decrypt(encryptedData: string, password: string): Uint8Array {
  const { salt, iv, authTag, data }: EncryptedPayload = JSON.parse(encryptedData);

  const key = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 32, SCRYPT_PARAMS);
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

/**
 * Encrypt a UTF-8 string.
 */
export function encryptString(plaintext: string, password: string): string {
  return encrypt(new TextEncoder().encode(plaintext), password);
}

/**
 * Decrypt to a UTF-8 string.
 */
export function decryptString(encryptedData: string, password: string): string {
  return new TextDecoder().decode(decrypt(encryptedData, password));
}

/**
 * Check if a string looks like an encrypted payload.
 */
export function isEncrypted(data: string): boolean {
  try {
    const parsed = JSON.parse(data);
    return (
      typeof parsed.salt === 'string' &&
      typeof parsed.iv === 'string' &&
      typeof parsed.authTag === 'string' &&
      typeof parsed.data === 'string'
    );
  } catch {
    return false;
  }
}

// =============================================================================
// MACHINE PASSWORD
// =============================================================================

/**
 * Derive a machine-specific password for encrypting keys.
 *
 * Uses multiple system fingerprints to create a password that:
 * - Is unique to this machine
 * - Cannot be easily guessed
 * - Survives across reboots
 *
 * For additional security, users can set PERSISTENCE_AGENT_PASSWORD env var.
 */
export function deriveMachinePassword(): string {
  const envPassword = process.env.PERSISTENCE_AGENT_PASSWORD;
  if (envPassword) {
    return envPassword;
  }

  const os = require('os');
  const fingerprints = [
    os.hostname(),
    os.homedir(),
    os.platform(),
    os.arch(),
    JSON.stringify(os.cpus()[0]?.model || 'unknown'),
    Object.values(os.networkInterfaces())
      .flat()
      .filter((iface: any) => !iface?.internal && iface?.mac)
      .map((iface: any) => iface.mac)
      .sort()
      .join(','),
  ].join('|');

  const hash = crypto.createHash('sha256').update(fingerprints).digest('hex');
  const salted = `persistence-agent-v1:${hash}`;
  return crypto.createHash('sha256').update(salted).digest('base64');
}
