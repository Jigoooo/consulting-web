import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, desc, eq, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type {
  EvalCaseItem,
  EvalRunItem,
  ObservabilityTraceListResponse,
  RagEvalMetricsSummary,
  TraceSpanItem,
  TraceSummary,
} from '@consulting/contracts';
import { RetrievalFailureTypeSchema } from '@consulting/contracts';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { computeRagMetrics, exportFailureFixtures, type RetrievalRunLabels } from '../consulting/rag-metrics.js';

const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 200;
const MAX_RAG_METRIC_RUNS = 1_000;
export const REDACTED_EVAL_PROMPT_PREVIEW = null;

const SAFE_METADATA_KEYS = new Set([
  'source', 'component', 'durationMs', 'runKind', 'artifactId', 'artifactVersionId',
  'contentHash', 'node', 'policyVersion', 'attempt', 'exactParity',
]);
const SENSITIVE_KEY_RE = /(api[_-]?key|authorization|bearer|cookie|secret|token|password|passwd|email|phone|ssn|resident|주민|prompt|input|output|payload|content|body|pii)/i;
const SENSITIVE_VALUE_RE = /(bearer\s+\S+|sk-[a-z0-9_-]+|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|\d{6}-\d{7}|(?:\+?82[- ]?)?0\d{1,2}[- ]?\d{3,4}[- ]?\d{4}|(?:[a-z]:[\\/]|\/{1,2})[^\s]+|(?:시|도|구|군|동|읍|면)\s)/iu;
const SAFE_SOURCE_REF_RE = /^[a-z0-9][a-z0-9_.:-]{0,119}$/u;
const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9_.:-]{0,119}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_RE = /^[0-9a-f]{64}$/iu;
const KOREAN_PHONE_SUBSTRING_RE = /(?<!\d)(?:(?:\+?82)[\s.()_-]*(?:10|2|[3-6][1-5]|70)|0(?:10|1[016789]|2|[3-6][1-5]|70))[\s.()_-]*\d{3,4}[\s.()_-]*\d{4}(?!\d)/u;

export interface ObservabilityTraceQuery {
  workspaceId: string;
  allowedThreadIds?: string[] | undefined;
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
    if (query.allowedThreadIds?.length === 0) {
      return {
        traces: [], spans: [], evalCases: [], evalRuns: [],
        ragMetrics: summarizeRagEvaluation([], query.threadId ? 'thread' : 'workspace'),
        nextCursor: null,
      };
    }
    const conds: SQL[] = [eq(schema.traceSpans.workspaceId, query.workspaceId), isNull(schema.traceSpans.deletedAt)];
    if (query.allowedThreadIds) conds.push(inArray(schema.traceSpans.threadId, query.allowedThreadIds));
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

    const evalCases = query.traceId ? [] : await this.listEvalCases(query.workspaceId, query.threadId, query.allowedThreadIds);
    const evalRuns = await this.listEvalRuns(query.workspaceId, {
      ...(query.threadId ? { threadId: query.threadId } : {}),
      ...(query.traceId ? { traceId: query.traceId } : {}),
      ...(query.allowedThreadIds ? { scoped: true } : {}),
    });
    const ragMetrics = query.traceId
      ? null
      : await this.listRagMetrics(query.workspaceId, query.threadId, query.allowedThreadIds);
    const nextCursor = spanRows.length > limit && pageRows.length > 0
      ? `${pageRows[pageRows.length - 1]!.createdAt.toISOString()}|${pageRows[pageRows.length - 1]!.id}`
      : null;

    return {
      traces: summarizeSpans(spans),
      spans,
      evalCases,
      evalRuns,
      ragMetrics,
      nextCursor,
    };
  }

  private async listEvalCases(workspaceId: string, threadId?: string, allowedThreadIds?: string[]): Promise<EvalCaseItem[]> {
    const conds: SQL[] = [eq(schema.evalCases.workspaceId, workspaceId), isNull(schema.evalCases.deletedAt)];
    if (threadId) conds.push(eq(schema.evalCases.threadId, threadId));
    if (allowedThreadIds) conds.push(inArray(schema.evalCases.threadId, allowedThreadIds));
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
      sourceRef: sanitizeObservabilitySourceRef(row.sourceRef),
      promptPreview: REDACTED_EVAL_PROMPT_PREVIEW,
      status: row.status,
      metadata: sanitizeObservabilityMetadata(row.metadata),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  private async listEvalRuns(workspaceId: string, filters: { threadId?: string; traceId?: string; scoped?: boolean }): Promise<EvalRunItem[]> {
    // eval_runs currently has no thread_id/trace_id relation. Do not mix
    // workspace-wide eval runs into a trace/thread-filtered view; that makes
    // unrelated runs look causally attached to the selected trace.
    if (filters.threadId || filters.traceId || filters.scoped) return [];
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

  private async listRagMetrics(workspaceId: string, threadId?: string, allowedThreadIds?: string[]): Promise<RagEvalMetricsSummary> {
    const runConds: SQL[] = [eq(schema.retrievalRuns.workspaceId, workspaceId), isNull(schema.retrievalRuns.deletedAt)];
    const hitConds: SQL[] = [eq(schema.retrievalHits.workspaceId, workspaceId), isNull(schema.retrievalHits.deletedAt)];
    if (threadId) {
      runConds.push(eq(schema.retrievalRuns.threadId, threadId));
      hitConds.push(eq(schema.retrievalHits.threadId, threadId));
    }
    if (allowedThreadIds) {
      runConds.push(inArray(schema.retrievalRuns.threadId, allowedThreadIds));
      hitConds.push(inArray(schema.retrievalHits.threadId, allowedThreadIds));
    }
    const runRows = await this.db
      .select({ id: schema.retrievalRuns.id })
      .from(schema.retrievalRuns)
      .where(and(...runConds))
      .orderBy(desc(schema.retrievalRuns.createdAt))
      .limit(MAX_RAG_METRIC_RUNS + 1);
    const cohortTruncated = runRows.length > MAX_RAG_METRIC_RUNS;
    const sampledRunRows = runRows.slice(0, MAX_RAG_METRIC_RUNS);
    const runIds = sampledRunRows.map((row) => row.id);
    const hitRows = runIds.length === 0 ? [] : await this.db.select({
        retrievalRunId: schema.retrievalHits.retrievalRunId,
        rank: schema.retrievalHits.rank,
        judgedRelevant: schema.retrievalHits.judgedRelevant,
        failureType: schema.retrievalHits.failureType,
      })
      .from(schema.retrievalHits)
      .innerJoin(schema.retrievalRuns, and(
        eq(schema.retrievalHits.retrievalRunId, schema.retrievalRuns.id),
        eq(schema.retrievalHits.workspaceId, schema.retrievalRuns.workspaceId),
        sql`${schema.retrievalHits.threadId} IS NOT DISTINCT FROM ${schema.retrievalRuns.threadId}`,
      ))
      .where(and(...hitConds, inArray(schema.retrievalHits.retrievalRunId, runIds), isNull(schema.retrievalRuns.deletedAt)));
    const byRun = new Map<string, RetrievalRunLabels>(sampledRunRows.map((row) => [row.id, { runId: row.id, hits: [] }]));
    for (const row of hitRows) {
      const run = byRun.get(row.retrievalRunId);
      if (!run) continue;
      const failureType = RetrievalFailureTypeSchema.safeParse(row.failureType);
      run.hits.push({
        rank: row.rank,
        judgedRelevant: row.judgedRelevant,
        failureType: failureType.success ? failureType.data : null,
      });
    }
    return summarizeRagEvaluation([...byRun.values()], threadId ? 'thread' : 'workspace', {
      cohortLimit: MAX_RAG_METRIC_RUNS,
      cohortTruncated,
    });
  }
}

export function summarizeRagEvaluation(
  runs: RetrievalRunLabels[],
  scope: 'workspace' | 'thread',
  cohort: { cohortLimit: number | null; cohortTruncated: boolean } = { cohortLimit: null, cohortTruncated: false },
): RagEvalMetricsSummary {
  const metrics = computeRagMetrics(runs, [1, 3, 5]);
  const labeledRunCoverage = metrics.totalRuns > 0
    ? Number((metrics.labeledRuns / metrics.totalRuns).toFixed(4))
    : 0;
  return {
    runKind: 'retrieval_human_labels',
    scope,
    status: metrics.labeledRuns === 0
      ? 'insufficient_labels'
      : metrics.labeledRuns < metrics.totalRuns
        ? 'partial_labels'
        : 'ready',
    cohortLimit: cohort.cohortLimit,
    cohortTruncated: cohort.cohortTruncated,
    totalRuns: metrics.totalRuns,
    labeledRuns: metrics.labeledRuns,
    labeledRunCoverage,
    labeledHits: metrics.labeledHits,
    relevantHits: metrics.relevantHits,
    precisionAtK: metrics.precisionAtK,
    precisionEvaluatedRunsAtK: metrics.precisionEvaluatedRunsAtK,
    precisionCoverageAtK: metrics.precisionCoverageAtK,
    mrr: metrics.mrr,
    hitRateAtK: metrics.hitRateAtK,
    failureBreakdown: metrics.failureBreakdown,
    failureFixtureCount: exportFailureFixtures(runs).length,
  };
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
    if (!SAFE_METADATA_KEYS.has(key)) continue;
    if (SENSITIVE_KEY_RE.test(key)) continue;
    if (!isSafeMetadataValue(key, item)) continue;
    sanitized[key] = item;
  }
  return sanitized;
}

export function sanitizeObservabilitySourceRef(value: string): string {
  const normalized = value.trim();
  return SAFE_SOURCE_REF_RE.test(normalized) && !containsSensitivePublicString(normalized)
    ? normalized
    : '[redacted]';
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

function isSafeMetadataValue(key: string, value: unknown): boolean {
  if (key === 'durationMs') return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (key === 'attempt') return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (key === 'exactParity') return typeof value === 'boolean';
  if (key === 'artifactId' || key === 'artifactVersionId') return typeof value === 'string' && UUID_RE.test(value);
  if (key === 'contentHash') return typeof value === 'string' && SHA256_RE.test(value);
  if (typeof value !== 'string' || value.length > 120) return false;
  return SAFE_SLUG_RE.test(value) && !containsSensitivePublicString(value);
}

function containsSensitivePublicString(value: string): boolean {
  return KOREAN_PHONE_SUBSTRING_RE.test(value) || SENSITIVE_VALUE_RE.test(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}
