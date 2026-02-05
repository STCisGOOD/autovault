/**
 * Circuit Breaker - Resilience Pattern for External APIs
 *
 * Prevents cascading failures by failing fast when external services
 * are unavailable. Uses a state machine: CLOSED -> OPEN -> HALF_OPEN -> CLOSED
 */

import { getCircuitBreakerConfig, CircuitBreakerConfig } from './config';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface FailureRecord {
  timestamp: number;
}

/**
 * Circuit Breaker for a single service
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Service is failing, requests fail immediately
 * - HALF_OPEN: Testing if service recovered, limited requests pass
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures: FailureRecord[] = [];
  private successCount: number = 0;
  private lastFailureTime: number = 0;
  private openedAt: number = 0;

  constructor(
    public readonly serviceName: string,
    private readonly config: CircuitBreakerConfig
  ) {}

  /**
   * Check if a request can proceed
   */
  canRequest(): boolean {
    this.updateState();

    switch (this.state) {
      case 'CLOSED':
        return true;

      case 'OPEN':
        return false;

      case 'HALF_OPEN':
        // In half-open, allow limited requests to test recovery
        return true;

      default:
        return false;
    }
  }

  /**
   * Record a successful request
   */
  recordSuccess(): void {
    this.updateState();

    if (this.state === 'HALF_OPEN') {
      this.successCount++;

      if (this.successCount >= this.config.successThreshold) {
        // Service recovered, close the circuit
        this.close();
      }
    } else if (this.state === 'CLOSED') {
      // In closed state, successes reset the failure count
      // (within the monitoring window)
      this.successCount++;
    }
  }

  /**
   * Record a failed request
   */
  recordFailure(): void {
    const now = Date.now();
    this.lastFailureTime = now;

    if (this.state === 'HALF_OPEN') {
      // Failure in half-open state reopens the circuit
      this.open();
      return;
    }

    // Add failure record
    this.failures.push({ timestamp: now });

    // Clean up old failures outside monitoring window
    const windowStart = now - this.config.monitoringWindow;
    this.failures = this.failures.filter(f => f.timestamp > windowStart);

    // Check if we've exceeded the failure threshold
    if (this.failures.length >= this.config.failureThreshold) {
      this.open();
    }
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    this.updateState();
    return this.state;
  }

  /**
   * Get detailed status information
   */
  getStatus(): {
    state: CircuitState;
    failures: number;
    successesInHalfOpen: number;
    timeUntilHalfOpen: number | null;
    lastFailure: number | null;
  } {
    this.updateState();

    return {
      state: this.state,
      failures: this.failures.length,
      successesInHalfOpen: this.state === 'HALF_OPEN' ? this.successCount : 0,
      timeUntilHalfOpen: this.state === 'OPEN'
        ? Math.max(0, this.openedAt + this.config.timeout - Date.now())
        : null,
      lastFailure: this.lastFailureTime || null
    };
  }

  /**
   * Manually reset the circuit breaker (for admin/testing)
   */
  reset(): void {
    this.close();
    this.failures = [];
    this.lastFailureTime = 0;
  }

  /**
   * Update state based on timers
   */
  private updateState(): void {
    if (this.state === 'OPEN') {
      const now = Date.now();
      const timeSinceOpen = now - this.openedAt;

      if (timeSinceOpen >= this.config.timeout) {
        // Timeout elapsed, transition to half-open
        this.halfOpen();
      }
    }
  }

  /**
   * Transition to OPEN state
   */
  private open(): void {
    this.state = 'OPEN';
    this.openedAt = Date.now();
    this.successCount = 0;
    console.warn(`[CircuitBreaker] ${this.serviceName}: Circuit OPENED (failures: ${this.failures.length})`);
  }

  /**
   * Transition to HALF_OPEN state
   */
  private halfOpen(): void {
    this.state = 'HALF_OPEN';
    this.successCount = 0;
    console.log(`[CircuitBreaker] ${this.serviceName}: Circuit HALF_OPEN (testing recovery)`);
  }

  /**
   * Transition to CLOSED state
   */
  private close(): void {
    this.state = 'CLOSED';
    this.failures = [];
    this.successCount = 0;
    this.openedAt = 0;
    console.log(`[CircuitBreaker] ${this.serviceName}: Circuit CLOSED (recovered)`);
  }
}

/**
 * Circuit Breaker Manager
 *
 * Manages circuit breakers for multiple services.
 * Provides a central point to check and manage all breakers.
 */
export class CircuitBreakerManager {
  private breakers: Map<string, CircuitBreaker> = new Map();

  /**
   * Get or create a circuit breaker for a service
   */
  getBreaker(serviceName: string): CircuitBreaker {
    let breaker = this.breakers.get(serviceName);

    if (!breaker) {
      const config = getCircuitBreakerConfig(serviceName);
      breaker = new CircuitBreaker(serviceName, config);
      this.breakers.set(serviceName, breaker);
    }

    return breaker;
  }

  /**
   * Check if a service is available
   */
  isAvailable(serviceName: string): boolean {
    return this.getBreaker(serviceName).canRequest();
  }

  /**
   * Get status of all circuit breakers
   */
  getAllStatus(): Record<string, ReturnType<CircuitBreaker['getStatus']>> {
    const status: Record<string, ReturnType<CircuitBreaker['getStatus']>> = {};

    for (const [name, breaker] of this.breakers.entries()) {
      status[name] = breaker.getStatus();
    }

    return status;
  }

  /**
   * Reset all circuit breakers
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  /**
   * Get list of services with open circuits
   */
  getOpenCircuits(): string[] {
    const open: string[] = [];

    for (const [name, breaker] of this.breakers.entries()) {
      if (breaker.getState() === 'OPEN') {
        open.push(name);
      }
    }

    return open;
  }
}

// Global circuit breaker manager instance
export const circuitBreakerManager = new CircuitBreakerManager();

/**
 * Utility: Execute a function with circuit breaker protection
 *
 * @param serviceName - Name of the service being called
 * @param fn - Async function to execute
 * @returns Result of the function or throws if circuit is open
 */
export async function withCircuitBreaker<T>(
  serviceName: string,
  fn: () => Promise<T>
): Promise<T> {
  const breaker = circuitBreakerManager.getBreaker(serviceName);

  if (!breaker.canRequest()) {
    throw new CircuitOpenError(serviceName);
  }

  try {
    const result = await fn();
    breaker.recordSuccess();
    return result;
  } catch (error) {
    breaker.recordFailure();
    throw error;
  }
}

/**
 * Error thrown when circuit is open
 */
export class CircuitOpenError extends Error {
  constructor(public readonly serviceName: string) {
    super(`Circuit breaker open for service: ${serviceName}`);
    this.name = 'CircuitOpenError';
  }
}
