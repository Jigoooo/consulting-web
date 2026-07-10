import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboxRelayService } from '../src/queues/outbox-relay.service.js';

describe('OutboxRelayService lifecycle loop', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts a non-overlapping periodic relay on module init and stops it on destroy', async () => {
    vi.useFakeTimers();
    const service = new OutboxRelayService({} as never, {} as never, {} as never);
    const relay = vi.spyOn(service, 'relayOnce').mockResolvedValue(0);

    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(1);
    expect(relay).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(relay).toHaveBeenCalledTimes(2);

    service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(relay).toHaveBeenCalledTimes(2);
  });
});
