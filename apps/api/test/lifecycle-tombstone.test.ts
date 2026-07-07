import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { schema } from '@consulting/db-schema';
import { inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { SignUpUseCase } from '../src/auth/sign-up.usecase.js';
import { ScryptPasswordHasher } from '../src/auth/password.js';
import { CreateProjectUseCase } from '../src/spaces/create-project.usecase.js';
import { CreateChannelUseCase } from '../src/spaces/create-channel.usecase.js';
import { CreateTopicUseCase } from '../src/spaces/create-topic.usecase.js';
import { CreateThreadUseCase } from '../src/spaces/create-thread.usecase.js';
import { ScopeRepository } from '../src/spaces/scope.repository.js';
import { SpaceMutateService } from '../src/spaces/space-mutate.service.js';
import { SpaceReadService } from '../src/spaces/space-read.service.js';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
const users: string[] = [];
const workspaces: string[] = [];

async function seedScopeTree() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const signup = new SignUpUseCase(db, new ScryptPasswordHasher());
  const owner = await signup.execute({
    email: `life-${suffix}@example.com`,
    password: 'supersecret1',
    displayName: 'Lifecycle Owner',
  });
  expect(owner.ok).toBe(true);
  if (!owner.ok) throw new Error('signup failed');
  users.push(owner.value.userId);
  workspaces.push(owner.value.personalWorkspaceId);

  const project = await new CreateProjectUseCase(db).execute({
    workspaceId: owner.value.personalWorkspaceId,
    actorUserId: owner.value.userId,
    name: 'Lifecycle Project',
    slug: `life-p-${suffix}`,
    tags: [
      { key: 'client', value: '창원' },
      { key: 'domain', value: '조직' },
    ],
  });
  expect(project.ok).toBe(true);
  if (!project.ok) throw new Error('project failed');

  const channel = await new CreateChannelUseCase(db, new ScopeRepository(db)).commit({
    projectId: project.value.projectId,
    actorUserId: owner.value.userId,
    name: 'Lifecycle Channel',
    slug: `life-c-${suffix}`,
  });
  expect(channel.ok).toBe(true);
  if (!channel.ok) throw new Error('channel failed');

  const topic = await new CreateTopicUseCase(db).execute({
    channelId: channel.value.channelId,
    actorUserId: owner.value.userId,
    name: 'Lifecycle Topic',
    slug: `life-t-${suffix}`,
  });
  expect(topic.ok).toBe(true);
  if (!topic.ok) throw new Error('topic failed');

  const thread = await new CreateThreadUseCase(db).execute({
    topicId: topic.value.topicId,
    actorUserId: owner.value.userId,
    title: 'Lifecycle Thread',
  });
  expect(thread.ok).toBe(true);
  if (!thread.ok) throw new Error('thread failed');

  return {
    projectId: project.value.projectId,
    channelId: channel.value.channelId,
    topicId: topic.value.topicId,
    threadId: thread.value.threadId,
  };
}

d('space lifecycle/tombstone integration', () => {
  beforeAll(() => {
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    if (workspaces.length) await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, workspaces));
    if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
    await pool.end();
  });

  it('soft-deletes a channel as deleted_soft and tombstones descendant graph edges/tags', async () => {
    const ids = await seedScopeTree();

    await new SpaceMutateService(db).softDeleteNode('channel', ids.channelId);

    const states = await pool.query(
      `select 'channel' as kind, status::text, deleted_at is not null as deleted from channels where id=$1
       union all select 'topic', status::text, deleted_at is not null from topics where id=$2
       union all select 'thread', status::text, deleted_at is not null from threads where id=$3
       order by kind`,
      [ids.channelId, ids.topicId, ids.threadId],
    );
    expect(states.rows).toEqual([
      { kind: 'channel', status: 'deleted_soft', deleted: true },
      { kind: 'thread', status: 'deleted_soft', deleted: true },
      { kind: 'topic', status: 'deleted_soft', deleted: true },
    ]);

    const graph = await pool.query(
      `select
         count(*) filter (where deleted_at is null) as live_edges,
         count(*) filter (where deleted_at is not null) as tombstoned_edges
       from context_edges
       where from_scope_id = any($1::uuid[]) or to_scope_id = any($1::uuid[])`,
      [[ids.channelId, ids.topicId, ids.threadId]],
    );
    expect(Number(graph.rows[0].live_edges)).toBe(0);
    expect(Number(graph.rows[0].tombstoned_edges)).toBeGreaterThanOrEqual(3);

    const tags = await pool.query(
      `select count(*) filter (where deleted_at is not null) as tombstoned_tags
       from scope_tags
       where scope_type='channel' and scope_id=$1`,
      [ids.channelId],
    );
    expect(Number(tags.rows[0].tombstoned_tags)).toBeGreaterThanOrEqual(1);
  });

  it('archives without tombstoning graph and restores soft-deleted descendants with graph rows', async () => {
    const ids = await seedScopeTree();
    const mutate = new SpaceMutateService(db) as any;

    await mutate.archiveNode('channel', ids.channelId);
    const archived = await pool.query(
      `select 'channel' as kind, status::text, deleted_at is not null as deleted from channels where id=$1
       union all select 'topic', status::text, deleted_at is not null from topics where id=$2
       union all select 'thread', status::text, deleted_at is not null from threads where id=$3
       order by kind`,
      [ids.channelId, ids.topicId, ids.threadId],
    );
    expect(archived.rows).toEqual([
      { kind: 'channel', status: 'archived', deleted: false },
      { kind: 'thread', status: 'archived', deleted: false },
      { kind: 'topic', status: 'archived', deleted: false },
    ]);
    const archivedGraph = await pool.query(
      `select count(*) filter (where deleted_at is not null) as tombstoned_edges
       from context_edges
       where from_scope_id = any($1::uuid[]) or to_scope_id = any($1::uuid[])`,
      [[ids.channelId, ids.topicId, ids.threadId]],
    );
    expect(Number(archivedGraph.rows[0].tombstoned_edges)).toBe(0);

    await mutate.softDeleteNode('channel', ids.channelId);
    await mutate.restoreNode('channel', ids.channelId);

    const restored = await pool.query(
      `select 'channel' as kind, status::text, deleted_at is not null as deleted from channels where id=$1
       union all select 'topic', status::text, deleted_at is not null from topics where id=$2
       union all select 'thread', status::text, deleted_at is not null from threads where id=$3
       order by kind`,
      [ids.channelId, ids.topicId, ids.threadId],
    );
    expect(restored.rows).toEqual([
      { kind: 'channel', status: 'active', deleted: false },
      { kind: 'thread', status: 'active', deleted: false },
      { kind: 'topic', status: 'active', deleted: false },
    ]);
    const restoredGraph = await pool.query(
      `select
         count(*) filter (where deleted_at is null) as live_edges,
         count(*) filter (where deleted_at is not null) as tombstoned_edges
       from context_edges
       where from_scope_id = any($1::uuid[]) or to_scope_id = any($1::uuid[])`,
      [[ids.channelId, ids.topicId, ids.threadId]],
    );
    expect(Number(restoredGraph.rows[0].live_edges)).toBeGreaterThanOrEqual(3);
    expect(Number(restoredGraph.rows[0].tombstoned_edges)).toBe(0);
  });

  it('hides archived scopes from the default workspace tree but shows them again after restore', async () => {
    const ids = await seedScopeTree();
    const mutate = new SpaceMutateService(db) as any;
    const reads = new SpaceReadService(db);

    await mutate.archiveNode('channel', ids.channelId);
    const archivedTree = await reads.workspaceTree(workspaces.at(-1)!);
    expect(archivedTree.projects[0]?.channels.map((c) => c.id)).not.toContain(ids.channelId);
    await expect(mutate.threadDetail(ids.threadId)).resolves.toBeNull();

    await mutate.restoreNode('channel', ids.channelId);
    const restoredTree = await reads.workspaceTree(workspaces.at(-1)!);
    expect(restoredTree.projects[0]?.channels.map((c) => c.id)).toContain(ids.channelId);
  });

  it('lists archived scopes for a workspace and restores them into the default tree', async () => {
    const ids = await seedScopeTree();
    const mutate = new SpaceMutateService(db);
    const reads = new SpaceReadService(db);
    const workspaceId = workspaces.at(-1)!;

    await mutate.archiveNode('channel', ids.channelId);
    const archive = await reads.listArchivedScopes(workspaceId);

    expect(archive.items.map((item) => ({ kind: item.kind, id: item.id }))).toEqual([
      { kind: 'channel', id: ids.channelId },
      { kind: 'topic', id: ids.topicId },
      { kind: 'thread', id: ids.threadId },
    ]);
    expect(archive.items[0]?.parentPath).toEqual(['Lifecycle Project']);

    await mutate.restoreNode('channel', ids.channelId);
    const afterRestore = await reads.workspaceTree(workspaceId);
    expect(afterRestore.projects[0]?.channels.map((c) => c.id)).toContain(ids.channelId);
  });

  it('rejects restoring a child while its parent remains archived', async () => {
    const ids = await seedScopeTree();
    const mutate = new SpaceMutateService(db);

    await mutate.archiveNode('project', ids.projectId);

    await expect(mutate.restoreNode('channel', ids.channelId)).rejects.toThrow(/parent scope must be active/i);
  });
});
