import { createHash } from 'node:crypto';
import process from 'node:process';
import { Pool, type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { schema } from '@consulting/db-schema';
import {
  ProjectTemplateService,
  type ApplyProjectTemplateResult,
  type ProjectTemplateBackfillPreview,
  type ProjectTemplateProject,
} from '../src/spaces/project-template.service.js';
import type { Db } from '../src/infra/drizzle.module.js';

const DEFAULT_TEST_PROJECT_ID = '61f95d26-33e7-47ea-a374-7b19da02c39a';

type CountKey = 'channels' | 'topics' | 'threads' | 'messages' | 'links';
type Counts = Record<CountKey, number>;

interface CountRow {
  channels: string;
  topics: string;
  threads: string;
  messages: string;
  links: string;
}

interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
}

interface MessageDigestRow {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

function argValue(name: string): string | undefined {
  const exact = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parseExpectedCounts(raw: string | undefined): Counts | null {
  if (!raw) return null;
  const out: Partial<Counts> = {};
  for (const part of raw.split(',')) {
    const [key, value] = part.split('=');
    if (!key || value === undefined) throw new Error(`invalid --expected-before part: ${part}`);
    if (!['channels', 'topics', 'threads', 'messages', 'links'].includes(key)) throw new Error(`unknown count key: ${key}`);
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`invalid count for ${key}: ${value}`);
    out[key as CountKey] = parsed;
  }
  for (const key of ['channels', 'topics', 'threads', 'messages', 'links'] satisfies CountKey[]) {
    if (out[key] === undefined) throw new Error(`missing count key: ${key}`);
  }
  return out as Counts;
}

function countsEqual(a: Counts, b: Counts): boolean {
  return a.channels === b.channels && a.topics === b.topics && a.threads === b.threads && a.messages === b.messages && a.links === b.links;
}

function formatCounts(counts: Counts): string {
  return `channels=${counts.channels} topics=${counts.topics} threads=${counts.threads} messages=${counts.messages} links=${counts.links}`;
}

function expectedAfter(before: Counts, created: ApplyProjectTemplateResult['created']): Counts {
  return {
    channels: before.channels + created.channels,
    topics: before.topics + created.topics,
    threads: before.threads + created.threads,
    messages: before.messages,
    links: before.links + created.consultingLinks,
  };
}

async function loadProject(client: PoolClient, projectId: string, commit: boolean): Promise<ProjectTemplateProject> {
  const lock = commit ? ' for update' : '';
  const result = await client.query<ProjectRow>(
    `select id::text, workspace_id::text, name, slug
     from projects
     where id = $1 and status = 'active' and deleted_at is null${lock}`,
    [projectId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`project not found or inactive: ${projectId}`);
  return { id: row.id, workspaceId: row.workspace_id, name: row.name, slug: row.slug };
}

async function measureCounts(client: PoolClient, projectId: string): Promise<Counts> {
  const result = await client.query<CountRow>(
    `select
       (select count(*)::text from channels where project_id = $1 and deleted_at is null) as channels,
       (select count(*)::text from topics t join channels c on c.id = t.channel_id where c.project_id = $1 and c.deleted_at is null and t.deleted_at is null) as topics,
       (select count(*)::text from threads th join topics t on t.id = th.topic_id join channels c on c.id = t.channel_id where c.project_id = $1 and c.deleted_at is null and t.deleted_at is null and th.deleted_at is null) as threads,
       (select count(*)::text from chat_messages m join threads th on th.id = m.thread_id join topics t on t.id = th.topic_id join channels c on c.id = t.channel_id where c.project_id = $1 and c.deleted_at is null and t.deleted_at is null and th.deleted_at is null and m.deleted_at is null) as messages,
       (select count(*)::text from consulting_topic_links where project_id = $1 and status = 'active' and archived_at is null) as links`,
    [projectId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('count query returned no row');
  return {
    channels: Number(row.channels),
    topics: Number(row.topics),
    threads: Number(row.threads),
    messages: Number(row.messages),
    links: Number(row.links),
  };
}

async function messageDigest(client: PoolClient, projectId: string): Promise<string> {
  const result = await client.query<MessageDigestRow>(
    `select m.id::text, m.role::text, m.content, m.created_at::text
     from chat_messages m
     join threads th on th.id = m.thread_id
     join topics t on t.id = th.topic_id
     join channels c on c.id = t.channel_id
     where c.project_id = $1
       and c.deleted_at is null
       and t.deleted_at is null
       and th.deleted_at is null
       and m.deleted_at is null
     order by m.created_at, m.id`,
    [projectId],
  );
  const hash = createHash('md5');
  for (const row of result.rows) {
    hash.update(JSON.stringify(row));
    hash.update('\n');
  }
  return hash.digest('hex');
}

async function assertExpectedLinks(client: PoolClient, projectId: string, expectedSlug: string): Promise<void> {
  const result = await client.query<{ consulting_topic_slug: string }>(
    `select consulting_topic_slug
     from consulting_topic_links
     where project_id = $1 and status = 'active' and archived_at is null
     order by consulting_topic_slug`,
    [projectId],
  );
  const slugs = result.rows.map((row) => row.consulting_topic_slug);
  if (!slugs.includes(expectedSlug)) throw new Error(`missing expected consulting topic slug: ${expectedSlug}`);
  if (slugs.includes('changwon-org-mgmt-diagnosis')) throw new Error('TEST backfill would mix Changwon brain slug');
}

function assertPreviewIsIdempotent(preview: ProjectTemplateBackfillPreview): void {
  const creates = preview.plannedCreates;
  if (creates.channels !== 0 || creates.topics !== 0 || creates.threads !== 0 || creates.consultingLinks !== 0) {
    throw new Error(`post-commit idempotency preview is not zero: ${JSON.stringify(creates)}`);
  }
}

function printSummary(input: {
  commit: boolean;
  project: ProjectTemplateProject;
  before: Counts;
  beforeDigest: string;
  preview: ProjectTemplateBackfillPreview;
  created?: ApplyProjectTemplateResult['created'];
  after?: Counts;
  afterDigest?: string;
  idempotentPreview?: ProjectTemplateBackfillPreview;
}): void {
  console.log(`mode: ${input.commit ? 'commit' : 'dry-run'}`);
  console.log(`project: ${input.project.name} (${input.project.slug}) id=${input.project.id}`);
  console.log(`before: ${formatCounts(input.before)}`);
  console.log(`message_digest_before: ${input.beforeDigest}`);
  console.log(
    `planned_creates: channels=${input.preview.plannedCreates.channels} topics=${input.preview.plannedCreates.topics} threads=${input.preview.plannedCreates.threads} links=${input.preview.plannedCreates.consultingLinks}`,
  );
  console.log(`warnings: ${input.preview.warnings.length ? input.preview.warnings.join('; ') : '-'}`);
  if (!input.commit) {
    console.log('mutation: skipped (--commit not provided)');
    return;
  }
  console.log(`created: channels=${input.created?.channels ?? 0} topics=${input.created?.topics ?? 0} threads=${input.created?.threads ?? 0} links=${input.created?.consultingLinks ?? 0}`);
  console.log(`after: ${input.after ? formatCounts(input.after) : '-'}`);
  console.log(`message_digest_after: ${input.afterDigest ?? '-'}`);
  if (input.idempotentPreview) {
    console.log(
      `post_commit_planned_creates: channels=${input.idempotentPreview.plannedCreates.channels} topics=${input.idempotentPreview.plannedCreates.topics} threads=${input.idempotentPreview.plannedCreates.threads} links=${input.idempotentPreview.plannedCreates.consultingLinks}`,
    );
  }
}

async function main(): Promise<void> {
  const projectId = argValue('--project-id') ?? DEFAULT_TEST_PROJECT_ID;
  const confirmProjectName = argValue('--confirm-project-name') ?? 'TEST';
  const actorUserId = argValue('--actor-user-id');
  const expectedBefore = parseExpectedCounts(argValue('--expected-before'));
  const expectedDigest = argValue('--expected-message-digest');
  const commit = hasFlag('--commit');
  const databaseUrl = process.env.DATABASE_URL;
  const hasPgEnv = Boolean(process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE);

  if (!databaseUrl && !hasPgEnv) {
    console.error('DATABASE_URL or PGHOST/PGUSER/PGDATABASE is required. Secret values are never printed by this script.');
    process.exit(1);
  }
  if (commit && !actorUserId) throw new Error('--actor-user-id is required with --commit');

  const pool = new Pool(databaseUrl ? { connectionString: databaseUrl, max: 1 } : { max: 1 });
  const client = await pool.connect();

  try {
    await client.query(commit ? 'BEGIN' : 'BEGIN READ ONLY');
    const project = await loadProject(client, projectId, commit);
    if (project.name !== confirmProjectName) throw new Error(`project name mismatch: expected ${confirmProjectName}, got ${project.name}`);

    const db = drizzle(client, { schema }) as unknown as Db;
    const service = new ProjectTemplateService(db);
    const previewResult = await service.previewConsultingDefaultBackfill(projectId);
    if (!previewResult.ok) throw new Error(`${previewResult.error.code}: ${previewResult.error.message}`);
    const before = await measureCounts(client, projectId);
    const beforeDigest = await messageDigest(client, projectId);

    if (expectedBefore && !countsEqual(before, expectedBefore)) {
      throw new Error(`before counts mismatch: expected ${formatCounts(expectedBefore)}, got ${formatCounts(before)}`);
    }
    if (expectedDigest && beforeDigest !== expectedDigest) {
      throw new Error(`message digest mismatch: expected ${expectedDigest}, got ${beforeDigest}`);
    }
    if (previewResult.value.warnings.length > 0) throw new Error(`preview warnings present: ${previewResult.value.warnings.join('; ')}`);

    if (!commit) {
      await client.query('COMMIT');
      printSummary({ commit, project, before, beforeDigest, preview: previewResult.value });
      return;
    }

    const applyResult = await service.applyConsultingDefaultToProjectInTransaction(
      db as unknown as Parameters<typeof service.applyConsultingDefaultToProjectInTransaction>[0],
      project,
      { actorUserId: actorUserId!, requestId: `manual-test-backfill:${projectId}` },
    );
    const after = await measureCounts(client, projectId);
    const afterDigest = await messageDigest(client, projectId);
    const expected = expectedAfter(before, applyResult.created);
    if (!countsEqual(after, expected)) throw new Error(`after counts mismatch: expected ${formatCounts(expected)}, got ${formatCounts(after)}`);
    if (after.messages !== before.messages) throw new Error(`message count changed: before=${before.messages} after=${after.messages}`);
    if (afterDigest !== beforeDigest) throw new Error(`message digest changed: before=${beforeDigest} after=${afterDigest}`);
    await assertExpectedLinks(client, projectId, applyResult.brainSlug);

    const idempotentPreviewResult = await service.previewConsultingDefaultBackfill(projectId);
    if (!idempotentPreviewResult.ok) throw new Error(`${idempotentPreviewResult.error.code}: ${idempotentPreviewResult.error.message}`);
    assertPreviewIsIdempotent(idempotentPreviewResult.value);

    await client.query('COMMIT');
    printSummary({
      commit,
      project,
      before,
      beforeDigest,
      preview: previewResult.value,
      created: applyResult.created,
      after,
      afterDigest,
      idempotentPreview: idempotentPreviewResult.value,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

void main();
