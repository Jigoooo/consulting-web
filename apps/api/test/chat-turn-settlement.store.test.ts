import { describe, expect, it, vi } from 'vitest';
import { schema } from '@consulting/db-schema';
import { ChatTurnSettlementStore, parseStoredVerifiedContradictions } from '../src/chat/chat-turn-settlement.store.js';

describe('ChatTurnSettlementStore', () => {
  it('fails closed when a persisted verifier snapshot is malformed', () => {
    expect(() => parseStoredVerifiedContradictions([{
      verdictRef: 'assistant:message:claim',
      claimId: 'claim',
      verdict: 'supports',
    }])).toThrow(/verified contradiction/i);
  });

  it('retries a transient transaction failure and atomically records answer, ledger, and outbox with stable ids', async () => {
    const writes: Array<{ table: unknown; values: unknown }> = [];
    const selectedRows = [
      [{
        workspaceId: '10000000-0000-4000-8000-000000000004',
        threadId: '10000000-0000-4000-8000-000000000005',
        role: 'user',
        authorUserId: '10000000-0000-4000-8000-000000000006',
        content: '정원 영향을 검토해줘',
      }],
      [{
        workspaceId: '10000000-0000-4000-8000-000000000004',
        threadId: '10000000-0000-4000-8000-000000000005',
        role: 'assistant',
        authorUserId: null,
        content: '정원 증가는 인건비에 영향을 줍니다.',
        runId: 'run_settlement_1',
        finishState: 'complete',
      }],
      [{
        id: '10000000-0000-4000-8000-000000000001',
        workspaceId: '10000000-0000-4000-8000-000000000004',
        threadId: '10000000-0000-4000-8000-000000000005',
        userMessageId: '10000000-0000-4000-8000-000000000003',
        assistantMessageId: '10000000-0000-4000-8000-000000000002',
        requestedByUserId: '10000000-0000-4000-8000-000000000006',
        userPrompt: '정원 영향을 검토해줘',
        userText: '정원 영향을 검토해줘',
        assistantText: '정원 증가는 인건비에 영향을 줍니다.',
        runId: 'run_settlement_1',
        finishState: 'complete',
        toolUses: [{ tool: 'web_search', preview: '공식 통계' }],
      }],
    ];
    const select = vi.fn(() => {
      const chain = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        for: vi.fn(() => chain),
        limit: vi.fn(async () => selectedRows.shift() ?? []),
      };
      return chain;
    });
    const tx = {
      select,
      insert: vi.fn((table: unknown) => ({
        values: vi.fn((values: unknown) => ({
          onConflictDoNothing: vi.fn(async () => {
            writes.push({ table, values });
          }),
        })),
      })),
    };
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary database disconnect'))
      .mockImplementationOnce(async (operation: (executor: typeof tx) => Promise<void>) => operation(tx));
    const store = new ChatTurnSettlementStore({ transaction } as never);

    await store.requestSettlement({
      settlementId: '10000000-0000-4000-8000-000000000001',
      assistantMessageId: '10000000-0000-4000-8000-000000000002',
      userMessageId: '10000000-0000-4000-8000-000000000003',
      workspaceId: '10000000-0000-4000-8000-000000000004',
      threadId: '10000000-0000-4000-8000-000000000005',
      requestedByUserId: '10000000-0000-4000-8000-000000000006',
      userPrompt: '정원 영향을 검토해줘',
      userText: '정원 영향을 검토해줘',
      assistantText: '정원 증가는 인건비에 영향을 줍니다.',
      runId: 'run_settlement_1',
      finishState: 'complete',
      toolUses: [{ tool: 'web_search', preview: '공식 통계' }],
    });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(writes.map((entry) => entry.table)).toEqual([
      schema.chatMessages,
      schema.chatTurnSettlements,
      schema.outboxEvents,
    ]);
    expect(writes[0]!.values).toEqual(expect.objectContaining({
      id: '10000000-0000-4000-8000-000000000002',
      role: 'assistant',
      content: '정원 증가는 인건비에 영향을 줍니다.',
    }));
    expect(writes[1]!.values).toEqual(expect.objectContaining({
      id: '10000000-0000-4000-8000-000000000001',
      assistantMessageId: '10000000-0000-4000-8000-000000000002',
      evidenceStatus: 'pending',
      verificationStatus: 'pending',
      brainStatus: 'pending',
      notificationStatus: 'pending',
    }));
    expect(writes[2]!.values).toEqual(expect.objectContaining({
      eventType: 'ChatTurnSettlementRequested',
      aggregateId: '10000000-0000-4000-8000-000000000005',
      idempotencyKey: 'chat-turn-settlement:10000000-0000-4000-8000-000000000001:attempt:0',
    }));
  });
});
