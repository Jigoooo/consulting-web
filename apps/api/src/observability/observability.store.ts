import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, desc, eq, isNull, lt, type SQL } from 'drizzle-orm';
import type {
  EvalCaseItem,
  EvalRunItem,
  ObservabilityTraceListResponse,
  TraceSpanItem,
  TraceSummary,
} from '@consulting/contracts';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 200;
export const REDACTED_EVAL_PROMPT_PREVIEW = null;

const SENSITIVE_KEY_RE = /(api[_-]?key|authorization|bearer|cookie|secret|token|password|passwd|email|phone|ssn|resident|주민|prompt|input|output|payload|content|body|pii)/i;
const SENSITIVE_VALUE_RE = /(bearer\s+\S+|sk-[a-z0-9_-]+|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|\d{6}-\d{7})/i;

export interface ObservabilityTraceQuery {
  workspaceId: string;
  threadId?: string | undefined;
  traceId?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

@Injectable()
export class ObservabilityStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listTraces(query: ObservabilityTraceQuery): Promise<ObservabilityTraceListResponse> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const conds: SQL[] = [eq(schema.traceSpans.workspaceId, query.workspaceId), isNull(schema.traceSpans.deletedAt)];
    if (query.threadId) conds.push(eq(schema.traceSpans.threadId, query.threadId));
    if (query.traceId) conds.push(eq(schema.traceSpans.traceId, query.traceId));
    const cursorDate = decodeCursor(query.cursor);
    if (cursorDate) conds.push(lt(schema.traceSpans.createdAt, cursorDate));

    const spanRows = await this.db
      .select({
        id: schema.traceSpans.id,
        traceId: schema.traceSpans.traceId,
        parentSpanId: schema.traceSpans.parentSpanId,
        threadId: schema.traceSpans.threadId,
        spanKind: schema.traceSpans.spanKind,
        name: schema.traceSpans.name,
        status: schema.traceSpans.status,
        startedAt: schema.traceSpans.startedAt,
        endedAt: schema.traceSpans.endedAt,
        durationMs: schema.traceSpans.durationMs,
        metadata: schema.traceSpans.metadata,
        createdAt: schema.traceSpans.createdAt,
      })
      .from(schema.traceSpans)
      .where(and(...conds))
      .orderBy(desc(schema.traceSpans.createdAt))
      .limit(limit + 1);

    const pageRows = spanRows.slice(0, limit);
    const spans: TraceSpanItem[] = pageRows.map((row) => ({
      id: row.id,
      traceId: row.traceId,
      parentSpanId: row.parentSpanId,
      threadId: row.threadId,
      spanKind: row.spanKind,
      name: row.name,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt?.toISOString() ?? null,
      durationMs: Math.max(0, row.durationMs ?? 0),
      inputPreview: null,
      outputPreview: null,
      metadata: sanitizeObservabilityMetadata(row.metadata),
    }));

    const evalCases = query.traceId ? [] : await this.listEvalCases(query.workspaceId, query.threadId);
    const evalRuns = await this.listEvalRuns(query.workspaceId, {
      ...(query.threadId ? { threadId: query.threadId } : {}),
      ...(query.traceId ? { traceId: query.traceId } : {}),
    });
    const nextCursor = spanRows.length > limit && pageRows.length > 0
      ? `${pageRows[pageRows.length - 1]!.createdAt.toISOString()}|${pageRows[pageRows.length - 1]!.id}`
      : null;

    return {
      traces: summarizeSpans(spans),
      spans,
      evalCases,
      evalRuns,
      nextCursor,
    };
  }

  private async listEvalCases(workspaceId: string, threadId?: string): Promise<EvalCaseItem[]> {
    const conds: SQL[] = [eq(schema.evalCases.workspaceId, workspaceId), isNull(schema.evalCases.deletedAt)];
    if (threadId) conds.push(eq(schema.evalCases.threadId, threadId));
    const rows = await this.db
      .select({
        id: schema.evalCases.id,
        threadId: schema.evalCases.threadId,
        caseKind: schema.evalCases.caseKind,
        sourceRef: schema.evalCases.sourceRef,
        prompt: schema.evalCases.prompt,
        status: schema.evalCases.status,
        metadata: schema.evalCases.metadata,
        createdAt: schema.evalCases.createdAt,
      })
      .from(schema.evalCases)
      .where(and(...conds))
      .orderBy(desc(schema.evalCases.createdAt))
      .limit(40);
    return rows.map((row) => ({
      id: row.id,
      threadId: row.threadId,
      caseKind: row.caseKind,
      sourceRef: row.sourceRef,
      promptPreview: REDACTED_EVAL_PROMPT_PREVIEW,
      status: row.status,
      metadata: sanitizeObservabilityMetadata(row.metadata),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  private async listEvalRuns(workspaceId: string, filters: { threadId?: string; traceId?: string }): Promise<EvalRunItem[]> {
    // eval_runs currently has no thread_id/trace_id relation. Do not mix
    // workspace-wide eval runs into a trace/thread-filtered view; that makes
    // unrelated runs look causally attached to the selected trace.
    if (filters.threadId || filters.traceId) return [];
    const rows = await this.db
      .select({
        id: schema.evalRuns.id,
        runKind: schema.evalRuns.runKind,
        status: schema.evalRuns.status,
        startedAt: schema.evalRuns.startedAt,
        completedAt: schema.evalRuns.completedAt,
        metrics: schema.evalRuns.metrics,
        createdAt: schema.evalRuns.createdAt,
      })
      .from(schema.evalRuns)
      .where(and(eq(schema.evalRuns.workspaceId, workspaceId), isNull(schema.evalRuns.deletedAt)))
      .orderBy(desc(schema.evalRuns.createdAt))
      .limit(20);
    return rows.map((row) => ({
      id: row.id,
      runKind: row.runKind,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      metrics: sanitizeObservabilityMetrics(row.metrics),
      createdAt: row.createdAt.toISOString(),
    }));
  }
}

export function summarizeSpans(spans: TraceSpanItem[]): TraceSummary[] {
  const grouped = new Map<string, TraceSpanItem[]>();
  for (const span of spans) grouped.set(span.traceId, [...(grouped.get(span.traceId) ?? []), span]);
  return [...grouped.entries()].map(([traceId, group]) => {
    const sorted = [...group].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const startedAt = sorted[0]?.startedAt ?? new Date(0).toISOString();
    const lastAt = sorted.reduce((latest, span) => {
      const candidate = span.endedAt ?? span.startedAt;
      return candidate > latest ? candidate : latest;
    }, startedAt);
    return {
      traceId,
      threadId: sorted.find((span) => span.threadId)?.threadId ?? null,
      spanCount: sorted.length,
      errorCount: sorted.filter((span) => span.status !== 'ok').length,
      startedAt,
      lastAt,
      totalDurationMs: sorted.reduce((sum, span) => sum + span.durationMs, 0),
      topSpanNames: sorted.slice(0, 8).map((span) => span.name),
    };
  }).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

function decodeCursor(cursor: string | undefined): Date | null {
  if (!cursor) return null;
  const [iso] = cursor.split('|');
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time) : null;
}

export function sanitizeObservabilityMetadata(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (SENSITIVE_KEY_RE.test(key)) continue;
    if (!isSafePublicPrimitive(item)) continue;
    sanitized[key] = item;
  }
  return sanitized;
}

export function sanitizeObservabilityMetrics(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (SENSITIVE_KEY_RE.test(key)) continue;
    if (typeof item !== 'number' && typeof item !== 'boolean') continue;
    if (typeof item === 'number' && !Number.isFinite(item)) continue;
    sanitized[key] = item;
  }
  return sanitized;
}

function isSafePublicPrimitive(value: unknown): value is string | number | boolean | null {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  return value.length <= 120 && !SENSITIVE_VALUE_RE.test(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}
