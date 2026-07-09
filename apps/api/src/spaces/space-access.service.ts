import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

export type SpaceAccess = { allowed: true; workspaceId: string } | { allowed: false; reason: 'not_found' | 'forbidden' };

@Injectable()
export class SpaceAccessService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async workspaceMember(userId: string, workspaceId: string): Promise<SpaceAccess> {
    const [workspace] = await this.db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(and(eq(schema.workspaces.id, workspaceId), isNull(schema.workspaces.deletedAt))).limit(1);
    if (!workspace) return { allowed: false, reason: 'not_found' };
    return (await this.hasMembership(userId, workspaceId)) ? { allowed: true, workspaceId } : { allowed: false, reason: 'forbidden' };
  }

  async projectMember(userId: string, projectId: string): Promise<SpaceAccess> {
    const [project] = await this.db.select({ workspaceId: schema.projects.workspaceId }).from(schema.projects).where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt))).limit(1);
    if (!project) return { allowed: false, reason: 'not_found' };
    return (await this.hasMembership(userId, project.workspaceId)) ? { allowed: true, workspaceId: project.workspaceId } : { allowed: false, reason: 'forbidden' };
  }

  async channelMember(userId: string, channelId: string): Promise<SpaceAccess> {
    const [channel] = await this.db.select({ workspaceId: schema.channels.workspaceId }).from(schema.channels).where(and(eq(schema.channels.id, channelId), isNull(schema.channels.deletedAt))).limit(1);
    if (!channel) return { allowed: false, reason: 'not_found' };
    return (await this.hasMembership(userId, channel.workspaceId)) ? { allowed: true, workspaceId: channel.workspaceId } : { allowed: false, reason: 'forbidden' };
  }

  async topicMember(userId: string, topicId: string): Promise<SpaceAccess> {
    const [topic] = await this.db.select({ workspaceId: schema.topics.workspaceId }).from(schema.topics).where(and(eq(schema.topics.id, topicId), isNull(schema.topics.deletedAt))).limit(1);
    if (!topic) return { allowed: false, reason: 'not_found' };
    return (await this.hasMembership(userId, topic.workspaceId)) ? { allowed: true, workspaceId: topic.workspaceId } : { allowed: false, reason: 'forbidden' };
  }

  async threadMember(userId: string, threadId: string): Promise<SpaceAccess> {
    const [thread] = await this.db.select({ workspaceId: schema.threads.workspaceId }).from(schema.threads).where(and(eq(schema.threads.id, threadId), isNull(schema.threads.deletedAt))).limit(1);
    if (!thread) return { allowed: false, reason: 'not_found' };
    return (await this.hasMembership(userId, thread.workspaceId)) ? { allowed: true, workspaceId: thread.workspaceId } : { allowed: false, reason: 'forbidden' };
  }

  private async hasMembership(userId: string, workspaceId: string): Promise<boolean> {
    const [membership] = await this.db
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.workspaceId, workspaceId)))
      .limit(1);
    return Boolean(membership);
  }
}
