import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { EvidenceSource, ListEvidenceResponse } from '@consulting/contracts';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { redactSensitiveText } from '../security/redact-sensitive-text.js';

export interface CapturedToolUse {
  tool: string;
  preview: string | null;
}

export function captureToolEvidence(
  target: CapturedToolUse[],
  event: { tool: string; phase: 'started' | 'completed'; preview?: string | undefined },
): void {
  if (event.phase !== 'completed' || !capturesCompletedEvidence(event.tool) || !event.preview) return;
  target.push({ tool: event.tool, preview: redactEvidencePreview(event.preview) });
}

function capturesCompletedEvidence(tool: string): boolean {
  const normalized = tool.trim().toLowerCase();
  const canonical = normalized.replace(/^(?:functions?|tools?)\./u, '');
  return canonical === 'web_search' || canonical === 'web_extract';
}

function redactEvidencePreview(preview: string, maxChars = 500): string {
  let sanitized = preview.slice(0, Math.max(maxChars * 4, 4_000));
  try {
    sanitized = JSON.stringify(redactJsonValue(JSON.parse(sanitized) as unknown));
  } catch {
    // Non-JSON tool previews are sanitized as plain text below.
  }
  return redactSensitiveText(sanitized).slice(0, maxChars);
}

function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      isSensitiveKey(key) ? '[REDACTED]' : redactJsonValue(child),
    ]));
  }
  return typeof value === 'string' ? redactSensitiveText(value) : value;
}

function isSensitiveKey(key: string): boolean {
  return /^(?:authorization|proxy[-_]?authorization|password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|token|client[_-]?secret|secret|private[_-]?key|credential(?:s)?|cookie|set[_-]?cookie|session(?:[_-]?(?:id|key|token))?|database[_-]?url|db[_-]?url|dsn|connection[_-]?string|x[-_](?:amz|goog)[-_](?:signature|credential|security[-_]?token)|googleaccessid)$/iu.test(key);
}

/** Map a Hermes tool name onto an evidence provenance bucket. */
export function classifyTool(tool: string): EvidenceSource {
  const t = tool.toLowerCase();
  if (t.includes('gbrain')) return 'gbrain';
  if (t.includes('web_search') || t.includes('web_extract') || t.startsWith('browser')) return 'web';
  if (t.includes('read_file') || t.includes('search_files') || t.includes('write_file')) return 'file';
  return 'tool';
}

/** Tools that are pure plumbing — not evidence of anything. */
const IGNORED_TOOLS = new Set(['todo', 'clarify', 'text_to_speech', 'image_generate']);

/**
 * Evidence persistence (Phase 2-A). Auto rows come from Hermes tool events
 * captured during a stream; manual rows come from POST /chat/evidence.
 */
@Injectable()
export class EvidenceStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Persist tool uses captured during a run, linked to the settled assistant message. */
  async saveRunEvidence(input: {
    workspaceId: string;
    threadId: string;
    messageId: string;
    runId: string | null;
    toolUses: CapturedToolUse[];
  }, db: Db = this.db): Promise<void> {
    const rows = input.toolUses
      .filter((u) => u.tool.length > 0 && !IGNORED_TOOLS.has(u.tool) && capturesCompletedEvidence(u.tool))
      .map((u) => {
        const preview = redactEvidencePreview(u.preview ?? '', 4_000);
        return {
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          messageId: input.messageId,
          runId: input.runId,
          sourceType: classifyTool(u.tool),
          ref: u.tool.slice(0, 200),
          excerpt: preview || u.tool,
          url: extractUrl(preview),
          qualityScore: null,
          qualitySignals: [],
        };
      });
    if (rows.length === 0) return;
    await db.insert(schema.evidenceItems).values(rows);
  }

  async addManual(input: {
    workspaceId: string;
    threadId: string;
    messageId: string | null;
    sourceType: EvidenceSource;
    ref: string;
    excerpt: string;
    url: string | null;
    addedByUserId: string;
    qualityScore?: number | null;
    qualitySignals?: string[];
  }): Promise<string> {
    const [row] = await this.db
      .insert(schema.evidenceItems)
      .values({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        messageId: input.messageId,
        sourceType: input.sourceType,
        ref: input.ref,
        excerpt: input.excerpt,
        url: input.url,
        qualityScore: input.qualityScore ?? null,
        qualitySignals: input.qualitySignals ?? [],
        addedByUserId: input.addedByUserId,
      })
      .returning({ id: schema.evidenceItems.id });
    return row!.id;
  }

  async listForThread(threadId: string): Promise<ListEvidenceResponse> {
    const rows = await this.db
      .select({
        id: schema.evidenceItems.id,
        messageId: schema.evidenceItems.messageId,
        runId: schema.evidenceItems.runId,
        sourceType: schema.evidenceItems.sourceType,
        ref: schema.evidenceItems.ref,
        excerpt: schema.evidenceItems.excerpt,
        url: schema.evidenceItems.url,
        qualityScore: schema.evidenceItems.qualityScore,
        qualitySignals: schema.evidenceItems.qualitySignals,
        addedByUserId: schema.evidenceItems.addedByUserId,
        createdAt: schema.evidenceItems.createdAt,
      })
      .from(schema.evidenceItems)
      .where(and(eq(schema.evidenceItems.threadId, threadId), isNull(schema.evidenceItems.deletedAt)))
      .orderBy(desc(schema.evidenceItems.createdAt));

    return {
      evidence: rows.map((r) => ({
        id: r.id,
        messageId: r.messageId,
        runId: r.runId,
        sourceType: r.sourceType,
        ref: r.ref,
        excerpt: r.excerpt,
        url: r.url,
        qualityScore: r.qualityScore,
        qualitySignals: r.qualitySignals,
        addedByUserId: r.addedByUserId,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  /**
   * #6: project-scoped evidence aggregation. Joins evidence → thread → topic →
   * channel → project so a project's evidence across ALL its channels shows in
   * one view. F9 (design doc): soft-delete does NOT cascade to evidence rows,
   * so we must guard deletedAt on EVERY parent level (thread/topic/channel/
   * project) — otherwise a deleted channel's evidence resurfaces as ghost data.
   */
  async listForProject(projectId: string, limit = 200): Promise<ListEvidenceResponse> {
    const rows = await this.db
      .select({
        id: schema.evidenceItems.id,
        messageId: schema.evidenceItems.messageId,
        runId: schema.evidenceItems.runId,
        sourceType: schema.evidenceItems.sourceType,
        ref: schema.evidenceItems.ref,
        excerpt: schema.evidenceItems.excerpt,
        url: schema.evidenceItems.url,
        qualityScore: schema.evidenceItems.qualityScore,
        qualitySignals: schema.evidenceItems.qualitySignals,
        addedByUserId: schema.evidenceItems.addedByUserId,
        createdAt: schema.evidenceItems.createdAt,
      })
      .from(schema.evidenceItems)
      .innerJoin(schema.threads, eq(schema.evidenceItems.threadId, schema.threads.id))
      .innerJoin(schema.topics, eq(schema.threads.topicId, schema.topics.id))
      .innerJoin(schema.channels, eq(schema.topics.channelId, schema.channels.id))
      .where(
        and(
          eq(schema.channels.projectId, projectId),
          isNull(schema.evidenceItems.deletedAt),
          // F9: every parent level must be alive or the row is a ghost.
          isNull(schema.threads.deletedAt),
          isNull(schema.topics.deletedAt),
          isNull(schema.channels.deletedAt),
        ),
      )
      .orderBy(desc(schema.evidenceItems.createdAt))
      .limit(limit);

    return {
      evidence: rows.map((r) => ({
        id: r.id,
        messageId: r.messageId,
        runId: r.runId,
        sourceType: r.sourceType,
        ref: r.ref,
        excerpt: r.excerpt,
        url: r.url,
        qualityScore: r.qualityScore,
        qualitySignals: r.qualitySignals,
        addedByUserId: r.addedByUserId,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }
}

function extractUrl(preview: string | null): string | null {
  if (!preview) return null;
  const m = preview.match(/https?:\/\/[^\s"')\]]+/);
  return m ? m[0].slice(0, 2000) : null;
}
