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
  assistantText: string;
  runId: string | null;
  assistantMessageId: string;
  timestamp: number;
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
      assistantText: input.assistantText,
      runId: input.runId,
      assistantMessageId: input.assistantMessageId,
      timestamp: Date.now() / 1000,
    };

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
