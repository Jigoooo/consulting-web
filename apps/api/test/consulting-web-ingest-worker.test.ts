import { describe, expect, it, vi } from 'vitest';
import { ConsultingWebIngestWorker } from '../src/consulting/consulting-web-ingest.worker.js';

const payload = {
  consultingTopicSlug: 'changwon-org-mgmt-diagnosis',
  consultingTopicId: 5,
  sessionId: 'consulting-web-thread:thread-1',
  workspaceId: 'ws',
  projectId: 'project',
  channelId: 'channel',
  topicId: 'topic',
  threadId: 'thread-1',
  scopePath: '창원/분석/조직진단/정원',
  userText: '정원 검토해줘',
  assistantText: '정원·인건비와 같이 봐야 합니다.',
  runId: 'run_abc',
  assistantMessageId: 'message-1',
  timestamp: 1770000000,
};

describe('ConsultingWebIngestWorker', () => {
  it('runs consulting brain ingest only for ConsultingWebTurnCompleted outbox jobs', async () => {
    const runner = vi.fn(async () => undefined);
    const worker = new ConsultingWebIngestWorker(
      { REDIS_URL: 'redis://127.0.0.1:6379' } as never,
      runner,
    );

    await worker.processOutboxJob({
      eventId: 'evt-1',
      eventType: 'WorkspaceCreated',
      aggregateType: 'workspace',
      aggregateId: 'workspace-1',
      workspaceId: 'ws',
      payload: { ignored: true },
    });
    expect(runner).not.toHaveBeenCalled();

    await worker.processOutboxJob({
      eventId: 'evt-2',
      eventType: 'ConsultingWebTurnCompleted',
      aggregateType: 'thread',
      aggregateId: 'thread-1',
      workspaceId: 'ws',
      payload,
    });

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(payload);
  });

  it('throws on malformed ConsultingWebTurnCompleted payload so BullMQ retries', async () => {
    const runner = vi.fn(async () => undefined);
    const worker = new ConsultingWebIngestWorker(
      { REDIS_URL: 'redis://127.0.0.1:6379' } as never,
      runner,
    );

    await expect(worker.processOutboxJob({
      eventId: 'evt-3',
      eventType: 'ConsultingWebTurnCompleted',
      aggregateType: 'thread',
      aggregateId: 'thread-1',
      workspaceId: 'ws',
      payload: { ...payload, assistantText: '' },
    })).rejects.toThrow(/invalid consulting web ingest payload/i);
    expect(runner).not.toHaveBeenCalled();
  });
});
