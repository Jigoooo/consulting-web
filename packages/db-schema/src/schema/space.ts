import { pgTable, text, uuid, index, unique } from 'drizzle-orm/pg-core';
import { entityStatus } from './enums';
import { workspaces } from './organization';
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
