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
  allowedSegments: [{ id: 'user:message-1', kind: 'user', text: '정원 검토해줘', reason: 'user_input_allowed' }],
  assistantCandidate: {
    id: 'assistant:message-1',
    text: '정원·인건비와 같이 봐야 합니다.',
    sourceMessageId: 'message-1',
    status: 'quarantined',
    reason: 'assistant_output_requires_review',
  },
  blockedSegments: [{ id: 'assistant:message-1', kind: 'assistant', text: '정원·인건비와 같이 봐야 합니다.', reason: 'assistant_output_requires_review' }],
  policyDecisionId: 'memory-write-guard:v1:message-1',
  traceId: 'run_abc',
  runId: 'run_abc',
  assistantMessageId: 'message-1',
  timestamp: 1770000000,
  verifiedContradictions: [{
    verdictRef: 'assistant:message-1:MSG-1',
    claimId: 'MSG-1',
    claimText: '기본급은 2,100,000원이다.',
    verdict: 'refutes',
    confidence: 0.91,
    rationale: '공식 표와 다름',
    evidenceItemId: 'evidence-1',
    evidenceRef: 'EV-PAY-01',
    evidenceText: '공식 표에는 2,000,000원으로 기재되어 있다.',
  }],
};

describe('ConsultingWebIngestWorker', () => {
  it('runs consulting brain ingest only for ConsultingWebTurnCompleted outbox jobs', async () => {
    const runner = vi.fn(async () => undefined);
    const worker = new ConsultingWebIngestWorker(
      { REDIS_URL: 'redis://127.0.0.1:6379' } as never,
      runner,
    );

    await expect(worker.processOutboxJob({
      eventId: 'evt-1',
      eventType: 'WorkspaceCreated',
      aggregateType: 'workspace',
      aggregateId: 'workspace-1',
      workspaceId: 'ws',
      payload: { ignored: true },
    })).rejects.toThrow(/unsupported outbox event/i);
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
      payload: { ...payload, allowedSegments: [] },
    })).rejects.toThrow(/invalid consulting web ingest payload/i);
    expect(runner).not.toHaveBeenCalled();
  });

  it('rejects malformed verified contradiction data instead of silently dropping it', async () => {
    const runner = vi.fn(async () => undefined);
    const worker = new ConsultingWebIngestWorker(
      { REDIS_URL: 'redis://127.0.0.1:6379' } as never,
      runner,
    );

    await expect(worker.processOutboxJob({
      eventId: 'evt-invalid-verdict',
      eventType: 'ConsultingWebTurnCompleted',
      aggregateType: 'thread',
      aggregateId: 'thread-1',
      workspaceId: 'ws',
      payload: {
        ...payload,
        verifiedContradictions: [{ ...payload.verifiedContradictions[0], verdict: 'supports', confidence: 2 }],
      },
    })).rejects.toThrow(/verified contradiction/i);
    expect(runner).not.toHaveBeenCalled();
  });

  it('normalizes legacy assistantText into a quarantine candidate instead of allowed memory', async () => {
    const runner = vi.fn(async () => undefined);
    const worker = new ConsultingWebIngestWorker(
      { REDIS_URL: 'redis://127.0.0.1:6379' } as never,
      runner,
    );

    await worker.processOutboxJob({
      eventId: 'evt-4',
      eventType: 'ConsultingWebTurnCompleted',
      aggregateType: 'thread',
      aggregateId: 'thread-1',
      workspaceId: 'ws',
      payload: {
        ...payload,
        allowedSegments: undefined,
        assistantCandidate: undefined,
        blockedSegments: undefined,
        assistantText: '레거시 답변은 brain에 쓰면 안 됩니다.',
      },
    });

    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      allowedSegments: [expect.objectContaining({ kind: 'user', text: '정원 검토해줘' })],
      assistantCandidate: expect.objectContaining({ text: '레거시 답변은 brain에 쓰면 안 됩니다.', status: 'quarantined' }),
      blockedSegments: [expect.objectContaining({ kind: 'assistant', text: '레거시 답변은 brain에 쓰면 안 됩니다.' })],
    }));
  });
});
