import { describe, expect, it } from 'vitest';
import { schema } from '@consulting/db-schema';
import { ConsultingRunTraceService } from '../src/consulting/consulting-run-trace.service.js';

function fakeDb(captured: unknown[], threadRows: Array<{ id: string }> = [{ id: 'thread' }]) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => threadRows,
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (value: unknown) => {
        captured.push({ table, value });
        return {
          returning: async () => [{ id: 'row-1' }],
          onConflictDoNothing: async () => [],
        };
      },
    }),
  };
}

describe('ConsultingRunTraceService', () => {
  it('records local trace spans without external tracing dependencies', async () => {
    expect(schema.traceSpans).toBeDefined();
    const captured: unknown[] = [];
    const service = new ConsultingRunTraceService(fakeDb(captured) as never);

    const span = await service.recordSpan({
      workspaceId: 'ws',
      threadId: 'thread',
      traceId: 'trace-1',
      spanKind: 'retrieval',
      name: 'consulting.graphrag.recall_many',
      durationMs: 42.4,
      input: { queryType: 'fact_lookup' },
      output: { hitCount: 3 },
    });

    expect(span.durationMs).toBe(42);
    expect(span.status).toBe('ok');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual(expect.objectContaining({
      value: expect.objectContaining({ traceId: 'trace-1', spanKind: 'retrieval', durationMs: 42 }),
    }));
  });

  it('normalizes eval cases from failure signals for later CI gates', async () => {
    expect(schema.evalCases).toBeDefined();
    expect(schema.evalRuns).toBeDefined();
    expect(schema.evalScores).toBeDefined();
    const captured: unknown[] = [];
    const service = new ConsultingRunTraceService(fakeDb(captured) as never);

    const row = await service.recordEvalCase({
      workspaceId: 'ws',
      threadId: 'thread',
      caseKind: 'unsupported_claim',
      sourceRef: 'claim:c1',
      prompt: '정원 증가는 인건비 부담을 증가시킨다',
      expected: { minSupport: 1 },
      metadata: { source: 'review_queue' },
    });

    expect(row.status).toBe('active');
    expect(row.caseKind).toBe('unsupported_claim');
    expect(captured[0]).toEqual(expect.objectContaining({
      value: expect.objectContaining({ caseKind: 'unsupported_claim', sourceRef: 'claim:c1', status: 'active' }),
    }));
  });

  it('rejects trace spans whose thread is outside the declared workspace before insert', async () => {
    const captured: unknown[] = [];
    const service = new ConsultingRunTraceService(fakeDb(captured, []) as never);

    await expect(service.recordSpan({
      workspaceId: 'workspace-a',
      threadId: 'thread-b',
      traceId: 'trace-cross-tenant',
      spanKind: 'retrieval',
      name: 'cross tenant trace',
    })).rejects.toThrow(/thread.*workspace/i);
    expect(captured).toHaveLength(0);
  });

  it('rejects eval cases whose thread is outside the declared workspace before insert', async () => {
    const captured: unknown[] = [];
    const service = new ConsultingRunTraceService(fakeDb(captured, []) as never);

    await expect(service.recordEvalCase({
      workspaceId: 'workspace-a',
      threadId: 'thread-b',
      caseKind: 'unsupported_claim',
      sourceRef: 'claim:cross',
      prompt: 'cross tenant prompt',
    })).rejects.toThrow(/thread.*workspace/i);
    expect(captured).toHaveLength(0);
  });
});
