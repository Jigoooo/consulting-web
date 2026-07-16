import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatCheckpointCoalescer } from '../src/chat/chat-checkpoint-coalescer.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ChatCheckpointCoalescer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists only the latest snapshot after the 300ms coalescing window', async () => {
    vi.useFakeTimers();
    const writes: Array<{ version: number }> = [];
    const coalescer = new ChatCheckpointCoalescer<{ version: number }>(
      async (snapshot) => { writes.push(snapshot); },
      { intervalMs: 300, maxBufferedBytes: 2_048 },
    );

    coalescer.schedule({ version: 1 }, 100);
    coalescer.schedule({ version: 2 }, 100);
    coalescer.schedule({ version: 3 }, 100);
    await vi.advanceTimersByTimeAsync(299);
    expect(writes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await coalescer.flush();

    expect(writes).toEqual([{ version: 3 }]);
    expect(coalescer.stats).toEqual({ scheduled: 3, writes: 1 });
  });

  it('flushes at 2KB and never overlaps checkpoint writes', async () => {
    const firstWrite = deferred<void>();
    const writes: number[] = [];
    let active = 0;
    let maxActive = 0;
    const coalescer = new ChatCheckpointCoalescer<number>(async (snapshot) => {
      writes.push(snapshot);
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (writes.length === 1) await firstWrite.promise;
      active -= 1;
    }, { intervalMs: 300, maxBufferedBytes: 2_048 });

    coalescer.schedule(1, 1_024);
    coalescer.schedule(2, 1_024);
    await vi.waitFor(() => expect(writes).toEqual([2]));
    coalescer.schedule(3, 2_048);
    firstWrite.resolve();
    await coalescer.flush();

    expect(writes).toEqual([2, 3]);
    expect(maxActive).toBe(1);
    expect(coalescer.stats).toEqual({ scheduled: 3, writes: 2 });
  });

  it('stores async write failure, notifies once, and rejects the next flush', async () => {
    const failure = new Error('checkpoint unavailable');
    const onError = vi.fn();
    const coalescer = new ChatCheckpointCoalescer<number>(
      async () => { throw failure; },
      { intervalMs: 300, maxBufferedBytes: 1, onError },
    );

    coalescer.schedule(1, 1);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));

    await expect(coalescer.flush()).rejects.toBe(failure);
    expect(onError).toHaveBeenCalledOnce();
    expect(coalescer.stats).toEqual({ scheduled: 1, writes: 0 });
  });

  it('treats a falsy rejection reason as a durable checkpoint failure', async () => {
    const onError = vi.fn();
    const coalescer = new ChatCheckpointCoalescer<number>(
      async () => await Promise.reject(undefined),
      { intervalMs: 300, maxBufferedBytes: 1, onError },
    );

    coalescer.schedule(1, 1);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    let rejected = false;
    try {
      await coalescer.flush();
    } catch {
      rejected = true;
    }

    expect(rejected).toBe(true);
    expect(coalescer.stats).toEqual({ scheduled: 1, writes: 0 });
  });

  it('seals before awaiting close so no late snapshot can be scheduled', async () => {
    const firstWrite = deferred<void>();
    const writes: number[] = [];
    const coalescer = new ChatCheckpointCoalescer<number>(async (snapshot) => {
      writes.push(snapshot);
      await firstWrite.promise;
    }, { intervalMs: 300, maxBufferedBytes: 1 });

    coalescer.schedule(1, 1);
    await vi.waitFor(() => expect(writes).toEqual([1]));
    const closing = coalescer.close();

    expect(() => coalescer.schedule(2, 1)).toThrow('checkpoint coalescer is closed');
    firstWrite.resolve();
    await closing;
    expect(writes).toEqual([1]);
  });
});
