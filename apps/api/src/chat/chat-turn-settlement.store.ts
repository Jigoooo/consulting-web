import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, desc, eq, gt, inArray, isNull, like, lt, lte, or } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { CHAT_TURN_SETTLEMENT_REQUESTED_EVENT, CONSULTING_INSIGHT_SHADOW_REQUESTED_EVENT } from '../queues/outbox-routing.js';
import { redactLogText } from '../security/redact-sensitive-text.js';
import type { ConsultingVerifiedContradiction } from '../consulting/consulting-web-ingest.service.js';
import type { CapturedToolUse } from './evidence.store.js';
import type { FinishState } from './chat-message.store.js';

const SETTLEMENT_REQUEST_ATTEMPTS = 3;
const SETTLEMENT_MAX_ATTEMPTS = 12;
const SETTLEMENT_ATTEMPT_LEASE_MS = 120_000;
const SETTLEMENT_VERIFICATION_LEASE_MS = 120_000;

export type SettlementAttemptClaim =
  | { state: 'claimed'; leaseToken: string; settlement: ChatTurnSettlementRecord }
  | { state: 'busy' | 'terminal' };

export type VerificationStepClaim =
  | { state: 'claimed'; leaseToken: string }
  | { state: 'busy' }
  | { state: 'terminal'; verifiedContradictions: ConsultingVerifiedContradiction[] };

export function settlementRetryDelaySeconds(attempt: number): number {
  return Math.min(300, 5 * (2 ** Math.max(0, attempt - 1)));
}

export type ChatTurnSettlementRecord = Omit<
  typeof schema.chatTurnSettlements.$inferSelect,
  'verifiedContradictions'
> & { verifiedContradictions: ConsultingVerifiedContradiction[] };

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function parseStoredVerifiedContradictions(value: unknown): ConsultingVerifiedContradiction[] {
  if (!Array.isArray(value)) throw new Error('invalid verified contradiction snapshot');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('invalid verified contradiction snapshot');
    }
    const record = item as Record<string, unknown>;
    const verdictRef = requiredString(record.verdictRef);
    const claimId = requiredString(record.claimId);
    const claimText = requiredString(record.claimText);
    const rationale = requiredString(record.rationale);
    const evidenceItemId = requiredString(record.evidenceItemId);
    const evidenceRef = requiredString(record.evidenceRef);
    const evidenceText = requiredString(record.evidenceText);
    const confidence = typeof record.confidence === 'number' && Number.isFinite(record.confidence)
      ? record.confidence
      : null;
    if (
      !verdictRef || !claimId || !claimText || !rationale || !evidenceItemId || !evidenceRef || !evidenceText
      || (record.verdict !== 'refutes' && record.verdict !== 'mixed')
      || confidence === null || confidence < 0 || confidence > 1
    ) {
      throw new Error('invalid verified contradiction snapshot');
    }
    return {
      verdictRef,
      claimId,
      claimText,
      verdict: record.verdict,
      confidence,
      rationale,
      evidenceItemId,
      evidenceRef,
      evidenceText,
    };
  });
}

export interface ChatTurnSettlementRequest {
  settlementId: string;
  assistantMessageId: string;
  userMessageId: string;
  workspaceId: string;
  threadId: string;
  requestedByUserId: string;
  userPrompt: string;
  userText: string;
  assistantText: string;
  runId: string | null;
  finishState: FinishState;
  toolUses: CapturedToolUse[];
  clientMessageId?: string;
  clientRequestHash?: string;
  attachmentIds?: string[];
  insightShadowId?: string;
}

export type BeginCaptureResult =
  | { state: 'started'; leaseToken: string; userMessageId: string }
  | { state: 'existing'; settlement: ChatTurnSettlementRecord };

export class ChatTurnIdempotencyConflictError extends Error {}

/** Atomically persists the assistant transcript, settlement ledger, and first outbox event. */
@Injectable()
export class ChatTurnSettlementStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async beginCapture(input: ChatTurnSettlementRequest): Promise<BeginCaptureResult> {
    const now = new Date();
    const leaseToken = randomUUID();
    return this.db.transaction(async (tx) => {
      let effectiveUserMessageId = input.userMessageId;
      if (input.clientMessageId && input.clientRequestHash) {
        const [insertedUser] = await tx
          .insert(schema.chatMessages)
          .values({
            id: input.userMessageId,
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            role: 'user',
            authorUserId: input.requestedByUserId,
            content: input.userText,
            clientMessageId: input.clientMessageId,
            clientRequestHash: input.clientRequestHash,
            finishState: 'complete',
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({
            target: [
              schema.chatMessages.workspaceId,
              schema.chatMessages.authorUserId,
              schema.chatMessages.clientMessageId,
            ],
          })
          .returning({ id: schema.chatMessages.id });
        if (!insertedUser) {
          const [existingUser] = await tx
            .select({
              id: schema.chatMessages.id,
              threadId: schema.chatMessages.threadId,
              content: schema.chatMessages.content,
              clientRequestHash: schema.chatMessages.clientRequestHash,
            })
            .from(schema.chatMessages)
            .where(and(
              eq(schema.chatMessages.workspaceId, input.workspaceId),
              eq(schema.chatMessages.authorUserId, input.requestedByUserId),
              eq(schema.chatMessages.clientMessageId, input.clientMessageId),
            ))
            .limit(1);
          if (
            !existingUser
            || existingUser.threadId !== input.threadId
            || existingUser.content !== input.userText
            || existingUser.clientRequestHash !== input.clientRequestHash
          ) {
            throw new ChatTurnIdempotencyConflictError('client message id reused with different request');
          }
          const [existingSettlement] = await tx
            .select()
            .from(schema.chatTurnSettlements)
            .where(eq(schema.chatTurnSettlements.userMessageId, existingUser.id))
            .limit(1);
          if (!existingSettlement) throw new Error('client message id exists without settlement ledger');
          return {
            state: 'existing',
            settlement: {
              ...existingSettlement,
              verifiedContradictions: parseStoredVerifiedContradictions(existingSettlement.verifiedContradictions),
            },
          };
        }
        effectiveUserMessageId = insertedUser.id;
      } else {
        await tx
          .insert(schema.chatMessages)
          .values({
            id: input.userMessageId,
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            role: 'user',
            authorUserId: input.requestedByUserId,
            content: input.userText,
            finishState: 'complete',
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: schema.chatMessages.id });
        const [existingUser] = await tx
          .select({
            workspaceId: schema.chatMessages.workspaceId,
            threadId: schema.chatMessages.threadId,
            authorUserId: schema.chatMessages.authorUserId,
            content: schema.chatMessages.content,
            role: schema.chatMessages.role,
          })
          .from(schema.chatMessages)
          .where(eq(schema.chatMessages.id, input.userMessageId))
          .limit(1);
        if (
          !existingUser
          || existingUser.workspaceId !== input.workspaceId
          || existingUser.threadId !== input.threadId
          || existingUser.authorUserId !== input.requestedByUserId
          || existingUser.content !== input.userText
          || existingUser.role !== 'user'
        ) {
          throw new ChatTurnIdempotencyConflictError('user message provenance conflict');
        }
      }

      const attachmentIds = [...new Set(input.attachmentIds ?? [])];
      if (attachmentIds.length !== (input.attachmentIds?.length ?? 0)) {
        throw new ChatTurnIdempotencyConflictError('duplicate attachment id in chat request');
      }
      if (attachmentIds.length > 0) {
        const attached = await tx
          .update(schema.fileAttachments)
          .set({ messageId: effectiveUserMessageId })
          .where(and(
            eq(schema.fileAttachments.workspaceId, input.workspaceId),
            eq(schema.fileAttachments.threadId, input.threadId),
            eq(schema.fileAttachments.uploaderUserId, input.requestedByUserId),
            isNull(schema.fileAttachments.messageId),
            isNull(schema.fileAttachments.deletedAt),
            inArray(schema.fileAttachments.id, attachmentIds),
          ))
          .returning({ id: schema.fileAttachments.id });
        if (attached.length !== attachmentIds.length) {
          throw new ChatTurnIdempotencyConflictError('chat attachment provenance conflict');
        }
      }

      await tx
        .insert(schema.chatMessages)
        .values({
          id: input.assistantMessageId,
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          role: 'assistant',
          authorUserId: null,
          content: input.assistantText,
          runId: input.runId,
          finishState: 'error',
          createdAt: new Date(now.getTime() + 1),
          updatedAt: new Date(now.getTime() + 1),
        })
        .onConflictDoNothing({ target: schema.chatMessages.id });
      await tx
        .insert(schema.chatTurnSettlements)
        .values({
          id: input.settlementId,
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          userMessageId: effectiveUserMessageId,
          assistantMessageId: input.assistantMessageId,
          requestedByUserId: input.requestedByUserId,
          userPrompt: input.userPrompt,
          userText: input.userText,
          assistantText: input.assistantText,
          runId: input.runId,
          finishState: 'error',
          toolUses: input.toolUses.map((item) => ({ ...item })),
          status: 'capturing',
          evidenceStatus: 'pending',
          verificationStatus: 'skipped',
          brainStatus: 'skipped',
          notificationStatus: 'skipped',
          verifiedContradictions: [],
          leaseToken,
          leaseExpiresAt: new Date(now.getTime() + SETTLEMENT_ATTEMPT_LEASE_MS),
          attemptCount: 0,
          stepErrors: {},
        })
        .onConflictDoNothing({ target: schema.chatTurnSettlements.assistantMessageId });
      const [row] = await tx
        .select({
          id: schema.chatTurnSettlements.id,
          workspaceId: schema.chatTurnSettlements.workspaceId,
          threadId: schema.chatTurnSettlements.threadId,
          userMessageId: schema.chatTurnSettlements.userMessageId,
          assistantMessageId: schema.chatTurnSettlements.assistantMessageId,
          status: schema.chatTurnSettlements.status,
          leaseToken: schema.chatTurnSettlements.leaseToken,
        })
        .from(schema.chatTurnSettlements)
        .where(eq(schema.chatTurnSettlements.assistantMessageId, input.assistantMessageId))
        .limit(1);
      if (
        !row
        || row.id !== input.settlementId
        || row.workspaceId !== input.workspaceId
        || row.threadId !== input.threadId
        || row.userMessageId !== effectiveUserMessageId
        || row.status !== 'capturing'
        || !row.leaseToken
      ) {
        throw new Error('chat capture provenance conflict');
      }
      return { state: 'started', leaseToken: row.leaseToken, userMessageId: effectiveUserMessageId };
    });
  }

  async checkpointCapture(input: ChatTurnSettlementRequest, captureLeaseToken: string): Promise<void> {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.chatTurnSettlements)
        .set({
          assistantText: input.assistantText,
          runId: input.runId,
          toolUses: input.toolUses.map((item) => ({ ...item })),
          leaseExpiresAt: new Date(now.getTime() + SETTLEMENT_ATTEMPT_LEASE_MS),
          updatedAt: now,
        })
        .where(and(
          eq(schema.chatTurnSettlements.id, input.settlementId),
          eq(schema.chatTurnSettlements.status, 'capturing'),
          eq(schema.chatTurnSettlements.leaseToken, captureLeaseToken),
          gt(schema.chatTurnSettlements.leaseExpiresAt, now),
        ))
        .returning({ assistantMessageId: schema.chatTurnSettlements.assistantMessageId });
      if (!row || row.assistantMessageId !== input.assistantMessageId) {
        throw new Error('chat capture lease lost');
      }
      await tx
        .update(schema.chatMessages)
        .set({ content: input.assistantText, runId: input.runId, updatedAt: new Date() })
        .where(eq(schema.chatMessages.id, input.assistantMessageId));
    });
  }

  async heartbeatCapture(settlementId: string, captureLeaseToken: string): Promise<boolean> {
    const now = new Date();
    const [row] = await this.db
      .update(schema.chatTurnSettlements)
      .set({
        leaseExpiresAt: new Date(now.getTime() + SETTLEMENT_ATTEMPT_LEASE_MS),
        updatedAt: now,
      })
      .where(and(
        eq(schema.chatTurnSettlements.id, settlementId),
        eq(schema.chatTurnSettlements.status, 'capturing'),
        eq(schema.chatTurnSettlements.leaseToken, captureLeaseToken),
        gt(schema.chatTurnSettlements.leaseExpiresAt, now),
      ))
      .returning({ id: schema.chatTurnSettlements.id });
    return Boolean(row);
  }

  async finalizeCapture(input: ChatTurnSettlementRequest, captureLeaseToken: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SETTLEMENT_REQUEST_ATTEMPTS; attempt += 1) {
      try {
        await this.db.transaction(async (tx) => {
          const [current] = await tx
            .select()
            .from(schema.chatTurnSettlements)
            .where(eq(schema.chatTurnSettlements.id, input.settlementId))
            .for('update')
            .limit(1);
          if (!current) throw new Error('chat capture not found');
          if (current.status !== 'capturing') {
            if (
              ['pending', 'processing', 'completed', 'dead'].includes(current.status)
              && current.assistantMessageId === input.assistantMessageId
              && current.assistantText === input.assistantText
              && current.finishState === input.finishState
            ) return;
            throw new Error('chat capture already finalized with different snapshot');
          }
          if (current.leaseToken !== captureLeaseToken) throw new Error('chat capture lease lost');
          if (!current.leaseExpiresAt || current.leaseExpiresAt <= new Date()) {
            throw new Error('chat capture lease expired');
          }

          const settleCompletedAnswer = input.finishState === 'complete' && input.assistantText.trim().length > 0;
          await tx
            .update(schema.chatMessages)
            .set({
              content: input.assistantText,
              runId: input.runId,
              finishState: input.finishState,
              updatedAt: new Date(),
            })
            .where(eq(schema.chatMessages.id, input.assistantMessageId));
          await tx
            .update(schema.chatTurnSettlements)
            .set({
              assistantText: input.assistantText,
              runId: input.runId,
              finishState: input.finishState,
              toolUses: input.toolUses.map((item) => ({ ...item })),
              status: 'pending',
              leaseToken: null,
              leaseExpiresAt: null,
              evidenceStatus: 'pending',
              verificationStatus: settleCompletedAnswer ? 'pending' : 'skipped',
              brainStatus: settleCompletedAnswer ? 'pending' : 'skipped',
              notificationStatus: settleCompletedAnswer ? 'pending' : 'skipped',
              updatedAt: new Date(),
            })
            .where(eq(schema.chatTurnSettlements.id, input.settlementId));
          if (input.insightShadowId) {
            const [shadow] = await tx
              .select()
              .from(schema.consultingInsightShadowTurns)
              .where(eq(schema.consultingInsightShadowTurns.id, input.insightShadowId))
              .for('update')
              .limit(1);
            if (
              !shadow
              || shadow.workspaceId !== input.workspaceId
              || shadow.threadId !== input.threadId
              || shadow.settlementId !== input.settlementId
              || shadow.userMessageId !== input.userMessageId
              || shadow.status !== 'pending'
            ) {
              throw new ChatTurnIdempotencyConflictError('consulting insight shadow provenance conflict');
            }
            const shadowStatus = settleCompletedAnswer
              ? 'succeeded'
              : input.finishState === 'cancelled' ? 'cancelled' : 'failed';
            const shadowReplayReady = Boolean(shadow.retrievalRunId && shadow.retrievalSnapshotHash);
            await tx
              .update(schema.consultingInsightShadowTurns)
              .set({
                assistantMessageId: input.assistantMessageId,
                runId: input.runId,
                status: shadowStatus,
                ...(settleCompletedAnswer && !shadowReplayReady
                  ? { replayStatus: 'snapshot_invalid', replayError: 'retrieval snapshot not attached' }
                  : {}),
                baselineResponseHash: createHash('sha256').update(input.assistantText, 'utf8').digest('hex'),
                settledAt: new Date(),
                updatedAt: new Date(),
              })
              .where(and(
                eq(schema.consultingInsightShadowTurns.id, input.insightShadowId),
                eq(schema.consultingInsightShadowTurns.status, 'pending'),
              ));
            if (settleCompletedAnswer && shadowReplayReady) {
              await tx
                .insert(schema.outboxEvents)
                .values({
                  workspaceId: input.workspaceId,
                  eventType: CONSULTING_INSIGHT_SHADOW_REQUESTED_EVENT,
                  aggregateType: 'thread',
                  aggregateId: input.threadId,
                  payload: {
                    shadowTurnId: shadow.id,
                    settlementId: input.settlementId,
                    retrievalRunId: shadow.retrievalRunId!,
                    assistantMessageId: input.assistantMessageId,
                  },
                  status: 'pending',
                  idempotencyKey: `consulting-insight-shadow:${shadow.id}:attempt:0`,
                })
                .onConflictDoNothing({ target: schema.outboxEvents.idempotencyKey });
            }
          }
          await tx
            .insert(schema.outboxEvents)
            .values({
              workspaceId: input.workspaceId,
              eventType: CHAT_TURN_SETTLEMENT_REQUESTED_EVENT,
              aggregateType: 'thread',
              aggregateId: input.threadId,
              payload: {
                settlementId: input.settlementId,
                assistantMessageId: input.assistantMessageId,
                threadId: input.threadId,
              },
              status: 'pending',
              idempotencyKey: `chat-turn-settlement:${input.settlementId}:attempt:0`,
            })
            .onConflictDoNothing({ target: schema.outboxEvents.idempotencyKey });
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < SETTLEMENT_REQUEST_ATTEMPTS) await delay(attempt * 20);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async requestSettlement(input: ChatTurnSettlementRequest): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SETTLEMENT_REQUEST_ATTEMPTS; attempt += 1) {
      try {
        await this.db.transaction(async (tx) => {
          const [userMessage] = await tx
            .select({
              workspaceId: schema.chatMessages.workspaceId,
              threadId: schema.chatMessages.threadId,
              role: schema.chatMessages.role,
              authorUserId: schema.chatMessages.authorUserId,
              content: schema.chatMessages.content,
            })
            .from(schema.chatMessages)
            .where(eq(schema.chatMessages.id, input.userMessageId))
            .limit(1);
          if (
            !userMessage
            || userMessage.workspaceId !== input.workspaceId
            || userMessage.threadId !== input.threadId
            || userMessage.role !== 'user'
            || userMessage.authorUserId !== input.requestedByUserId
            || userMessage.content !== input.userText
          ) {
            throw new ChatTurnIdempotencyConflictError('user message provenance conflict');
          }

          await tx
            .insert(schema.chatMessages)
            .values({
              id: input.assistantMessageId,
              workspaceId: input.workspaceId,
              threadId: input.threadId,
              role: 'assistant',
              authorUserId: null,
              content: input.assistantText,
              runId: input.runId,
              finishState: input.finishState,
            })
            .onConflictDoNothing({ target: schema.chatMessages.id });

          const [assistantMessage] = await tx
            .select({
              workspaceId: schema.chatMessages.workspaceId,
              threadId: schema.chatMessages.threadId,
              role: schema.chatMessages.role,
              authorUserId: schema.chatMessages.authorUserId,
              content: schema.chatMessages.content,
              runId: schema.chatMessages.runId,
              finishState: schema.chatMessages.finishState,
            })
            .from(schema.chatMessages)
            .where(eq(schema.chatMessages.id, input.assistantMessageId))
            .limit(1);
          if (
            !assistantMessage
            || assistantMessage.workspaceId !== input.workspaceId
            || assistantMessage.threadId !== input.threadId
            || assistantMessage.role !== 'assistant'
            || assistantMessage.authorUserId !== null
            || assistantMessage.content !== input.assistantText
            || assistantMessage.runId !== input.runId
            || assistantMessage.finishState !== input.finishState
          ) {
            throw new ChatTurnIdempotencyConflictError('assistant message provenance conflict');
          }

          const settleCompletedAnswer = input.finishState === 'complete' && input.assistantText.trim().length > 0;
          const expectedToolUses = input.toolUses.map((item) => ({ ...item }));
          await tx
            .insert(schema.chatTurnSettlements)
            .values({
              id: input.settlementId,
              workspaceId: input.workspaceId,
              threadId: input.threadId,
              userMessageId: input.userMessageId,
              assistantMessageId: input.assistantMessageId,
              requestedByUserId: input.requestedByUserId,
              userPrompt: input.userPrompt,
              userText: input.userText,
              assistantText: input.assistantText,
              runId: input.runId,
              finishState: input.finishState,
              toolUses: expectedToolUses,
              status: 'pending',
              evidenceStatus: 'pending',
              verificationStatus: settleCompletedAnswer ? 'pending' : 'skipped',
              brainStatus: settleCompletedAnswer ? 'pending' : 'skipped',
              notificationStatus: settleCompletedAnswer ? 'pending' : 'skipped',
              verifiedContradictions: [],
              attemptCount: 0,
              stepErrors: {},
            })
            .onConflictDoNothing({ target: schema.chatTurnSettlements.assistantMessageId });

          const [settlement] = await tx
            .select()
            .from(schema.chatTurnSettlements)
            .where(eq(schema.chatTurnSettlements.assistantMessageId, input.assistantMessageId))
            .for('update')
            .limit(1);
          if (
            !settlement
            || settlement.id !== input.settlementId
            || settlement.workspaceId !== input.workspaceId
            || settlement.threadId !== input.threadId
            || settlement.userMessageId !== input.userMessageId
            || settlement.assistantMessageId !== input.assistantMessageId
            || settlement.requestedByUserId !== input.requestedByUserId
            || settlement.userPrompt !== input.userPrompt
            || settlement.userText !== input.userText
            || settlement.assistantText !== input.assistantText
            || settlement.runId !== input.runId
            || settlement.finishState !== input.finishState
            || canonicalJson(settlement.toolUses) !== canonicalJson(expectedToolUses)
          ) {
            throw new ChatTurnIdempotencyConflictError('chat settlement provenance conflict');
          }

          await tx
            .insert(schema.outboxEvents)
            .values({
              workspaceId: input.workspaceId,
              eventType: CHAT_TURN_SETTLEMENT_REQUESTED_EVENT,
              aggregateType: 'thread',
              aggregateId: input.threadId,
              payload: {
                settlementId: input.settlementId,
                assistantMessageId: input.assistantMessageId,
                threadId: input.threadId,
              },
              status: 'pending',
              idempotencyKey: `chat-turn-settlement:${input.settlementId}:attempt:0`,
            })
            .onConflictDoNothing({ target: schema.outboxEvents.idempotencyKey });
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < SETTLEMENT_REQUEST_ATTEMPTS) await delay(attempt * 20);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async findById(settlementId: string): Promise<ChatTurnSettlementRecord | null> {
    const [row] = await this.db
      .select()
      .from(schema.chatTurnSettlements)
      .where(eq(schema.chatTurnSettlements.id, settlementId))
      .limit(1);
    return row ? { ...row, verifiedContradictions: parseStoredVerifiedContradictions(row.verifiedContradictions) } : null;
  }

  async findOwnershipByRunId(runId: string): Promise<{ workspaceId: string; threadId: string } | null> {
    const rows = await this.db
      .select({ workspaceId: schema.chatTurnSettlements.workspaceId, threadId: schema.chatTurnSettlements.threadId })
      .from(schema.chatTurnSettlements)
      .where(eq(schema.chatTurnSettlements.runId, runId))
      .orderBy(desc(schema.chatTurnSettlements.updatedAt))
      .limit(2);
    return rows.length === 1 ? rows[0]! : null;
  }

  async claimAttempt(settlementId: string): Promise<SettlementAttemptClaim> {
    const now = new Date();
    const leaseToken = randomUUID();
    const [row] = await this.db
      .update(schema.chatTurnSettlements)
      .set({
        status: 'processing',
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + SETTLEMENT_ATTEMPT_LEASE_MS),
        updatedAt: now,
      })
      .where(and(
        eq(schema.chatTurnSettlements.id, settlementId),
        or(
          eq(schema.chatTurnSettlements.status, 'pending'),
          and(
            eq(schema.chatTurnSettlements.status, 'processing'),
            or(
              isNull(schema.chatTurnSettlements.leaseExpiresAt),
              lte(schema.chatTurnSettlements.leaseExpiresAt, now),
            ),
          ),
        ),
      ))
      .returning();
    if (row) {
      return {
        state: 'claimed',
        leaseToken,
        settlement: {
          ...row,
          verifiedContradictions: parseStoredVerifiedContradictions(row.verifiedContradictions),
        },
      };
    }
    const current = await this.findById(settlementId);
    if (!current) return { state: 'terminal' };
    return current.status === 'completed' || current.status === 'dead'
      ? { state: 'terminal' }
      : { state: 'busy' };
  }

  async heartbeatAttempt(settlementId: string, leaseToken: string): Promise<boolean> {
    const now = new Date();
    const [row] = await this.db
      .update(schema.chatTurnSettlements)
      .set({
        leaseExpiresAt: new Date(now.getTime() + SETTLEMENT_ATTEMPT_LEASE_MS),
        updatedAt: now,
      })
      .where(and(
        eq(schema.chatTurnSettlements.id, settlementId),
        eq(schema.chatTurnSettlements.status, 'processing'),
        eq(schema.chatTurnSettlements.leaseToken, leaseToken),
        gt(schema.chatTurnSettlements.leaseExpiresAt, now),
      ))
      .returning({ id: schema.chatTurnSettlements.id });
    return Boolean(row);
  }

  async runEvidenceStep(settlementId: string, attemptLeaseToken: string, operation: (db: Db) => Promise<void>): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          stepStatus: schema.chatTurnSettlements.evidenceStatus,
          status: schema.chatTurnSettlements.status,
          leaseToken: schema.chatTurnSettlements.leaseToken,
          leaseExpiresAt: schema.chatTurnSettlements.leaseExpiresAt,
        })
        .from(schema.chatTurnSettlements)
        .where(eq(schema.chatTurnSettlements.id, settlementId))
        .for('update')
        .limit(1);
      if (!row) throw new Error('chat settlement not found');
      this.assertAttemptLease(row, attemptLeaseToken);
      if (row.stepStatus !== 'pending') return;
      await operation(tx);
      const completedAt = new Date();
      const [completed] = await tx
        .update(schema.chatTurnSettlements)
        .set({ evidenceStatus: 'completed', updatedAt: completedAt })
        .where(and(
          eq(schema.chatTurnSettlements.id, settlementId),
          eq(schema.chatTurnSettlements.leaseToken, attemptLeaseToken),
          gt(schema.chatTurnSettlements.leaseExpiresAt, completedAt),
        ))
        .returning({ id: schema.chatTurnSettlements.id });
      if (!completed) throw new Error('chat settlement attempt lease lost');
    });
  }

  async claimVerificationStep(settlementId: string, attemptLeaseToken: string): Promise<VerificationStepClaim> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          status: schema.chatTurnSettlements.status,
          attemptLeaseToken: schema.chatTurnSettlements.leaseToken,
          stepStatus: schema.chatTurnSettlements.verificationStatus,
          verificationLeaseExpiresAt: schema.chatTurnSettlements.verificationLeaseExpiresAt,
          attemptLeaseExpiresAt: schema.chatTurnSettlements.leaseExpiresAt,
          verifiedContradictions: schema.chatTurnSettlements.verifiedContradictions,
        })
        .from(schema.chatTurnSettlements)
        .where(eq(schema.chatTurnSettlements.id, settlementId))
        .for('update')
        .limit(1);
      if (!row) throw new Error('chat settlement not found');
      this.assertAttemptLease({
        status: row.status,
        leaseToken: row.attemptLeaseToken,
        leaseExpiresAt: row.attemptLeaseExpiresAt,
      }, attemptLeaseToken);
      if (row.stepStatus === 'skipped') return { state: 'terminal', verifiedContradictions: [] };
      if (row.stepStatus === 'completed') {
        return {
          state: 'terminal',
          verifiedContradictions: parseStoredVerifiedContradictions(row.verifiedContradictions),
        };
      }
      const now = new Date();
      if (row.stepStatus === 'processing' && row.verificationLeaseExpiresAt && row.verificationLeaseExpiresAt > now) {
        return { state: 'busy' };
      }
      const leaseToken = randomUUID();
      const [claimed] = await tx
        .update(schema.chatTurnSettlements)
        .set({
          verificationStatus: 'processing',
          verificationLeaseToken: leaseToken,
          verificationLeaseExpiresAt: new Date(now.getTime() + SETTLEMENT_VERIFICATION_LEASE_MS),
          updatedAt: now,
        })
        .where(and(
          eq(schema.chatTurnSettlements.id, settlementId),
          eq(schema.chatTurnSettlements.leaseToken, attemptLeaseToken),
          gt(schema.chatTurnSettlements.leaseExpiresAt, now),
        ))
        .returning({ id: schema.chatTurnSettlements.id });
      if (!claimed) throw new Error('chat settlement attempt lease lost');
      return { state: 'claimed', leaseToken };
    });
  }

  async completeVerificationStep(
    settlementId: string,
    attemptLeaseToken: string,
    verificationLeaseToken: string,
    operation: (db: Db) => Promise<{ verifiedContradictions: ConsultingVerifiedContradiction[] }>,
  ): Promise<ConsultingVerifiedContradiction[]> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          status: schema.chatTurnSettlements.status,
          attemptLeaseToken: schema.chatTurnSettlements.leaseToken,
          attemptLeaseExpiresAt: schema.chatTurnSettlements.leaseExpiresAt,
          stepStatus: schema.chatTurnSettlements.verificationStatus,
          verificationLeaseToken: schema.chatTurnSettlements.verificationLeaseToken,
          verificationLeaseExpiresAt: schema.chatTurnSettlements.verificationLeaseExpiresAt,
          verifiedContradictions: schema.chatTurnSettlements.verifiedContradictions,
        })
        .from(schema.chatTurnSettlements)
        .where(eq(schema.chatTurnSettlements.id, settlementId))
        .for('update')
        .limit(1);
      if (!row) throw new Error('chat settlement not found');
      this.assertAttemptLease({
        status: row.status,
        leaseToken: row.attemptLeaseToken,
        leaseExpiresAt: row.attemptLeaseExpiresAt,
      }, attemptLeaseToken);
      if (row.stepStatus === 'skipped') return [];
      if (row.stepStatus === 'completed') return parseStoredVerifiedContradictions(row.verifiedContradictions);
      if (
        row.stepStatus !== 'processing'
        || row.verificationLeaseToken !== verificationLeaseToken
        || !row.verificationLeaseExpiresAt
        || row.verificationLeaseExpiresAt <= new Date()
      ) {
        throw new Error('verification step lease lost');
      }
      const result = await operation(tx);
      const verifiedContradictions = parseStoredVerifiedContradictions(result.verifiedContradictions);
      const completedAt = new Date();
      const [completed] = await tx
        .update(schema.chatTurnSettlements)
        .set({
          verificationStatus: 'completed',
          verificationLeaseToken: null,
          verificationLeaseExpiresAt: null,
          verifiedContradictions: verifiedContradictions.map((item) => ({ ...item })),
          updatedAt: completedAt,
        })
        .where(and(
          eq(schema.chatTurnSettlements.id, settlementId),
          eq(schema.chatTurnSettlements.leaseToken, attemptLeaseToken),
          eq(schema.chatTurnSettlements.verificationLeaseToken, verificationLeaseToken),
          gt(schema.chatTurnSettlements.leaseExpiresAt, completedAt),
          gt(schema.chatTurnSettlements.verificationLeaseExpiresAt, completedAt),
        ))
        .returning({ id: schema.chatTurnSettlements.id });
      if (!completed) throw new Error('verification step lease lost');
      return verifiedContradictions;
    });
  }

  async releaseVerificationStep(
    settlementId: string,
    attemptLeaseToken: string,
    verificationLeaseToken: string,
  ): Promise<void> {
    const releasedAt = new Date();
    await this.db
      .update(schema.chatTurnSettlements)
      .set({
        verificationStatus: 'pending',
        verificationLeaseToken: null,
        verificationLeaseExpiresAt: null,
        updatedAt: releasedAt,
      })
      .where(and(
        eq(schema.chatTurnSettlements.id, settlementId),
        eq(schema.chatTurnSettlements.status, 'processing'),
        eq(schema.chatTurnSettlements.leaseToken, attemptLeaseToken),
        gt(schema.chatTurnSettlements.leaseExpiresAt, releasedAt),
        eq(schema.chatTurnSettlements.verificationStatus, 'processing'),
        eq(schema.chatTurnSettlements.verificationLeaseToken, verificationLeaseToken),
        gt(schema.chatTurnSettlements.verificationLeaseExpiresAt, releasedAt),
      ));
  }

  async runNotificationStep(settlementId: string, attemptLeaseToken: string, operation: (db: Db) => Promise<void>): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          stepStatus: schema.chatTurnSettlements.notificationStatus,
          status: schema.chatTurnSettlements.status,
          leaseToken: schema.chatTurnSettlements.leaseToken,
          leaseExpiresAt: schema.chatTurnSettlements.leaseExpiresAt,
        })
        .from(schema.chatTurnSettlements)
        .where(eq(schema.chatTurnSettlements.id, settlementId))
        .for('update')
        .limit(1);
      if (!row) throw new Error('chat settlement not found');
      this.assertAttemptLease(row, attemptLeaseToken);
      if (row.stepStatus !== 'pending') return;
      await operation(tx);
      const completedAt = new Date();
      const [completed] = await tx
        .update(schema.chatTurnSettlements)
        .set({ notificationStatus: 'completed', updatedAt: completedAt })
        .where(and(
          eq(schema.chatTurnSettlements.id, settlementId),
          eq(schema.chatTurnSettlements.leaseToken, attemptLeaseToken),
          gt(schema.chatTurnSettlements.leaseExpiresAt, completedAt),
        ))
        .returning({ id: schema.chatTurnSettlements.id });
      if (!completed) throw new Error('chat settlement attempt lease lost');
    });
  }

  async runBrainStep(settlementId: string, attemptLeaseToken: string, operation: () => Promise<void>): Promise<void> {
    const [row] = await this.db
      .select({
        stepStatus: schema.chatTurnSettlements.brainStatus,
        status: schema.chatTurnSettlements.status,
        leaseToken: schema.chatTurnSettlements.leaseToken,
        leaseExpiresAt: schema.chatTurnSettlements.leaseExpiresAt,
      })
      .from(schema.chatTurnSettlements)
      .where(eq(schema.chatTurnSettlements.id, settlementId))
      .limit(1);
    if (!row) throw new Error('chat settlement not found');
    this.assertAttemptLease(row, attemptLeaseToken);
    if (row.stepStatus !== 'pending') return;
    await operation();
    const completedAt = new Date();
    const [completed] = await this.db
      .update(schema.chatTurnSettlements)
      .set({ brainStatus: 'completed', updatedAt: completedAt })
      .where(and(
        eq(schema.chatTurnSettlements.id, settlementId),
        eq(schema.chatTurnSettlements.status, 'processing'),
        eq(schema.chatTurnSettlements.leaseToken, attemptLeaseToken),
        gt(schema.chatTurnSettlements.leaseExpiresAt, completedAt),
        eq(schema.chatTurnSettlements.brainStatus, 'pending'),
      ))
      .returning({ id: schema.chatTurnSettlements.id });
    if (!completed) throw new Error('chat settlement attempt lease lost');
  }

  async finishAttempt(settlementId: string, attemptLeaseToken: string, errors: Record<string, string>): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.chatTurnSettlements)
        .where(eq(schema.chatTurnSettlements.id, settlementId))
        .for('update')
        .limit(1);
      if (!row) throw new Error('chat settlement not found');
      if (row.status === 'completed' || row.status === 'dead') return;
      this.assertAttemptLease(row, attemptLeaseToken);

      const terminal = [
        row.evidenceStatus,
        row.verificationStatus,
        row.brainStatus,
        row.notificationStatus,
      ].every((status) => status === 'completed' || status === 'skipped');
      const sanitizedErrors = Object.fromEntries(
        Object.entries(errors).map(([step, message]) => [step, redactLogText(message)]),
      );
      const stepErrors = { ...row.stepErrors, ...sanitizedErrors };
      if (terminal) {
        const finishedAt = new Date();
        const [completed] = await tx
          .update(schema.chatTurnSettlements)
          .set({
            status: 'completed',
            leaseToken: null,
            leaseExpiresAt: null,
            lastError: null,
            stepErrors,
            updatedAt: finishedAt,
          })
          .where(and(
            eq(schema.chatTurnSettlements.id, settlementId),
            eq(schema.chatTurnSettlements.leaseToken, attemptLeaseToken),
            gt(schema.chatTurnSettlements.leaseExpiresAt, finishedAt),
          ))
          .returning({ id: schema.chatTurnSettlements.id });
        if (!completed) throw new Error('chat settlement attempt lease lost');
        return;
      }

      const nextAttempt = row.attemptCount + 1;
      const lastError = Object.entries(sanitizedErrors)
        .map(([step, message]) => `${step}: ${message}`)
        .join('; ') || 'settlement has unfinished steps';
      if (nextAttempt >= SETTLEMENT_MAX_ATTEMPTS) {
        const finishedAt = new Date();
        const [completed] = await tx
          .update(schema.chatTurnSettlements)
          .set({
            status: 'dead',
            leaseToken: null,
            leaseExpiresAt: null,
            attemptCount: nextAttempt,
            lastError,
            stepErrors,
            updatedAt: finishedAt,
          })
          .where(and(
            eq(schema.chatTurnSettlements.id, settlementId),
            eq(schema.chatTurnSettlements.leaseToken, attemptLeaseToken),
            gt(schema.chatTurnSettlements.leaseExpiresAt, finishedAt),
          ))
          .returning({ id: schema.chatTurnSettlements.id });
        if (!completed) throw new Error('chat settlement attempt lease lost');
        return;
      }

      const transitionedAt = new Date();
      const nextAttemptAt = new Date(transitionedAt.getTime() + settlementRetryDelaySeconds(nextAttempt) * 1_000);
      const [transitioned] = await tx
        .update(schema.chatTurnSettlements)
        .set({
          status: 'pending',
          leaseToken: null,
          leaseExpiresAt: null,
          attemptCount: nextAttempt,
          lastError,
          stepErrors,
          updatedAt: transitionedAt,
        })
        .where(and(
          eq(schema.chatTurnSettlements.id, settlementId),
          eq(schema.chatTurnSettlements.leaseToken, attemptLeaseToken),
          gt(schema.chatTurnSettlements.leaseExpiresAt, transitionedAt),
        ))
        .returning({ id: schema.chatTurnSettlements.id });
      if (!transitioned) throw new Error('chat settlement attempt lease lost');
      await tx
        .insert(schema.outboxEvents)
        .values({
          workspaceId: row.workspaceId,
          eventType: CHAT_TURN_SETTLEMENT_REQUESTED_EVENT,
          aggregateType: 'thread',
          aggregateId: row.threadId,
          payload: {
            settlementId: row.id,
            assistantMessageId: row.assistantMessageId,
            threadId: row.threadId,
          },
          status: 'pending',
          idempotencyKey: `chat-turn-settlement:${row.id}:attempt:${nextAttempt}`,
          nextAttemptAt,
        })
        .onConflictDoNothing({ target: schema.outboxEvents.idempotencyKey });
    });
  }

  async recoverStalledSettlements(
    staleBefore = new Date(Date.now() - SETTLEMENT_ATTEMPT_LEASE_MS),
    limit = 50,
  ): Promise<number> {
    const now = new Date();
    const candidates = await this.db
      .select({ id: schema.chatTurnSettlements.id })
      .from(schema.chatTurnSettlements)
      .where(and(
        inArray(schema.chatTurnSettlements.status, ['capturing', 'pending', 'processing']),
        lt(schema.chatTurnSettlements.updatedAt, staleBefore),
        or(
          eq(schema.chatTurnSettlements.status, 'pending'),
          and(
            eq(schema.chatTurnSettlements.status, 'capturing'),
            or(
              isNull(schema.chatTurnSettlements.leaseExpiresAt),
              lte(schema.chatTurnSettlements.leaseExpiresAt, now),
            ),
          ),
          and(
            eq(schema.chatTurnSettlements.status, 'processing'),
            or(
              isNull(schema.chatTurnSettlements.leaseExpiresAt),
              lte(schema.chatTurnSettlements.leaseExpiresAt, now),
            ),
          ),
        ),
      ))
      .limit(limit);

    let recovered = 0;
    for (const candidate of candidates) {
      recovered += await this.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.chatTurnSettlements)
          .where(eq(schema.chatTurnSettlements.id, candidate.id))
          .for('update')
          .limit(1);
        if (!row || row.status === 'completed' || row.status === 'dead' || row.updatedAt >= staleBefore) return 0;
        if (
          (row.status === 'capturing' || row.status === 'processing')
          && row.leaseExpiresAt
          && row.leaseExpiresAt > now
        ) return 0;
        if (
          row.verificationStatus === 'processing'
          && row.verificationLeaseExpiresAt
          && row.verificationLeaseExpiresAt > now
        ) return 0;

        const [activeOutbox] = await tx
          .select({ id: schema.outboxEvents.id })
          .from(schema.outboxEvents)
          .where(and(
            eq(schema.outboxEvents.workspaceId, row.workspaceId),
            like(schema.outboxEvents.idempotencyKey, `chat-turn-settlement:${row.id}:%`),
            inArray(schema.outboxEvents.status, ['pending', 'processing']),
          ))
          .limit(1);
        if (activeOutbox) return 0;

        const recoveryCount = row.recoveryCount + 1;
        if (row.status === 'capturing') {
          await tx
            .update(schema.chatMessages)
            .set({
              content: row.assistantText,
              runId: row.runId,
              finishState: 'cancelled',
              updatedAt: now,
            })
            .where(eq(schema.chatMessages.id, row.assistantMessageId));
          await tx
            .update(schema.chatTurnSettlements)
            .set({
              status: 'pending',
              finishState: 'cancelled',
              leaseToken: null,
              leaseExpiresAt: null,
              verificationStatus: 'skipped',
              verificationLeaseToken: null,
              verificationLeaseExpiresAt: null,
              brainStatus: 'skipped',
              notificationStatus: 'skipped',
              recoveryCount,
              lastError: 'capture lease expired before terminal settlement',
              updatedAt: now,
            })
            .where(eq(schema.chatTurnSettlements.id, row.id));
          await tx
            .insert(schema.outboxEvents)
            .values({
              workspaceId: row.workspaceId,
              eventType: CHAT_TURN_SETTLEMENT_REQUESTED_EVENT,
              aggregateType: 'thread',
              aggregateId: row.threadId,
              payload: {
                settlementId: row.id,
                assistantMessageId: row.assistantMessageId,
                threadId: row.threadId,
              },
              status: 'pending',
              idempotencyKey: `chat-turn-settlement:${row.id}:capture-recovery:${recoveryCount}`,
            })
            .onConflictDoNothing({ target: schema.outboxEvents.idempotencyKey });
          return 1;
        }
        const resetVerification = row.verificationStatus === 'processing';
        await tx
          .update(schema.chatTurnSettlements)
          .set({
            status: 'pending',
            leaseToken: null,
            leaseExpiresAt: null,
            recoveryCount,
            ...(resetVerification
              ? {
                  verificationStatus: 'pending',
                  verificationLeaseToken: null,
                  verificationLeaseExpiresAt: null,
                }
              : {}),
            updatedAt: now,
          })
          .where(eq(schema.chatTurnSettlements.id, row.id));
        await tx
          .insert(schema.outboxEvents)
          .values({
            workspaceId: row.workspaceId,
            eventType: CHAT_TURN_SETTLEMENT_REQUESTED_EVENT,
            aggregateType: 'thread',
            aggregateId: row.threadId,
            payload: {
              settlementId: row.id,
              assistantMessageId: row.assistantMessageId,
              threadId: row.threadId,
            },
            status: 'pending',
            idempotencyKey: `chat-turn-settlement:${row.id}:recovery:${recoveryCount}`,
          })
          .onConflictDoNothing({ target: schema.outboxEvents.idempotencyKey });
        return 1;
      });
    }
    return recovered;
  }

  private assertAttemptLease(
    row: { status: string; leaseToken: string | null; leaseExpiresAt: Date | null },
    attemptLeaseToken: string,
  ): void {
    if (
      row.status !== 'processing'
      || row.leaseToken !== attemptLeaseToken
      || !row.leaseExpiresAt
      || row.leaseExpiresAt <= new Date()
    ) {
      throw new Error('chat settlement attempt lease lost');
    }
  }
}
