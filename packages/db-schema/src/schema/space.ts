import { pgTable, text, uuid, index, unique } from 'drizzle-orm/pg-core';
import { entityStatus, chatRole } from './enums';
import { workspaces } from './organization';
import { users } from './identity';
import { primaryId, timestamps, softDelete, optimisticVersion } from './_shared';

/**
 * Space tree (ADR-0002). Every row carries workspace_id (ADR-0001).
 * slug is unique within its parent (ADR-0020 concurrency).
 */
export const projects = pgTable(
  'projects',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    status: entityStatus('status').notNull().default('active'),
    ...optimisticVersion,
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    unique('projects_slug_unique').on(t.workspaceId, t.slug),
    index('projects_workspace_idx').on(t.workspaceId),
  ],
);

export const channels = pgTable(
  'channels',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    status: entityStatus('status').notNull().default('active'),
    ...optimisticVersion,
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    unique('channels_slug_unique').on(t.projectId, t.slug),
    index('channels_workspace_idx').on(t.workspaceId),
    index('channels_project_idx').on(t.projectId),
  ],
);

export const topics = pgTable(
  'topics',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** dialogue_memory topic linkage (ADR-0003). Null until registered. */
    memoryTopicId: text('memory_topic_id'),
    status: entityStatus('status').notNull().default('active'),
    ...optimisticVersion,
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    unique('topics_slug_unique').on(t.channelId, t.slug),
    index('topics_workspace_idx').on(t.workspaceId),
    index('topics_channel_idx').on(t.channelId),
  ],
);

export const threads = pgTable(
  'threads',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    topicId: uuid('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: entityStatus('status').notNull().default('active'),
    ...optimisticVersion,
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('threads_workspace_idx').on(t.workspaceId),
    index('threads_topic_idx').on(t.topicId),
  ],
);

/**
 * Chat messages persisted per thread (Phase 1.5 N-1). Every row carries
 * workspace_id for tenant filtering (ADR-0001). assistant rows keep the
 * Hermes run id for traceability; author_user_id is null for assistant rows.
 */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    role: chatRole('role').notNull(),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    content: text('content').notNull(),
    runId: text('run_id'),
    /** 'complete' | 'cancelled' | 'error' — assistant rows only, user rows always complete. */
    finishState: text('finish_state').notNull().default('complete'),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('chat_messages_thread_idx').on(t.threadId, t.createdAt),
    index('chat_messages_workspace_idx').on(t.workspaceId),
  ],
);
