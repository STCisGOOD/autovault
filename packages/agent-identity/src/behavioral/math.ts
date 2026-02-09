/**
 * math.ts
 *
 * NaN-safe arithmetic utilities for the ARIL pipeline.
 *
 * Every value that crosses a module boundary (OutcomeEvaluator → ShapleyAttributor
 * → ReplicatorOptimizer → GuidanceEngine) must pass through these guards.
 * A single NaN or Infinity anywhere in the chain permanently poisons downstream
 * state (EMA baselines, fitness arrays, meta-learning rates) with no recovery path.
 *
 * These utilities ensure that never happens.
 */

// =============================================================================
// CORE GUARDS
// =============================================================================

/**
 * Returns true if the value is a finite, non-NaN number.
 */
export function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * Coerce a value to a finite number.
 * Returns `fallback` if `x` is NaN, Infinity, -Infinity, undefined, null,
 * or not a number at all.
 */
export function safeFinite(x: unknown, fallback: number = 0): number {
  if (typeof x === 'number' && Number.isFinite(x)) {
    return x;
  }
  return fallback;
}

/**
 * NaN-safe clamp. Returns `fallback` if `x` is not a finite number.
 *
 * Standard clamp: Math.max(min, Math.min(max, NaN)) → NaN  (DANGEROUS)
 * Safe clamp:     safeClamp(NaN, -1, 1) → 0                (SAFE)
 */
export function safeClamp(
  x: number,
  min: number,
  max: number,
  fallback: number = 0,
): number {
  if (!Number.isFinite(x)) return fallback;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return fallback;
  return Math.max(min, Math.min(max, x));
}

/**
 * NaN-safe division. Returns `fallback` when divisor is zero, NaN, or Infinity,
 * or when the result would be non-finite.
 */
export function safeDivide(
  numerator: number,
  denominator: number,
  fallback: number = 0,
): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return fallback;
  }
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : fallback;
}

// =============================================================================
// ARRAY VALIDATION
// =============================================================================

/**
 * Assert that all provided arrays have the same length.
 * Throws a descriptive error if they don't.
 *
 * @param context - Human-readable context for the error message
 * @param arrays - Named arrays to check: [['weights', arr1], ['fitness', arr2], ...]
 */
export function assertCompatibleLengths(
  context: string,
  ...arrays: [string, { length: number }][]
): void {
  if (arrays.length < 2) return;

  const [firstName, firstArr] = arrays[0];
  const expectedLength = firstArr.length;

  for (let i = 1; i < arrays.length; i++) {
    const [name, arr] = arrays[i];
    if (arr.length !== expectedLength) {
      throw new Error(
        `[${context}] Length mismatch: ${firstName}.length=${expectedLength}, ${name}.length=${arr.length}`
      );
    }
  }
}

/**
 * Sanitize a Float64Array: replace any NaN or Infinity values with `fallback`.
 * Returns a NEW array (does not mutate the input).
 */
export function sanitizeFloat64Array(
  arr: Float64Array,
  fallback: number = 0,
): Float64Array {
  const result = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    result[i] = Number.isFinite(arr[i]) ? arr[i] : fallback;
  }
  return result;
}

/**
 * Check if any element of a Float64Array is NaN or Infinity.
 */
export function hasNonFinite(arr: Float64Array): boolean {
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) return true;
  }
  return false;
}

// =============================================================================
// SAFE JSON
// =============================================================================

/**
 * Safe JSON.stringify that handles circular references and size limits.
 * Returns the stringified result or `fallbackStr` on failure.
 *
 * @param value - Value to stringify
 * @param maxLength - Maximum output string length (default 10KB)
 * @param fallbackStr - Returned on error (default '{}')
 */
export function safeJsonStringify(
  value: unknown,
  maxLength: number = 10240,
  fallbackStr: string = '{}',
): string {
  try {
    const seen = new WeakSet();
    const result = JSON.stringify(value, (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      if (typeof val === 'function') return undefined;
      if (typeof val === 'bigint') return val.toString();
      return val;
    });
    if (result && result.length > maxLength) {
      return result.slice(0, maxLength);
    }
    return result ?? fallbackStr;
  } catch {
    return fallbackStr;
  }
}
