import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { MatrixPolicyEngine } from '../permissions/matrix-policy-engine.js';
import { PERMISSIONS, type MembershipRecord, type OverrideRecord, type Permission, type ScopeChainNode } from '../permissions/permission.types.js';

export type SpaceAccess =
  | { allowed: true; workspaceId: string }
  | { allowed: false; reason: 'not_found' }
  | { allowed: false; reason: 'forbidden'; workspaceId: string };
type PermissionLookupOptions = { allowArchived?: boolean };

@Injectable()
export class SpaceAccessService {
  private readonly policy = new MatrixPolicyEngine();

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async workspaceMember(userId: string, workspaceId: string): Promise<SpaceAccess> {
    return this.workspacePermission(userId, workspaceId, 'workspace.read');
  }

  async workspaceAnyMembership(userId: string, workspaceId: string): Promise<SpaceAccess> {
    const [workspace] = await this.db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(and(eq(schema.workspaces.id, workspaceId), isNull(schema.workspaces.deletedAt))).limit(1);
    if (!workspace) return { allowed: false, reason: 'not_found' };
    const [membership] = await this.db.select({ id: schema.memberships.id }).from(schema.memberships).where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.workspaceId, workspaceId))).limit(1);
    return membership ? { allowed: true, workspaceId } : { allowed: false, reason: 'forbidden', workspaceId };
  }

  async workspacePermission(userId: string, workspaceId: string, permission: Permission): Promise<SpaceAccess> {
    const [workspace] = await this.db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.status, 'active'), isNull(schema.workspaces.deletedAt))).limit(1);
    if (!workspace) return { allowed: false, reason: 'not_found' };
    return this.authorize(userId, workspaceId, [{ scopeType: 'workspace', scopeId: workspaceId }], permission);
  }

  async projectMember(userId: string, projectId: string): Promise<SpaceAccess> {
    return this.projectPermission(userId, projectId, 'project.read');
  }

  async projectPermission(userId: string, projectId: string, permission: Permission, options: PermissionLookupOptions = {}): Promise<SpaceAccess> {
    const [project] = await this.db
      .select({ workspaceId: schema.projects.workspaceId })
      .from(schema.projects)
      .innerJoin(schema.workspaces, eq(schema.projects.workspaceId, schema.workspaces.id))
      .where(and(
        eq(schema.projects.id, projectId),
        ...(options.allowArchived ? [] : [eq(schema.projects.status, 'active')]),
        isNull(schema.projects.deletedAt),
        eq(schema.workspaces.status, 'active'),
        isNull(schema.workspaces.deletedAt),
      ))
      .limit(1);
    if (!project) return { allowed: false, reason: 'not_found' };
    return this.authorize(userId, project.workspaceId, [
      { scopeType: 'workspace', scopeId: project.workspaceId },
      { scopeType: 'project', scopeId: projectId },
    ], permission);
  }

  async channelMember(userId: string, channelId: string): Promise<SpaceAccess> {
    return this.channelPermission(userId, channelId, 'channel.read');
  }

  async channelPermission(userId: string, channelId: string, permission: Permission, options: PermissionLookupOptions = {}): Promise<SpaceAccess> {
    const [channel] = await this.db
      .select({ workspaceId: schema.channels.workspaceId, projectId: schema.channels.projectId })
      .from(schema.channels)
      .innerJoin(schema.projects, and(
        eq(schema.channels.projectId, schema.projects.id),
        eq(schema.channels.workspaceId, schema.projects.workspaceId),
      ))
      .innerJoin(schema.workspaces, eq(schema.projects.workspaceId, schema.workspaces.id))
      .where(and(
        eq(schema.channels.id, channelId),
        ...(options.allowArchived ? [] : [eq(schema.channels.status, 'active'), eq(schema.projects.status, 'active')]),
        isNull(schema.channels.deletedAt),
        isNull(schema.projects.deletedAt),
        eq(schema.workspaces.status, 'active'),
        isNull(schema.workspaces.deletedAt),
      ))
      .limit(1);
    if (!channel) return { allowed: false, reason: 'not_found' };
    return this.authorize(userId, channel.workspaceId, [
      { scopeType: 'workspace', scopeId: channel.workspaceId },
      { scopeType: 'project', scopeId: channel.projectId },
      { scopeType: 'channel', scopeId: channelId },
    ], permission);
  }

  async topicMember(userId: string, topicId: string): Promise<SpaceAccess> {
    return this.topicPermission(userId, topicId, 'message.read');
  }

  async topicPermission(userId: string, topicId: string, permission: Permission, options: PermissionLookupOptions = {}): Promise<SpaceAccess> {
    const [topic] = await this.db
      .select({ workspaceId: schema.topics.workspaceId, channelId: schema.topics.channelId, projectId: schema.channels.projectId })
      .from(schema.topics)
      .innerJoin(schema.channels, and(
        eq(schema.topics.channelId, schema.channels.id),
        eq(schema.topics.workspaceId, schema.channels.workspaceId),
      ))
      .innerJoin(schema.projects, and(
        eq(schema.channels.projectId, schema.projects.id),
        eq(schema.channels.workspaceId, schema.projects.workspaceId),
      ))
      .innerJoin(schema.workspaces, eq(schema.projects.workspaceId, schema.workspaces.id))
      .where(and(
        eq(schema.topics.id, topicId),
        ...(options.allowArchived ? [] : [eq(schema.topics.status, 'active'), eq(schema.channels.status, 'active'), eq(schema.projects.status, 'active')]),
        isNull(schema.topics.deletedAt),
        isNull(schema.channels.deletedAt),
        isNull(schema.projects.deletedAt),
        eq(schema.workspaces.status, 'active'),
        isNull(schema.workspaces.deletedAt),
      ))
      .limit(1);
    if (!topic) return { allowed: false, reason: 'not_found' };
    return this.authorize(userId, topic.workspaceId, [
      { scopeType: 'workspace', scopeId: topic.workspaceId },
      { scopeType: 'project', scopeId: topic.projectId },
      { scopeType: 'channel', scopeId: topic.channelId },
      { scopeType: 'topic', scopeId: topicId },
    ], permission);
  }

  async permittedProjectIds(userId: string, workspaceId: string, permission: Permission): Promise<string[]> {
    const [projects, memberships, overrideRows, userRows] = await Promise.all([
      this.db.select({ id: schema.projects.id }).from(schema.projects)
        .innerJoin(schema.workspaces, eq(schema.projects.workspaceId, schema.workspaces.id))
        .where(and(
          eq(schema.projects.workspaceId, workspaceId),
          eq(schema.projects.status, 'active'),
          isNull(schema.projects.deletedAt),
          eq(schema.workspaces.status, 'active'),
          isNull(schema.workspaces.deletedAt),
        )),
      this.db.select({ scopeType: schema.memberships.scopeType, scopeId: schema.memberships.scopeId, role: schema.memberships.role }).from(schema.memberships).where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.workspaceId, workspaceId))),
      this.db.select({ scopeType: schema.permissionOverrides.scopeType, scopeId: schema.permissionOverrides.scopeId, permission: schema.permissionOverrides.permission, allow: schema.permissionOverrides.allow }).from(schema.permissionOverrides).where(and(eq(schema.permissionOverrides.userId, userId), eq(schema.permissionOverrides.workspaceId, workspaceId))),
      this.db.select({ systemRole: schema.users.systemRole }).from(schema.users).where(and(eq(schema.users.id, userId), eq(schema.users.status, 'active'), isNull(schema.users.deletedAt))).limit(1),
    ]);
    const membershipRecords: MembershipRecord[] = memberships.map((row) => ({ scopeType: row.scopeType, scopeId: row.scopeId, role: row.role }));
    const overrideRecords: OverrideRecord[] = overrideRows
      .filter((row): row is typeof row & { permission: Permission } => PERMISSIONS.includes(row.permission as Permission))
      .map((row) => ({ scopeType: row.scopeType, scopeId: row.scopeId, permission: row.permission, allow: row.allow }));
    return projects.filter((project) => this.policy.evaluate({
      permission,
      scopeChain: [
        { scopeType: 'workspace', scopeId: workspaceId },
        { scopeType: 'project', scopeId: project.id },
      ],
      memberships: membershipRecords,
      overrides: overrideRecords,
      systemRole: userRows[0]?.systemRole ?? 'user',
    }).allowed).map((project) => project.id);
  }

  async threadMember(userId: string, threadId: string): Promise<SpaceAccess> {
    return this.threadPermission(userId, threadId, 'message.read');
  }

  async readableThreadIds(userId: string, workspaceId: string): Promise<string[]> {
    const [threads, memberships, overrideRows, userRows] = await Promise.all([
      this.db
        .select({
          id: schema.threads.id,
          topicId: schema.threads.topicId,
          channelId: schema.topics.channelId,
          projectId: schema.channels.projectId,
        })
        .from(schema.threads)
        .innerJoin(schema.topics, and(
          eq(schema.threads.topicId, schema.topics.id),
          eq(schema.threads.workspaceId, schema.topics.workspaceId),
        ))
        .innerJoin(schema.channels, and(
          eq(schema.topics.channelId, schema.channels.id),
          eq(schema.topics.workspaceId, schema.channels.workspaceId),
        ))
        .innerJoin(schema.projects, and(
          eq(schema.channels.projectId, schema.projects.id),
          eq(schema.channels.workspaceId, schema.projects.workspaceId),
        ))
        .innerJoin(schema.workspaces, eq(schema.projects.workspaceId, schema.workspaces.id))
        .where(and(
          eq(schema.threads.workspaceId, workspaceId),
          eq(schema.threads.status, 'active'),
          eq(schema.topics.status, 'active'),
          eq(schema.channels.status, 'active'),
          eq(schema.projects.status, 'active'),
          eq(schema.workspaces.status, 'active'),
          isNull(schema.threads.deletedAt),
          isNull(schema.topics.deletedAt),
          isNull(schema.channels.deletedAt),
          isNull(schema.projects.deletedAt),
          isNull(schema.workspaces.deletedAt),
        )),
      this.db.select({ scopeType: schema.memberships.scopeType, scopeId: schema.memberships.scopeId, role: schema.memberships.role }).from(schema.memberships).where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.workspaceId, workspaceId))),
      this.db.select({ scopeType: schema.permissionOverrides.scopeType, scopeId: schema.permissionOverrides.scopeId, permission: schema.permissionOverrides.permission, allow: schema.permissionOverrides.allow }).from(schema.permissionOverrides).where(and(eq(schema.permissionOverrides.userId, userId), eq(schema.permissionOverrides.workspaceId, workspaceId))),
      this.db.select({ systemRole: schema.users.systemRole }).from(schema.users).where(and(eq(schema.users.id, userId), eq(schema.users.status, 'active'), isNull(schema.users.deletedAt))).limit(1),
    ]);
    const membershipRecords: MembershipRecord[] = memberships.map((row) => ({ scopeType: row.scopeType, scopeId: row.scopeId, role: row.role }));
    const overrideRecords: OverrideRecord[] = overrideRows
      .filter((row): row is typeof row & { permission: Permission } => PERMISSIONS.includes(row.permission as Permission))
      .map((row) => ({ scopeType: row.scopeType, scopeId: row.scopeId, permission: row.permission, allow: row.allow }));
    return threads
      .filter((thread) => this.policy.evaluate({
        permission: 'message.read',
        scopeChain: [
          { scopeType: 'workspace', scopeId: workspaceId },
          { scopeType: 'project', scopeId: thread.projectId },
          { scopeType: 'channel', scopeId: thread.channelId },
          { scopeType: 'topic', scopeId: thread.topicId },
          { scopeType: 'thread', scopeId: thread.id },
        ],
        memberships: membershipRecords,
        overrides: overrideRecords,
        systemRole: userRows[0]?.systemRole ?? 'user',
      }).allowed)
      .map((thread) => thread.id);
  }

  async threadPermission(userId: string, threadId: string, permission: Permission, options: PermissionLookupOptions = {}): Promise<SpaceAccess> {
    const [thread] = await this.db
      .select({ workspaceId: schema.threads.workspaceId, topicId: schema.threads.topicId, channelId: schema.topics.channelId, projectId: schema.channels.projectId })
      .from(schema.threads)
      .innerJoin(schema.topics, and(
        eq(schema.threads.topicId, schema.topics.id),
        eq(schema.threads.workspaceId, schema.topics.workspaceId),
      ))
      .innerJoin(schema.channels, and(
        eq(schema.topics.channelId, schema.channels.id),
        eq(schema.topics.workspaceId, schema.channels.workspaceId),
      ))
      .innerJoin(schema.projects, and(
        eq(schema.channels.projectId, schema.projects.id),
        eq(schema.channels.workspaceId, schema.projects.workspaceId),
      ))
      .innerJoin(schema.workspaces, eq(schema.projects.workspaceId, schema.workspaces.id))
      .where(and(
        eq(schema.threads.id, threadId),
        ...(options.allowArchived ? [] : [eq(schema.threads.status, 'active'), eq(schema.topics.status, 'active'), eq(schema.channels.status, 'active'), eq(schema.projects.status, 'active')]),
        isNull(schema.threads.deletedAt),
        isNull(schema.topics.deletedAt),
        isNull(schema.channels.deletedAt),
        isNull(schema.projects.deletedAt),
        eq(schema.workspaces.status, 'active'),
        isNull(schema.workspaces.deletedAt),
      ))
      .limit(1);
    if (!thread) return { allowed: false, reason: 'not_found' };
    return this.authorize(userId, thread.workspaceId, [
      { scopeType: 'workspace', scopeId: thread.workspaceId },
      { scopeType: 'project', scopeId: thread.projectId },
      { scopeType: 'channel', scopeId: thread.channelId },
      { scopeType: 'topic', scopeId: thread.topicId },
      { scopeType: 'thread', scopeId: threadId },
    ], permission);
  }

  private async authorize(userId: string, workspaceId: string, scopeChain: ScopeChainNode[], permission: Permission): Promise<SpaceAccess> {
    const [memberships, overrideRows, userRows] = await Promise.all([
      this.db.select({ scopeType: schema.memberships.scopeType, scopeId: schema.memberships.scopeId, role: schema.memberships.role }).from(schema.memberships).where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.workspaceId, workspaceId))),
      this.db.select({ scopeType: schema.permissionOverrides.scopeType, scopeId: schema.permissionOverrides.scopeId, permission: schema.permissionOverrides.permission, allow: schema.permissionOverrides.allow }).from(schema.permissionOverrides).where(and(eq(schema.permissionOverrides.userId, userId), eq(schema.permissionOverrides.workspaceId, workspaceId))),
      this.db.select({ systemRole: schema.users.systemRole }).from(schema.users).where(and(eq(schema.users.id, userId), eq(schema.users.status, 'active'), isNull(schema.users.deletedAt))).limit(1),
    ]);
    const membershipRecords: MembershipRecord[] = memberships.map((row) => ({ scopeType: row.scopeType, scopeId: row.scopeId, role: row.role }));
    const overrideRecords: OverrideRecord[] = overrideRows
      .filter((row): row is typeof row & { permission: Permission } => PERMISSIONS.includes(row.permission as Permission))
      .map((row) => ({ scopeType: row.scopeType, scopeId: row.scopeId, permission: row.permission, allow: row.allow }));
    const result = this.policy.evaluate({
      permission,
      scopeChain,
      memberships: membershipRecords,
      overrides: overrideRecords,
      systemRole: userRows[0]?.systemRole ?? 'user',
    });
    return result.allowed ? { allowed: true, workspaceId } : { allowed: false, reason: 'forbidden', workspaceId };
  }
}
