import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { schema } from '@consulting/db-schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { SignUpUseCase } from '../src/auth/sign-up.usecase.js';
import { ScryptPasswordHasher } from '../src/auth/password.js';
import { ProjectTemplateService } from '../src/spaces/project-template.service.js';
import { ScopeProfileService } from '../src/spaces/scope-profile.service.js';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
const users: string[] = [];
const workspaces: string[] = [];

async function createBareProject(label: string) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const owner = await new SignUpUseCase(db, new ScryptPasswordHasher()).execute({
    email: `scope-profile-${label}-${suffix}@example.com`,
    password: 'supersecret1',
    displayName: `Scope Profile ${label}`,
  });
  expect(owner.ok).toBe(true);
  if (!owner.ok) throw new Error('signup failed');
  users.push(owner.value.userId);
  workspaces.push(owner.value.personalWorkspaceId);

  const [project] = await db
    .insert(schema.projects)
    .values({ workspaceId: owner.value.personalWorkspaceId, name: `${label} 프로젝트`, slug: `${label}-consulting` })
    .returning({ id: schema.projects.id, workspaceId: schema.projects.workspaceId, name: schema.projects.name, slug: schema.projects.slug });
  if (!project) throw new Error('project insert failed');
  return { ...project, actorUserId: owner.value.userId };
}

async function profileCounts(projectId: string) {
  const [row] = await pool.query<{ channels: string; topics: string }>(
    `select
       (select count(*)::text
        from scope_profiles sp
        join channels c on c.id = sp.scope_id
        where c.project_id = $1 and sp.scope_type = 'channel' and sp.deleted_at is null) as channels,
       (select count(*)::text
        from scope_profiles sp
        join topics t on t.id = sp.scope_id
        join channels c on c.id = t.channel_id
        where c.project_id = $1 and sp.scope_type = 'topic' and sp.deleted_at is null) as topics`,
    [projectId],
  ).then((result) => result.rows);
  return { channels: Number(row!.channels), topics: Number(row!.topics) };
}

d('ScopeProfileService', () => {
  beforeAll(() => {
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    if (workspaces.length) await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, workspaces));
    if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
    await pool.end();
  });

  it('seeds consulting_default channel/topic profiles and keeps template reapply idempotent', async () => {
    const project = await createBareProject('seed');
    const apply = await new ProjectTemplateService(db).applyConsultingDefault({ projectId: project.id, actorUserId: project.actorUserId });
    expect(apply.ok).toBe(true);
    if (!apply.ok) throw new Error('template apply failed');

    expect(await profileCounts(project.id)).toEqual({ channels: 5, topics: 8 });
    const [analysisChannel] = await db
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(and(eq(schema.channels.projectId, project.id), eq(schema.channels.slug, 'analysis')))
      .limit(1);
    const profile = await new ScopeProfileService(db).getProfile('channel', analysisChannel!.id);
    expect(profile.ok).toBe(true);
    if (!profile.ok) throw new Error('profile lookup failed');
    expect(profile.value.profile).toEqual(expect.objectContaining({
      scopeType: 'channel',
      scopeId: analysisChannel!.id,
      source: 'template',
      purpose: expect.stringContaining('분석'),
      rules: expect.stringContaining('근거'),
    }));

    const second = await new ProjectTemplateService(db).applyConsultingDefault({ projectId: project.id, actorUserId: project.actorUserId });
    expect(second.ok).toBe(true);
    expect(await profileCounts(project.id)).toEqual({ channels: 5, topics: 8 });
  });

  it('preserves manual topic profile edits when template seed runs again', async () => {
    const project = await createBareProject('manual');
    const template = new ProjectTemplateService(db);
    const first = await template.applyConsultingDefault({ projectId: project.id, actorUserId: project.actorUserId });
    expect(first.ok).toBe(true);

    const [topic] = await db
      .select({ id: schema.topics.id })
      .from(schema.topics)
      .innerJoin(schema.channels, eq(schema.channels.id, schema.topics.channelId))
      .where(and(eq(schema.channels.projectId, project.id), eq(schema.topics.slug, 'exactness-check')))
      .limit(1);
    const service = new ScopeProfileService(db);
    const updated = await service.updateProfile('topic', topic!.id, {
      actorUserId: project.actorUserId,
      patch: { purpose: '사용자가 정한 검산 목적', rules: '숫자는 반드시 재계산한다.' },
    });
    expect(updated.ok).toBe(true);

    const second = await template.applyConsultingDefault({ projectId: project.id, actorUserId: project.actorUserId });
    expect(second.ok).toBe(true);
    const read = await service.getProfile('topic', topic!.id);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('profile read failed');
    expect(read.value.profile).toEqual(expect.objectContaining({
      source: 'manual',
      purpose: '사용자가 정한 검산 목적',
      rules: '숫자는 반드시 재계산한다.',
    }));
  });

  it('returns null for missing profiles and refuses to edit archived scopes', async () => {
    const project = await createBareProject('archived');
    const [channel] = await db
      .insert(schema.channels)
      .values({ workspaceId: project.workspaceId, projectId: project.id, name: '임시', slug: `tmp-${Date.now()}` })
      .returning({ id: schema.channels.id });
    const service = new ScopeProfileService(db);

    const missing = await service.getProfile('channel', channel!.id);
    expect(missing.ok).toBe(true);
    if (!missing.ok) throw new Error('profile lookup failed');
    expect(missing.value.profile).toBeNull();

    await db.update(schema.channels).set({ status: 'archived' }).where(eq(schema.channels.id, channel!.id));
    const archivedEdit = await service.updateProfile('channel', channel!.id, {
      actorUserId: project.actorUserId,
      patch: { purpose: '보관된 채널 수정 금지' },
    });
    expect(archivedEdit.ok).toBe(false);
    if (!archivedEdit.ok) expect(archivedEdit.error.code).toBe('NOT_FOUND');

    const activeProfiles = await db.select({ id: schema.scopeProfiles.id }).from(schema.scopeProfiles).where(sql`${schema.scopeProfiles.scopeId} = ${channel!.id}`);
    expect(activeProfiles).toHaveLength(0);
  });
});
