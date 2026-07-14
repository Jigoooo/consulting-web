import { describe, expect, it, vi } from 'vitest';
import { ChatTurnSettlementWorker } from '../src/chat/chat-turn-settlement.worker.js';

const SETTLEMENT_ID = '20000000-0000-4000-8000-000000000001';
const MESSAGE_ID = '20000000-0000-4000-8000-000000000002';
const THREAD_ID = '20000000-0000-4000-8000-000000000003';
const WORKSPACE_ID = '20000000-0000-4000-8000-000000000004';

function job(eventType = 'ChatTurnSettlementRequested') {
  return {
    eventId: '20000000-0000-4000-8000-000000000005',
    eventType,
    workspaceId: WORKSPACE_ID,
    aggregateType: 'thread',
    aggregateId: THREAD_ID,
    payload: { settlementId: SETTLEMENT_ID, assistantMessageId: MESSAGE_ID, threadId: THREAD_ID },
  };
}

describe('ChatTurnSettlementWorker', () => {
  it('continues verifier, brain ingest, and notification when evidence persistence fails, then durably schedules only unfinished work', async () => {
    const verificationOrder: string[] = [];
    const settlement = {
      id: SETTLEMENT_ID,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      assistantMessageId: MESSAGE_ID,
      requestedByUserId: '20000000-0000-4000-8000-000000000006',
      userPrompt: '정원 영향을 검토해줘',
      userText: '정원 영향을 검토해줘',
      assistantText: '정원 증가는 인건비 부담을 높입니다.',
      runId: 'run_settlement_2',
      finishState: 'complete',
      toolUses: [{ tool: 'web_search', preview: '공식 통계' }],
      status: 'pending',
      evidenceStatus: 'pending',
      verificationStatus: 'pending',
      brainStatus: 'pending',
      notificationStatus: 'pending',
      verifiedContradictions: [],
    };
    const store = {
      findById: vi.fn(async () => settlement),
      claimAttempt: vi.fn(async () => ({ state: 'claimed', leaseToken: 'attempt-lease-1', settlement })),
      heartbeatAttempt: vi.fn(async () => true),
      runEvidenceStep: vi.fn(async (_id: string, _attemptLeaseToken: string, operation: (db: unknown) => Promise<void>) => operation({})),
      claimVerificationStep: vi.fn(async () => ({ state: 'claimed', leaseToken: 'verification-lease-1' })),
      completeVerificationStep: vi.fn(async (
        _id: string,
        _attemptLeaseToken: string,
        _verificationLeaseToken: string,
        operation: (db: unknown) => Promise<{ verifiedContradictions: unknown[] }>,
      ) => {
        verificationOrder.push('transaction-start');
        const result = await operation({});
        verificationOrder.push('transaction-end');
        return result.verifiedContradictions;
      }),
      releaseVerificationStep: vi.fn(async () => undefined),
      runNotificationStep: vi.fn(async (_id: string, _attemptLeaseToken: string, operation: (db: unknown) => Promise<void>) => operation({})),
      runBrainStep: vi.fn(async (_id: string, _attemptLeaseToken: string, operation: () => Promise<void>) => operation()),
      finishAttempt: vi.fn(async () => undefined),
    };
    const evidence = { saveRunEvidence: vi.fn(async () => { throw new Error('evidence db timeout'); }) };
    const verifiedContradictions = [{
      verdictRef: `assistant:${MESSAGE_ID}:MSG-1`,
      claimId: 'MSG-1',
      claimText: '부담이 높아진다',
      verdict: 'refutes',
      confidence: 0.9,
      rationale: 'counter evidence',
      evidenceItemId: '20000000-0000-4000-8000-000000000007',
      evidenceRef: 'EV-1',
      evidenceText: '부담이 낮아졌다',
    }];
    const prepared = { marker: 'prepared-outside-transaction' };
    const decisions = {
      prepareCompletedAnswer: vi.fn(async () => {
        verificationOrder.push('prepare');
        return prepared;
      }),
      persistCompletedAnswer: vi.fn(async (_input: unknown, received: unknown, _db: unknown) => {
        verificationOrder.push('persist');
        expect(received).toBe(prepared);
        return { verifiedContradictions };
      }),
    };
    const webIngest = { ingestCompletedTurn: vi.fn(async () => undefined) };
    const notifications = { notifyWorkspace: vi.fn(async () => 1) };
    const worker = new ChatTurnSettlementWorker(
      { REDIS_URL: 'redis://127.0.0.1:6379' } as never,
      store as never,
      evidence as never,
      decisions as never,
      webIngest as never,
      notifications as never,
    );

    await worker.processOutboxJob(job());

    expect(decisions.persistCompletedAnswer).toHaveBeenCalledOnce();
    expect(verificationOrder).toEqual(['prepare', 'transaction-start', 'persist', 'transaction-end']);
    expect(webIngest.ingestCompletedTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: THREAD_ID,
      assistantMessageId: MESSAGE_ID,
      verifiedContradictions,
    }));
    expect(notifications.notifyWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ dedupKey: `chat-settlement:${SETTLEMENT_ID}:assistant-reply` }),
      expect.anything(),
    );
    expect(store.finishAttempt).toHaveBeenCalledWith(SETTLEMENT_ID, 'attempt-lease-1', {
      evidence: 'evidence db timeout',
    });
  });

  it('acknowledges a queued job whose settlement was cascade-deleted', async () => {
    const store = {
      findById: vi.fn(async () => null),
      claimAttempt: vi.fn(),
    };
    const worker = new ChatTurnSettlementWorker(
      { REDIS_URL: 'redis://127.0.0.1:6379' } as never,
      store as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(worker.processOutboxJob(job())).resolves.toBeUndefined();
    expect(store.claimAttempt).not.toHaveBeenCalled();
  });

  it('fails closed for an incompatible outbox event before touching the ledger', async () => {
    const store = { findById: vi.fn() };
    const worker = new ChatTurnSettlementWorker(
      { REDIS_URL: 'redis://127.0.0.1:6379' } as never,
      store as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(worker.processOutboxJob(job('WorkspaceCreated'))).rejects.toThrow(/unsupported outbox event/i);
    expect(store.findById).not.toHaveBeenCalled();
  });
});
