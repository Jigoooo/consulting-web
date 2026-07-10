import { describe, expect, it } from 'vitest';
import { outboxJobId, outboxJobOptions, outboxRetryDelaySeconds } from '../src/queues/outbox-relay.service.js';

describe('outboxJobOptions', () => {
  it('adds retry/backoff for ConsultingWebTurnCompleted ingest events', () => {
    const opts = outboxJobOptions('ConsultingWebTurnCompleted', 'consulting-web-ingest:test:thread');

    expect(opts.jobId).toBe(outboxJobId('consulting-web-ingest:test:thread'));
    expect(opts.attempts).toBeGreaterThanOrEqual(5);
    expect(opts.backoff).toMatchObject({ type: 'exponential' });
    expect(opts.removeOnFail).toBeGreaterThanOrEqual(5000);
  });

  it('keeps ordinary outbox events deduped without forcing heavy retry policy', () => {
    const opts = outboxJobOptions('WorkspaceCreated', 'workspace:created:abc');

    expect(opts.jobId).toBe(outboxJobId('workspace:created:abc'));
    expect(opts.attempts).toBeUndefined();
  });

  it('does not collapse distinct idempotency keys into the same BullMQ job id', () => {
    expect(outboxJobId('workspace:created:abc')).not.toBe(outboxJobId('workspace_created_abc'));
    expect(outboxJobId('workspace:created:abc')).toMatch(/^outbox_[a-f0-9]{64}$/u);
  });
});

describe('outboxRetryDelaySeconds', () => {
  it('backs off exponentially and caps broker retry delay at five minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 12].map(outboxRetryDelaySeconds))
      .toEqual([5, 10, 20, 40, 80, 160, 300, 300]);
  });
});
