/**
 * fileClassifier.ts
 *
 * Classifies files by role (source/test/config) and package membership
 * for trajectory metric tagging (v2.2 spec §10).
 *
 * All paths are normalized to forward slashes before classification.
 */

import type { FileRole } from './types';

// =============================================================================
// FILE ROLE CLASSIFICATION
// =============================================================================

const TEST_PATTERNS = [
  /\.test\./i,
  /\.spec\./i,
  /[\\/]__tests__[\\/]/i,
  /[\\/]test[\\/]/i,
];

const CONFIG_PATTERNS = [
  /\.config\./i,
  /\.rc\./i,
  /[\\/]tsconfig/i,
  /[\\/]package\.json$/i,
  /[\\/]jest\.config/i,
  /[\\/]webpack\.config/i,
  /[\\/]vite\.config/i,
  /[\\/]eslint/i,
  /[\\/]prettier/i,
  /[\\/]\.env/i,
];

/**
 * Classify a file's role based on its path.
 *
 * Rules (in priority order):
 * 1. .test. / .spec. / __tests__/ / test/ → 'test'
 * 2. .config. / .rc. / tsconfig / package.json → 'config'
 * 3. Default → 'source'
 */
export function classifyFileRole(filePath: string): FileRole {
  // Normalize Windows backslashes for consistent matching
  const normalized = filePath.replace(/\\/g, '/');

  if (TEST_PATTERNS.some(p => p.test(normalized))) return 'test';
  if (CONFIG_PATTERNS.some(p => p.test(normalized))) return 'config';
  return 'source';
}

// =============================================================================
// PACKAGE CLASSIFICATION
// =============================================================================

// Cache package roots → regex for performance
let cachedRoots: string[] = [];
let cachedPatterns: Array<{ root: string; regex: RegExp }> = [];

/**
 * Classify which package a file belongs to based on known package roots.
 * Returns the package root directory name, or null if no match.
 */
export function classifyPackage(filePath: string, packageRoots: string[]): string | null {
  if (packageRoots.length === 0) return null;

  const normalized = filePath.replace(/\\/g, '/');

  // Rebuild cache if roots changed
  if (packageRoots !== cachedRoots && !arraysEqual(packageRoots, cachedRoots)) {
    cachedRoots = packageRoots;
    cachedPatterns = packageRoots.map(root => {
      const normalizedRoot = root.replace(/\\/g, '/');
      // Escape regex special chars in path
      const escaped = normalizedRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return { root: normalizedRoot, regex: new RegExp(`^${escaped}`) };
    });
    // Sort by length descending so longest (most specific) match wins
    cachedPatterns.sort((a, b) => b.root.length - a.root.length);
  }

  for (const { root, regex } of cachedPatterns) {
    if (regex.test(normalized)) {
      // Extract package directory name from the root
      const parts = root.replace(/\/$/, '').split('/');
      return parts[parts.length - 1] || null;
    }
  }

  return null;
}

/**
 * Clear the package classification cache (for testing).
 */
export function clearPackageCache(): void {
  cachedRoots = [];
  cachedPatterns = [];
}

// =============================================================================
// HELPERS
// =============================================================================

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
