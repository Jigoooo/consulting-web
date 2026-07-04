import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { eq } from 'drizzle-orm';
import { ok, err, type Result, domainError } from '@consulting/shared';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

export interface CreateTopicCommand {
  channelId: string;
  actorUserId: string;
  name: string;
  slug: string;
  requestId?: string;
}

@Injectable()
export class CreateTopicUseCase {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async execute(cmd: CreateTopicCommand): Promise<Result<{ topicId: string }>> {
    const [channel] = await this.db
      .select({ id: schema.channels.id, workspaceId: schema.channels.workspaceId })
      .from(schema.channels)
      .where(eq(schema.channels.id, cmd.channelId))
      .limit(1);
    if (!channel) return err(domainError('NOT_FOUND', 'channel not found'));

    try {
      return await this.db.transaction(async (tx) => {
        const [topic] = await tx
          .insert(schema.topics)
          .values({ workspaceId: channel.workspaceId, channelId: cmd.channelId, name: cmd.name, slug: cmd.slug })
          .onConflictDoNothing()
          .returning({ id: schema.topics.id });
        if (!topic) return err(domainError('CONFLICT', 'topic slug already exists'));

        await tx.insert(schema.contextEdges).values({
          workspaceId: channel.workspaceId,
          fromScopeType: 'channel',
          fromScopeId: cmd.channelId,
          toScopeType: 'topic',
          toScopeId: topic.id,
          edgeType: 'parent_of',
          origin: 'system',
        }).onConflictDoNothing();

        await tx.insert(schema.outboxEvents).values({
          workspaceId: channel.workspaceId,
          eventType: 'TopicCreated',
          aggregateType: 'topic',
          aggregateId: topic.id,
          payload: { channelId: cmd.channelId, slug: cmd.slug },
          idempotencyKey: `topic-created:${topic.id}`,
          requestId: cmd.requestId ?? null,
        });

        await tx.insert(schema.auditEvents).values({
          workspaceId: channel.workspaceId,
          actorUserId: cmd.actorUserId,
          action: 'topic.create',
          scopeType: 'topic',
          scopeId: topic.id,
          after: { name: cmd.name, slug: cmd.slug },
          requestId: cmd.requestId ?? null,
        });

        return ok({ topicId: topic.id });
      });
    } catch {
      return err(domainError('INTERNAL', 'create topic transaction failed'));
    }
  }
}
