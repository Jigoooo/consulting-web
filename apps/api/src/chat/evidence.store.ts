import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { EvidenceSource, ListEvidenceResponse } from '@consulting/contracts';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

export interface CapturedToolUse {
  tool: string;
  preview: string | null;
}

/** Map a Hermes tool name onto an evidence provenance bucket. */
export function classifyTool(tool: string): EvidenceSource {
  const t = tool.toLowerCase();
  if (t.startsWith('gbrain')) return 'gbrain';
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
  }): Promise<void> {
    const rows = input.toolUses
      .filter((u) => u.tool.length > 0 && !IGNORED_TOOLS.has(u.tool))
      .map((u) => ({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        messageId: input.messageId,
        runId: input.runId,
        sourceType: classifyTool(u.tool),
        ref: u.tool.slice(0, 200),
        excerpt: (u.preview ?? '').slice(0, 4000) || u.tool,
        url: extractUrl(u.preview),
      }));
    if (rows.length === 0) return;
    await this.db.insert(schema.evidenceItems).values(rows);
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
