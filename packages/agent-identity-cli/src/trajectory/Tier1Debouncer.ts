/**
 * Tier1Debouncer.ts
 *
 * Debounces Tier 1 dependency analysis batch triggers (v2.2 spec §12, fix #19).
 *
 * Multiple Tier 1 triggers within the debounce window (default 500ms) collapse
 * into a single batch. Uses batchId gating (latest-batch-wins): if a previous
 * batch is still running when a new one fires, the old batch may run to
 * completion but its results are discarded because its batchId is stale.
 *
 * Provides `flush(timeoutMs)` for SessionEnd to drain pending work within budget.
 */

import type { BatchMeta } from './types';

export type Tier1Handler = (
  files: string[],
  meta: BatchMeta,
  /** Check before committing results — returns false if a newer batch superseded this one. */
  shouldCommit: () => boolean,
) => Promise<void>;

export class Tier1Debouncer {
  private pendingFiles: Map<string, number> = new Map(); // filePath → trigger stepIndex
  private timer: ReturnType<typeof setTimeout> | null = null;
  private runningPromise: Promise<void> | null = null;
  /** Monotonically increasing batch counter for latest-batch-wins gating. */
  private currentBatchId = 0;
  private readonly DEBOUNCE_MS: number;
  private readonly handler: Tier1Handler;

  constructor(handler: Tier1Handler, config?: { debounceMs?: number }) {
    this.handler = handler;
    this.DEBOUNCE_MS = config?.debounceMs ?? 500;
  }

  /**
   * Add a file to the pending batch. Resets the debounce timer.
   */
  add(filePath: string, stepIndex: number): void {
    this.pendingFiles.set(filePath, stepIndex);

    // Reset timer
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fire();
    }, this.DEBOUNCE_MS);
  }

  /**
   * Cancel all pending work and invalidate running batch.
   */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingFiles.clear();

    // Increment batchId so any running handler's shouldCommit() returns false
    this.currentBatchId++;
    this.runningPromise = null;
  }

  /**
   * Force-fire pending batch and await completion with timeout.
   * Used at SessionEnd to drain work within the 15s budget.
   */
  async flush(timeoutMs: number): Promise<void> {
    // Clear debounce timer
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Fire pending if any
    if (this.pendingFiles.size > 0) {
      this.fire();
    }

    // Await running batch with timeout
    if (this.runningPromise) {
      await Promise.race([
        this.runningPromise,
        new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
      ]);
    }
  }

  /**
   * Get count of pending (not yet fired) files.
   */
  getPendingCount(): number {
    return this.pendingFiles.size;
  }

  // ===========================================================================
  // PRIVATE
  // ===========================================================================

  private fire(): void {
    if (this.pendingFiles.size === 0) return;

    // Capture batch snapshot
    const files = Array.from(this.pendingFiles.keys());
    const steps = Array.from(this.pendingFiles.values());
    this.pendingFiles.clear();

    const meta: BatchMeta = {
      triggerStepMin: Math.min(...steps),
      triggerStepMax: Math.max(...steps),
      batchSpanSteps: Math.max(...steps) - Math.min(...steps),
      batchFiles: files,
    };

    // Assign a new batchId — any previous running handler's shouldCommit()
    // will now return false (its captured myBatchId !== this.currentBatchId).
    const myBatchId = ++this.currentBatchId;

    const shouldCommit = () => myBatchId === this.currentBatchId;

    // Attach .catch() to prevent UnhandledPromiseRejection from orphaned
    // batches. When fire() overwrites runningPromise or cancel() nulls it,
    // the old promise is no longer awaited — if its handler throws, Node 15+
    // would terminate the process without this catch.
    const promise = (async () => {
      try {
        await this.handler(files, meta, shouldCommit);
      } finally {
        // Only clear runningPromise if this is still the current batch
        if (myBatchId === this.currentBatchId) {
          this.runningPromise = null;
        }
      }
    })().catch(() => {});

    this.runningPromise = promise;
  }
}
