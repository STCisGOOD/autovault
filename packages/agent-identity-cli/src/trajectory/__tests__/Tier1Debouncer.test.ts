import { Tier1Debouncer } from '../Tier1Debouncer';
import type { BatchMeta } from '../types';

/**
 * Helper to create a debouncer with controlled handler.
 * The handler now receives a `shouldCommit` callback (batchId gating).
 */
function makeDebouncer(opts?: { debounceMs?: number }): {
  debouncer: Tier1Debouncer;
  batches: Array<{ files: string[]; meta: BatchMeta; shouldCommit: () => boolean }>;
  resolvers: Array<() => void>;
} {
  const batches: Array<{ files: string[]; meta: BatchMeta; shouldCommit: () => boolean }> = [];
  const resolvers: Array<() => void> = [];

  const handler = async (files: string[], meta: BatchMeta, shouldCommit: () => boolean) => {
    batches.push({ files, meta, shouldCommit });
    // Create a controllable promise so we can simulate long-running batches
    await new Promise<void>(resolve => resolvers.push(resolve));
  };

  return {
    debouncer: new Tier1Debouncer(handler, { debounceMs: opts?.debounceMs ?? 50 }),
    batches,
    resolvers,
  };
}

describe('Tier1Debouncer', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('collapses multiple triggers within debounce window into single batch', async () => {
    jest.useFakeTimers();
    const { debouncer, batches, resolvers } = makeDebouncer({ debounceMs: 100 });

    debouncer.add('/a.ts', 0);
    debouncer.add('/b.ts', 1);
    debouncer.add('/c.ts', 2);

    // Advance past debounce window
    jest.advanceTimersByTime(150);

    // Allow microtasks to resolve
    await Promise.resolve();

    expect(batches.length).toBe(1);
    expect(batches[0].files).toEqual(['/a.ts', '/b.ts', '/c.ts']);

    // shouldCommit should be true for the only (current) batch
    expect(batches[0].shouldCommit()).toBe(true);

    // Resolve the handler
    resolvers[0]();
    debouncer.cancel();
  });

  it('batch metadata includes triggerStepMin and triggerStepMax', async () => {
    jest.useFakeTimers();
    const { debouncer, batches, resolvers } = makeDebouncer({ debounceMs: 50 });

    debouncer.add('/a.ts', 3);
    debouncer.add('/b.ts', 7);
    debouncer.add('/c.ts', 5);

    jest.advanceTimersByTime(100);
    await Promise.resolve();

    expect(batches[0].meta.triggerStepMin).toBe(3);
    expect(batches[0].meta.triggerStepMax).toBe(7);
    expect(batches[0].meta.batchSpanSteps).toBe(4);

    resolvers[0]();
    debouncer.cancel();
  });

  it('latest-batch-wins: shouldCommit() returns false for superseded batch', async () => {
    jest.useFakeTimers();
    const { debouncer, batches, resolvers } = makeDebouncer({ debounceMs: 50 });

    // First batch
    debouncer.add('/a.ts', 0);
    jest.advanceTimersByTime(100);
    await Promise.resolve();
    expect(batches.length).toBe(1);

    // First batch's shouldCommit is true while it's the current batch
    expect(batches[0].shouldCommit()).toBe(true);

    // Second batch fires while first is still running (not resolved)
    debouncer.add('/b.ts', 1);
    jest.advanceTimersByTime(100);
    await Promise.resolve();

    // Both handlers were called
    expect(batches.length).toBe(2);

    // First batch's shouldCommit is now FALSE — superseded by second batch
    expect(batches[0].shouldCommit()).toBe(false);
    // Second batch's shouldCommit is still true
    expect(batches[1].shouldCommit()).toBe(true);

    // Resolve both
    resolvers.forEach(r => r());
    debouncer.cancel();
  });

  it('cancel() invalidates running batch shouldCommit', async () => {
    jest.useFakeTimers();
    const { debouncer, batches, resolvers } = makeDebouncer({ debounceMs: 50 });

    debouncer.add('/a.ts', 0);
    jest.advanceTimersByTime(100);
    await Promise.resolve();
    expect(batches.length).toBe(1);

    // shouldCommit is true before cancel
    expect(batches[0].shouldCommit()).toBe(true);

    // cancel() increments batchId → shouldCommit returns false
    debouncer.cancel();
    expect(batches[0].shouldCommit()).toBe(false);

    resolvers[0]();
  });

  it('flush() force-fires pending and awaits running promise', async () => {
    const { debouncer, batches, resolvers } = makeDebouncer({ debounceMs: 5000 });

    debouncer.add('/a.ts', 0);
    debouncer.add('/b.ts', 1);

    // Pending count before flush
    expect(debouncer.getPendingCount()).toBe(2);

    // Start flush (will fire the batch immediately)
    const flushPromise = debouncer.flush(2000);

    // Resolve the handler
    await new Promise(r => setTimeout(r, 10));
    if (resolvers.length > 0) resolvers[0]();

    await flushPromise;

    expect(batches.length).toBe(1);
    expect(batches[0].files).toEqual(['/a.ts', '/b.ts']);
    expect(debouncer.getPendingCount()).toBe(0);
    // Flushed batch should be committable
    expect(batches[0].shouldCommit()).toBe(true);
  });

  it('flush() respects timeout', async () => {
    const { debouncer } = makeDebouncer({ debounceMs: 50 });

    debouncer.add('/a.ts', 0);

    // Flush with short timeout — handler never resolves
    const start = Date.now();
    await debouncer.flush(100);
    const elapsed = Date.now() - start;

    // Should finish within ~200ms (timeout + overhead)
    expect(elapsed).toBeLessThan(500);
    debouncer.cancel();
  });

  it('cancel() clears pending and cancels running', async () => {
    jest.useFakeTimers();
    const { debouncer, batches } = makeDebouncer({ debounceMs: 100 });

    debouncer.add('/a.ts', 0);
    expect(debouncer.getPendingCount()).toBe(1);

    debouncer.cancel();
    expect(debouncer.getPendingCount()).toBe(0);

    // Advance timer — should NOT fire
    jest.advanceTimersByTime(200);
    await Promise.resolve();

    expect(batches.length).toBe(0);
  });

  it('getPendingCount reflects current pending state', () => {
    const { debouncer } = makeDebouncer({ debounceMs: 5000 });

    expect(debouncer.getPendingCount()).toBe(0);
    debouncer.add('/a.ts', 0);
    expect(debouncer.getPendingCount()).toBe(1);
    debouncer.add('/b.ts', 1);
    expect(debouncer.getPendingCount()).toBe(2);
    debouncer.add('/a.ts', 2); // same file, updated step
    expect(debouncer.getPendingCount()).toBe(2); // still 2 files

    debouncer.cancel();
  });
});
