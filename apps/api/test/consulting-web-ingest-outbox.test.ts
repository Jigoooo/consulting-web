import { describe, expect, it, vi } from 'vitest';
import { ConsultingWebIngestService } from '../src/consulting/consulting-web-ingest.service.js';
import type { ConsultingTopicResolver } from '../src/consulting/consulting-topic-resolver.service.js';

function makeDb() {
  const inserted: unknown[] = [];
  return {
    inserted,
    insert: vi.fn(() => ({
      values: vi.fn((row: unknown) => {
        inserted.push(row);
        return { onConflictDoNothing: vi.fn(async () => []) };
      }),
    })),
  };
}

const liveScope = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  channelId: '33333333-3333-4333-8333-333333333333',
  topicId: '44444444-4444-4444-8444-444444444444',
  threadId: '55555555-5555-4555-8555-555555555555',
  projectName: '창원시 컨설팅',
  channelName: '분석',
  topicName: '조직진단',
  threadTitle: '정원 검토',
  consultingTopicSlug: 'changwon-org-mgmt-diagnosis',
  consultingTopicId: 5,
  linkLevel: 'project' as const,
  scopePath: '창원시 컨설팅/분석/조직진단/정원 검토',
  archived: false,
};

describe('ConsultingWebIngestService outbox path', () => {
  it('records a pending outbox event instead of running best-effort ingest inline', async () => {
    const db = makeDb();
    const resolver = { resolveThread: vi.fn(async () => liveScope) };
    const service = new ConsultingWebIngestService(
      resolver as unknown as ConsultingTopicResolver,
      db as never,
    );

    await service.ingestCompletedTurn({
      threadId: liveScope.threadId,
      userText: '정원 검토해줘',
      assistantText: '정원·인건비 영향과 함께 봐야 합니다.',
      runId: 'run_abc',
      assistantMessageId: '66666666-6666-4666-8666-666666666666',
    });

    expect(resolver.resolveThread).toHaveBeenCalledWith(liveScope.threadId);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.inserted).toHaveLength(1);
    const row = db.inserted[0] as Record<string, unknown>;
    expect(row.eventType).toBe('ConsultingWebTurnCompleted');
    expect(row.aggregateType).toBe('thread');
    expect(row.aggregateId).toBe(liveScope.threadId);
    expect(row.workspaceId).toBe(liveScope.workspaceId);
    expect(row.status).toBe('pending');
    expect(row.idempotencyKey).toBe(`consulting-web-ingest:${liveScope.threadId}:66666666-6666-4666-8666-666666666666`);
    expect(row.payload).toMatchObject({
      consultingTopicSlug: 'changwon-org-mgmt-diagnosis',
      consultingTopicId: 5,
      sessionId: `consulting-web-thread:${liveScope.threadId}`,
      workspaceId: liveScope.workspaceId,
      projectId: liveScope.projectId,
      channelId: liveScope.channelId,
      topicId: liveScope.topicId,
      threadId: liveScope.threadId,
      scopePath: liveScope.scopePath,
      userText: '정원 검토해줘',
      assistantText: '정원·인건비 영향과 함께 봐야 합니다.',
      runId: 'run_abc',
      assistantMessageId: '66666666-6666-4666-8666-666666666666',
    });
  });

  it('does not enqueue archived or empty turns', async () => {
    const db = makeDb();
    const resolver = { resolveThread: vi.fn(async () => ({ ...liveScope, archived: true })) };
    const service = new ConsultingWebIngestService(
      resolver as unknown as ConsultingTopicResolver,
      db as never,
    );

    await service.ingestCompletedTurn({
      threadId: liveScope.threadId,
      userText: '  ',
      assistantText: '응답',
      runId: null,
      assistantMessageId: '66666666-6666-4666-8666-666666666666',
    });
    await service.ingestCompletedTurn({
      threadId: liveScope.threadId,
      userText: '질문',
      assistantText: '응답',
      runId: null,
      assistantMessageId: '66666666-6666-4666-8666-666666666666',
    });

    expect(db.insert).not.toHaveBeenCalled();
  });
});
