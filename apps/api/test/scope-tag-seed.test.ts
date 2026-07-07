import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { schema } from '@consulting/db-schema';
import { inArray, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { SignUpUseCase } from '../src/auth/sign-up.usecase.js';
import { ScryptPasswordHasher } from '../src/auth/password.js';
import { CreateProjectUseCase } from '../src/spaces/create-project.usecase.js';
import { CreateChannelUseCase } from '../src/spaces/create-channel.usecase.js';
import { CreateTopicUseCase } from '../src/spaces/create-topic.usecase.js';
import { ScopeRepository } from '../src/spaces/scope.repository.js';
import { ScopeTagSeedService } from '../src/spaces/scope-tag-seed.service.js';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
const users: string[] = [];
const workspaces: string[] = [];

async function seedWorkspaceTree(emailPrefix: string) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const owner = await new SignUpUseCase(db, new ScryptPasswordHasher()).execute({
    email: `${emailPrefix}-${suffix}@example.com`,
    password: 'supersecret1',
    displayName: 'Scope Tag Seed Owner',
  });
  expect(owner.ok).toBe(true);
  if (!owner.ok) throw new Error('signup failed');
  users.push(owner.value.userId);
  workspaces.push(owner.value.personalWorkspaceId);

  const project = await new CreateProjectUseCase(db).execute({
    workspaceId: owner.value.personalWorkspaceId,
    actorUserId: owner.value.userId,
    name: '창원 조직진단',
    slug: `changwon-org-diagnosis-${suffix}`,
  });
  expect(project.ok).toBe(true);
  if (!project.ok) throw new Error('project failed');

  const channel = await new CreateChannelUseCase(db, new ScopeRepository(db)).commit({
    projectId: project.value.projectId,
    actorUserId: owner.value.userId,
    name: '자료 수집',
    slug: `data-collection-${suffix}`,
  });
  expect(channel.ok).toBe(true);
  if (!channel.ok) throw new Error('channel failed');

  const topic = await new CreateTopicUseCase(db).execute({
    channelId: channel.value.channelId,
    actorUserId: owner.value.userId,
    name: '예산 현장 감사',
    slug: `budget-field-audit-${suffix}`,
  });
  expect(topic.ok).toBe(true);
  if (!topic.ok) throw new Error('topic failed');

  await db
    .update(schema.topics)
    .set({ memoryTopicId: 'changwon-org-mgmt-diagnosis' })
    .where(eq(schema.topics.id, topic.value.topicId));

  return {
    userId: owner.value.userId,
    workspaceId: owner.value.personalWorkspaceId,
    projectId: project.value.projectId,
    channelId: channel.value.channelId,
    topicId: topic.value.topicId,
  };
}

async function tagsFor(workspaceId: string) {
  const rows = await pool.query<{
    scope_type: string;
    scope_id: string;
    key: string;
    normalized_value: string;
    origin: string;
  }>(
    `select st.scope_type::text, st.scope_id::text, ct.key, ct.normalized_value, st.origin::text
     from scope_tags st
     join context_tags ct on ct.id = st.tag_id
     where st.workspace_id = $1 and st.deleted_at is null
     order by st.scope_type, st.scope_id, ct.key, ct.normalized_value`,
    [workspaceId],
  );
  return rows.rows;
}

d('ScopeTagSeedService', () => {
  beforeAll(() => {
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    if (workspaces.length) await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, workspaces));
    if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
    await pool.end();
  });

  it('seeds deterministic classifier tags for project/channel/topic names and memory topics', async () => {
    const primary = await seedWorkspaceTree('scope-tag-primary');
    const other = await seedWorkspaceTree('scope-tag-other');
    const service = new ScopeTagSeedService(db);

    expect(await tagsFor(primary.workspaceId)).toHaveLength(0);

    const preview = await service.previewWorkspace(primary.workspaceId);
    expect(preview.scopesScanned).toBeGreaterThanOrEqual(3);
    expect(preview.tagsSuggested).toBeGreaterThanOrEqual(6);
    expect(await tagsFor(primary.workspaceId)).toHaveLength(0);

    const first = await service.seedWorkspace(primary.workspaceId);
    const seeded = await tagsFor(primary.workspaceId);

    expect(first.scopesScanned).toBeGreaterThanOrEqual(3);
    expect(first.tagsCreated).toBeGreaterThanOrEqual(6);
    expect(seeded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope_type: 'project', scope_id: primary.projectId, key: 'client', normalized_value: 'changwon', origin: 'classifier' }),
        expect.objectContaining({ scope_type: 'project', scope_id: primary.projectId, key: 'domain', normalized_value: 'organization-diagnosis', origin: 'classifier' }),
        expect.objectContaining({ scope_type: 'channel', scope_id: primary.channelId, key: 'phase', normalized_value: 'data-collection', origin: 'classifier' }),
        expect.objectContaining({ scope_type: 'topic', scope_id: primary.topicId, key: 'client', normalized_value: 'changwon', origin: 'classifier' }),
        expect.objectContaining({ scope_type: 'topic', scope_id: primary.topicId, key: 'topic', normalized_value: 'budget', origin: 'classifier' }),
        expect.objectContaining({ scope_type: 'topic', scope_id: primary.topicId, key: 'topic', normalized_value: 'field-audit', origin: 'classifier' }),
      ]),
    );
    expect(seeded.filter((row) => row.scope_type === 'channel' && row.scope_id === primary.channelId).length).toBeGreaterThanOrEqual(1);
    expect(seeded.filter((row) => row.scope_type === 'topic' && row.scope_id === primary.topicId).length).toBeGreaterThanOrEqual(1);

    const countAfterFirst = seeded.length;
    const second = await service.seedWorkspace(primary.workspaceId);
    expect(second.tagsCreated).toBe(0);
    expect(await tagsFor(primary.workspaceId)).toHaveLength(countAfterFirst);
    expect(await tagsFor(other.workspaceId)).toHaveLength(0);
  });
});
