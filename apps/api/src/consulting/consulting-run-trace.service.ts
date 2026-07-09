import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

export type TraceSpanStatus = 'ok' | 'error' | 'blocked' | 'skipped';
export type TraceSpanKind =
  | 'intent'
  | 'scope_fanout'
  | 'retrieval'
  | 'rerank'
  | 'crag'
  | 'hermes_run'
  | 'claim_extraction'
  | 'verifier'
  | 'exactness'
  | 'memory_policy'
  | 'artifact_gate';

export interface TraceSpanInput {
  workspaceId: string;
  threadId?: string | null;
  traceId: string;
  parentSpanId?: string | null;
  spanKind: TraceSpanKind;
  name: string;
  status?: TraceSpanStatus;
  startedAt?: Date;
  endedAt?: Date | null;
  durationMs?: number;
  input?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

export interface NormalizedTraceSpan extends Required<Omit<TraceSpanInput, 'threadId' | 'parentSpanId' | 'endedAt' | 'input' | 'output' | 'metadata'>> {
  threadId: string | null;
  parentSpanId: string | null;
  endedAt: Date | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
}

export type EvalCaseKind = 'retrieval_failure' | 'unsupported_claim' | 'refuted_claim' | 'exactness_blocked' | 'human_feedback' | 'artifact_export_blocker';

export interface EvalCaseInput {
  workspaceId: string;
  threadId?: string | null;
  caseKind: EvalCaseKind;
  sourceRef: string;
  prompt: string;
  expected?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class ConsultingRunTraceService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  normalizeSpan(input: TraceSpanInput): NormalizedTraceSpan {
    const startedAt = input.startedAt ?? new Date();
    const endedAt = input.endedAt === undefined ? new Date(startedAt.getTime() + Math.max(0, Math.round(input.durationMs ?? 0))) : input.endedAt;
    const durationMs = input.durationMs ?? (endedAt ? endedAt.getTime() - startedAt.getTime() : 0);
    return {
      workspaceId: input.workspaceId,
      threadId: input.threadId ?? null,
      traceId: input.traceId,
      parentSpanId: input.parentSpanId ?? null,
      spanKind: input.spanKind,
      name: input.name,
      status: input.status ?? 'ok',
      startedAt,
      endedAt,
      durationMs: Math.max(0, Math.round(durationMs)),
      input: input.input ?? null,
      output: input.output ?? null,
      metadata: input.metadata ?? {},
    };
  }

  async recordSpan(input: TraceSpanInput): Promise<NormalizedTraceSpan> {
    const span = this.normalizeSpan(input);
    await this.assertThreadInWorkspace(span.workspaceId, span.threadId);
    try {
      await this.db.insert(schema.traceSpans).values({
        workspaceId: span.workspaceId,
        threadId: span.threadId,
        traceId: span.traceId,
        parentSpanId: span.parentSpanId,
        spanKind: span.spanKind,
        name: span.name,
        status: span.status,
        startedAt: span.startedAt,
        endedAt: span.endedAt,
        durationMs: span.durationMs,
        input: span.input,
        output: span.output,
        metadata: span.metadata,
      });
    } catch (error) {
      if (!isMissingTraceTable(error)) throw error;
    }
    return span;
  }

  normalizeEvalCase(input: EvalCaseInput): Required<Omit<EvalCaseInput, 'threadId' | 'expected' | 'metadata'>> & {
    threadId: string | null;
    expected: Record<string, unknown>;
    metadata: Record<string, unknown>;
    status: 'active';
  } {
    return {
      workspaceId: input.workspaceId,
      threadId: input.threadId ?? null,
      caseKind: input.caseKind,
      sourceRef: input.sourceRef,
      prompt: input.prompt,
      expected: input.expected ?? {},
      metadata: input.metadata ?? {},
      status: 'active',
    };
  }

  async recordEvalCase(input: EvalCaseInput): Promise<ReturnType<ConsultingRunTraceService['normalizeEvalCase']>> {
    const row = this.normalizeEvalCase(input);
    await this.assertThreadInWorkspace(row.workspaceId, row.threadId);
    try {
      await this.db.insert(schema.evalCases).values({
        workspaceId: row.workspaceId,
        threadId: row.threadId,
        caseKind: row.caseKind,
        sourceRef: row.sourceRef,
        prompt: row.prompt,
        expected: row.expected,
        status: row.status,
        metadata: row.metadata,
      });
    } catch (error) {
      if (!isMissingTraceTable(error)) throw error;
    }
    return row;
  }

  private async assertThreadInWorkspace(workspaceId: string, threadId: string | null): Promise<void> {
    if (!threadId) return;
    const [thread] = await this.db
      .select({ id: schema.threads.id })
      .from(schema.threads)
      .where(and(
        eq(schema.threads.id, threadId),
        eq(schema.threads.workspaceId, workspaceId),
        isNull(schema.threads.deletedAt),
      ))
      .limit(1);
    if (!thread) throw new Error('trace thread/workspace mismatch');
  }
}

function isMissingTraceTable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const row = error as { code?: unknown; message?: unknown };
  if (row.code === '42P01') return true;
  const message = typeof row.message === 'string' ? row.message : '';
  return /relation .*(trace_spans|eval_cases|eval_runs|eval_scores).* does not exist|no such table: (trace_spans|eval_cases|eval_runs|eval_scores)/iu.test(message);
}
