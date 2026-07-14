import { describe, expect, it, vi } from 'vitest';
import { ConsultingWebIngestWorker } from '../src/consulting/consulting-web-ingest.worker.js';
import { routeOutboxEvent } from '../src/queues/outbox-routing.js';

describe('outbox event routing fail-closed', () => {
  it('routes only the registered production event types', () => {
    expect(routeOutboxEvent('WorkspaceCreated')).toBe('generic-audit');
    expect(routeOutboxEvent('ChannelCreated')).toBe('generic-audit');
    expect(routeOutboxEvent('TopicCreated')).toBe('generic-audit');
    expect(routeOutboxEvent('ThreadCreated')).toBe('generic-audit');
    expect(routeOutboxEvent('ConsultingWebTurnCompleted')).toBe('consulting-web-ingest');
    expect(routeOutboxEvent('ChatTurnSettlementRequested')).toBe('chat-turn-settlement');
    expect(routeOutboxEvent('NotificationPushRequested')).toBe('notification-push');
    expect(() => routeOutboxEvent('UnknownEvent')).toThrow(/unsupported outbox event type/i);
  });

  it('does not acknowledge an event type that this worker cannot handle', async () => {
    const runner = vi.fn(async () => undefined);
    const worker = new ConsultingWebIngestWorker(
      { REDIS_URL: 'redis://127.0.0.1:6379' } as never,
      runner,
    );

    await expect(worker.processOutboxJob({
      eventId: 'evt-unknown',
      eventType: 'WorkspaceCreated',
      aggregateType: 'workspace',
      aggregateId: 'workspace-1',
      workspaceId: 'workspace-1',
      payload: {},
    })).rejects.toThrow(/unsupported outbox event|cannot handle|wrong queue/i);
    expect(runner).not.toHaveBeenCalled();
  });
});
