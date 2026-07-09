import process from 'node:process';
import { Pool, type PoolClient } from 'pg';
import {
  auditTelegramTopicBindingsFromSnapshot,
  type TelegramTopicBindingAuditResult,
  type TelegramTopicBindingAuditRow,
} from '../src/consulting/telegram-topic-registry.service.js';

interface Args {
  projectId: string | null;
  json: boolean;
  allowBlocked: boolean;
}

interface ProjectRow {
  id: string;
  workspaceId: string;
  name: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { projectId: null, json: false, allowBlocked: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (arg === '--allow-blocked') {
      args.allowBlocked = true;
      continue;
    }
    if (arg === '--project-id') {
      args.projectId = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

async function loadProject(client: PoolClient, projectId: string): Promise<ProjectRow> {
  const result = await client.query<{ id: string; workspace_id: string; name: string }>(
    `select id::text, workspace_id::text, name
     from projects
     where id = $1 and status = 'active' and deleted_at is null
     limit 1`,
    [projectId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`project not found or inactive: ${projectId}`);
  return { id: row.id, workspaceId: row.workspace_id, name: row.name };
}

async function loadTopicLinks(client: PoolClient, projectId: string): Promise<TelegramTopicBindingAuditRow[]> {
  const result = await client.query<{
    telegramChatId: string;
    telegramThreadId: string | null;
    telegramTopicName: string | null;
    consultingTopicSlug: string | null;
    memoryTopicId: string | null;
    webTopicSlug: string | null;
    webTopicName: string | null;
    webTopicMemoryTopicId: string | null;
    threadTitle: string | null;
    status: string | null;
  }>(
    `select
       l.telegram_chat_id as "telegramChatId",
       l.telegram_thread_id as "telegramThreadId",
       l.telegram_topic_name as "telegramTopicName",
       l.consulting_topic_slug as "consultingTopicSlug",
       l.memory_topic_id as "memoryTopicId",
       t.slug as "webTopicSlug",
       t.name as "webTopicName",
       t.memory_topic_id as "webTopicMemoryTopicId",
       th.title as "threadTitle",
       l.status as "status"
     from telegram_topic_links l
     left join topics t on t.id = l.web_topic_id and t.deleted_at is null
     left join threads th on th.id = l.thread_id and th.deleted_at is null
     where l.project_id = $1
     order by l.telegram_chat_id, nullif(l.telegram_thread_id, '')::int nulls first, l.telegram_thread_id`,
    [projectId],
  );
  return result.rows;
}

function printText(result: TelegramTopicBindingAuditResult): void {
  console.log(`read_only: ${result.readOnly}`);
  console.log(`status: ${result.status}`);
  console.log(`project: ${result.projectName} (${result.projectId})`);
  console.log(`registry_count: ${result.registryCount}`);
  console.log(`active_binding_count: ${result.activeBindingCount}`);
  console.log(`exact_binding_keys: ${result.exactBindingKeys.join(',')}`);
  console.log(`matched_keys: ${result.matchedKeys.join(',') || '-'}`);
  if (result.blockers.length === 0) console.log('blockers: -');
  else for (const issue of result.blockers) console.log(`blocker: ${issue.code} key=${issue.key} detail=${issue.detail}`);
  if (result.warnings.length === 0) console.log('warnings: -');
  else for (const issue of result.warnings) console.log(`warning: ${issue.code} key=${issue.key} detail=${issue.detail}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.projectId) throw new Error('--project-id is required');
  const databaseUrl = process.env.DATABASE_URL;
  const hasPgEnv = Boolean(process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE);
  if (!databaseUrl && !hasPgEnv) {
    throw new Error('DATABASE_URL or PGHOST/PGUSER/PGDATABASE is required. Secret values are never printed by this script.');
  }

  const pool = new Pool(databaseUrl ? { connectionString: databaseUrl, max: 1 } : { max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin read only');
    const project = await loadProject(client, args.projectId);
    const topicLinks = await loadTopicLinks(client, project.id);
    const result = auditTelegramTopicBindingsFromSnapshot({
      workspaceId: project.workspaceId,
      projectId: project.id,
      projectName: project.name,
      topicLinks,
    });
    await client.query('rollback');
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printText(result);
    if (result.status === 'blocked' && !args.allowBlocked) process.exitCode = 1;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
