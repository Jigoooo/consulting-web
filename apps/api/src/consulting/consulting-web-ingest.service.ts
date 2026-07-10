import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { ConsultingTopicResolver } from './consulting-topic-resolver.service.js';

export interface ConsultingWebTurnIngestInput {
  threadId: string;
  userText: string;
  assistantText: string;
  runId: string | null;
  assistantMessageId: string;
  verifiedContradictions?: ConsultingVerifiedContradiction[];
}

export interface ConsultingVerifiedContradiction {
  verdictRef: string;
  claimId: string;
  claimText: string;
  verdict: 'refutes' | 'mixed';
  confidence: number;
  rationale: string;
  evidenceItemId: string;
  evidenceRef: string;
  evidenceText: string;
}

export interface ConsultingMemoryAllowedSegment {
  id: string;
  kind: 'user' | 'document' | 'tool';
  text: string;
  reason: string;
}

export interface ConsultingMemoryBlockedSegment {
  id: string;
  kind: 'assistant' | 'system' | 'unknown';
  text: string;
  reason: string;
}

export interface ConsultingAssistantMemoryCandidate {
  id: string;
  text: string;
  sourceMessageId: string;
  status: 'quarantined';
  reason: string;
}

export interface ConsultingWebTurnIngestPayload {
  consultingTopicSlug: string;
  consultingTopicId: number | null;
  sessionId: string;
  workspaceId: string;
  projectId: string;
  channelId: string;
  topicId: string;
  threadId: string;
  scopePath: string;
  userText: string;
  allowedSegments: ConsultingMemoryAllowedSegment[];
  assistantCandidate: ConsultingAssistantMemoryCandidate;
  blockedSegments: ConsultingMemoryBlockedSegment[];
  policyDecisionId: string;
  traceId: string;
  runId: string | null;
  assistantMessageId: string;
  timestamp: number;
  verifiedContradictions: ConsultingVerifiedContradiction[];
}

export const CONSULTING_WEB_TURN_COMPLETED_EVENT = 'ConsultingWebTurnCompleted';

@Injectable()
export class ConsultingWebIngestService {
  constructor(
    private readonly resolver: ConsultingTopicResolver,
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  async ingestCompletedTurn(input: ConsultingWebTurnIngestInput): Promise<void> {
    if (!input.userText.trim() || !input.assistantText.trim()) return;
    const scope = await this.resolver.resolveThread(input.threadId);
    if (!scope || scope.archived) return;
    const policyDecisionId = `memory-write-guard:v1:${input.assistantMessageId}`;
    const traceId = input.runId ?? `assistant-message:${input.assistantMessageId}`;
    const allowedSegments: ConsultingMemoryAllowedSegment[] = [{
      id: `user:${input.assistantMessageId}`,
      kind: 'user',
      text: input.userText,
      reason: 'user_input_allowed',
    }];
    const assistantCandidate: ConsultingAssistantMemoryCandidate = {
      id: `assistant:${input.assistantMessageId}`,
      text: input.assistantText,
      sourceMessageId: input.assistantMessageId,
      status: 'quarantined',
      reason: 'assistant_output_requires_review',
    };
    const blockedSegments: ConsultingMemoryBlockedSegment[] = [{
      id: assistantCandidate.id,
      kind: 'assistant',
      text: input.assistantText,
      reason: assistantCandidate.reason,
    }];

    const payload: ConsultingWebTurnIngestPayload = {
      consultingTopicSlug: scope.consultingTopicSlug,
      consultingTopicId: scope.consultingTopicId,
      sessionId: `consulting-web-thread:${input.threadId}`,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      channelId: scope.channelId,
      topicId: scope.topicId,
      threadId: scope.threadId,
      scopePath: scope.scopePath,
      userText: input.userText,
      allowedSegments,
      assistantCandidate,
      blockedSegments,
      policyDecisionId,
      traceId,
      runId: input.runId,
      assistantMessageId: input.assistantMessageId,
      timestamp: Date.now() / 1000,
      verifiedContradictions: (input.verifiedContradictions ?? []).map((item) => ({ ...item })),
    };

    await this.db
      .insert(schema.memoryWriteCandidates)
      .values({
        workspaceId: scope.workspaceId,
        threadId: scope.threadId,
        assistantMessageId: input.assistantMessageId,
        runId: input.runId,
        policyDecisionId,
        traceId,
        candidateText: input.assistantText,
        allowedSegments: allowedSegments.map((segment) => ({ ...segment })),
        blockedSegments: blockedSegments.map((segment) => ({ ...segment })),
        status: 'quarantined',
        reason: assistantCandidate.reason,
      })
      .onConflictDoNothing({ target: schema.memoryWriteCandidates.policyDecisionId });

    await this.db
      .insert(schema.outboxEvents)
      .values({
        workspaceId: scope.workspaceId,
        eventType: CONSULTING_WEB_TURN_COMPLETED_EVENT,
        aggregateType: 'thread',
        aggregateId: scope.threadId,
        payload,
        status: 'pending',
        idempotencyKey: `consulting-web-ingest:${scope.threadId}:${input.assistantMessageId}`,
      })
      .onConflictDoNothing({ target: schema.outboxEvents.idempotencyKey });
  }
}
