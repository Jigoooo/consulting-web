import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { schema } from '@consulting/db-schema';
import { eq, inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { SignUpUseCase } from '../src/auth/sign-up.usecase.js';
import { ScryptPasswordHasher } from '../src/auth/password.js';
import { CreateProjectUseCase } from '../src/spaces/create-project.usecase.js';
import { CreateChannelUseCase } from '../src/spaces/create-channel.usecase.js';
import { CreateTopicUseCase } from '../src/spaces/create-topic.usecase.js';
import { CreateThreadUseCase } from '../src/spaces/create-thread.usecase.js';
import { ScopeRepository } from '../src/spaces/scope.repository.js';
import { ContextGraphService } from '../src/spaces/context-graph.service.js';
import { ScopeTagSeedService } from '../src/spaces/scope-tag-seed.service.js';
import { ConsultingTopicResolver } from '../src/consulting/consulting-topic-resolver.service.js';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
const users: string[] = [];
const workspaces: string[] = [];

type ScopeFixture = {
  userId: string;
  workspaceId: string;
  projectId: string;
  channelId: string;
  topicId: string;
  threadId: string;
};

async function createTopicTree(label: string, workspaceId?: string, userId?: string): Promise<ScopeFixture> {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let ownerUserId = userId;
  let ownerWorkspaceId = workspaceId;
  if (!ownerUserId || !ownerWorkspaceId) {
    const owner = await new SignUpUseCase(db, new ScryptPasswordHasher()).execute({
      email: `context-graph-${label}-${suffix}@example.com`,
      password: 'supersecret1',
      displayName: `Context Graph ${label}`,
    });
    expect(owner.ok).toBe(true);
    if (!owner.ok) throw new Error('signup failed');
    ownerUserId = owner.value.userId;
    ownerWorkspaceId = owner.value.personalWorkspaceId;
    users.push(ownerUserId);
    workspaces.push(ownerWorkspaceId);
  }

  const project = await new CreateProjectUseCase(db).execute({
    workspaceId: ownerWorkspaceId,
    actorUserId: ownerUserId,
    name: `${label} 프로젝트`,
    slug: `${label}-project-${suffix}`,
  });
  expect(project.ok).toBe(true);
  if (!project.ok) throw new Error('project failed');

  const channel = await new CreateChannelUseCase(db, new ScopeRepository(db)).commit({
    projectId: project.value.projectId,
    actorUserId: ownerUserId,
    name: `${label} 채널`,
    slug: `${label}-channel-${suffix}`,
  });
  expect(channel.ok).toBe(true);
  if (!channel.ok) throw new Error('channel failed');

  const topic = await new CreateTopicUseCase(db).execute({
    channelId: channel.value.channelId,
    actorUserId: ownerUserId,
    name: `${label} 토픽`,
    slug: `${label}-topic-${suffix}`,
  });
  expect(topic.ok).toBe(true);
  if (!topic.ok) throw new Error('topic failed');

  const thread = await new CreateThreadUseCase(db).execute({
    topicId: topic.value.topicId,
    actorUserId: ownerUserId,
    title: `${label} 스레드`,
  });
  expect(thread.ok).toBe(true);
  if (!thread.ok) throw new Error('thread failed');

  return {
    userId: ownerUserId,
    workspaceId: ownerWorkspaceId,
    projectId: project.value.projectId,
    channelId: channel.value.channelId,
    topicId: topic.value.topicId,
    threadId: thread.value.threadId,
  };
}

async function linkProjectToBrain(scope: ScopeFixture, slug: string, projectName: string) {
  await db.insert(schema.consultingTopicLinks).values({
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    linkLevel: 'project',
    consultingTopicSlug: slug,
    scopePath: projectName,
    status: 'active',
    origin: 'manual',
    createdByUserId: scope.userId,
  });
}

d('context graph activation', () => {
  beforeAll(() => {
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    if (workspaces.length) await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, workspaces));
    if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
    await pool.end();
  });

  it('creates manual related_to edges and traverses only live same-workspace related scopes', async () => {
    const a = await createTopicTree('alpha');
    const b = await createTopicTree('beta', a.workspaceId, a.userId);
    const other = await createTopicTree('other');
    const service = new ContextGraphService(db);

    const created = await service.createManualEdge({
      fromScopeType: 'topic',
      fromScopeId: a.topicId,
      toScopeType: 'topic',
      toScopeId: b.topicId,
      edgeType: 'related_to',
      confidence: 0.9,
    });
    expect(created.ok).toBe(true);

    const blocked = await service.createManualEdge({
      fromScopeType: 'topic',
      fromScopeId: a.topicId,
      toScopeType: 'topic',
      toScopeId: other.topicId,
      edgeType: 'related_to',
      confidence: 0.9,
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('FORBIDDEN');

    await db.insert(schema.contextEdges).values({
      workspaceId: a.workspaceId,
      fromScopeType: 'topic',
      fromScopeId: a.topicId,
      toScopeType: 'topic',
      toScopeId: other.topicId,
      edgeType: 'related_to',
      origin: 'import',
      confidence: '0.95',
    });

    const related = await service.traverseRelatedScopes({ scopeType: 'topic', scopeId: a.topicId });
    expect(related).toEqual([
      expect.objectContaining({
        scopeType: 'topic',
        scopeId: b.topicId,
        edgeType: 'related_to',
        origin: 'manual',
        relation: 'cross_project',
        weight: 0.6,
      }),
    ]);

    if (!created.ok) throw new Error('edge create failed');
    const target = await service.getManualEdgeTarget(created.value.edgeId);
    expect(target.ok).toBe(true);
    const deleted = await service.deleteManualEdge(created.value.edgeId);
    expect(deleted).toEqual({ ok: true, value: { ok: true } });
    await expect(service.traverseRelatedScopes({ scopeType: 'topic', scopeId: a.topicId })).resolves.toEqual([]);

    await db.update(schema.topics).set({ status: 'archived' }).where(eq(schema.topics.id, b.topicId));
    await expect(service.traverseRelatedScopes({ scopeType: 'topic', scopeId: a.topicId })).resolves.toEqual([]);
  });

  it('uses context_edges rather than every workspace consulting topic for GraphRAG fanout', async () => {
    const current = await createTopicTree('current');
    const related = await createTopicTree('related', current.workspaceId, current.userId);
    const unrelated = await createTopicTree('unrelated', current.workspaceId, current.userId);
    await linkProjectToBrain(current, 'current-brain-topic', '현재 프로젝트');
    await linkProjectToBrain(related, 'related-brain-topic', '관련 프로젝트');
    await linkProjectToBrain(unrelated, 'unrelated-brain-topic', '무관 프로젝트');

    const graph = new ContextGraphService(db);
    const edge = await graph.createManualEdge({
      fromScopeType: 'topic',
      fromScopeId: current.topicId,
      toScopeType: 'topic',
      toScopeId: related.topicId,
      edgeType: 'references',
      confidence: 1,
    });
    expect(edge.ok).toBe(true);

    const fanout = await new ConsultingTopicResolver(db, graph).resolveThreadFanout(current.threadId);
    expect(fanout?.recallScopes.map((scope) => scope.topicSlug)).toEqual(['current-brain-topic', 'related-brain-topic']);
    expect(fanout?.recallScopes[1]).toEqual(expect.objectContaining({ relation: 'cross_project', weight: 0.6, label: '다른 프로젝트: related 프로젝트' }));
  });

  it('keeps manual project-to-project connections symmetric and strength-updatable', async () => {
    const a = await createTopicTree('manual-pair-a');
    const b = await createTopicTree('manual-pair-b', a.workspaceId, a.userId);
    const service = new ContextGraphService(db);

    const weak = await service.createManualEdge({
      fromScopeType: 'project',
      fromScopeId: a.projectId,
      toScopeType: 'project',
      toScopeId: b.projectId,
      edgeType: 'related_to',
      confidence: 0.65,
    });
    expect(weak.ok).toBe(true);
    await expect(service.traverseRelatedScopes({ scopeType: 'project', scopeId: b.projectId })).resolves.toEqual([
      expect.objectContaining({ scopeId: a.projectId, edgeType: 'related_to', origin: 'manual' }),
    ]);

    const strongReverse = await service.createManualEdge({
      fromScopeType: 'project',
      fromScopeId: b.projectId,
      toScopeType: 'project',
      toScopeId: a.projectId,
      edgeType: 'shares_memory_with',
      confidence: 1,
    });
    expect(strongReverse.ok).toBe(true);

    const livePair = await pool.query<{ count: string; edge_type: string }>(
      `select count(*)::text, max(edge_type)::text as edge_type
       from context_edges
       where workspace_id = $1
         and origin = 'manual'
         and deleted_at is null
         and edge_type in ('related_to', 'shares_memory_with')
         and ((from_scope_type = 'project' and from_scope_id = $2 and to_scope_type = 'project' and to_scope_id = $3)
           or (from_scope_type = 'project' and from_scope_id = $3 and to_scope_type = 'project' and to_scope_id = $2))`,
      [a.workspaceId, a.projectId, b.projectId],
    );
    expect(livePair.rows[0]).toEqual({ count: '1', edge_type: 'shares_memory_with' });

    const fromA = await service.traverseRelatedScopes({ scopeType: 'project', scopeId: a.projectId });
    expect(fromA).toEqual([
      expect.objectContaining({ scopeId: b.projectId, edgeType: 'shares_memory_with', origin: 'manual' }),
    ]);
    const edgeId = fromA[0]?.edgeId;
    expect(edgeId).toBeTruthy();
    if (!edgeId) throw new Error('edge id missing');

    await expect(service.deleteManualEdge(edgeId)).resolves.toEqual({ ok: true, value: { ok: true } });
    await expect(service.traverseRelatedScopes({ scopeType: 'project', scopeId: b.projectId })).resolves.toEqual([]);
  });

  it('creates idempotent classifier related_to edges from tag overlap', async () => {
    const a = await createTopicTree('tag-alpha');
    const b = await createTopicTree('tag-beta', a.workspaceId, a.userId);
    await db.update(schema.projects).set({ name: '창원 조직진단 A' }).where(eq(schema.projects.id, a.projectId));
    await db.update(schema.projects).set({ name: '창원 조직진단 B' }).where(eq(schema.projects.id, b.projectId));

    const seed = await new ScopeTagSeedService(db).seedWorkspace(a.workspaceId);
    expect(seed.tagsCreated).toBeGreaterThanOrEqual(4);

    const service = new ContextGraphService(db);
    const first = await service.inferClassifierEdges({ workspaceId: a.workspaceId });
    expect(first.edgesCreated).toBeGreaterThanOrEqual(1);
    const second = await service.inferClassifierEdges({ workspaceId: a.workspaceId });
    expect(second.edgesCreated).toBe(0);

    await db.update(schema.projects).set({ name: '창원 조직진단 Z' }).where(eq(schema.projects.id, a.projectId));
    await db.update(schema.projects).set({ name: '창원 조직진단 A' }).where(eq(schema.projects.id, b.projectId));
    const afterRename = await service.inferClassifierEdges({ workspaceId: a.workspaceId });
    expect(afterRename.edgesCreated).toBe(0);
    const duplicateCheck = await pool.query<{ count: string }>(
      `select count(*)::text
       from context_edges
       where workspace_id = $1
         and edge_type = 'related_to'
         and origin = 'classifier'
         and deleted_at is null
         and ((from_scope_type = 'project' and from_scope_id = $2 and to_scope_type = 'project' and to_scope_id = $3)
           or (from_scope_type = 'project' and from_scope_id = $3 and to_scope_type = 'project' and to_scope_id = $2))`,
      [a.workspaceId, a.projectId, b.projectId],
    );
    expect(duplicateCheck.rows[0]?.count).toBe('1');

    const related = await service.traverseRelatedScopes({ scopeType: 'project', scopeId: a.projectId });
    expect(related).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scopeType: 'project',
        scopeId: b.projectId,
        edgeType: 'related_to',
        origin: 'classifier',
        relation: 'cross_project',
        weight: 0.6,
      }),
    ]));
  });
});
