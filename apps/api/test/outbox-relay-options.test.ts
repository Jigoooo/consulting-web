import { describe, expect, it } from 'vitest';
import { outboxJobOptions } from '../src/queues/outbox-relay.service.js';

describe('outboxJobOptions', () => {
  it('adds retry/backoff for ConsultingWebTurnCompleted ingest events', () => {
    const opts = outboxJobOptions('ConsultingWebTurnCompleted', 'consulting-web-ingest:test:thread');

    expect(opts.jobId).toBe('consulting-web-ingest_test_thread');
    expect(opts.attempts).toBeGreaterThanOrEqual(5);
    expect(opts.backoff).toMatchObject({ type: 'exponential' });
    expect(opts.removeOnFail).toBeGreaterThanOrEqual(5000);
  });

  it('keeps ordinary outbox events deduped without forcing heavy retry policy', () => {
    const opts = outboxJobOptions('WorkspaceCreated', 'workspace:created:abc');

    expect(opts.jobId).toBe('workspace_created_abc');
    expect(opts.attempts).toBeUndefined();
  });
});
