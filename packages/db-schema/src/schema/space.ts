import { pgTable, text, timestamp, uuid, index, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { entityStatus, chatRole, scopeType } from './enums';
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
 * Append-only rows describing one recursive archive/soft-delete transition.
 * Restore replays the latest unresolved event to each scope's exact previous
 * state, so independent child archives survive parent lifecycle operations.
 */
export const scopeLifecycleTransitions = pgTable(
  'scope_lifecycle_transitions',
  {
    id: primaryId,
    eventId: uuid('event_id').notNull(),
    rootScopeType: scopeType('root_scope_type').notNull(),
    rootScopeId: uuid('root_scope_id').notNull(),
    operation: text('operation').$type<'archive' | 'soft_delete'>().notNull(),
    scopeType: scopeType('scope_type').notNull(),
    scopeId: uuid('scope_id').notNull(),
    previousStatus: entityStatus('previous_status').notNull(),
    previousDeletedAt: timestamp('previous_deleted_at', { withTimezone: true }),
    restoredAt: timestamp('restored_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique('scope_lifecycle_transition_event_scope_unique').on(t.eventId, t.scopeType, t.scopeId),
    index('scope_lifecycle_transition_root_idx').on(t.rootScopeType, t.rootScopeId, t.restoredAt, t.createdAt),
    index('scope_lifecycle_transition_event_idx').on(t.eventId),
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
    /** Browser-generated logical turn id. User rows only; null for legacy/assistant rows. */
    clientMessageId: uuid('client_message_id'),
    /** SHA-256 of the immutable thread/message/model/attachment request identity. */
    clientRequestHash: text('client_request_hash'),
    runId: text('run_id'),
    /** 'complete' | 'cancelled' | 'error' — assistant rows only, user rows always complete. */
    finishState: text('finish_state').notNull().default('complete'),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('chat_messages_thread_idx').on(t.threadId, t.createdAt),
    index('chat_messages_thread_cursor_idx').on(t.threadId, t.createdAt, t.id),
    index('chat_messages_workspace_idx').on(t.workspaceId),
    uniqueIndex('chat_messages_workspace_user_client_message_unique')
      .on(t.workspaceId, t.authorUserId, t.clientMessageId),
  ],
);
