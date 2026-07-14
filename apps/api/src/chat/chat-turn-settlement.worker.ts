import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import { ENV_TOKEN } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { EvidenceDecisionStore } from '../consulting/evidence-decision.store.js';
import { ConsultingWebIngestService } from '../consulting/consulting-web-ingest.service.js';
import { CHAT_TURN_SETTLEMENT_REQUESTED_EVENT } from '../queues/outbox-routing.js';
import { QUEUE_NAMES } from '../queues/queue.tokens.js';
import { redactLogText } from '../security/redact-sensitive-text.js';
import { EvidenceStore } from './evidence.store.js';
import { NotificationStore } from './notification.store.js';
import { ChatTurnSettlementStore } from './chat-turn-settlement.store.js';

interface ChatSettlementOutboxJob {
  eventId: string;
  eventType: string;
  workspaceId: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
}

interface ChatSettlementPayload {
  settlementId: string;
  assistantMessageId: string;
  threadId: string;
}

function redisConnectionFromUrl(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379) };
}

function parsePayload(value: unknown): ChatSettlementPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid chat settlement payload');
  const record = value as Record<string, unknown>;
  const settlementId = typeof record.settlementId === 'string' ? record.settlementId.trim() : '';
  const assistantMessageId = typeof record.assistantMessageId === 'string' ? record.assistantMessageId.trim() : '';
  const threadId = typeof record.threadId === 'string' ? record.threadId.trim() : '';
  if (!settlementId || !assistantMessageId || !threadId) throw new Error('invalid chat settlement payload');
  return { settlementId, assistantMessageId, threadId };
}

@Injectable()
export class ChatTurnSettlementWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatTurnSettlementWorker.name);
  private worker: Worker | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    private readonly settlements: ChatTurnSettlementStore,
    private readonly evidence: EvidenceStore,
    private readonly decisions: EvidenceDecisionStore,
    private readonly webIngest: ConsultingWebIngestService,
    private readonly notifications: NotificationStore,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.recoverStalled();
    this.recoveryTimer = setInterval(() => {
      void this.recoverStalled();
    }, 30_000);
    this.recoveryTimer.unref();
    this.worker = new Worker(
      QUEUE_NAMES.chatTurnSettlement,
      async (job) => {
        try {
          await this.processOutboxJob(job.data as ChatSettlementOutboxJob);
        } catch (error) {
          this.logger.error(`chat settlement job failed: ${redactLogText(error instanceof Error ? error.message : String(error))}`);
          throw error;
        }
      },
      { connection: redisConnectionFromUrl(this.env.REDIS_URL), concurrency: 4 },
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    await this.worker?.close();
    this.worker = null;
  }

  async processOutboxJob(job: ChatSettlementOutboxJob): Promise<void> {
    if (job.eventType !== CHAT_TURN_SETTLEMENT_REQUESTED_EVENT) {
      throw new Error(`unsupported outbox event type: ${job.eventType}`);
    }
    if (job.aggregateType !== 'thread') throw new Error('chat settlement aggregate must be thread');
    const payload = parsePayload(job.payload);
    if (payload.threadId !== job.aggregateId) throw new Error('chat settlement thread envelope mismatch');

    const envelopeSettlement = await this.settlements.findById(payload.settlementId);
    if (!envelopeSettlement) return;
    if (
      envelopeSettlement.workspaceId !== job.workspaceId
      || envelopeSettlement.threadId !== payload.threadId
      || envelopeSettlement.assistantMessageId !== payload.assistantMessageId
    ) {
      throw new Error('chat settlement provenance envelope mismatch');
    }
    const attemptClaim = await this.settlements.claimAttempt(payload.settlementId);
    if (attemptClaim.state !== 'claimed') return;
    const { leaseToken: attemptLeaseToken, settlement } = attemptClaim;
    const heartbeat = setInterval(() => {
      void this.settlements.heartbeatAttempt(settlement.id, attemptLeaseToken).catch((error: unknown) => {
        this.logger.warn(`chat settlement heartbeat failed: ${redactLogText(error instanceof Error ? error.message : String(error))}`);
      });
    }, 30_000);
    heartbeat.unref();

    const errors: Record<string, string> = {};
    try {
      try {
        await this.settlements.runEvidenceStep(settlement.id, attemptLeaseToken, async (db) => {
        await this.evidence.saveRunEvidence({
          workspaceId: settlement.workspaceId,
          threadId: settlement.threadId,
          messageId: settlement.assistantMessageId,
          runId: settlement.runId,
          toolUses: settlement.toolUses,
        }, db);
        });
      } catch (error) {
        errors.evidence = error instanceof Error ? error.message : String(error);
      }

      let verifiedContradictions = settlement.verifiedContradictions;
      let verificationReady = true;
      const decisionInput = {
          workspaceId: settlement.workspaceId,
          threadId: settlement.threadId,
          assistantMessageId: settlement.assistantMessageId,
          userPrompt: settlement.userPrompt,
          answer: settlement.assistantText,
          runId: settlement.runId,
      };
      try {
        const verificationClaim = await this.settlements.claimVerificationStep(settlement.id, attemptLeaseToken);
        if (verificationClaim.state === 'terminal') {
          verifiedContradictions = verificationClaim.verifiedContradictions;
        } else if (verificationClaim.state === 'busy') {
          throw new Error('verification step lease busy');
        } else {
          try {
            const prepared = await this.decisions.prepareCompletedAnswer(decisionInput);
            verifiedContradictions = await this.settlements.completeVerificationStep(
              settlement.id,
              attemptLeaseToken,
              verificationClaim.leaseToken,
              async (db) => this.decisions.persistCompletedAnswer(decisionInput, prepared, db),
            );
          } catch (error) {
            await this.settlements.releaseVerificationStep(
              settlement.id,
              attemptLeaseToken,
              verificationClaim.leaseToken,
            );
            throw error;
          }
        }
      } catch (error) {
        verificationReady = false;
        errors.verification = error instanceof Error ? error.message : String(error);
      }

      if (verificationReady) {
        try {
          await this.settlements.runBrainStep(settlement.id, attemptLeaseToken, async () => {
          await this.webIngest.ingestCompletedTurn({
            threadId: settlement.threadId,
            userText: settlement.userText,
            assistantText: settlement.assistantText,
            runId: settlement.runId,
            assistantMessageId: settlement.assistantMessageId,
            verifiedContradictions,
          });
          });
        } catch (error) {
          errors.brain = error instanceof Error ? error.message : String(error);
        }
      }

      try {
        await this.settlements.runNotificationStep(settlement.id, attemptLeaseToken, async (db) => {
        await this.notifications.notifyWorkspace({
          workspaceId: settlement.workspaceId,
          ...(settlement.requestedByUserId ? { excludeUserId: settlement.requestedByUserId } : {}),
          dedupKey: `chat-settlement:${settlement.id}:assistant-reply`,
          type: 'assistant_reply',
          title: '지구의 새 답변',
          body: settlement.assistantText.slice(0, 200),
          refType: 'thread',
          refId: settlement.threadId,
        }, db);
        });
      } catch (error) {
        errors.notification = error instanceof Error ? error.message : String(error);
      }

      await this.settlements.finishAttempt(settlement.id, attemptLeaseToken, errors);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async recoverStalled(): Promise<void> {
    try {
      const recovered = await this.settlements.recoverStalledSettlements();
      if (recovered > 0) this.logger.warn(`recovered ${recovered} stalled chat settlement(s)`);
    } catch (error) {
      this.logger.error(`chat settlement recovery sweep failed: ${redactLogText(error instanceof Error ? error.message : String(error))}`);
    }
  }
}
