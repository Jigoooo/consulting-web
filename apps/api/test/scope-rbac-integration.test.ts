import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { schema } from '@consulting/db-schema';
import { SignUpUseCase } from '../src/auth/sign-up.usecase.js';
import { ScryptPasswordHasher } from '../src/auth/password.js';
import { SpaceAccessService } from '../src/spaces/space-access.service.js';
import { SpaceReadService } from '../src/spaces/space-read.service.js';
import { ChatStreamUseCase } from '../src/chat/chat-stream.usecase.js';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

type ScopeIds = { projectId: string; channelId: string; topicId: string; threadId: string };

d('Scope RBAC integration', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const users: string[] = [];
  const workspaces: string[] = [];
  let ownerId: string;
  let viewerId: string;
  let editorId: string;
  let threadViewerId: string;
  let workspaceId: string;
  let allowed: ScopeIds;
  let sibling: ScopeIds;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
    const signup = new SignUpUseCase(db, new ScryptPasswordHasher());
    const suffix = crypto.randomUUID().slice(0, 8);
    const owner = await signup.execute({ email: `scope-owner-${suffix}@example.com`, password: 'supersecret1', displayName: 'Scope Owner' });
    const viewer = await signup.execute({ email: `scope-viewer-${suffix}@example.com`, password: 'supersecret1', displayName: 'Scope Viewer' });
    const editor = await signup.execute({ email: `scope-editor-${suffix}@example.com`, password: 'supersecret1', displayName: 'Scope Editor' });
    const threadViewer = await signup.execute({ email: `scope-thread-viewer-${suffix}@example.com`, password: 'supersecret1', displayName: 'Scope Thread Viewer' });
    if (!owner.ok || !viewer.ok || !editor.ok || !threadViewer.ok) throw new Error('scope RBAC fixture signup failed');
    ownerId = owner.value.userId;
    viewerId = viewer.value.userId;
    editorId = editor.value.userId;
    threadViewerId = threadViewer.value.userId;
    workspaceId = owner.value.personalWorkspaceId;
    users.push(ownerId, viewerId, editorId, threadViewerId);
    workspaces.push(owner.value.personalWorkspaceId, viewer.value.personalWorkspaceId, editor.value.personalWorkspaceId, threadViewer.value.personalWorkspaceId);
    allowed = await createScopeTree(db, workspaceId, `allowed-${suffix}`);
    sibling = await createScopeTree(db, workspaceId, `sibling-${suffix}`);
    await db.insert(schema.memberships).values([
      { workspaceId, userId: viewerId, scopeType: 'project', scopeId: allowed.projectId, role: 'viewer' },
      { workspaceId, userId: editorId, scopeType: 'project', scopeId: allowed.projectId, role: 'editor' },
      { workspaceId, userId: threadViewerId, scopeType: 'thread', scopeId: allowed.threadId, role: 'viewer' },
    ]);
  });

  afterAll(async () => {
    if (workspaces.length) await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, workspaces));
    if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
    await pool.end();
  });

  it('does not expand a project-scoped membership to sibling or workspace-wide access', async () => {
    const access = new SpaceAccessService(db);
    const chat = new ChatStreamUseCase(db);

    expect(await access.workspaceMember(viewerId, workspaceId)).toEqual({ allowed: false, reason: 'forbidden', workspaceId });
    expect(await access.projectMember(viewerId, allowed.projectId)).toEqual({ allowed: true, workspaceId });
    expect(await access.projectMember(viewerId, sibling.projectId)).toEqual({ allowed: false, reason: 'forbidden', workspaceId });
    expect(await access.threadMember(viewerId, allowed.threadId)).toEqual({ allowed: true, workspaceId });
    expect(await access.threadMember(viewerId, sibling.threadId)).toEqual({ allowed: false, reason: 'forbidden', workspaceId });
    expect(await chat.canReadThread(viewerId, allowed.threadId)).toEqual({ status: 'allowed', workspaceId, projectId: allowed.projectId });
    expect(await chat.canReadThread(viewerId, sibling.threadId)).toEqual({ status: 'forbidden', workspaceId, projectId: sibling.projectId });
    expect(await chat.canSendThread(viewerId, allowed.threadId)).toEqual({ status: 'forbidden', workspaceId, projectId: allowed.projectId });
    expect(await chat.canSendThread(editorId, allowed.threadId)).toEqual({ status: 'allowed', workspaceId, projectId: allowed.projectId });
    expect(await access.topicMember(threadViewerId, allowed.topicId)).toEqual({ allowed: false, reason: 'forbidden', workspaceId });
    expect(await access.threadMember(threadViewerId, allowed.threadId)).toEqual({ allowed: true, workspaceId });
    expect(await access.threadMember(threadViewerId, sibling.threadId)).toEqual({ allowed: false, reason: 'forbidden', workspaceId });
  });

  it('returns only the subtree reachable from the caller memberships', async () => {
    const reads = new SpaceReadService(db);
    const scopedTree = await reads.workspaceTree(workspaceId, viewerId);
    const threadTree = await reads.workspaceTree(workspaceId, threadViewerId);
    const ownerTree = await reads.workspaceTree(workspaceId, ownerId);

    expect(scopedTree.projects.map((project) => project.id)).toEqual([allowed.projectId]);
    expect(threadTree.projects.map((project) => project.id)).toEqual([allowed.projectId]);
    expect(threadTree.projects[0]?.channels[0]?.topics[0]?.defaultThreadId).toBe(allowed.threadId);
    expect(ownerTree.projects.map((project) => project.id)).toEqual(expect.arrayContaining([allowed.projectId, sibling.projectId]));

    const denyRows = await db.insert(schema.permissionOverrides).values([
      { workspaceId, userId: ownerId, scopeType: 'project', scopeId: allowed.projectId, permission: 'project.read', allow: false },
      { workspaceId, userId: ownerId, scopeType: 'project', scopeId: allowed.projectId, permission: 'channel.read', allow: false },
      { workspaceId, userId: ownerId, scopeType: 'project', scopeId: allowed.projectId, permission: 'message.read', allow: false },
    ]).returning({ id: schema.permissionOverrides.id });
    const deniedTree = await reads.workspaceTree(workspaceId, ownerId);
    expect(deniedTree.projects.map((project) => project.id)).not.toContain(allowed.projectId);
    expect(deniedTree.projects.map((project) => project.id)).toContain(sibling.projectId);
    await db.delete(schema.permissionOverrides).where(inArray(schema.permissionOverrides.id, denyRows.map((row) => row.id)));
  });

  it('enforces role grants and explicit deny overrides on the target scope chain', async () => {
    const access = new SpaceAccessService(db);

    expect(await access.threadPermission(viewerId, allowed.threadId, 'message.send')).toEqual({ allowed: false, reason: 'forbidden', workspaceId });
    expect(await access.projectPermission(editorId, allowed.projectId, 'channel.create')).toEqual({ allowed: true, workspaceId });
    expect(await access.threadPermission(editorId, allowed.threadId, 'message.send')).toEqual({ allowed: true, workspaceId });

    const [threadDeny] = await db.insert(schema.permissionOverrides).values({
      workspaceId,
      userId: editorId,
      scopeType: 'thread',
      scopeId: allowed.threadId,
      permission: 'message.send',
      allow: false,
    }).returning({ id: schema.permissionOverrides.id });
    expect(await access.threadPermission(editorId, allowed.threadId, 'message.send')).toEqual({ allowed: false, reason: 'forbidden', workspaceId });
    await db.delete(schema.permissionOverrides).where(inArray(schema.permissionOverrides.id, [threadDeny!.id]));

    await db.insert(schema.permissionOverrides).values({
      workspaceId,
      userId: editorId,
      scopeType: 'channel',
      scopeId: allowed.channelId,
      permission: 'message.send',
      allow: false,
    });
    expect(await access.threadPermission(editorId, allowed.threadId, 'message.send')).toEqual({ allowed: false, reason: 'forbidden', workspaceId });

    const reads = new SpaceReadService(db);
    const legacyTree = await reads.workspaceTree(workspaceId, editorId);
    const capabilityTree = await reads.workspaceTree(workspaceId, editorId, true);
    expect(legacyTree.permissions).toBeUndefined();
    expect(capabilityTree.projects[0]?.permissions).toEqual(expect.arrayContaining(['project.update', 'channel.create', 'artifact.create']));
    expect(capabilityTree.projects[0]?.channels[0]?.permissions).toContain('channel.update');
    expect(capabilityTree.projects[0]?.channels[0]?.topics[0]?.permissions).toContain('message.read');
    expect(capabilityTree.projects[0]?.channels[0]?.topics[0]?.permissions).not.toContain('message.send');
  });
  it('authorizes an archived target chain only for the explicit restore path', async () => {
    const access = new SpaceAccessService(db);
    await db.update(schema.channels).set({ status: 'archived' }).where(eq(schema.channels.id, allowed.channelId));
    try {
      expect(await access.channelPermission(editorId, allowed.channelId, 'channel.update')).toEqual({ allowed: false, reason: 'not_found' });
      expect(await access.channelPermission(editorId, allowed.channelId, 'channel.update', { allowArchived: true })).toEqual({ allowed: true, workspaceId });
    } finally {
      await db.update(schema.channels).set({ status: 'active' }).where(eq(schema.channels.id, allowed.channelId));
    }
  });
});

async function createScopeTree(db: NodePgDatabase<typeof schema>, workspaceId: string, slug: string): Promise<ScopeIds> {
  const [project] = await db.insert(schema.projects).values({ workspaceId, name: slug, slug }).returning({ id: schema.projects.id });
  const [channel] = await db.insert(schema.channels).values({ workspaceId, projectId: project!.id, name: `${slug}-channel`, slug: `${slug}-channel` }).returning({ id: schema.channels.id });
  const [topic] = await db.insert(schema.topics).values({ workspaceId, channelId: channel!.id, name: `${slug}-topic`, slug: `${slug}-topic` }).returning({ id: schema.topics.id });
  const [thread] = await db.insert(schema.threads).values({ workspaceId, topicId: topic!.id, title: `${slug}-thread` }).returning({ id: schema.threads.id });
  return { projectId: project!.id, channelId: channel!.id, topicId: topic!.id, threadId: thread!.id };
}
