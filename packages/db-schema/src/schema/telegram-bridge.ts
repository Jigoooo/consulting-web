import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from './organization';
import { projects, channels, topics, threads } from './space';
import { primaryId, timestamps } from './_shared';

/** Exact Telegram forum-topic mapping into consulting-web scopes. */
export const telegramTopicLinks = pgTable(
  'telegram_topic_links',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    webTopicId: uuid('web_topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    telegramChatId: text('telegram_chat_id').notNull(),
    telegramThreadId: text('telegram_thread_id').notNull(),
    telegramTopicName: text('telegram_topic_name').notNull(),
    consultingTopicSlug: text('consulting_topic_slug').notNull(),
    memoryTopicId: text('memory_topic_id').notNull(),
    profileSource: text('profile_source').notNull().default('manual'),
    status: text('status').notNull().default('active'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('telegram_topic_links_unique').on(t.telegramChatId, t.telegramThreadId),
    index('telegram_topic_links_project_idx').on(t.projectId),
    index('telegram_topic_links_scope_idx').on(t.channelId, t.webTopicId, t.threadId),
    index('telegram_topic_links_memory_topic_idx').on(t.memoryTopicId),
  ],
);
