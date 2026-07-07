import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';

const execFileAsync = promisify(execFile);
const DEFAULT_CONSULTING_ROOT = existsSync('/legacy/consulting')
  ? '/legacy/consulting'
  : '/home/jigoo/.hermes/workspace/consulting';
const CONSULTING_ROOT = process.env.CONSULTING_LEGACY_ROOT ?? DEFAULT_CONSULTING_ROOT;
const CONSULTING_PYTHON = process.env.CONSULTING_PYTHON ?? 'python3';
const DIALOGUE_MEMORY_CLI = `${CONSULTING_ROOT}/scripts/dialogue_memory_cli.py`;

export interface ConsultingGraphRagHit {
  kind: string;
  score: number | null;
  docTitle: string | null;
  utilityTier: string | null;
  text: string;
  linked: string[];
}

export interface ConsultingGraphRagRecallResult {
  ok: boolean;
  topic: string;
  query: string;
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

@Injectable()
export class ConsultingGraphRagBridge {
  async recall(input: { topicSlug: string; query: string; topK?: number }): Promise<ConsultingGraphRagRecallResult> {
    const topK = Math.min(Math.max(input.topK ?? 5, 1), 10);
    try {
      const { stdout } = await execFileAsync(
        CONSULTING_PYTHON,
        [
          DIALOGUE_MEMORY_CLI,
          'recall',
          '--topic', input.topicSlug,
          '--q', input.query,
          '--top-k', String(topK),
          '--format', 'json',
          '--no-rerank',
        ],
        { timeout: 5_000, maxBuffer: 1024 * 1024 },
      );
      const parsed: unknown = JSON.parse(String(stdout));
      if (!isRecord(parsed)) return this.empty(input, 'invalid recall json');
      const hitsRaw = Array.isArray(parsed.hits) ? parsed.hits : [];
      return {
        ok: parsed.ok === true,
        topic: asString(parsed.topic) ?? input.topicSlug,
        query: asString(parsed.query) ?? input.query,
        hits: hitsRaw.map((hit) => this.normalizeHit(hit)).filter((hit): hit is ConsultingGraphRagHit => hit !== null),
      };
    } catch (error) {
      return this.empty(input, error instanceof Error ? error.message : 'recall failed');
    }
  }

  private normalizeHit(value: unknown): ConsultingGraphRagHit | null {
    if (!isRecord(value)) return null;
    const text = asString(value.context_text) ?? asString(value.raw_text) ?? '';
    if (!text) return null;
    const linkedRaw = Array.isArray(value.linked) ? value.linked : [];
    return {
      kind: asString(value.kind) ?? 'unknown',
      score: asNumber(value.fused_score) ?? asNumber(value.score),
      docTitle: asString(value.doc_title),
      utilityTier: asString(value.utility_tier),
      text,
      linked: linkedRaw.filter((item): item is string => typeof item === 'string'),
    };
  }

  private empty(input: { topicSlug: string; query: string }, error?: string): ConsultingGraphRagRecallResult {
    return {
      ok: false,
      topic: input.topicSlug,
      query: input.query,
      hits: [],
      ...(error ? { error: error.slice(0, 300) } : {}),
    };
  }
}
