import { describe, expect, it } from 'vitest';
import { GenericDomainEventAuditWorker } from '../src/queues/generic-domain-event-audit.worker.js';

describe('GenericDomainEventAuditWorker', () => {
  const worker = new GenericDomainEventAuditWorker({ REDIS_URL: 'redis://127.0.0.1:6379' } as never);

  it.each(['WorkspaceCreated', 'ChannelCreated', 'TopicCreated', 'ThreadCreated'])(
    'acknowledges registered audit-only event %s',
    async (eventType) => {
      await expect(worker.processOutboxJob({
        eventId: `evt-${eventType}`,
        eventType,
        aggregateType: 'test',
        aggregateId: 'aggregate-1',
        workspaceId: 'workspace-1',
        payload: {},
      })).resolves.toBeUndefined();
    },
  );

  it('rejects an unregistered event instead of silently acknowledging it', async () => {
    await expect(worker.processOutboxJob({
      eventId: 'evt-unknown',
      eventType: 'UnknownEvent',
      aggregateType: 'test',
      aggregateId: 'aggregate-1',
      workspaceId: 'workspace-1',
      payload: {},
    })).rejects.toThrow(/unsupported outbox event type/i);
  });
});
