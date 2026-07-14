import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { consultingRetrievalSnapshotHash } from './consulting-memory-context.builder.js';

export type ConsultingInsightIntentDecision = 'analysis' | 'factual' | 'ambiguous';

export interface ConsultingInsightShadowAcceptance {
  settlementId: string;
  userMessageId: string;
  workspaceId: string;
  threadId: string;
  retrievalRunId?: string;
  intentDecision: ConsultingInsightIntentDecision;
  intentConfidence: number;
  sourceMessageHash: string;
  retrievalSnapshotHash?: string;
  policyHash: string;
}

export type ConsultingInsightShadowAcceptResult =
  | { state: 'accepted'; id: string }
  | { state: 'existing'; id: string }
  | { state: 'ineligible'; reason: 'intent_not_analysis' | 'exact_scope_required' };

export interface ConsultingInsightShadowRetrievalAttachment {
  retrievalRunId: string;
  retrievalSnapshotHash: string;
}

export class ConsultingInsightShadowProvenanceError extends Error {
  constructor() {
    super('consulting insight shadow acceptance provenance conflict');
    this.name = 'ConsultingInsightShadowProvenanceError';
  }
}

@Injectable()
export class ConsultingInsightShadowStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async accept(input: ConsultingInsightShadowAcceptance): Promise<ConsultingInsightShadowAcceptResult> {
    if (input.intentDecision !== 'analysis') {
      return { state: 'ineligible', reason: 'intent_not_analysis' };
    }
    const [capability] = await this.db
      .select({ threadId: schema.threads.id })
      .from(schema.threads)
      .innerJoin(schema.topics, and(
        eq(schema.threads.topicId, schema.topics.id),
        eq(schema.threads.workspaceId, schema.topics.workspaceId),
      ))
      .innerJoin(schema.channels, and(
        eq(schema.topics.channelId, schema.channels.id),
        eq(schema.topics.workspaceId, schema.channels.workspaceId),
      ))
      .innerJoin(schema.projects, and(
        eq(schema.channels.projectId, schema.projects.id),
        eq(schema.channels.workspaceId, schema.projects.workspaceId),
      ))
      .innerJoin(schema.consultingTopicLinks, and(
        eq(schema.consultingTopicLinks.workspaceId, schema.projects.workspaceId),
        eq(schema.consultingTopicLinks.projectId, schema.projects.id),
        eq(schema.consultingTopicLinks.status, 'active'),
        or(
          and(
            eq(schema.consultingTopicLinks.linkLevel, 'thread'),
            eq(schema.consultingTopicLinks.threadId, schema.threads.id),
          ),
          and(
            eq(schema.consultingTopicLinks.linkLevel, 'topic'),
            eq(schema.consultingTopicLinks.webTopicId, schema.topics.id),
          ),
        ),
      ))
      .innerJoin(schema.chatTurnSettlements, and(
        eq(schema.chatTurnSettlements.id, input.settlementId),
        eq(schema.chatTurnSettlements.workspaceId, schema.threads.workspaceId),
        eq(schema.chatTurnSettlements.threadId, schema.threads.id),
        eq(schema.chatTurnSettlements.userMessageId, input.userMessageId),
      ))
      .where(and(
        eq(schema.threads.id, input.threadId),
        eq(schema.threads.workspaceId, input.workspaceId),
        eq(schema.threads.status, 'active'),
        eq(schema.topics.status, 'active'),
        eq(schema.channels.status, 'active'),
        eq(schema.projects.status, 'active'),
        isNull(schema.threads.deletedAt),
        isNull(schema.topics.deletedAt),
        isNull(schema.channels.deletedAt),
        isNull(schema.projects.deletedAt),
      ))
      .limit(1);
    if (!capability) return { state: 'ineligible', reason: 'exact_scope_required' };
    if ((input.retrievalRunId === undefined) !== (input.retrievalSnapshotHash === undefined)) {
      throw new ConsultingInsightShadowProvenanceError();
    }
    if (input.retrievalRunId && !(await this.isValidRetrieval(input.workspaceId, input.threadId, input.retrievalRunId))) {
      return { state: 'ineligible', reason: 'exact_scope_required' };
    }

    const [inserted] = await this.db
      .insert(schema.consultingInsightShadowTurns)
      .values({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        settlementId: input.settlementId,
        userMessageId: input.userMessageId,
        retrievalRunId: input.retrievalRunId ?? null,
        status: 'pending',
        intentDecision: 'analysis',
        intentConfidence: String(input.intentConfidence),
        sourceMessageHash: input.sourceMessageHash,
        retrievalSnapshotHash: input.retrievalSnapshotHash ?? null,
        policyHash: input.policyHash,
      })
      .onConflictDoNothing({ target: schema.consultingInsightShadowTurns.settlementId })
      .returning({ id: schema.consultingInsightShadowTurns.id });
    if (inserted) return { state: 'accepted', id: inserted.id };

    const [existing] = await this.db
      .select()
      .from(schema.consultingInsightShadowTurns)
      .where(eq(schema.consultingInsightShadowTurns.settlementId, input.settlementId))
      .limit(1);
    if (
      !existing
      || existing.workspaceId !== input.workspaceId
      || existing.threadId !== input.threadId
      || existing.userMessageId !== input.userMessageId
      || existing.retrievalRunId !== (input.retrievalRunId ?? null)
      || Number(existing.intentConfidence) !== input.intentConfidence
      || existing.sourceMessageHash !== input.sourceMessageHash
      || existing.retrievalSnapshotHash !== (input.retrievalSnapshotHash ?? null)
      || existing.policyHash !== input.policyHash
    ) {
      throw new ConsultingInsightShadowProvenanceError();
    }
    return { state: 'existing', id: existing.id };
  }

  async attachRetrieval(
    shadowTurnId: string,
    input: ConsultingInsightShadowRetrievalAttachment,
  ): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/u.test(input.retrievalSnapshotHash)) {
      throw new ConsultingInsightShadowProvenanceError();
    }
    const [shadow] = await this.db.select({
      workspaceId: schema.consultingInsightShadowTurns.workspaceId,
      threadId: schema.consultingInsightShadowTurns.threadId,
      status: schema.consultingInsightShadowTurns.status,
      retrievalRunId: schema.consultingInsightShadowTurns.retrievalRunId,
      retrievalSnapshotHash: schema.consultingInsightShadowTurns.retrievalSnapshotHash,
    }).from(schema.consultingInsightShadowTurns)
      .where(eq(schema.consultingInsightShadowTurns.id, shadowTurnId)).limit(1);
    if (!shadow || shadow.status !== 'pending') return false;
    if (shadow.retrievalRunId !== null || shadow.retrievalSnapshotHash !== null) {
      if (
        shadow.retrievalRunId === input.retrievalRunId
        && shadow.retrievalSnapshotHash === input.retrievalSnapshotHash
      ) return true;
      throw new ConsultingInsightShadowProvenanceError();
    }
    if (!(await this.isValidRetrieval(shadow.workspaceId, shadow.threadId, input.retrievalRunId))) {
      return false;
    }
    const [attached] = await this.db.update(schema.consultingInsightShadowTurns).set({
      retrievalRunId: input.retrievalRunId,
      retrievalSnapshotHash: input.retrievalSnapshotHash,
      updatedAt: new Date(),
    }).where(and(
      eq(schema.consultingInsightShadowTurns.id, shadowTurnId),
      eq(schema.consultingInsightShadowTurns.status, 'pending'),
      isNull(schema.consultingInsightShadowTurns.retrievalRunId),
      isNull(schema.consultingInsightShadowTurns.retrievalSnapshotHash),
    )).returning({ id: schema.consultingInsightShadowTurns.id });
    if (attached) return true;
    throw new ConsultingInsightShadowProvenanceError();
  }

  private async isValidRetrieval(workspaceId: string, threadId: string, retrievalRunId: string): Promise<boolean> {
    const [run] = await this.db.select({ id: schema.retrievalRuns.id })
      .from(schema.retrievalRuns)
      .where(and(
        eq(schema.retrievalRuns.id, retrievalRunId),
        eq(schema.retrievalRuns.workspaceId, workspaceId),
        eq(schema.retrievalRuns.threadId, threadId),
        eq(schema.retrievalRuns.status, 'ok'),
        isNull(schema.retrievalRuns.deletedAt),
      )).limit(1);
    return Boolean(run);
  }

  async claimReplay(shadowTurnId: string, leaseMs = 180_000): Promise<
    | { state: 'claimed'; leaseToken: string; shadow: typeof schema.consultingInsightShadowTurns.$inferSelect; query: string; hits: Array<typeof schema.retrievalHits.$inferSelect> }
    | { state: 'busy' | 'terminal' | 'snapshot_invalid' }
  > {
    const now = new Date();
    const leaseToken = randomUUID();
    const [claimed] = await this.db.update(schema.consultingInsightShadowTurns).set({
      replayStatus: 'processing', replayLeaseToken: leaseToken,
      replayLeaseExpiresAt: new Date(now.getTime() + leaseMs),
      replayAttemptCount: sql`${schema.consultingInsightShadowTurns.replayAttemptCount} + 1`,
      replayError: null, updatedAt: now,
    }).where(and(
      eq(schema.consultingInsightShadowTurns.id, shadowTurnId),
      eq(schema.consultingInsightShadowTurns.status, 'succeeded'),
      lt(schema.consultingInsightShadowTurns.replayAttemptCount, 5),
      or(
        eq(schema.consultingInsightShadowTurns.replayStatus, 'pending'),
        eq(schema.consultingInsightShadowTurns.replayStatus, 'failed'),
        and(eq(schema.consultingInsightShadowTurns.replayStatus, 'processing'), lt(schema.consultingInsightShadowTurns.replayLeaseExpiresAt, now)),
      ),
    )).returning();
    if (!claimed) {
      const [row] = await this.db.select({
        replayStatus: schema.consultingInsightShadowTurns.replayStatus,
        replayAttemptCount: schema.consultingInsightShadowTurns.replayAttemptCount,
      })
        .from(schema.consultingInsightShadowTurns).where(eq(schema.consultingInsightShadowTurns.id, shadowTurnId)).limit(1);
      return row && (
        ['completed', 'snapshot_invalid'].includes(row.replayStatus)
        || (row.replayStatus === 'failed' && row.replayAttemptCount >= 5)
      ) ? { state: 'terminal' } : { state: 'busy' };
    }
    if (!claimed.retrievalRunId || !claimed.retrievalSnapshotHash) {
      await this.invalidateSnapshot(claimed.id, leaseToken, 'retrieval snapshot not attached');
      return { state: 'snapshot_invalid' };
    }
    const retrievalRunId = claimed.retrievalRunId;
    const [run] = await this.db.select().from(schema.retrievalRuns).where(and(
      eq(schema.retrievalRuns.id, retrievalRunId),
      eq(schema.retrievalRuns.workspaceId, claimed.workspaceId),
      eq(schema.retrievalRuns.threadId, claimed.threadId),
      isNull(schema.retrievalRuns.deletedAt),
    )).limit(1);
    const hits = await this.db.select().from(schema.retrievalHits).where(and(
      eq(schema.retrievalHits.retrievalRunId, retrievalRunId),
      eq(schema.retrievalHits.workspaceId, claimed.workspaceId),
      eq(schema.retrievalHits.threadId, claimed.threadId),
      isNull(schema.retrievalHits.deletedAt),
    )).orderBy(schema.retrievalHits.rank);
    if (!run) {
      await this.invalidateSnapshot(claimed.id, leaseToken, 'retrieval run missing');
      return { state: 'snapshot_invalid' };
    }
    const recomputed = consultingRetrievalSnapshotHash({
      retrievalRunId: run.id, workspaceId: run.workspaceId, threadId: run.threadId ?? '', query: run.queryText,
      hits: hits.map((hit) => ({
        rank: hit.rank, kind: hit.hitKind, sourceTopicSlug: hit.sourceTopicSlug,
        sourceRelation: hit.sourceRelation, text: hit.textPreview, linked: [...hit.linked],
      })),
    });
    if (recomputed.snapshotHash !== claimed.retrievalSnapshotHash) {
      await this.invalidateSnapshot(claimed.id, leaseToken, 'retrieval snapshot hash mismatch');
      return { state: 'snapshot_invalid' };
    }
    return { state: 'claimed', leaseToken, shadow: claimed, query: run.queryText, hits };
  }

  async completeReplay(shadowTurnId: string, leaseToken: string, result: Record<string, unknown>): Promise<boolean> {
    const now = new Date();
    const resultHash = createHash('sha256').update(JSON.stringify(result), 'utf8').digest('hex');
    return this.db.transaction(async (tx) => {
      const [completed] = await tx.update(schema.consultingInsightShadowTurns).set({
        replayStatus: 'completed', replayLeaseToken: null, replayLeaseExpiresAt: null, replayError: null, updatedAt: now,
      }).where(and(
        eq(schema.consultingInsightShadowTurns.id, shadowTurnId),
        eq(schema.consultingInsightShadowTurns.replayStatus, 'processing'),
        eq(schema.consultingInsightShadowTurns.replayLeaseToken, leaseToken),
        gt(schema.consultingInsightShadowTurns.replayLeaseExpiresAt, now),
      )).returning({ workspaceId: schema.consultingInsightShadowTurns.workspaceId });
      if (!completed) return false;
      await tx.insert(schema.consultingInsightShadowResults).values({
        workspaceId: completed.workspaceId, shadowTurnId, resultHash, result,
      }).onConflictDoNothing({ target: schema.consultingInsightShadowResults.shadowTurnId });
      return true;
    });
  }

  async failReplay(shadowTurnId: string, leaseToken: string, error: string): Promise<boolean> {
    const [row] = await this.db.update(schema.consultingInsightShadowTurns).set({
      replayStatus: 'failed', replayLeaseToken: null, replayLeaseExpiresAt: null,
      replayError: error.slice(0, 2_000), updatedAt: new Date(),
    }).where(and(
      eq(schema.consultingInsightShadowTurns.id, shadowTurnId),
      eq(schema.consultingInsightShadowTurns.replayStatus, 'processing'),
      eq(schema.consultingInsightShadowTurns.replayLeaseToken, leaseToken),
    )).returning({ id: schema.consultingInsightShadowTurns.id });
    return Boolean(row);
  }

  private async invalidateSnapshot(shadowTurnId: string, leaseToken: string, error: string): Promise<void> {
    await this.db.update(schema.consultingInsightShadowTurns).set({
      replayStatus: 'snapshot_invalid', replayLeaseToken: null, replayLeaseExpiresAt: null,
      replayError: error, updatedAt: new Date(),
    }).where(and(
      eq(schema.consultingInsightShadowTurns.id, shadowTurnId),
      eq(schema.consultingInsightShadowTurns.replayStatus, 'processing'),
      eq(schema.consultingInsightShadowTurns.replayLeaseToken, leaseToken),
    ));
  }
}
