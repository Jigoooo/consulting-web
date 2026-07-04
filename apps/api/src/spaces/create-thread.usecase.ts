import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { eq } from 'drizzle-orm';
import { ok, err, type Result, domainError } from '@consulting/shared';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

export interface CreateThreadCommand {
  topicId: string;
  actorUserId: string;
  title: string;
  requestId?: string;
}

@Injectable()
export class CreateThreadUseCase {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async execute(cmd: CreateThreadCommand): Promise<Result<{ threadId: string }>> {
    const [topic] = await this.db
      .select({ id: schema.topics.id, workspaceId: schema.topics.workspaceId })
      .from(schema.topics)
      .where(eq(schema.topics.id, cmd.topicId))
      .limit(1);
    if (!topic) return err(domainError('NOT_FOUND', 'topic not found'));

    try {
      return await this.db.transaction(async (tx) => {
        const [thread] = await tx
          .insert(schema.threads)
          .values({ workspaceId: topic.workspaceId, topicId: cmd.topicId, title: cmd.title })
          .returning({ id: schema.threads.id });
        if (!thread) return err(domainError('INTERNAL', 'thread insert failed'));

        await tx.insert(schema.contextEdges).values({
          workspaceId: topic.workspaceId,
          fromScopeType: 'topic',
          fromScopeId: cmd.topicId,
          toScopeType: 'thread',
          toScopeId: thread.id,
          edgeType: 'parent_of',
          origin: 'system',
        }).onConflictDoNothing();

        await tx.insert(schema.outboxEvents).values({
          workspaceId: topic.workspaceId,
          eventType: 'ThreadCreated',
          aggregateType: 'thread',
          aggregateId: thread.id,
          payload: { topicId: cmd.topicId, title: cmd.title },
          idempotencyKey: `thread-created:${thread.id}`,
          requestId: cmd.requestId ?? null,
        });

        await tx.insert(schema.auditEvents).values({
          workspaceId: topic.workspaceId,
          actorUserId: cmd.actorUserId,
          action: 'thread.create',
          scopeType: 'thread',
          scopeId: thread.id,
          after: { title: cmd.title },
          requestId: cmd.requestId ?? null,
        });

        return ok({ threadId: thread.id });
      });
    } catch {
      return err(domainError('INTERNAL', 'create thread transaction failed'));
    }
  }
}
