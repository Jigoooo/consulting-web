export interface ChatCheckpointCoalescerOptions {
  readonly intervalMs: number;
  readonly maxBufferedBytes: number;
  readonly onError?: (error: unknown) => void;
}

export interface ChatCheckpointCoalescerStats {
  readonly scheduled: number;
  readonly writes: number;
}

export class ChatCheckpointCoalescer<T> {
  private pending: T | undefined;
  private pendingBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private failure: unknown;
  private hasFailure = false;
  private closed = false;
  private scheduledCount = 0;
  private writeCount = 0;

  constructor(
    private readonly write: (snapshot: T) => Promise<void>,
    private readonly options: ChatCheckpointCoalescerOptions,
  ) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs < 0) {
      throw new RangeError('checkpoint interval must be a non-negative finite number');
    }
    if (!Number.isFinite(options.maxBufferedBytes) || options.maxBufferedBytes < 1) {
      throw new RangeError('checkpoint byte threshold must be a positive finite number');
    }
  }

  get stats(): ChatCheckpointCoalescerStats {
    return { scheduled: this.scheduledCount, writes: this.writeCount };
  }

  schedule(snapshot: T, addedBytes = 0): void {
    if (this.closed) throw new Error('checkpoint coalescer is closed');
    if (this.hasFailure) throw this.failure;
    this.pending = snapshot;
    this.pendingBytes += Math.max(0, Number.isFinite(addedBytes) ? addedBytes : 0);
    this.scheduledCount += 1;
    if (this.pendingBytes >= this.options.maxBufferedBytes) {
      this.clearTimer();
      void this.startDrain();
      return;
    }
    this.armTimer();
  }

  async flush(snapshot?: T, addedBytes = 0): Promise<void> {
    if (snapshot !== undefined) this.schedule(snapshot, addedBytes);
    this.clearTimer();
    while (true) {
      if (this.hasFailure) throw this.failure;
      await this.startDrain();
      if (this.hasFailure) throw this.failure;
      if (this.pending === undefined && this.inFlight === undefined) return;
    }
  }

  async close(snapshot?: T, addedBytes = 0): Promise<void> {
    if (snapshot !== undefined) this.schedule(snapshot, addedBytes);
    this.closed = true;
    this.clearTimer();
    await this.flush();
  }

  private armTimer(): void {
    if (this.timer || this.inFlight) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.startDrain();
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private startDrain(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.hasFailure) return Promise.resolve();
    this.inFlight = this.drain()
      .catch((error: unknown) => {
        this.failure = error;
        this.hasFailure = true;
        this.pending = undefined;
        this.pendingBytes = 0;
        this.options.onError?.(error);
      })
      .finally(() => {
        this.inFlight = undefined;
        if (this.pending !== undefined && !this.hasFailure) {
          if (this.pendingBytes >= this.options.maxBufferedBytes) void this.startDrain();
          else this.armTimer();
        }
      });
    return this.inFlight;
  }

  private async drain(): Promise<void> {
    while (this.pending !== undefined) {
      const snapshot = this.pending;
      this.pending = undefined;
      this.pendingBytes = 0;
      await this.write(snapshot);
      this.writeCount += 1;
    }
  }
}
