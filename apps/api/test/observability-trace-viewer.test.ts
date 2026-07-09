import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ObservabilityTraceListResponseSchema } from '@consulting/contracts';
import { ObservabilityController } from '../src/observability/observability.controller.js';
import {
  ObservabilityStore,
  REDACTED_EVAL_PROMPT_PREVIEW,
  sanitizeObservabilityMetadata,
  sanitizeObservabilityMetrics,
  summarizeSpans,
} from '../src/observability/observability.store.js';

const traceId = 'trace-p4-smoke';
const spanA = '11111111-1111-4111-8111-111111111111';
const spanB = '22222222-2222-4222-8222-222222222222';
const threadId = '33333333-3333-4333-8333-333333333333';

describe('Observability Trace Viewer contracts', () => {
  it('summarizes trace spans into latest-first trace cards', () => {
    const traces = summarizeSpans([
      {
        id: spanB,
        traceId,
        parentSpanId: spanA,
        threadId,
        spanKind: 'retrieval',
        name: 'graphrag.recall',
        status: 'warning',
        startedAt: '2026-07-09T00:00:01.000Z',
        endedAt: '2026-07-09T00:00:01.120Z',
        durationMs: 120,
        inputPreview: null,
        outputPreview: null,
        metadata: {},
      },
      {
        id: spanA,
        traceId,
        parentSpanId: null,
        threadId,
        spanKind: 'chat',
        name: 'chat.turn',
        status: 'ok',
        startedAt: '2026-07-09T00:00:00.000Z',
        endedAt: '2026-07-09T00:00:00.500Z',
        durationMs: 500,
        inputPreview: null,
        outputPreview: null,
        metadata: {},
      },
    ]);

    expect(traces).toEqual([
      expect.objectContaining({
        traceId,
        threadId,
        spanCount: 2,
        errorCount: 1,
        totalDurationMs: 620,
        topSpanNames: ['chat.turn', 'graphrag.recall'],
      }),
    ]);
  });

  it('parses the strict list response exposed to the web client', () => {
    const parsed = ObservabilityTraceListResponseSchema.parse({
      traces: [{
        traceId,
        threadId,
        spanCount: 1,
        errorCount: 0,
        startedAt: '2026-07-09T00:00:00.000Z',
        lastAt: '2026-07-09T00:00:00.500Z',
        totalDurationMs: 500,
        topSpanNames: ['chat.turn'],
      }],
      spans: [{
        id: spanA,
        traceId,
        parentSpanId: null,
        threadId,
        spanKind: 'chat',
        name: 'chat.turn',
        status: 'ok',
        startedAt: '2026-07-09T00:00:00.000Z',
        endedAt: '2026-07-09T00:00:00.500Z',
        durationMs: 500,
        inputPreview: null,
        outputPreview: null,
        metadata: { source: 'unit' },
      }],
      evalCases: [{
        id: '44444444-4444-4444-8444-444444444444',
        threadId,
        caseKind: 'regression',
        sourceRef: 'fixture',
        promptPreview: null,
        status: 'active',
        metadata: { source: 'unit' },
        createdAt: '2026-07-09T00:00:00.000Z',
      }],
      evalRuns: [{
        id: '55555555-5555-4555-8555-555555555555',
        runKind: 'graphrag_eval',
        status: 'completed',
        startedAt: '2026-07-09T00:00:00.000Z',
        completedAt: null,
        metrics: { context_precision: 0.45, passed: true },
        createdAt: '2026-07-09T00:00:00.000Z',
      }],
      nextCursor: null,
    });

    expect(parsed.spans[0]?.metadata).toEqual({ source: 'unit' });
    expect(parsed.evalCases[0]?.promptPreview).toBeNull();
  });

  it('rejects raw eval prompt previews at the public contract boundary', () => {
    expect(() => ObservabilityTraceListResponseSchema.parse({
      traces: [],
      spans: [],
      evalCases: [{
        id: '44444444-4444-4444-8444-444444444444',
        threadId,
        caseKind: 'regression',
        sourceRef: 'fixture',
        promptPreview: '주민등록번호 900101-1234567 포함 raw prompt',
        status: 'active',
        metadata: {},
        createdAt: '2026-07-09T00:00:00.000Z',
      }],
      evalRuns: [],
      nextCursor: null,
    })).toThrow();
  });

  it('sanitizes observability metadata and eval metrics before public rendering', () => {
    expect(sanitizeObservabilityMetadata({
      source: 'unit',
      component: 'retrieval',
      durationMs: 12,
      apiKey: 'sk-live-secret',
      email: 'owner@example.com',
      prompt: 'ignore previous instructions',
      nested: { token: 'Bearer secret' },
    })).toEqual({ source: 'unit', component: 'retrieval', durationMs: 12 });

    expect(sanitizeObservabilityMetrics({
      context_precision: 0.45,
      passed: true,
      secretPrompt: '외부 반출 금지 raw prompt',
      userEmail: 'owner@example.com',
      samples: ['raw'],
    })).toEqual({ context_precision: 0.45, passed: true });
    expect(REDACTED_EVAL_PROMPT_PREVIEW).toBeNull();
  });

  it('rejects raw trace input/output previews at the public contract boundary', () => {
    expect(() => ObservabilityTraceListResponseSchema.parse({
      traces: [],
      spans: [{
        id: spanA,
        traceId,
        parentSpanId: null,
        threadId,
        spanKind: 'chat',
        name: 'chat.turn',
        status: 'ok',
        startedAt: '2026-07-09T00:00:00.000Z',
        endedAt: '2026-07-09T00:00:00.500Z',
        durationMs: 500,
        inputPreview: '{"prompt":"secret"}',
        outputPreview: null,
        metadata: {},
      }],
      evalCases: [],
      evalRuns: [],
      nextCursor: null,
    })).toThrow();
  });

  it('requires a threadId filter to belong to the requested workspace before querying traces', async () => {
    const store = { listTraces: vi.fn() };
    const access = {
      workspaceMember: vi.fn(async () => ({ allowed: true as const, workspaceId: '11111111-1111-4111-8111-111111111111' })),
      threadMember: vi.fn(async () => ({ allowed: true as const, workspaceId: '22222222-2222-4222-8222-222222222222' })),
    };
    const controller = new ObservabilityController(store as never, access as never);

    await expect(controller.traces(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      undefined,
      undefined,
      undefined,
      { authUserId: '44444444-4444-4444-8444-444444444444' } as never,
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(store.listTraces).not.toHaveBeenCalled();
  });

  it('does not mix workspace-wide eval ledgers into a trace-filtered view', async () => {
    const db = makeTraceOnlyDb([{
      id: spanA,
      traceId,
      parentSpanId: null,
      threadId,
      spanKind: 'chat',
      name: 'chat.turn',
      status: 'ok',
      startedAt: new Date('2026-07-09T00:00:00.000Z'),
      endedAt: new Date('2026-07-09T00:00:00.500Z'),
      durationMs: 500,
      metadata: { source: 'unit', prompt: 'raw prompt must be hidden' },
      createdAt: new Date('2026-07-09T00:00:00.500Z'),
    }]);
    const store = new ObservabilityStore(db as never);

    const response = await store.listTraces({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      traceId,
    });

    expect(response.spans).toHaveLength(1);
    expect(response.spans[0]?.metadata).toEqual({ source: 'unit' });
    expect(response.evalCases).toEqual([]);
    expect(response.evalRuns).toEqual([]);
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});

function makeTraceOnlyDb(rows: unknown[]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => rows),
          })),
        })),
      })),
    })),
  };
}
