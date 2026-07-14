import { drizzle } from 'drizzle-orm/node-postgres';
import { schema } from '@consulting/db-schema';
import { Pool, type PoolClient } from 'pg';
import {
  CHANGWON_TELEGRAM_TOPIC_REGISTRY,
  TelegramTopicRegistryService,
  type TelegramTopicBackfillPlan,
  type TelegramTopicRegistryEntry,
} from '../src/consulting/telegram-topic-registry.service.js';
import type { Db } from '../src/infra/drizzle.module.js';

interface Args {
  projectId: string | null;
  telegramChunks: number;
  json: boolean;
  commit: boolean;
  expectedWebMessages: number | null;
  confirmProjectName: string | null;
}

interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
}

interface ScopeRow {
  id: string;
  workspace_id?: string;
  project_id?: string;
  channel_id?: string;
  topic_id?: string;
}

interface TopicRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  memory_topic_id: string | null;
}

interface LinkRow {
  workspace_id: string;
  project_id: string;
  channel_id: string;
  web_topic_id: string;
  thread_id: string;
  memory_topic_id: string;
  consulting_topic_slug: string;
}

interface ApplySummary {
  mode: 'commit';
  projectId: string;
  projectName: string;
  beforeWebMessages: number;
  afterWebMessages: number;
  created: {
    channels: number;
    topics: number;
    threads: number;
    telegramTopicLinks: number;
    topicProfiles: number;
  };
  postCommitPlannedCreates: TelegramTopicBackfillPlan['plannedCreates'];
  exactBindingKeys: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    projectId: null,
    telegramChunks: 0,
    json: false,
    commit: false,
    expectedWebMessages: null,
    confirmProjectName: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--dry-run') continue;
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (arg === '--commit') {
      args.commit = true;
      continue;
    }
    if (arg === '--project-id') {
      args.projectId = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === '--telegram-chunks') {
      args.telegramChunks = Number(argv[i + 1] ?? 0);
      i += 1;
      continue;
    }
    if (arg === '--expected-web-messages') {
      const parsed = Number(argv[i + 1] ?? NaN);
      if (!Number.isInteger(parsed) || parsed < 0)
        throw new Error(`invalid --expected-web-messages: ${argv[i + 1] ?? ''}`);
      args.expectedWebMessages = parsed;
      i += 1;
      continue;
    }
    if (arg === '--confirm-project-name') {
      args.confirmProjectName = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function printText(plan: TelegramTopicBackfillPlan): void {
  console.log(`read_only: ${plan.readOnly}`);
  console.log(`project: ${plan.projectName} (${plan.projectId})`);
  console.log(
    `before: web_messages=${plan.before.webMessages} telegram_chunks=${plan.before.telegramChunks}`,
  );
  console.log(
    `planned_creates: channels=${plan.plannedCreates.channels} topics=${plan.plannedCreates.topics} threads=${plan.plannedCreates.threads} telegram_topic_links=${plan.plannedCreates.telegramTopicLinks} topic_profiles=${plan.plannedCreates.topicProfiles}`,
  );
  console.log(`exact_binding_keys: ${plan.exactBindingKeys.join(',')}`);
  for (const row of plan.plannedRows.topics)
    console.log(
      `topic: create slug=${row.slug} name=${row.name} memory_topic_id=${row.memoryTopicId}`,
    );
  for (const row of plan.plannedRows.threads)
    console.log(`thread: create topic_slug=${row.topicSlug} title=${row.title}`);
  for (const row of plan.plannedRows.telegramTopicLinks)
    console.log(
      `telegram_topic_link: create key=${row.telegramChatId}:${row.telegramThreadId} memory_topic_id=${row.memoryTopicId}`,
    );
  for (const row of plan.plannedRows.topicProfiles)
    console.log(
      `topic_profile: create topic_slug=${row.topicSlug} source=${row.source} purpose=${row.purpose}`,
    );
  console.log(`warnings: ${plan.warnings.join(',') || '-'}`);
}

function printApplyText(summary: ApplySummary): void {
  console.log(`mode: ${summary.mode}`);
  console.log(`project: ${summary.projectName} (${summary.projectId})`);
  console.log(`before_web_messages: ${summary.beforeWebMessages}`);
  console.log(
    `created: channels=${summary.created.channels} topics=${summary.created.topics} threads=${summary.created.threads} telegram_topic_links=${summary.created.telegramTopicLinks} topic_profiles=${summary.created.topicProfiles}`,
  );
  console.log(`after_web_messages: ${summary.afterWebMessages}`);
  console.log(`exact_binding_keys: ${summary.exactBindingKeys.join(',')}`);
  console.log(
    `post_commit_planned_creates: channels=${summary.postCommitPlannedCreates.channels} topics=${summary.postCommitPlannedCreates.topics} threads=${summary.postCommitPlannedCreates.threads} telegram_topic_links=${summary.postCommitPlannedCreates.telegramTopicLinks} topic_profiles=${summary.postCommitPlannedCreates.topicProfiles}`,
  );
}

async function loadProject(
  client: PoolClient,
  projectId: string,
  confirmProjectName: string | null,
): Promise<ProjectRow> {
  const result = await client.query<ProjectRow>(
    `select id::text, workspace_id::text, name
     from projects
     where id = $1 and status = 'active' and deleted_at is null
     for update`,
    [projectId],
  );
  const project = result.rows[0];
  if (!project) throw new Error(`project not found or inactive: ${projectId}`);
  if (confirmProjectName && project.name !== confirmProjectName)
    throw new Error(`project name mismatch: expected ${confirmProjectName}, got ${project.name}`);
  return project;
}

async function countWebMessages(client: PoolClient, projectId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `select count(*)::text
     from chat_messages m
     join threads th on th.id = m.thread_id
     join topics t on t.id = th.topic_id
     join channels c on c.id = t.channel_id
     where c.project_id = $1
       and c.deleted_at is null
       and t.deleted_at is null
       and th.deleted_at is null
       and m.deleted_at is null`,
    [projectId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function ensureTelegramChannel(
  client: PoolClient,
  project: ProjectRow,
): Promise<{ id: string; created: boolean }> {
  const existing = await client.query<ScopeRow>(
    `select id::text, workspace_id::text, project_id::text from channels
     where project_id = $1 and status = 'active' and deleted_at is null and (slug = 'telegram' or name = '텔레그램')
     order by case when slug = 'telegram' then 0 else 1 end
     limit 1
     for update`,
    [project.id],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.workspace_id !== project.workspace_id || row.project_id !== project.id) {
      throw new Error(`telegram channel scope mismatch: ${row.id}`);
    }
    return { id: row.id, created: false };
  }
  const inserted = await client.query<ScopeRow>(
    `insert into channels (workspace_id, project_id, name, slug)
     values ($1, $2, '텔레그램', 'telegram')
     returning id::text`,
    [project.workspace_id, project.id],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('failed to create telegram channel');
  return { id: row.id, created: true };
}

async function ensureTopic(
  client: PoolClient,
  project: ProjectRow,
  channelId: string,
  entry: TelegramTopicRegistryEntry,
): Promise<{ id: string; created: boolean }> {
  const existing = await client.query<TopicRow>(
    `select id::text, workspace_id::text, channel_id::text, memory_topic_id
     from topics
     where channel_id = $1 and slug = $2 and status = 'active' and deleted_at is null
     limit 1
     for update`,
    [channelId, entry.webTopicSlug],
  );
  const row = existing.rows[0];
  if (row) {
    if (row.workspace_id !== project.workspace_id || row.channel_id !== channelId)
      throw new Error(`topic scope mismatch for ${entry.webTopicSlug}`);
    if (row.memory_topic_id && row.memory_topic_id !== entry.memoryTopicId)
      throw new Error(`memory_topic mismatch for ${entry.webTopicSlug}: ${row.memory_topic_id}`);
    if (!row.memory_topic_id) {
      const updated = await client.query<{ memory_topic_id: string }>(
        `update topics set memory_topic_id = $1, updated_at = now()
         where id = $2 and memory_topic_id is null
         returning memory_topic_id`,
        [entry.memoryTopicId, row.id],
      );
      if (updated.rowCount !== 1) {
        const current = await client.query<{ memory_topic_id: string | null }>(
          'select memory_topic_id from topics where id = $1 for update',
          [row.id],
        );
        if (current.rows[0]?.memory_topic_id !== entry.memoryTopicId) {
          throw new Error(`memory_topic concurrent mismatch for ${entry.webTopicSlug}`);
        }
      }
    }
    return { id: row.id, created: false };
  }
  const inserted = await client.query<ScopeRow>(
    `insert into topics (workspace_id, channel_id, name, slug, memory_topic_id)
     values ($1, $2, $3, $4, $5)
     returning id::text`,
    [project.workspace_id, channelId, entry.webTopicName, entry.webTopicSlug, entry.memoryTopicId],
  );
  const insertedRow = inserted.rows[0];
  if (!insertedRow) throw new Error(`failed to create topic: ${entry.webTopicSlug}`);
  return { id: insertedRow.id, created: true };
}

async function ensureThread(
  client: PoolClient,
  project: ProjectRow,
  topicId: string,
  entry: TelegramTopicRegistryEntry,
): Promise<{ id: string; created: boolean }> {
  const existing = await client.query<ScopeRow>(
    `select id::text, workspace_id::text, topic_id::text from threads
     where topic_id = $1 and title = $2 and status = 'active' and deleted_at is null
     limit 1
     for update`,
    [topicId, entry.defaultThreadTitle],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.workspace_id !== project.workspace_id || row.topic_id !== topicId)
      throw new Error(`thread scope mismatch for ${entry.defaultThreadTitle}`);
    return { id: row.id, created: false };
  }
  const inserted = await client.query<ScopeRow>(
    `insert into threads (workspace_id, topic_id, title)
     values ($1, $2, $3)
     returning id::text`,
    [project.workspace_id, topicId, entry.defaultThreadTitle],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error(`failed to create thread: ${entry.defaultThreadTitle}`);
  return { id: row.id, created: true };
}

async function ensureTelegramTopicLink(
  client: PoolClient,
  project: ProjectRow,
  channelId: string,
  topicId: string,
  threadId: string,
  entry: TelegramTopicRegistryEntry,
): Promise<boolean> {
  const existing = await client.query<LinkRow>(
    `select workspace_id::text, project_id::text, channel_id::text,
            web_topic_id::text, thread_id::text, memory_topic_id, consulting_topic_slug
     from telegram_topic_links
     where telegram_chat_id = $1 and telegram_thread_id = $2 and status = 'active'
     limit 1
     for update`,
    [entry.telegramChatId, entry.telegramThreadId],
  );
  const row = existing.rows[0];
  if (row) {
    if (row.workspace_id !== project.workspace_id)
      throw new Error(`telegram topic workspace mismatch for thread ${entry.telegramThreadId}`);
    if (row.project_id !== project.id)
      throw new Error(
        `telegram topic ${entry.telegramChatId}:${entry.telegramThreadId} already bound to another project: ${row.project_id}`,
      );
    if (row.channel_id !== channelId || row.web_topic_id !== topicId || row.thread_id !== threadId)
      throw new Error(`telegram topic parent chain mismatch for thread ${entry.telegramThreadId}`);
    if (row.memory_topic_id !== entry.memoryTopicId)
      throw new Error(
        `telegram topic memory mismatch for thread ${entry.telegramThreadId}: ${row.memory_topic_id}`,
      );
    if (row.consulting_topic_slug !== entry.consultingTopicSlug)
      throw new Error(
        `telegram topic consulting slug mismatch for thread ${entry.telegramThreadId}: ${row.consulting_topic_slug}`,
      );
    return false;
  }
  await client.query(
    `insert into telegram_topic_links
       (workspace_id, project_id, channel_id, web_topic_id, thread_id, telegram_chat_id, telegram_thread_id, telegram_topic_name, consulting_topic_slug, memory_topic_id, profile_source, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'inferred', 'active')`,
    [
      project.workspace_id,
      project.id,
      channelId,
      topicId,
      threadId,
      entry.telegramChatId,
      entry.telegramThreadId,
      entry.telegramTopicName,
      entry.consultingTopicSlug,
      entry.memoryTopicId,
    ],
  );
  return true;
}

async function ensureTopicProfile(
  client: PoolClient,
  project: ProjectRow,
  topicId: string,
  entry: TelegramTopicRegistryEntry,
): Promise<boolean> {
  const existing = await client.query<ScopeRow>(
    `select id::text from scope_profiles
     where workspace_id = $1 and scope_type = 'topic' and scope_id = $2 and deleted_at is null
     limit 1`,
    [project.workspace_id, topicId],
  );
  if (existing.rows[0]) return false;
  await client.query(
    `insert into scope_profiles
       (workspace_id, scope_type, scope_id, purpose, role, style, rules, source)
     values ($1, 'topic', $2, $3, $4, $5, $6, 'inferred')`,
    [
      project.workspace_id,
      topicId,
      entry.profile.purpose,
      entry.profile.role,
      entry.profile.style,
      entry.profile.rules,
    ],
  );
  return true;
}

async function validateProvisionedBinding(
  client: PoolClient,
  project: ProjectRow,
  channelId: string,
  topicId: string,
  threadId: string,
  entry: TelegramTopicRegistryEntry,
): Promise<void> {
  const valid = await client.query(
    `select 1
     from telegram_topic_links l
     join workspaces w on w.id = l.workspace_id
     join projects p on p.id = l.project_id
     join channels c on c.id = l.channel_id
     join topics t on t.id = l.web_topic_id
     join threads th on th.id = l.thread_id
     where l.telegram_chat_id = $1 and l.telegram_thread_id = $2 and l.status = 'active'
       and l.workspace_id = $3 and l.project_id = $4 and l.channel_id = $5
       and l.web_topic_id = $6 and l.thread_id = $7
       and l.memory_topic_id = $8 and l.consulting_topic_slug = $9
       and w.id = $3 and w.status = 'active' and w.deleted_at is null
       and p.id = $4 and p.workspace_id = $3 and p.status = 'active' and p.deleted_at is null
       and c.workspace_id = $3 and c.project_id = $4 and c.status = 'active' and c.deleted_at is null
       and t.workspace_id = $3 and t.channel_id = $5 and t.memory_topic_id = $8
       and t.status = 'active' and t.deleted_at is null
       and th.workspace_id = $3 and th.topic_id = $6 and th.status = 'active' and th.deleted_at is null
     for share of w, p, l, c, t, th`,
    [
      entry.telegramChatId,
      entry.telegramThreadId,
      project.workspace_id,
      project.id,
      channelId,
      topicId,
      threadId,
      entry.memoryTopicId,
      entry.consultingTopicSlug,
    ],
  );
  if (valid.rowCount !== 1) {
    throw new Error(`telegram topic final chain mismatch for thread ${entry.telegramThreadId}`);
  }
}

async function applyChangwonTopics(
  client: PoolClient,
  projectId: string,
  confirmProjectName: string | null,
  expectedWebMessages: number | null,
): Promise<ApplySummary> {
  const project = await loadProject(client, projectId, confirmProjectName);
  const beforeWebMessages = await countWebMessages(client, project.id);
  if (expectedWebMessages !== null && beforeWebMessages !== expectedWebMessages) {
    throw new Error(
      `web message count mismatch: expected ${expectedWebMessages}, got ${beforeWebMessages}`,
    );
  }

  const created: ApplySummary['created'] = {
    channels: 0,
    topics: 0,
    threads: 0,
    telegramTopicLinks: 0,
    topicProfiles: 0,
  };
  const channel = await ensureTelegramChannel(client, project);
  if (channel.created) created.channels += 1;
  const provisioned: Array<{
    entry: TelegramTopicRegistryEntry;
    topicId: string;
    threadId: string;
  }> = [];

  for (const entry of CHANGWON_TELEGRAM_TOPIC_REGISTRY) {
    const topic = await ensureTopic(client, project, channel.id, entry);
    if (topic.created) created.topics += 1;
    const thread = await ensureThread(client, project, topic.id, entry);
    if (thread.created) created.threads += 1;
    if (await ensureTelegramTopicLink(client, project, channel.id, topic.id, thread.id, entry))
      created.telegramTopicLinks += 1;
    if (await ensureTopicProfile(client, project, topic.id, entry)) created.topicProfiles += 1;
    provisioned.push({ entry, topicId: topic.id, threadId: thread.id });
  }

  for (const binding of provisioned) {
    await validateProvisionedBinding(
      client,
      project,
      channel.id,
      binding.topicId,
      binding.threadId,
      binding.entry,
    );
  }

  const afterWebMessages = await countWebMessages(client, project.id);
  if (afterWebMessages !== beforeWebMessages)
    throw new Error(
      `web message count changed: before=${beforeWebMessages} after=${afterWebMessages}`,
    );

  const db = drizzle(client, { schema }) as unknown as Db;
  const idempotent = await new TelegramTopicRegistryService(db).previewChangwonBackfill(project.id);
  if (!idempotent.ok) throw new Error(`${idempotent.error.code}: ${idempotent.error.message}`);
  const post = idempotent.value.plannedCreates;
  if (
    post.channels !== 0 ||
    post.topics !== 0 ||
    post.threads !== 0 ||
    post.telegramTopicLinks !== 0 ||
    post.topicProfiles !== 0
  ) {
    throw new Error(`post-commit idempotency preview is not zero: ${JSON.stringify(post)}`);
  }

  return {
    mode: 'commit',
    projectId: project.id,
    projectName: project.name,
    beforeWebMessages,
    afterWebMessages,
    created,
    postCommitPlannedCreates: post,
    exactBindingKeys: CHANGWON_TELEGRAM_TOPIC_REGISTRY.map(
      (item) => `${item.telegramChatId}:${item.telegramThreadId}`,
    ),
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.projectId) throw new Error('--project-id is required');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    if (!args.commit) {
      const db = drizzle(client, { schema });
      const result = await new TelegramTopicRegistryService(db).previewChangwonBackfill(
        args.projectId,
        { telegramChunks: args.telegramChunks },
      );
      if (!result.ok) {
        console.error(`${result.error.code}: ${result.error.message}`);
        return 1;
      }
      if (args.json) console.log(JSON.stringify(result.value, null, 2));
      else printText(result.value);
      return 0;
    }

    await client.query('BEGIN');
    try {
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended('consulting.telegram-sync.v1', 0))",
      );
      const summary = await applyChangwonTopics(
        client,
        args.projectId,
        args.confirmProjectName,
        args.expectedWebMessages,
      );
      await client.query('COMMIT');
      if (args.json) console.log(JSON.stringify(summary, null, 2));
      else printApplyText(summary);
      return 0;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
