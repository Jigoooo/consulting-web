import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from './organization';
import { projects, channels, topics, threads } from './space';
import { users } from './identity';
import { primaryId, timestamps } from './_shared';

/**
 * Bridge between consulting-web scopes and the shared consulting brain GraphRAG topic.
 *
 * Important naming distinction:
 * - consulting.db topic = consulting engagement/project (e.g. changwon-org-mgmt-diagnosis)
 * - consulting-web topic = a sub-scope under channel
 */
export const consultingTopicLinks = pgTable(
  'consulting_topic_links',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'cascade' }),
    webTopicId: uuid('web_topic_id').references(() => topics.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id').references(() => threads.id, { onDelete: 'cascade' }),
    linkLevel: text('link_level').notNull(), // project | channel | topic | thread
    consultingTopicSlug: text('consulting_topic_slug').notNull(),
    consultingTopicId: integer('consulting_topic_id'),
    scopePath: text('scope_path').notNull().default(''),
    status: text('status').notNull().default('active'), // active | archived
    origin: text('origin').notNull().default('system'), // system | manual | import
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('consulting_topic_links_project_unique')
      .on(t.projectId)
      .where(sql`link_level = 'project' AND status = 'active'`),
    index('consulting_topic_links_workspace_idx').on(t.workspaceId),
    index('consulting_topic_links_slug_idx').on(t.consultingTopicSlug),
    index('consulting_topic_links_scope_idx').on(t.projectId, t.channelId, t.webTopicId, t.threadId),
  ],
);
