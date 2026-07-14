import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboxRelayService, outboxJobId } from '../src/queues/outbox-relay.service.js';

describe('OutboxRelayService finalize heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps extending the owner lease until the published-state finalize completes', async () => {
    vi.useFakeTimers();
    let updateCalls = 0;
    let heartbeatCalls = 0;
    let resolveFinalize!: (rows: { id: string }[]) => void;
    const finalize = new Promise<{ id: string }[]>((resolve) => {
      resolveFinalize = resolve;
    });
    const event = {
      id: 'evt-finalize-heartbeat',
      workspaceId: 'workspace-1',
      eventType: 'WorkspaceCreated',
      aggregateType: 'workspace',
      aggregateId: 'workspace-1',
      payload: {},
      status: 'pending',
      idempotencyKey: 'finalize-heartbeat:test',
      leaseToken: null,
      leaseExpiresAt: null,
      attemptCount: 0,
      lastError: null,
      nextAttemptAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: async () => [event] }),
          }),
        }),
      }),
      update: () => {
        updateCalls += 1;
        if (updateCalls === 1) {
          return { set: () => ({ where: () => ({ returning: async () => [{ id: event.id }] }) }) };
        }
        if (updateCalls === 2) {
          return { set: () => ({ where: () => ({ returning: () => finalize }) }) };
        }
        heartbeatCalls += 1;
        return { set: () => ({ where: () => Promise.resolve() }) };
      },
    };
    const queue = { add: vi.fn(async () => undefined) };
    const service = new OutboxRelayService(db as never, queue as never, queue as never);

    const relay = service.relayOnce(1);
    for (let i = 0; i < 10 && updateCalls < 2; i += 1) await Promise.resolve();
    expect(updateCalls).toBe(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(heartbeatCalls).toBe(1);

    resolveFinalize([{ id: event.id }]);
    await expect(relay).resolves.toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(heartbeatCalls).toBe(1);
    service.onModuleDestroy();
  });

  it('publishes settlement events only to the dedicated settlement queue', async () => {
    const event = {
      id: 'evt-chat-settlement',
      workspaceId: 'workspace-1',
      eventType: 'ChatTurnSettlementRequested',
      aggregateType: 'thread',
      aggregateId: 'thread-1',
      payload: { settlementId: 'settlement-1', assistantMessageId: 'message-1', threadId: 'thread-1' },
      status: 'pending',
      idempotencyKey: 'chat-turn-settlement:settlement-1:attempt:0',
      leaseToken: null,
      leaseExpiresAt: null,
      attemptCount: 0,
      lastError: null,
      nextAttemptAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: async () => [event] }) }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => [{ id: event.id }] }),
        }),
      }),
    };
    const genericQueue = { add: vi.fn(async () => undefined) };
    const consultingQueue = { add: vi.fn(async () => undefined) };
    const settlementQueue = { add: vi.fn(async () => undefined) };
    const service = new OutboxRelayService(
      db as never,
      genericQueue as never,
      consultingQueue as never,
      settlementQueue as never,
    );

    await expect(service.relayOnce(1)).resolves.toBe(1);
    expect(settlementQueue.add).toHaveBeenCalledWith(
      'ChatTurnSettlementRequested',
      expect.objectContaining({ eventType: 'ChatTurnSettlementRequested', aggregateId: 'thread-1' }),
      expect.objectContaining({ jobId: outboxJobId(event.idempotencyKey), attempts: 5 }),
    );
    expect(genericQueue.add).not.toHaveBeenCalled();
    expect(consultingQueue.add).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });
});
