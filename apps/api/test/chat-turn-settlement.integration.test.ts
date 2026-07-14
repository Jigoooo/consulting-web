import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { schema } from '@consulting/db-schema';
import { ChatTurnSettlementStore } from '../src/chat/chat-turn-settlement.store.js';
import { ChatTurnSettlementWorker } from '../src/chat/chat-turn-settlement.worker.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

d('chat turn settlement real database recovery', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const channelId = randomUUID();
  const topicId = randomUUID();
  const threadId = randomUUID();
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const settlementId = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    db = drizzle(pool, { schema });
    await db.insert(schema.users).values({ id: userId, email: `${userId}@example.com`, displayName: 'settlement test' });
    await db.insert(schema.workspaces).values({ id: workspaceId, name: 'settlement workspace', slug: `settlement-${workspaceId}`, ownerUserId: userId });
    await db.insert(schema.projects).values({ id: projectId, workspaceId, name: 'project', slug: 'project' });
    await db.insert(schema.channels).values({ id: channelId, workspaceId, projectId, name: 'channel', slug: 'channel' });
    await db.insert(schema.topics).values({ id: topicId, workspaceId, channelId, name: 'topic', slug: 'topic' });
    await db.insert(schema.threads).values({ id: threadId, workspaceId, topicId, title: 'settlement thread' });
    await db.insert(schema.chatMessages).values({
      id: userMessageId,
      workspaceId,
      threadId,
      role: 'user',
      authorUserId: userId,
      content: '질문',
      finishState: 'complete',
    });
  });

  afterAll(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool.end();
  });

  it('rolls back the idempotency key and both transcript rows when capture creation fails', async () => {
    const store = new ChatTurnSettlementStore(db as never);
    const failedSettlementId = randomUUID();
    const failedUserMessageId = randomUUID();
    const failedAssistantMessageId = randomUUID();
    const clientMessageId = randomUUID();
    await pool.query(`
      CREATE OR REPLACE FUNCTION cw_test_reject_capture_begin()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${failedSettlementId}'::uuid THEN
          RAISE EXCEPTION 'forced capture begin failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER cw_test_reject_capture_begin_trigger
      BEFORE INSERT ON chat_turn_settlements
      FOR EACH ROW EXECUTE FUNCTION cw_test_reject_capture_begin();
    `);
    try {
      await expect(store.beginCapture({
        settlementId: failedSettlementId,
        assistantMessageId: failedAssistantMessageId,
        userMessageId: failedUserMessageId,
        workspaceId,
        threadId,
        requestedByUserId: userId,
        userPrompt: '원자성 질문',
        userText: '원자성 질문',
        assistantText: '',
        runId: null,
        finishState: 'error',
        toolUses: [],
        clientMessageId,
        clientRequestHash: 'a'.repeat(64),
      })).rejects.toThrow();
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS cw_test_reject_capture_begin_trigger ON chat_turn_settlements;
        DROP FUNCTION IF EXISTS cw_test_reject_capture_begin();
      `);
    }

    const userRows = await db.select({ id: schema.chatMessages.id })
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, failedUserMessageId));
    const assistantRows = await db.select({ id: schema.chatMessages.id })
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, failedAssistantMessageId));
    expect(userRows).toEqual([]);
    expect(assistantRows).toEqual([]);
    expect(await store.findById(failedSettlementId)).toBeNull();
  });

  it('rejects finalize from an expired capture owner before the recovery sweep', async () => {
    const captureUserMessageId = randomUUID();
    const captureAssistantMessageId = randomUUID();
    const captureSettlementId = randomUUID();
    await db.insert(schema.chatMessages).values({
      id: captureUserMessageId,
      workspaceId,
      threadId,
      role: 'user',
      authorUserId: userId,
      content: '만료 capture 질문',
      finishState: 'complete',
    });
    const store = new ChatTurnSettlementStore(db as never);
    const input = {
      settlementId: captureSettlementId,
      assistantMessageId: captureAssistantMessageId,
      userMessageId: captureUserMessageId,
      workspaceId,
      threadId,
      requestedByUserId: userId,
      userPrompt: '만료 capture 질문',
      userText: '만료 capture 질문',
      assistantText: '',
      runId: null,
      finishState: 'error' as const,
      toolUses: [],
    };
    const capture = await store.beginCapture(input);
    expect(capture.state).toBe('started');
    if (capture.state !== 'started') throw new Error('expected a fresh capture');
    const expiredAt = new Date(Date.now() - 60_000);
    await db.update(schema.chatTurnSettlements)
      .set({ leaseExpiresAt: expiredAt })
      .where(eq(schema.chatTurnSettlements.id, captureSettlementId));

    await expect(store.finalizeCapture({
      ...input,
      assistantText: '만료 후 늦게 도착한 답변',
      runId: 'run_expired_capture',
      finishState: 'complete',
    }, capture.leaseToken)).rejects.toThrow(/lease/i);

    expect(await store.findById(captureSettlementId)).toEqual(expect.objectContaining({
      status: 'capturing',
      assistantText: '',
    }));
    const events = await db.select({ id: schema.outboxEvents.id })
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.idempotencyKey, `chat-turn-settlement:${captureSettlementId}:attempt:0`));
    expect(events).toEqual([]);
  });

  it('rejects settlement id drift for an existing assistant message without orphaning an outbox event', async () => {
    const conflictUserMessageId = randomUUID();
    const conflictAssistantMessageId = randomUUID();
    const firstSettlementId = randomUUID();
    const losingSettlementId = randomUUID();
    await db.insert(schema.chatMessages).values({
      id: conflictUserMessageId,
      workspaceId,
      threadId,
      role: 'user',
      authorUserId: userId,
      content: 'settlement provenance 질문',
      finishState: 'complete',
    });
    const store = new ChatTurnSettlementStore(db as never);
    const request = {
      settlementId: firstSettlementId,
      assistantMessageId: conflictAssistantMessageId,
      userMessageId: conflictUserMessageId,
      workspaceId,
      threadId,
      requestedByUserId: userId,
      userPrompt: 'settlement provenance 질문',
      userText: 'settlement provenance 질문',
      assistantText: 'settlement provenance 답변',
      runId: 'run_settlement_provenance',
      finishState: 'complete' as const,
      toolUses: [],
    };
    await store.requestSettlement(request);

    await expect(store.requestSettlement({
      ...request,
      settlementId: losingSettlementId,
    })).rejects.toThrow(/provenance|conflict/i);

    const orphanEvents = await db.select({ id: schema.outboxEvents.id })
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.idempotencyKey, `chat-turn-settlement:${losingSettlementId}:attempt:0`));
    expect(orphanEvents).toEqual([]);
  });

  it('preserves successful steps and retries only evidence after a partial failure', async () => {
    const store = new ChatTurnSettlementStore(db as never);
    await store.requestSettlement({
      settlementId,
      assistantMessageId,
      userMessageId,
      workspaceId,
      threadId,
      requestedByUserId: userId,
      userPrompt: '질문',
      userText: '질문',
      assistantText: '검증된 답변',
      runId: 'run_real_settlement',
      finishState: 'complete',
      toolUses: [{ tool: 'web_search', preview: '공식 통계' }],
    });

    const evidence = {
      saveRunEvidence: vi.fn()
        .mockRejectedValueOnce(new Error('temporary evidence outage'))
        .mockResolvedValueOnce(undefined),
    };
    const decisions = {
      prepareCompletedAnswer: vi.fn(async () => ({ prepared: true })),
      persistCompletedAnswer: vi.fn(async () => ({ verifiedContradictions: [] })),
    };
    const webIngest = { ingestCompletedTurn: vi.fn(async () => undefined) };
    const notifications = { notifyWorkspace: vi.fn(async () => 1) };
    const worker = new ChatTurnSettlementWorker(
      { REDIS_URL: 'redis://127.0.0.1:6379' } as never,
      store,
      evidence as never,
      decisions as never,
      webIngest as never,
      notifications as never,
    );
    const job = {
      eventId: randomUUID(),
      eventType: 'ChatTurnSettlementRequested',
      workspaceId,
      aggregateType: 'thread',
      aggregateId: threadId,
      payload: { settlementId, assistantMessageId, threadId },
    };

    await worker.processOutboxJob(job);
    const afterFirst = await store.findById(settlementId);
    expect(afterFirst).toEqual(expect.objectContaining({
      status: 'pending',
      evidenceStatus: 'pending',
      verificationStatus: 'completed',
      brainStatus: 'completed',
      notificationStatus: 'completed',
      attemptCount: 1,
    }));
    const [retryEvent] = await db
      .select({ idempotencyKey: schema.outboxEvents.idempotencyKey, nextAttemptAt: schema.outboxEvents.nextAttemptAt })
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.idempotencyKey, `chat-turn-settlement:${settlementId}:attempt:1`))
      .limit(1);
    expect(retryEvent?.nextAttemptAt).toBeInstanceOf(Date);

    await worker.processOutboxJob({ ...job, eventId: randomUUID() });

    expect(await store.findById(settlementId)).toEqual(expect.objectContaining({
      status: 'completed',
      evidenceStatus: 'completed',
      verificationStatus: 'completed',
      brainStatus: 'completed',
      notificationStatus: 'completed',
      attemptCount: 1,
      lastError: null,
    }));
    expect(evidence.saveRunEvidence).toHaveBeenCalledTimes(2);
    expect(decisions.prepareCompletedAnswer).toHaveBeenCalledTimes(1);
    expect(decisions.persistCompletedAnswer).toHaveBeenCalledTimes(1);
    expect(webIngest.ingestCompletedTurn).toHaveBeenCalledTimes(1);
    expect(notifications.notifyWorkspace).toHaveBeenCalledTimes(1);
  });

  it('treats a cascade-deleted settlement claim as terminal', async () => {
    const missingStore = new ChatTurnSettlementStore(db as never);
    await expect(missingStore.claimAttempt(randomUUID())).resolves.toEqual({ state: 'terminal' });
  });

  it('recovers a checkpointed partial transcript after terminal persistence failure and process loss', async () => {
    const captureUserMessageId = randomUUID();
    const captureAssistantMessageId = randomUUID();
    const captureSettlementId = randomUUID();
    await db.insert(schema.chatMessages).values({
      id: captureUserMessageId,
      workspaceId,
      threadId,
      role: 'user',
      authorUserId: userId,
      content: '중단 복구 질문',
      finishState: 'complete',
    });
    const store = new ChatTurnSettlementStore(db as never);
    const base = {
      settlementId: captureSettlementId,
      assistantMessageId: captureAssistantMessageId,
      userMessageId: captureUserMessageId,
      workspaceId,
      threadId,
      requestedByUserId: userId,
      userPrompt: '중단 복구 질문',
      userText: '중단 복구 질문',
      assistantText: '',
      runId: null,
      finishState: 'error' as const,
      toolUses: [],
    };
    const capture = await store.beginCapture(base);
    expect(capture.state).toBe('started');
    if (capture.state !== 'started') throw new Error('expected a fresh capture');
    const captureLeaseToken = capture.leaseToken;
    await store.checkpointCapture({
      ...base,
      assistantText: '클라이언트에 보인 partial',
      runId: 'run_capture_recovery',
      toolUses: [{ tool: 'web_search', preview: 'checkpointed evidence' }],
    }, captureLeaseToken);

    await pool.query(`
      CREATE OR REPLACE FUNCTION cw_test_reject_capture_finalize()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.idempotency_key = 'chat-turn-settlement:${captureSettlementId}:attempt:0' THEN
          RAISE EXCEPTION 'forced capture finalize failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER cw_test_reject_capture_finalize_trigger
      BEFORE INSERT ON outbox_events
      FOR EACH ROW EXECUTE FUNCTION cw_test_reject_capture_finalize();
    `);
    try {
      await expect(store.finalizeCapture({
        ...base,
        assistantText: '클라이언트에 보인 partial',
        runId: 'run_capture_recovery',
        finishState: 'cancelled',
        toolUses: [{ tool: 'web_search', preview: 'checkpointed evidence' }],
      }, captureLeaseToken)).rejects.toThrow();
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS cw_test_reject_capture_finalize_trigger ON outbox_events;
        DROP FUNCTION IF EXISTS cw_test_reject_capture_finalize();
      `);
    }

    expect(await store.findById(captureSettlementId)).toEqual(expect.objectContaining({
      status: 'capturing',
      assistantText: '클라이언트에 보인 partial',
      runId: 'run_capture_recovery',
    }));
    const expiredAt = new Date(Date.now() - 300_000);
    await db.update(schema.chatTurnSettlements)
      .set({ leaseExpiresAt: expiredAt, updatedAt: expiredAt })
      .where(eq(schema.chatTurnSettlements.id, captureSettlementId));

    expect(await store.recoverStalledSettlements(new Date(Date.now() - 60_000))).toBe(1);
    expect(await store.findById(captureSettlementId)).toEqual(expect.objectContaining({
      status: 'pending',
      finishState: 'cancelled',
      assistantText: '클라이언트에 보인 partial',
      verificationStatus: 'skipped',
      brainStatus: 'skipped',
      notificationStatus: 'skipped',
    }));
    const [assistant] = await db.select().from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, captureAssistantMessageId));
    expect(assistant).toEqual(expect.objectContaining({
      content: '클라이언트에 보인 partial',
      finishState: 'cancelled',
      runId: 'run_capture_recovery',
    }));
    const [recoveryEvent] = await db.select({ idempotencyKey: schema.outboxEvents.idempotencyKey })
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.idempotencyKey, `chat-turn-settlement:${captureSettlementId}:capture-recovery:1`));
    expect(recoveryEvent?.idempotencyKey).toBe(`chat-turn-settlement:${captureSettlementId}:capture-recovery:1`);
  });

  it('rejects a brain step whose lease expires during the side effect', async () => {
    const staleUserMessageId = randomUUID();
    const staleAssistantMessageId = randomUUID();
    const staleSettlementId = randomUUID();
    await db.insert(schema.chatMessages).values({
      id: staleUserMessageId,
      workspaceId,
      threadId,
      role: 'user',
      authorUserId: userId,
      content: '장기 brain 질문',
      finishState: 'complete',
    });
    const store = new ChatTurnSettlementStore(db as never);
    await store.requestSettlement({
      settlementId: staleSettlementId,
      assistantMessageId: staleAssistantMessageId,
      userMessageId: staleUserMessageId,
      workspaceId,
      threadId,
      requestedByUserId: userId,
      userPrompt: '장기 brain 질문',
      userText: '장기 brain 질문',
      assistantText: '장기 brain 답변',
      runId: 'run_expired_brain',
      finishState: 'complete',
      toolUses: [],
    });
    const claim = await store.claimAttempt(staleSettlementId);
    expect(claim.state).toBe('claimed');
    if (claim.state !== 'claimed') throw new Error('expected claimed settlement');

    await expect(store.runBrainStep(staleSettlementId, claim.leaseToken, async () => {
      await db.update(schema.chatTurnSettlements)
        .set({ leaseExpiresAt: new Date(Date.now() - 60_000) })
        .where(eq(schema.chatTurnSettlements.id, staleSettlementId));
    })).rejects.toThrow(/lease/i);

    expect(await store.findById(staleSettlementId)).toEqual(expect.objectContaining({
      status: 'processing',
      brainStatus: 'pending',
      leaseToken: claim.leaseToken,
    }));
  });

  it('rejects finish from an expired processing owner before the recovery sweep', async () => {
    const staleUserMessageId = randomUUID();
    const staleAssistantMessageId = randomUUID();
    const staleSettlementId = randomUUID();
    await db.insert(schema.chatMessages).values({
      id: staleUserMessageId,
      workspaceId,
      threadId,
      role: 'user',
      authorUserId: userId,
      content: '만료 worker 질문',
      finishState: 'complete',
    });
    const store = new ChatTurnSettlementStore(db as never);
    await store.requestSettlement({
      settlementId: staleSettlementId,
      assistantMessageId: staleAssistantMessageId,
      userMessageId: staleUserMessageId,
      workspaceId,
      threadId,
      requestedByUserId: userId,
      userPrompt: '만료 worker 질문',
      userText: '만료 worker 질문',
      assistantText: '만료 worker 답변',
      runId: 'run_expired_worker',
      finishState: 'complete',
      toolUses: [],
    });
    const claim = await store.claimAttempt(staleSettlementId);
    expect(claim.state).toBe('claimed');
    if (claim.state !== 'claimed') throw new Error('expected claimed settlement');
    const expiredAt = new Date(Date.now() - 60_000);
    await db.update(schema.chatTurnSettlements)
      .set({ leaseExpiresAt: expiredAt })
      .where(eq(schema.chatTurnSettlements.id, staleSettlementId));

    await expect(store.finishAttempt(
      staleSettlementId,
      claim.leaseToken,
      { evidence: 'late worker result' },
    )).rejects.toThrow(/lease/i);

    expect(await store.findById(staleSettlementId)).toEqual(expect.objectContaining({
      status: 'processing',
      attemptCount: 0,
      leaseToken: claim.leaseToken,
    }));
  });

  it('recovers an expired processing lease and fences the stale worker token', async () => {
    const staleUserMessageId = randomUUID();
    const staleAssistantMessageId = randomUUID();
    const staleSettlementId = randomUUID();
    await db.insert(schema.chatMessages).values({
      id: staleUserMessageId,
      workspaceId,
      threadId,
      role: 'user',
      authorUserId: userId,
      content: '복구 질문',
      finishState: 'complete',
    });
    const store = new ChatTurnSettlementStore(db as never);
    await store.requestSettlement({
      settlementId: staleSettlementId,
      assistantMessageId: staleAssistantMessageId,
      userMessageId: staleUserMessageId,
      workspaceId,
      threadId,
      requestedByUserId: userId,
      userPrompt: '복구 질문',
      userText: '복구 질문',
      assistantText: '복구 답변',
      runId: 'run_recovery',
      finishState: 'complete',
      toolUses: [],
    });

    const staleClaim = await store.claimAttempt(staleSettlementId);
    expect(staleClaim.state).toBe('claimed');
    if (staleClaim.state !== 'claimed') throw new Error('expected claimed settlement');
    const expiredAt = new Date(Date.now() - 300_000);
    await db
      .update(schema.chatTurnSettlements)
      .set({ leaseExpiresAt: expiredAt, updatedAt: expiredAt })
      .where(eq(schema.chatTurnSettlements.id, staleSettlementId));
    await db
      .update(schema.outboxEvents)
      .set({ status: 'published', updatedAt: expiredAt })
      .where(eq(schema.outboxEvents.idempotencyKey, `chat-turn-settlement:${staleSettlementId}:attempt:0`));

    expect(await store.recoverStalledSettlements(new Date(Date.now() - 60_000))).toBe(1);
    const [recoveryEvent] = await db
      .select({ idempotencyKey: schema.outboxEvents.idempotencyKey })
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.idempotencyKey, `chat-turn-settlement:${staleSettlementId}:recovery:1`))
      .limit(1);
    expect(recoveryEvent?.idempotencyKey).toBe(`chat-turn-settlement:${staleSettlementId}:recovery:1`);
    expect(await store.heartbeatAttempt(staleSettlementId, staleClaim.leaseToken)).toBe(false);
    expect((await store.claimAttempt(staleSettlementId)).state).toBe('claimed');
  });

  it('rejects a malformed verifier snapshot before it can poison the settlement ledger', async () => {
    const poisonUserMessageId = randomUUID();
    const poisonAssistantMessageId = randomUUID();
    const poisonSettlementId = randomUUID();
    await db.insert(schema.chatMessages).values({
      id: poisonUserMessageId,
      workspaceId,
      threadId,
      role: 'user',
      authorUserId: userId,
      content: '검증 스냅샷 질문',
      finishState: 'complete',
    });
    const store = new ChatTurnSettlementStore(db as never);
    await store.requestSettlement({
      settlementId: poisonSettlementId,
      assistantMessageId: poisonAssistantMessageId,
      userMessageId: poisonUserMessageId,
      workspaceId,
      threadId,
      requestedByUserId: userId,
      userPrompt: '검증 스냅샷 질문',
      userText: '검증 스냅샷 질문',
      assistantText: '검증 스냅샷 답변',
      runId: 'run_verifier_snapshot_poison',
      finishState: 'complete',
      toolUses: [],
    });
    const attempt = await store.claimAttempt(poisonSettlementId);
    expect(attempt.state).toBe('claimed');
    if (attempt.state !== 'claimed') throw new Error('expected claimed settlement');
    const verification = await store.claimVerificationStep(poisonSettlementId, attempt.leaseToken);
    expect(verification.state).toBe('claimed');
    if (verification.state !== 'claimed') throw new Error('expected claimed verification step');

    await expect(store.completeVerificationStep(
      poisonSettlementId,
      attempt.leaseToken,
      verification.leaseToken,
      async () => ({
        verifiedContradictions: [{
          verdictRef: 'assistant:poison:claim',
          claimId: 'claim-poison',
          claimText: '검증 대상 주장',
          verdict: 'refutes',
          confidence: 2,
          rationale: '범위를 벗어난 confidence',
          evidenceItemId: 'evidence-poison',
          evidenceRef: 'EV-POISON',
          evidenceText: '검증 근거',
        }],
      }),
    )).rejects.toThrow(/verified contradiction/i);

    expect(await store.findById(poisonSettlementId)).toEqual(expect.objectContaining({
      verificationStatus: 'processing',
      verifiedContradictions: [],
    }));
  });
});
