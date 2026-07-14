import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { schema } from '@consulting/db-schema';
import { ChatTurnSettlementStore } from '../src/chat/chat-turn-settlement.store.js';
import { CONSULTING_INSIGHT_SHADOW_REQUESTED_EVENT } from '../src/queues/outbox-routing.js';
import { consultingRetrievalSnapshotHash } from '../src/consulting/consulting-memory-context.builder.js';
import {
  ConsultingInsightShadowProvenanceError,
  ConsultingInsightShadowStore,
} from '../src/consulting/consulting-insight-shadow.store.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

d('consulting insight shadow acceptance ledger', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const channelId = randomUUID();
  const topicId = randomUUID();
  const threadId = randomUUID();
  const projectOnlyTopicId = randomUUID();
  const projectOnlyThreadId = randomUUID();
  const retrievalRunId = randomUUID();
  const projectRetrievalRunId = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    db = drizzle(pool, { schema });
    await db.insert(schema.users).values({ id: userId, email: `${userId}@example.com`, displayName: 'insight shadow test' });
    await db.insert(schema.workspaces).values({ id: workspaceId, name: 'insight shadow workspace', slug: `insight-${workspaceId}`, ownerUserId: userId });
    await db.insert(schema.projects).values({ id: projectId, workspaceId, name: 'project', slug: 'project' });
    await db.insert(schema.channels).values({ id: channelId, workspaceId, projectId, name: 'channel', slug: 'channel' });
    await db.insert(schema.topics).values([
      { id: topicId, workspaceId, channelId, name: '보수체계', slug: 'pay' },
      { id: projectOnlyTopicId, workspaceId, channelId, name: '프로젝트 폴백', slug: 'project-only' },
    ]);
    await db.insert(schema.threads).values([
      { id: threadId, workspaceId, topicId, title: 'exact thread' },
      { id: projectOnlyThreadId, workspaceId, topicId: projectOnlyTopicId, title: 'project-only thread' },
    ]);
    await db.insert(schema.consultingTopicLinks).values([
      {
        workspaceId, projectId, channelId, webTopicId: topicId, linkLevel: 'topic',
        consultingTopicSlug: 'changwon-pay-system', scopePath: 'project/channel/pay', status: 'active',
      },
      {
        workspaceId, projectId, linkLevel: 'project', consultingTopicSlug: 'project-fallback',
        scopePath: 'project', status: 'active',
      },
    ]);
    await db.insert(schema.retrievalRuns).values([
      {
        id: retrievalRunId, workspaceId, projectId, channelId, topicId, threadId,
        traceId: `retrieval:${threadId}`, queryHash: 'a'.repeat(40), queryText: '왜 구조가 발생했는가', status: 'ok',
      },
      {
        id: projectRetrievalRunId, workspaceId, projectId, channelId, topicId: projectOnlyTopicId, threadId: projectOnlyThreadId,
        traceId: `retrieval:${projectOnlyThreadId}`, queryHash: 'b'.repeat(40), queryText: '왜 구조가 발생했는가', status: 'ok',
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool.end();
  });

  it('accepts one exact analysis turn idempotently and rejects provenance drift', async () => {
    const store = new ConsultingInsightShadowStore(db as never);
    const settlementId = randomUUID();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const settlements = new ChatTurnSettlementStore(db as never);
    const capture = await settlements.beginCapture({
      settlementId,
      userMessageId,
      assistantMessageId,
      workspaceId,
      threadId,
      requestedByUserId: userId,
      userPrompt: '왜 구조가 발생했는가',
      userText: '왜 구조가 발생했는가',
      assistantText: '',
      runId: null,
      finishState: 'error',
      toolUses: [],
    });
    const input = {
      settlementId,
      userMessageId,
      workspaceId,
      threadId,
      intentDecision: 'analysis' as const,
      intentConfidence: 0.91,
      sourceMessageHash: 'c'.repeat(64),
      policyHash: 'e'.repeat(64),
    };
    const retrievalSnapshotHash = consultingRetrievalSnapshotHash({
      retrievalRunId, workspaceId, threadId, query: '왜 구조가 발생했는가', hits: [],
    }).snapshotHash;

    const accepted = await store.accept(input);
    expect(accepted).toMatchObject({ state: 'accepted' });
    await expect(store.accept(input)).resolves.toMatchObject({ state: 'existing' });
    await expect(store.accept({ ...input, sourceMessageHash: 'f'.repeat(64) }))
      .rejects.toBeInstanceOf(ConsultingInsightShadowProvenanceError);
    if (accepted.state !== 'accepted') throw new Error('fixture acceptance failed');
    await expect(store.attachRetrieval(accepted.id, { retrievalRunId, retrievalSnapshotHash })).resolves.toBe(true);
    await expect(store.attachRetrieval(accepted.id, { retrievalRunId, retrievalSnapshotHash })).resolves.toBe(true);

    expect(capture.state).toBe('started');
    if (capture.state !== 'started' || accepted.state !== 'accepted') throw new Error('fixture capture failed');
    const assistantText = 'baseline 응답은 그대로 유지된다';
    const settlementRequest = {
      settlementId,
      userMessageId,
      assistantMessageId,
      workspaceId,
      threadId,
      requestedByUserId: userId,
      userPrompt: '왜 구조가 발생했는가',
      userText: '왜 구조가 발생했는가',
      assistantText,
      runId: 'run-shadow-baseline',
      finishState: 'complete' as const,
      toolUses: [],
      insightShadowId: accepted.id,
    };
    await settlements.finalizeCapture(settlementRequest, capture.leaseToken);
    await settlements.finalizeCapture(settlementRequest, capture.leaseToken);

    const rows = await db.select().from(schema.consultingInsightShadowTurns)
      .where(and(
        eq(schema.consultingInsightShadowTurns.workspaceId, workspaceId),
        eq(schema.consultingInsightShadowTurns.settlementId, settlementId),
      ));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'succeeded', threadId, retrievalRunId, assistantMessageId,
      baselineResponseHash: createHash('sha256').update(assistantText, 'utf8').digest('hex'),
    });
    const outbox = await db.select().from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.eventType, CONSULTING_INSIGHT_SHADOW_REQUESTED_EVENT));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.payload).toEqual({
      shadowTurnId: accepted.id,
      settlementId,
      retrievalRunId,
      assistantMessageId,
    });
    expect(JSON.stringify(outbox[0]?.payload)).not.toContain(assistantText);
    const claim = await store.claimReplay(accepted.id);
    expect(claim.state).toBe('claimed');
    if (claim.state !== 'claimed') throw new Error('replay claim failed');
    await expect(store.claimReplay(accepted.id)).resolves.toEqual({ state: 'busy' });
    await expect(store.completeReplay(accepted.id, 'stale-owner', { candidates: [] })).resolves.toBe(false);
    await expect(store.completeReplay(accepted.id, claim.leaseToken, { candidates: [] })).resolves.toBe(true);
    await expect(store.claimReplay(accepted.id)).resolves.toEqual({ state: 'terminal' });
    const results = await db.select().from(schema.consultingInsightShadowResults)
      .where(eq(schema.consultingInsightShadowResults.shadowTurnId, accepted.id));
    expect(results).toHaveLength(1);
  });

  it('keeps a pre-baseline denominator row but emits no replay when retrieval attachment is missing', async () => {
    const store = new ConsultingInsightShadowStore(db as never);
    const settlements = new ChatTurnSettlementStore(db as never);
    const settlementId = randomUUID();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const capture = await settlements.beginCapture({
      settlementId, userMessageId, assistantMessageId, workspaceId, threadId,
      requestedByUserId: userId, userPrompt: '왜 실패했는가', userText: '왜 실패했는가',
      assistantText: '', runId: null, finishState: 'error', toolUses: [],
    });
    const accepted = await store.accept({
      settlementId, userMessageId, workspaceId, threadId,
      intentDecision: 'analysis', intentConfidence: 0.9,
      sourceMessageHash: '7'.repeat(64), policyHash: '8'.repeat(64),
    });
    if (capture.state !== 'started' || accepted.state !== 'accepted') throw new Error('fixture setup failed');
    await settlements.finalizeCapture({
      settlementId, userMessageId, assistantMessageId, workspaceId, threadId,
      requestedByUserId: userId, userPrompt: '왜 실패했는가', userText: '왜 실패했는가',
      assistantText: 'baseline은 성공', runId: 'run-no-retrieval', finishState: 'complete', toolUses: [],
      insightShadowId: accepted.id,
    }, capture.leaseToken);
    const [row] = await db.select().from(schema.consultingInsightShadowTurns)
      .where(eq(schema.consultingInsightShadowTurns.id, accepted.id));
    expect(row).toMatchObject({ status: 'succeeded', replayStatus: 'snapshot_invalid' });
    expect(row?.retrievalRunId).toBeNull();
    const events = await db.select().from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.eventType, CONSULTING_INSIGHT_SHADOW_REQUESTED_EVENT));
    expect(events.some((event) => (event.payload as { shadowTurnId?: string }).shadowTurnId === accepted.id)).toBe(false);
  });

  it('rejects factual and project-only turns without denominator rows', async () => {
    const store = new ConsultingInsightShadowStore(db as never);
    await expect(store.accept({
      settlementId: randomUUID(), userMessageId: randomUUID(), workspaceId, threadId, retrievalRunId,
      intentDecision: 'factual', intentConfidence: 0.95,
      sourceMessageHash: '1'.repeat(64), retrievalSnapshotHash: '2'.repeat(64), policyHash: '3'.repeat(64),
    })).resolves.toEqual({ state: 'ineligible', reason: 'intent_not_analysis' });
    const projectSettlementId = randomUUID();
    const projectUserMessageId = randomUUID();
    await new ChatTurnSettlementStore(db as never).beginCapture({
      settlementId: projectSettlementId,
      userMessageId: projectUserMessageId,
      assistantMessageId: randomUUID(),
      workspaceId,
      threadId: projectOnlyThreadId,
      requestedByUserId: userId,
      userPrompt: '왜 구조가 발생했는가',
      userText: '왜 구조가 발생했는가',
      assistantText: '',
      runId: null,
      finishState: 'error',
      toolUses: [],
    });
    await expect(store.accept({
      settlementId: projectSettlementId, userMessageId: projectUserMessageId, workspaceId, threadId: projectOnlyThreadId,
      retrievalRunId: projectRetrievalRunId, intentDecision: 'analysis', intentConfidence: 0.9,
      sourceMessageHash: '4'.repeat(64), retrievalSnapshotHash: '5'.repeat(64), policyHash: '6'.repeat(64),
    })).resolves.toEqual({ state: 'ineligible', reason: 'exact_scope_required' });

    const rows = await db.select({ id: schema.consultingInsightShadowTurns.id })
      .from(schema.consultingInsightShadowTurns)
      .where(eq(schema.consultingInsightShadowTurns.workspaceId, workspaceId));
    expect(rows).toHaveLength(2);
  });
});
