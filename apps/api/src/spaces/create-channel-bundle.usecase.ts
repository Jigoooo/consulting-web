import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { ok, err, type Result, domainError } from '@consulting/shared';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { ScopeRepository } from './scope.repository.js';

export interface CreateChannelBundleCommand {
  projectId: string;
  actorUserId: string;
  name: string;
  slug: string;
  requestId?: string;
}

export interface CreateChannelBundleResult {
  channelId: string;
  topicId: string;
  threadId: string;
}

export interface EnsureChannelConversationCommand {
  channelId: string;
  actorUserId: string;
  requestId?: string;
}

const DEFAULT_TOPIC_NAME = '대화';
const DEFAULT_TOPIC_SLUG = 'conversation';
const DEFAULT_THREAD_TITLE = '새 대화';

class ChannelBundleConflictError extends Error {}

/**
 * Idempotently creates (or completes) a channel's default conversation tree.
 * The channel, first topic, first thread, graph edges, inherited tags, outbox,
 * and audit rows commit atomically in one database transaction.
 */
@Injectable()
export class CreateChannelBundleUseCase {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(ScopeRepository) private readonly scopes: ScopeRepository,
  ) {}

  async execute(cmd: CreateChannelBundleCommand): Promise<Result<CreateChannelBundleResult>> {
    const chain = await this.scopes.chainForProject(cmd.projectId);
    if (!chain) return err(domainError('NOT_FOUND', 'project not found'));
    const workspaceId = chain[0]!.scopeId;
    const inheritedTags = await this.scopes.inheritedTags(workspaceId, chain);

    try {
      const value = await this.db.transaction(async (tx) => {
        const [project] = await tx
          .select({ workspaceId: schema.projects.workspaceId })
          .from(schema.projects)
          .innerJoin(schema.workspaces, eq(schema.projects.workspaceId, schema.workspaces.id))
          .where(and(
            eq(schema.projects.id, cmd.projectId),
            eq(schema.projects.workspaceId, workspaceId),
            eq(schema.projects.status, 'active'),
            isNull(schema.projects.deletedAt),
            isNull(schema.workspaces.deletedAt),
          ))
          .for('update')
          .limit(1);
        if (!project) throw new ChannelBundleConflictError('project is not active');

        const insertedChannels = await tx
          .insert(schema.channels)
          .values({ workspaceId, projectId: cmd.projectId, name: cmd.name, slug: cmd.slug })
          .onConflictDoNothing()
          .returning({ id: schema.channels.id, name: schema.channels.name });
        let channel = insertedChannels[0];
        const channelCreated = Boolean(channel);
        if (!channel) {
          [channel] = await tx
            .select({ id: schema.channels.id, name: schema.channels.name })
            .from(schema.channels)
            .where(and(
              eq(schema.channels.workspaceId, workspaceId),
              eq(schema.channels.projectId, cmd.projectId),
              eq(schema.channels.slug, cmd.slug),
              eq(schema.channels.status, 'active'),
              isNull(schema.channels.deletedAt),
            ))
            .for('update')
            .limit(1);
        }
        if (!channel || channel.name !== cmd.name) {
          throw new ChannelBundleConflictError('channel slug already belongs to another channel');
        }

        await tx.insert(schema.contextEdges).values({
          workspaceId,
          fromScopeType: 'project',
          fromScopeId: cmd.projectId,
          toScopeType: 'channel',
          toScopeId: channel.id,
          edgeType: 'parent_of',
          origin: 'system',
        }).onConflictDoNothing();

        if (channelCreated) {
          for (const tag of inheritedTags) {
            const [tagRow] = await tx.insert(schema.contextTags)
              .values({ key: tag.key, value: tag.value, normalizedValue: tag.value.trim().toLowerCase() })
              .onConflictDoUpdate({
                target: [schema.contextTags.key, schema.contextTags.normalizedValue],
                set: { value: tag.value },
              })
              .returning({ id: schema.contextTags.id });
            if (!tagRow) continue;
            await tx.insert(schema.scopeTags).values({
              workspaceId,
              scopeType: 'channel',
              scopeId: channel.id,
              tagId: tagRow.id,
              origin: 'inherited',
            }).onConflictDoNothing();
          }
          await tx.insert(schema.outboxEvents).values({
            workspaceId,
            eventType: 'ChannelCreated',
            aggregateType: 'channel',
            aggregateId: channel.id,
            payload: { projectId: cmd.projectId, slug: cmd.slug, inheritedTagCount: inheritedTags.length },
            idempotencyKey: `channel-created:${channel.id}`,
            requestId: cmd.requestId ?? null,
          });
          await tx.insert(schema.auditEvents).values({
            workspaceId,
            actorUserId: cmd.actorUserId,
            action: 'channel.create',
            scopeType: 'channel',
            scopeId: channel.id,
            after: { name: cmd.name, slug: cmd.slug, atomicBundle: true },
            requestId: cmd.requestId ?? null,
          });
        }

        let [topic] = await tx
          .select({ id: schema.topics.id })
          .from(schema.topics)
          .where(and(
            eq(schema.topics.workspaceId, workspaceId),
            eq(schema.topics.channelId, channel.id),
            eq(schema.topics.status, 'active'),
            isNull(schema.topics.deletedAt),
          ))
          .orderBy(asc(schema.topics.createdAt), asc(schema.topics.id))
          .for('update')
          .limit(1);
        let topicCreated = false;
        if (!topic) {
          const inserted = await tx.insert(schema.topics)
            .values({
              workspaceId,
              channelId: channel.id,
              name: DEFAULT_TOPIC_NAME,
              slug: DEFAULT_TOPIC_SLUG,
            })
            .onConflictDoNothing()
            .returning({ id: schema.topics.id });
          topic = inserted[0];
          topicCreated = Boolean(topic);
        }
        if (!topic) throw new Error('default topic insert failed');

        await tx.insert(schema.contextEdges).values({
          workspaceId,
          fromScopeType: 'channel',
          fromScopeId: channel.id,
          toScopeType: 'topic',
          toScopeId: topic.id,
          edgeType: 'parent_of',
          origin: 'system',
        }).onConflictDoNothing();
        if (topicCreated) {
          await tx.insert(schema.outboxEvents).values({
            workspaceId,
            eventType: 'TopicCreated',
            aggregateType: 'topic',
            aggregateId: topic.id,
            payload: { channelId: channel.id, slug: DEFAULT_TOPIC_SLUG },
            idempotencyKey: `topic-created:${topic.id}`,
            requestId: cmd.requestId ?? null,
          });
          await tx.insert(schema.auditEvents).values({
            workspaceId,
            actorUserId: cmd.actorUserId,
            action: 'topic.create',
            scopeType: 'topic',
            scopeId: topic.id,
            after: { name: DEFAULT_TOPIC_NAME, slug: DEFAULT_TOPIC_SLUG, atomicBundle: true },
            requestId: cmd.requestId ?? null,
          });
        }

        let [thread] = await tx
          .select({ id: schema.threads.id })
          .from(schema.threads)
          .where(and(
            eq(schema.threads.workspaceId, workspaceId),
            eq(schema.threads.topicId, topic.id),
            eq(schema.threads.status, 'active'),
            isNull(schema.threads.deletedAt),
          ))
          .orderBy(asc(schema.threads.createdAt), asc(schema.threads.id))
          .for('update')
          .limit(1);
        let threadCreated = false;
        if (!thread) {
          [thread] = await tx.insert(schema.threads)
            .values({ workspaceId, topicId: topic.id, title: DEFAULT_THREAD_TITLE })
            .returning({ id: schema.threads.id });
          threadCreated = Boolean(thread);
        }
        if (!thread) throw new Error('first thread insert failed');

        await tx.insert(schema.contextEdges).values({
          workspaceId,
          fromScopeType: 'topic',
          fromScopeId: topic.id,
          toScopeType: 'thread',
          toScopeId: thread.id,
          edgeType: 'parent_of',
          origin: 'system',
        }).onConflictDoNothing();
        if (threadCreated) {
          await tx.insert(schema.outboxEvents).values({
            workspaceId,
            eventType: 'ThreadCreated',
            aggregateType: 'thread',
            aggregateId: thread.id,
            payload: { topicId: topic.id, title: DEFAULT_THREAD_TITLE },
            idempotencyKey: `thread-created:${thread.id}`,
            requestId: cmd.requestId ?? null,
          });
          await tx.insert(schema.auditEvents).values({
            workspaceId,
            actorUserId: cmd.actorUserId,
            action: 'thread.create',
            scopeType: 'thread',
            scopeId: thread.id,
            after: { title: DEFAULT_THREAD_TITLE, atomicBundle: true },
            requestId: cmd.requestId ?? null,
          });
        }

        return { channelId: channel.id, topicId: topic.id, threadId: thread.id };
      });
      return ok(value);
    } catch (error) {
      if (error instanceof ChannelBundleConflictError) {
        return err(domainError('CONFLICT', error.message));
      }
      return err(domainError('INTERNAL', 'create channel bundle transaction failed'));
    }
  }

  async ensureConversation(
    cmd: EnsureChannelConversationCommand,
  ): Promise<Result<CreateChannelBundleResult>> {
    try {
      const value = await this.db.transaction(async (tx) => {
        const [channel] = await tx
          .select({
            id: schema.channels.id,
            workspaceId: schema.channels.workspaceId,
            projectId: schema.channels.projectId,
          })
          .from(schema.channels)
          .innerJoin(schema.projects, and(
            eq(schema.channels.projectId, schema.projects.id),
            eq(schema.channels.workspaceId, schema.projects.workspaceId),
          ))
          .innerJoin(schema.workspaces, eq(schema.projects.workspaceId, schema.workspaces.id))
          .where(and(
            eq(schema.channels.id, cmd.channelId),
            eq(schema.channels.status, 'active'),
            eq(schema.projects.status, 'active'),
            isNull(schema.channels.deletedAt),
            isNull(schema.projects.deletedAt),
            isNull(schema.workspaces.deletedAt),
          ))
          .for('update')
          .limit(1);
        if (!channel) throw new ChannelBundleConflictError('channel is not active');

        await tx.insert(schema.contextEdges).values({
          workspaceId: channel.workspaceId,
          fromScopeType: 'project',
          fromScopeId: channel.projectId,
          toScopeType: 'channel',
          toScopeId: channel.id,
          edgeType: 'parent_of',
          origin: 'system',
        }).onConflictDoNothing();

        let [topic] = await tx
          .select({ id: schema.topics.id, slug: schema.topics.slug })
          .from(schema.topics)
          .where(and(
            eq(schema.topics.workspaceId, channel.workspaceId),
            eq(schema.topics.channelId, channel.id),
            eq(schema.topics.status, 'active'),
            isNull(schema.topics.deletedAt),
          ))
          .orderBy(asc(schema.topics.createdAt), asc(schema.topics.id))
          .for('update')
          .limit(1);
        let topicCreated = false;
        if (!topic) {
          const usedSlugs = new Set((await tx
            .select({ slug: schema.topics.slug })
            .from(schema.topics)
            .where(eq(schema.topics.channelId, channel.id)))
            .map((row) => row.slug));
          let slug = DEFAULT_TOPIC_SLUG;
          for (let suffix = 2; usedSlugs.has(slug); suffix += 1) {
            slug = `${DEFAULT_TOPIC_SLUG}-${suffix}`;
          }
          [topic] = await tx.insert(schema.topics)
            .values({
              workspaceId: channel.workspaceId,
              channelId: channel.id,
              name: DEFAULT_TOPIC_NAME,
              slug,
            })
            .returning({ id: schema.topics.id, slug: schema.topics.slug });
          topicCreated = Boolean(topic);
        }
        if (!topic) throw new Error('default topic insert failed');

        await tx.insert(schema.contextEdges).values({
          workspaceId: channel.workspaceId,
          fromScopeType: 'channel',
          fromScopeId: channel.id,
          toScopeType: 'topic',
          toScopeId: topic.id,
          edgeType: 'parent_of',
          origin: 'system',
        }).onConflictDoNothing();
        if (topicCreated) {
          await tx.insert(schema.outboxEvents).values({
            workspaceId: channel.workspaceId,
            eventType: 'TopicCreated',
            aggregateType: 'topic',
            aggregateId: topic.id,
            payload: { channelId: channel.id, slug: topic.slug },
            idempotencyKey: `topic-created:${topic.id}`,
            requestId: cmd.requestId ?? null,
          });
          await tx.insert(schema.auditEvents).values({
            workspaceId: channel.workspaceId,
            actorUserId: cmd.actorUserId,
            action: 'topic.create',
            scopeType: 'topic',
            scopeId: topic.id,
            after: { name: DEFAULT_TOPIC_NAME, slug: topic.slug, atomicRepair: true },
            requestId: cmd.requestId ?? null,
          });
        }

        let [thread] = await tx
          .select({ id: schema.threads.id })
          .from(schema.threads)
          .where(and(
            eq(schema.threads.workspaceId, channel.workspaceId),
            eq(schema.threads.topicId, topic.id),
            eq(schema.threads.status, 'active'),
            isNull(schema.threads.deletedAt),
          ))
          .orderBy(asc(schema.threads.createdAt), asc(schema.threads.id))
          .for('update')
          .limit(1);
        let threadCreated = false;
        if (!thread) {
          [thread] = await tx.insert(schema.threads)
            .values({
              workspaceId: channel.workspaceId,
              topicId: topic.id,
              title: DEFAULT_THREAD_TITLE,
            })
            .returning({ id: schema.threads.id });
          threadCreated = Boolean(thread);
        }
        if (!thread) throw new Error('first thread insert failed');

        await tx.insert(schema.contextEdges).values({
          workspaceId: channel.workspaceId,
          fromScopeType: 'topic',
          fromScopeId: topic.id,
          toScopeType: 'thread',
          toScopeId: thread.id,
          edgeType: 'parent_of',
          origin: 'system',
        }).onConflictDoNothing();
        if (threadCreated) {
          await tx.insert(schema.outboxEvents).values({
            workspaceId: channel.workspaceId,
            eventType: 'ThreadCreated',
            aggregateType: 'thread',
            aggregateId: thread.id,
            payload: { topicId: topic.id, title: DEFAULT_THREAD_TITLE },
            idempotencyKey: `thread-created:${thread.id}`,
            requestId: cmd.requestId ?? null,
          });
          await tx.insert(schema.auditEvents).values({
            workspaceId: channel.workspaceId,
            actorUserId: cmd.actorUserId,
            action: 'thread.create',
            scopeType: 'thread',
            scopeId: thread.id,
            after: { title: DEFAULT_THREAD_TITLE, atomicRepair: true },
            requestId: cmd.requestId ?? null,
          });
        }

        return { channelId: channel.id, topicId: topic.id, threadId: thread.id };
      });
      return ok(value);
    } catch (error) {
      if (error instanceof ChannelBundleConflictError) {
        return err(domainError('CONFLICT', error.message));
      }
      return err(domainError('INTERNAL', 'ensure channel conversation transaction failed'));
    }
  }
}
