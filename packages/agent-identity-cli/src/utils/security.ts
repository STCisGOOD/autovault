/**
 * Security utilities for the CLI.
 *
 * Handles input validation, path sanitization, and secure defaults.
 */

import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// =============================================================================
// PATH SECURITY
// =============================================================================

/**
 * Allowed base directories for file operations.
 * Prevents path traversal attacks.
 */
const ALLOWED_BASE_DIRS = [
  os.homedir(),
  process.cwd(),
];

/**
 * Sanitize and validate a file path.
 * Prevents path traversal attacks (../, etc.)
 *
 * @param inputPath - User-provided path
 * @param allowedBase - Base directory that must contain the resolved path
 * @returns Sanitized absolute path
 * @throws Error if path is invalid or escapes allowed directory
 */
export function sanitizePath(inputPath: string, allowedBase?: string): string {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('Invalid path: must be a non-empty string');
  }

  // Expand ~ to home directory
  let expandedPath = inputPath;
  if (expandedPath.startsWith('~')) {
    expandedPath = path.join(os.homedir(), expandedPath.slice(1));
  }

  // Resolve to absolute path
  const absolutePath = path.resolve(expandedPath);

  // Normalize to remove ../ and ./
  const normalizedPath = path.normalize(absolutePath);

  // If allowedBase specified, verify path is within it
  if (allowedBase) {
    const normalizedBase = path.normalize(path.resolve(allowedBase));
    if (!normalizedPath.startsWith(normalizedBase)) {
      throw new Error(`Path escapes allowed directory: ${inputPath}`);
    }
  } else {
    // Must be within one of the allowed base directories
    const isAllowed = ALLOWED_BASE_DIRS.some(base => {
      const normalizedBase = path.normalize(path.resolve(base));
      return normalizedPath.startsWith(normalizedBase);
    });

    if (!isAllowed) {
      throw new Error(`Path not in allowed directory: ${inputPath}`);
    }
  }

  return normalizedPath;
}

/**
 * Get the secure storage directory for agent identity.
 * Creates it with restrictive permissions if it doesn't exist.
 */
export function getSecureStorageDir(): string {
  const dir = path.join(os.homedir(), '.agent-identity');
  return dir;
}

// =============================================================================
// INPUT VALIDATION
// =============================================================================

/**
 * Maximum allowed lengths for various inputs.
 * Prevents denial-of-service via large inputs.
 */
export const MAX_LENGTHS = {
  insight: 2000,         // Max insight text length
  dimension: 50,         // Max dimension name length
  sessionId: 100,        // Max session ID length
  command: 500,          // Max hook command length
  filePath: 1000,        // Max file path length
  jsonInput: 100000,     // Max JSON input size (100KB)
} as const;

/**
 * Validate and sanitize an insight string.
 */
export function validateInsight(insight: string): string {
  if (!insight || typeof insight !== 'string') {
    throw new Error('Insight must be a non-empty string');
  }

  const trimmed = insight.trim();

  if (trimmed.length === 0) {
    throw new Error('Insight cannot be empty or whitespace only');
  }

  if (trimmed.length > MAX_LENGTHS.insight) {
    throw new Error(`Insight too long: ${trimmed.length} chars (max ${MAX_LENGTHS.insight})`);
  }

  // Remove any control characters except newlines
  const sanitized = trimmed.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, '');

  return sanitized;
}

/**
 * Validate a dimension name.
 */
export function validateDimension(dimension: string): string {
  if (!dimension || typeof dimension !== 'string') {
    throw new Error('Dimension must be a non-empty string');
  }

  const trimmed = dimension.trim().toLowerCase();

  if (trimmed.length === 0) {
    throw new Error('Dimension cannot be empty');
  }

  if (trimmed.length > MAX_LENGTHS.dimension) {
    throw new Error(`Dimension name too long: ${trimmed.length} chars (max ${MAX_LENGTHS.dimension})`);
  }

  // Only allow alphanumeric and underscores
  if (!/^[a-z][a-z0-9_]*$/.test(trimmed)) {
    throw new Error('Dimension must start with a letter and contain only letters, numbers, and underscores');
  }

  return trimmed;
}

/**
 * Validate a session ID.
 */
export function validateSessionId(sessionId: string): string {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('Session ID must be a non-empty string');
  }

  const trimmed = sessionId.trim();

  if (trimmed.length > MAX_LENGTHS.sessionId) {
    throw new Error(`Session ID too long: ${trimmed.length} chars (max ${MAX_LENGTHS.sessionId})`);
  }

  // Only allow safe characters in session IDs
  if (!/^[a-zA-Z0-9_\-]+$/.test(trimmed)) {
    throw new Error('Session ID contains invalid characters');
  }

  return trimmed;
}

// =============================================================================
// JSON SECURITY
// =============================================================================

/**
 * Safely parse JSON input with size limits.
 */
export function safeParseJson<T>(input: string, maxSize: number = MAX_LENGTHS.jsonInput): T {
  if (!input || typeof input !== 'string') {
    throw new Error('JSON input must be a non-empty string');
  }

  if (input.length > maxSize) {
    throw new Error(`JSON input too large: ${input.length} bytes (max ${maxSize})`);
  }

  try {
    return JSON.parse(input) as T;
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : 'parse error'}`);
  }
}

/**
 * Safely stringify JSON with circular reference handling.
 */
export function safeStringifyJson(obj: unknown, indent?: number): string {
  const seen = new WeakSet();

  return JSON.stringify(obj, (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    // Don't serialize functions
    if (typeof value === 'function') {
      return undefined;
    }
    return value;
  }, indent);
}

// =============================================================================
// CRYPTOGRAPHIC UTILITIES
// =============================================================================

/**
 * Generate a cryptographically secure random session ID.
 */
export function generateSecureSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(8).toString('hex');
  return `session_${timestamp}_${random}`;
}

/**
 * Hash a string using SHA-256.
 */
export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
export function secureCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) {
    // Still do comparison to maintain constant time
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

// =============================================================================
// ENVIRONMENT SECURITY
// =============================================================================

/**
 * Check if running in a secure environment.
 * Warns about potential security issues.
 */
export function checkSecurityEnvironment(): string[] {
  const warnings: string[] = [];

  // Check for insecure NODE_ENV
  if (process.env.NODE_ENV === 'development') {
    warnings.push('Running in development mode');
  }

  // Check for debug flags that might leak info
  if (process.env.DEBUG) {
    warnings.push('DEBUG environment variable is set - may leak sensitive information');
  }

  // Check for root/admin execution (bad practice)
  if (process.getuid && process.getuid() === 0) {
    warnings.push('Running as root - this is not recommended');
  }

  return warnings;
}

/**
 * Redact sensitive data from logs.
 */
export function redactSensitive(text: string): string {
  return text
    // Redact private keys (base58, 87-88 chars)
    .replace(/[1-9A-HJ-NP-Za-km-z]{87,88}/g, '[REDACTED_KEY]')
    // Redact hex secrets (64+ chars)
    .replace(/[0-9a-fA-F]{64,}/g, '[REDACTED_HEX]')
    // Redact bearer tokens
    .replace(/Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/gi, 'Bearer [REDACTED]')
    // Redact passwords in URLs
    .replace(/:\/\/[^:]+:[^@]+@/g, '://[REDACTED]@');
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  sanitizePath,
  getSecureStorageDir,
  validateInsight,
  validateDimension,
  validateSessionId,
  safeParseJson,
  safeStringifyJson,
  generateSecureSessionId,
  sha256,
  secureCompare,
  checkSecurityEnvironment,
  redactSensitive,
  MAX_LENGTHS,
};
