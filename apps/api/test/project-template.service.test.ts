import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { schema } from '@consulting/db-schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { SignUpUseCase } from '../src/auth/sign-up.usecase.js';
import { ScryptPasswordHasher } from '../src/auth/password.js';
import { CreateProjectUseCase } from '../src/spaces/create-project.usecase.js';
import { CONSULTING_DEFAULT_TEMPLATE, ProjectTemplateService } from '../src/spaces/project-template.service.js';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
const users: string[] = [];
const workspaces: string[] = [];

async function createBareProject(label: string) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const owner = await new SignUpUseCase(db, new ScryptPasswordHasher()).execute({
    email: `template-${label}-${suffix}@example.com`,
    password: 'supersecret1',
    displayName: `Template ${label}`,
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

async function countTemplateRows(projectId: string) {
  const [row] = await pool.query<{
    channels: string;
    topics: string;
    threads: string;
    links: string;
  }>(
    `select
       (select count(*)::text from channels where project_id=$1 and deleted_at is null) as channels,
       (select count(*)::text from topics t join channels c on c.id=t.channel_id where c.project_id=$1 and t.deleted_at is null and c.deleted_at is null) as topics,
       (select count(*)::text from threads th join topics t on t.id=th.topic_id join channels c on c.id=t.channel_id where c.project_id=$1 and th.deleted_at is null and t.deleted_at is null and c.deleted_at is null) as threads,
       (select count(*)::text from consulting_topic_links where project_id=$1 and status='active') as links`,
    [projectId],
  ).then((result) => result.rows);
  return { channels: Number(row!.channels), topics: Number(row!.topics), threads: Number(row!.threads), links: Number(row!.links) };
}

d('consulting_default project template', () => {
  beforeAll(() => {
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    if (workspaces.length) await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, workspaces));
    if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
    await pool.end();
  });

  it('defines the consulting_default channel/topic/thread skeleton', () => {
    expect(CONSULTING_DEFAULT_TEMPLATE.templateKey).toBe('consulting_default');
    expect(CONSULTING_DEFAULT_TEMPLATE.channels.map((channel) => channel.slug)).toEqual([
      'source-collection',
      'analysis',
      'reports',
      'qna',
      'conversation',
    ]);
    expect(CONSULTING_DEFAULT_TEMPLATE.channels.flatMap((channel) => channel.topics)).toHaveLength(8);
  });

  it('creates default channels/topics/threads and a project brain link idempotently', async () => {
    const project = await createBareProject('template-alpha');
    const service = new ProjectTemplateService(db);

    const first = await service.applyConsultingDefault({ projectId: project.id, actorUserId: project.actorUserId });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('template apply failed');
    expect(first.value.created).toMatchObject({ channels: 5, topics: 8, threads: 8, consultingLinks: 1 });
    expect(first.value.brainSlug).toBe('template-alpha-consulting');
    expect(await countTemplateRows(project.id)).toEqual({ channels: 5, topics: 8, threads: 8, links: 1 });

    const second = await service.applyConsultingDefault({ projectId: project.id, actorUserId: project.actorUserId });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('template reapply failed');
    expect(second.value.created).toEqual({ channels: 0, topics: 0, threads: 0, consultingLinks: 0 });
    expect(await countTemplateRows(project.id)).toEqual({ channels: 5, topics: 8, threads: 8, links: 1 });
  });

  it('uses a project-scoped brain slug and does not mix TEST with Changwon', async () => {
    const project = await createBareProject('test');
    const service = new ProjectTemplateService(db);

    const result = await service.applyConsultingDefault({ projectId: project.id, actorUserId: project.actorUserId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('template apply failed');

    const links = await db
      .select({ slug: schema.consultingTopicLinks.consultingTopicSlug })
      .from(schema.consultingTopicLinks)
      .where(eq(schema.consultingTopicLinks.projectId, project.id));
    expect(links.map((link) => link.slug)).toEqual(['test-consulting']);
    expect(links.map((link) => link.slug)).not.toContain('changwon-org-mgmt-diagnosis');

    const memoryIds = await db
      .select({ memoryTopicId: schema.topics.memoryTopicId })
      .from(schema.topics)
      .innerJoin(schema.channels, eq(schema.channels.id, schema.topics.channelId))
      .where(and(eq(schema.channels.projectId, project.id), sql`${schema.topics.memoryTopicId} is not null`));
    expect(memoryIds).toHaveLength(8);
    expect(memoryIds.every((row) => row.memoryTopicId?.startsWith('consulting:test-consulting#'))).toBe(true);
  });

  it('refuses to apply the default template when the project already points at the Changwon brain', async () => {
    const project = await createBareProject('already-linked');
    await db.insert(schema.consultingTopicLinks).values({
      workspaceId: project.workspaceId,
      projectId: project.id,
      linkLevel: 'project',
      consultingTopicSlug: 'changwon-org-mgmt-diagnosis',
      scopePath: project.name,
      origin: 'manual',
      createdByUserId: project.actorUserId,
    });

    const result = await new ProjectTemplateService(db).applyConsultingDefault({
      projectId: project.id,
      actorUserId: project.actorUserId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CONFLICT');
    expect(await countTemplateRows(project.id)).toEqual({ channels: 0, topics: 0, threads: 0, links: 1 });
  });

  it('refuses to apply when any scoped consulting link already points at another brain', async () => {
    const project = await createBareProject('scoped-linked');
    const [channel] = await db
      .insert(schema.channels)
      .values({ workspaceId: project.workspaceId, projectId: project.id, name: '대화', slug: 'conversation' })
      .returning({ id: schema.channels.id });
    await db.insert(schema.consultingTopicLinks).values({
      workspaceId: project.workspaceId,
      projectId: project.id,
      channelId: channel!.id,
      linkLevel: 'channel',
      consultingTopicSlug: 'changwon-org-mgmt-diagnosis',
      scopePath: `${project.name}/대화`,
      origin: 'manual',
      createdByUserId: project.actorUserId,
    });

    const result = await new ProjectTemplateService(db).applyConsultingDefault({
      projectId: project.id,
      actorUserId: project.actorUserId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CONFLICT');
    expect(await countTemplateRows(project.id)).toEqual({ channels: 1, topics: 0, threads: 0, links: 1 });
  });

  it('refuses to overwrite an existing template topic memory id from another brain', async () => {
    const project = await createBareProject('memory-linked');
    const [channel] = await db
      .insert(schema.channels)
      .values({ workspaceId: project.workspaceId, projectId: project.id, name: '대화', slug: 'conversation' })
      .returning({ id: schema.channels.id });
    await db.insert(schema.topics).values({
      workspaceId: project.workspaceId,
      channelId: channel!.id,
      name: '기본 대화',
      slug: 'default-chat',
      memoryTopicId: 'consulting:changwon-org-mgmt-diagnosis#telegram/default-chat',
    });

    const result = await new ProjectTemplateService(db).applyConsultingDefault({
      projectId: project.id,
      actorUserId: project.actorUserId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CONFLICT');
    expect(await countTemplateRows(project.id)).toEqual({ channels: 1, topics: 1, threads: 0, links: 0 });
  });

  it('previews TEST-style backfill without mutating existing rows or messages', async () => {
    const project = await createBareProject('preview');
    const [channel] = await db
      .insert(schema.channels)
      .values({ workspaceId: project.workspaceId, projectId: project.id, name: '대화', slug: 'conversation' })
      .returning({ id: schema.channels.id });
    const [topic] = await db
      .insert(schema.topics)
      .values({ workspaceId: project.workspaceId, channelId: channel!.id, name: '기본 대화', slug: 'default-chat' })
      .returning({ id: schema.topics.id });
    const [thread] = await db
      .insert(schema.threads)
      .values({ workspaceId: project.workspaceId, topicId: topic!.id, title: '기본 대화' })
      .returning({ id: schema.threads.id });
    await db.insert(schema.chatMessages).values({
      workspaceId: project.workspaceId,
      threadId: thread!.id,
      role: 'user',
      authorUserId: project.actorUserId,
      content: '기존 TEST 메시지는 보존되어야 한다',
    });

    const before = await countTemplateRows(project.id);
    const preview = await new ProjectTemplateService(db).previewConsultingDefaultBackfill(project.id);

    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error('preview failed');
    expect(preview.value.readOnly).toBe(true);
    expect(preview.value.brainSlug).toBe('preview-consulting');
    expect(preview.value.before).toEqual({ channels: 1, topics: 1, threads: 1, messages: 1, consultingLinks: 0 });
    expect(preview.value.plannedCreates).toEqual({ channels: 4, topics: 7, threads: 7, consultingLinks: 1 });
    expect(preview.value.warnings).not.toContain('would_link_to_changwon_brain');
    expect(await countTemplateRows(project.id)).toEqual(before);
  });

  it('applies consulting_default from the project creation path when the config flag is enabled', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const owner = await new SignUpUseCase(db, new ScryptPasswordHasher()).execute({
      email: `template-create-${suffix}@example.com`,
      password: 'supersecret1',
      displayName: 'Template Create',
    });
    expect(owner.ok).toBe(true);
    if (!owner.ok) throw new Error('signup failed');
    users.push(owner.value.userId);
    workspaces.push(owner.value.personalWorkspaceId);

    const project = await new CreateProjectUseCase(
      db,
      new ProjectTemplateService(db),
      { CONSULTING_DEFAULT_TEMPLATE_ENABLED: true },
    ).execute({
      workspaceId: owner.value.personalWorkspaceId,
      actorUserId: owner.value.userId,
      name: '생성경로 프로젝트',
      slug: 'created-consulting',
    });

    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error('project create failed');
    expect(await countTemplateRows(project.value.projectId)).toEqual({ channels: 5, topics: 8, threads: 8, links: 1 });
  });

  it('honors an explicit project creation opt-out even when the env default is enabled', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const owner = await new SignUpUseCase(db, new ScryptPasswordHasher()).execute({
      email: `template-create-optout-${suffix}@example.com`,
      password: 'supersecret1',
      displayName: 'Template Create Optout',
    });
    expect(owner.ok).toBe(true);
    if (!owner.ok) throw new Error('signup failed');
    users.push(owner.value.userId);
    workspaces.push(owner.value.personalWorkspaceId);

    const project = await new CreateProjectUseCase(
      db,
      new ProjectTemplateService(db),
      { CONSULTING_DEFAULT_TEMPLATE_ENABLED: true },
    ).execute({
      workspaceId: owner.value.personalWorkspaceId,
      actorUserId: owner.value.userId,
      name: '템플릿 제외 프로젝트',
      slug: 'created-without-template',
      applyDefaultTemplate: false,
    });

    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error('project create failed');
    expect(project.value.templateApplied).toBe(false);
    expect(await countTemplateRows(project.value.projectId)).toEqual({ channels: 0, topics: 0, threads: 0, links: 0 });
  });

  it('inherits project seed tags onto template-created channels', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const owner = await new SignUpUseCase(db, new ScryptPasswordHasher()).execute({
      email: `template-tags-${suffix}@example.com`,
      password: 'supersecret1',
      displayName: 'Template Tags',
    });
    expect(owner.ok).toBe(true);
    if (!owner.ok) throw new Error('signup failed');
    users.push(owner.value.userId);
    workspaces.push(owner.value.personalWorkspaceId);

    const project = await new CreateProjectUseCase(
      db,
      new ProjectTemplateService(db),
      { CONSULTING_DEFAULT_TEMPLATE_ENABLED: true },
    ).execute({
      workspaceId: owner.value.personalWorkspaceId,
      actorUserId: owner.value.userId,
      name: '태그상속 프로젝트',
      slug: 'tagged-consulting',
      tags: [{ key: 'engagement', value: 'Changwon' }],
    });
    expect(project.ok).toBe(true);
    if (!project.ok) throw new Error('project create failed');

    const inherited = await db
      .select({ channelId: schema.scopeTags.scopeId })
      .from(schema.scopeTags)
      .innerJoin(schema.contextTags, eq(schema.contextTags.id, schema.scopeTags.tagId))
      .innerJoin(schema.channels, eq(schema.channels.id, schema.scopeTags.scopeId))
      .where(and(
        eq(schema.scopeTags.scopeType, 'channel'),
        eq(schema.scopeTags.origin, 'inherited'),
        eq(schema.contextTags.key, 'engagement'),
        eq(schema.contextTags.normalizedValue, 'changwon'),
        eq(schema.channels.projectId, project.value.projectId),
      ));
    expect(inherited).toHaveLength(5);
  });
});
