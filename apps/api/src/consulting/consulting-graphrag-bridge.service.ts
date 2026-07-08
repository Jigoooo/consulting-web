import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';

const execFileAsync = promisify(execFile);
const DEFAULT_CONSULTING_ROOT = existsSync('/brain/consulting')
  ? '/brain/consulting'
  : '/home/jigoo/.hermes/workspace/consulting';
const CONSULTING_ROOT = process.env.CONSULTING_BRAIN_ROOT ?? DEFAULT_CONSULTING_ROOT;
const CONSULTING_PYTHON = process.env.CONSULTING_PYTHON ?? 'python3';
const DIALOGUE_MEMORY_CLI = `${CONSULTING_ROOT}/scripts/dialogue_memory_cli.py`;
export const CONSULTING_RECALL_TIMEOUT_MS = Math.max(
  45_000,
  Number(process.env.CONSULTING_RECALL_TIMEOUT_MS ?? 60_000) || 60_000,
);

export interface ConsultingGraphRagSignals {
  semantic: number;
  lexical: number;
  graph: number;
  fileSemantic: number;
  fileLexical: number;
  fileGraph: number;
  tog2Deep: number;
}

export interface ConsultingGraphRagHit {
  kind: string;
  score: number | null;
  fusedScore?: number | null;
  rerankScore?: number | null;
  adjustedScore?: number;
  docTitle: string | null;
  utilityTier: string | null;
  text: string;
  linked: string[];
  graphPath?: string[];
  signalBreakdown: Record<string, unknown> | null;
  sourceTopicSlug?: string;
  sourceLabel?: string;
  sourceRelation?: 'current' | 'same_project' | 'cross_project' | 'archived';
  sourceWeight?: number;
}

export interface ConsultingGraphRagRecallScope {
  topicSlug: string;
  label: string;
  relation: 'current' | 'same_project' | 'cross_project' | 'archived';
  weight: number;
}

export interface ConsultingGraphRagRecallResult {
  status: 'ok' | 'empty' | 'timeout' | 'error';
  ok: boolean;
  topic: string;
  query: string;
  rerank: string | null;
  rerankError: string | null;
  signals: ConsultingGraphRagSignals | null;
  hits: ConsultingGraphRagHit[];
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeSignals(value: unknown): ConsultingGraphRagSignals | null {
  if (!isRecord(value)) return null;
  return {
    semantic: asNumber(value.semantic) ?? 0,
    lexical: asNumber(value.lexical) ?? 0,
    graph: asNumber(value.graph) ?? 0,
    fileSemantic: asNumber(value.file_semantic) ?? 0,
    fileLexical: asNumber(value.file_lexical) ?? 0,
    fileGraph: asNumber(value.file_graph) ?? 0,
    tog2Deep: asNumber(value.tog2_deep) ?? 0,
  };
}

function normalizeHit(value: unknown): ConsultingGraphRagHit | null {
  if (!isRecord(value)) return null;
  const text = asString(value.context_text) ?? asString(value.raw_text) ?? '';
  if (!text) return null;
  const linkedRaw = Array.isArray(value.linked) ? value.linked : [];
  return {
    kind: asString(value.kind) ?? 'unknown',
    score: asNumber(value.rerank_score) ?? asNumber(value.fused_score) ?? asNumber(value.score),
    fusedScore: asNumber(value.fused_score),
    rerankScore: asNumber(value.rerank_score),
    docTitle: asString(value.doc_title),
    utilityTier: asString(value.utility_tier),
    text,
    linked: linkedRaw.filter((item): item is string => typeof item === 'string'),
    graphPath: linkedRaw.filter((item): item is string => typeof item === 'string' && item.includes(':')),
    signalBreakdown: isRecord(value.signal_breakdown) ? value.signal_breakdown : null,
  };
}

export function buildConsultingRecallArgs(input: { topicSlug: string; query: string; topK?: number }): string[] {
  const topK = Math.min(Math.max(input.topK ?? 5, 1), 10);
  return [
    DIALOGUE_MEMORY_CLI,
    'recall',
    '--topic', input.topicSlug,
    '--q', input.query,
    '--top-k', String(topK),
    '--format', 'json',
    '--backend', 'pg',
    '--rerank',
  ];
}

export function normalizeConsultingRecallJson(
  parsed: unknown,
  input: { topicSlug: string; query: string },
): ConsultingGraphRagRecallResult {
  if (!isRecord(parsed)) return emptyRecall(input, 'invalid recall json');
  const hitsRaw = Array.isArray(parsed.hits) ? parsed.hits : [];
  return {
    status: parsed.ok === true && hitsRaw.length > 0 ? 'ok' : (parsed.ok === true ? 'empty' : 'error'),
    ok: parsed.ok === true,
    topic: asString(parsed.topic) ?? input.topicSlug,
    query: asString(parsed.query) ?? input.query,
    rerank: asString(parsed.rerank),
    rerankError: asString(parsed.rerank_error),
    signals: normalizeSignals(parsed.signals),
    hits: hitsRaw.map((hit) => normalizeHit(hit)).filter((hit): hit is ConsultingGraphRagHit => hit !== null),
  };
}

function emptyRecall(
  input: { topicSlug: string; query: string },
  error?: string,
  status: ConsultingGraphRagRecallResult['status'] = 'error',
): ConsultingGraphRagRecallResult {
  return {
    status,
    ok: false,
    topic: input.topicSlug,
    query: input.query,
    rerank: null,
    rerankError: null,
    signals: null,
    hits: [],
    ...(error ? { error: error.slice(0, 300) } : {}),
  };
}

function dedupeScopes(scopes: ConsultingGraphRagRecallScope[]): ConsultingGraphRagRecallScope[] {
  const bySlug = new Map<string, ConsultingGraphRagRecallScope>();
  for (const scope of scopes) {
    const slug = scope.topicSlug.trim();
    if (!slug) continue;
    const current = bySlug.get(slug);
    if (!current || scope.weight > current.weight) bySlug.set(slug, { ...scope, topicSlug: slug });
  }
  return [...bySlug.values()];
}

function withScope(hit: ConsultingGraphRagHit, scope: ConsultingGraphRagRecallScope): ConsultingGraphRagHit {
  const baseScore = hit.score ?? 0;
  return {
    ...hit,
    adjustedScore: Number((baseScore * scope.weight).toFixed(8)),
    sourceTopicSlug: scope.topicSlug,
    sourceLabel: scope.label,
    sourceRelation: scope.relation,
    sourceWeight: scope.weight,
  };
}

function dedupeHits(hits: ConsultingGraphRagHit[]): ConsultingGraphRagHit[] {
  const seen = new Set<string>();
  const out: ConsultingGraphRagHit[] = [];
  for (const hit of hits) {
    const key = `${hit.kind}|${hit.sourceTopicSlug ?? ''}|${hit.linked.slice(0, 3).join(',')}|${hit.text.slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

function mergeLabel(values: Array<string | null>): string | null {
  const labels = [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
  return labels.length > 0 ? labels.join(',') : null;
}

function mergeSignals(values: Array<ConsultingGraphRagSignals | null>): ConsultingGraphRagSignals | null {
  const present = values.filter((value): value is ConsultingGraphRagSignals => value !== null);
  if (present.length === 0) return null;
  return present.reduce<ConsultingGraphRagSignals>((acc, value) => ({
    semantic: acc.semantic + value.semantic,
    lexical: acc.lexical + value.lexical,
    graph: acc.graph + value.graph,
    fileSemantic: acc.fileSemantic + value.fileSemantic,
    fileLexical: acc.fileLexical + value.fileLexical,
    fileGraph: acc.fileGraph + value.fileGraph,
    tog2Deep: acc.tog2Deep + value.tog2Deep,
  }), { semantic: 0, lexical: 0, graph: 0, fileSemantic: 0, fileLexical: 0, fileGraph: 0, tog2Deep: 0 });
}

@Injectable()
export class ConsultingGraphRagBridge {
  async recall(input: { topicSlug: string; query: string; topK?: number }): Promise<ConsultingGraphRagRecallResult> {
    try {
      const { stdout } = await execFileAsync(
        CONSULTING_PYTHON,
        buildConsultingRecallArgs(input),
        { timeout: CONSULTING_RECALL_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
      );
      const parsed: unknown = JSON.parse(String(stdout));
      return normalizeConsultingRecallJson(parsed, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'recall failed';
      return emptyRecall(input, message, /timed out|timeout/i.test(message) ? 'timeout' : 'error');
    }
  }

  async recallMany(input: { scopes: ConsultingGraphRagRecallScope[]; query: string; topK?: number }): Promise<ConsultingGraphRagRecallResult> {
    const topK = Math.min(Math.max(input.topK ?? 5, 1), 10);
    const uniqueScopes = dedupeScopes(input.scopes);
    if (uniqueScopes.length === 0) return emptyRecall({ topicSlug: 'fanout', query: input.query }, undefined, 'empty');

    const results = await Promise.all(uniqueScopes.map(async (scope) => ({
      scope,
      recall: await this.recall({ topicSlug: scope.topicSlug, query: input.query, topK }),
    })));
    const hits = results.flatMap(({ scope, recall }) => recall.hits.map((hit) => withScope(hit, scope)));
    const sortedHits = dedupeHits(hits)
      .sort((a, b) => (b.adjustedScore ?? b.score ?? 0) - (a.adjustedScore ?? a.score ?? 0))
      .slice(0, topK);
    const statuses = results.map((result) => result.recall.status);
    const status: ConsultingGraphRagRecallResult['status'] = sortedHits.length > 0
      ? 'ok'
      : (statuses.every((s) => s === 'timeout') ? 'timeout' : (statuses.some((s) => s === 'error' || s === 'timeout') ? 'error' : 'empty'));

    return {
      status,
      ok: status === 'ok' || status === 'empty',
      topic: uniqueScopes.map((scope) => scope.topicSlug).join(','),
      query: input.query,
      rerank: mergeLabel(results.map((result) => result.recall.rerank)),
      rerankError: mergeLabel(results.map((result) => result.recall.rerankError)),
      signals: mergeSignals(results.map((result) => result.recall.signals)),
      hits: sortedHits,
    };
  }
}
