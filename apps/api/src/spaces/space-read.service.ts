import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type {
  ListWorkspacesResponse,
  WorkspaceTreeResponse,
  ListThreadsResponse,
  WorkspaceSummary,
} from '@consulting/contracts';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

const ROLE_ORDER: Record<string, number> = { owner: 0, admin: 1, editor: 2, commenter: 3, viewer: 4 };

/**
 * Read-side queries for the space tree (Phase 1-M). Pure selects — access is
 * enforced by the controller via SpaceAccessService before calling in here.
 * Soft-deleted rows are excluded everywhere.
 */
@Injectable()
export class SpaceReadService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Workspaces where the user holds ANY membership, with their highest role. */
  async listWorkspaces(userId: string): Promise<ListWorkspacesResponse> {
    const rows = await this.db
      .select({
        id: schema.workspaces.id,
        name: schema.workspaces.name,
        slug: schema.workspaces.slug,
        isPersonal: schema.workspaces.isPersonal,
        role: schema.memberships.role,
      })
      .from(schema.memberships)
      .innerJoin(schema.workspaces, eq(schema.memberships.workspaceId, schema.workspaces.id))
      .where(and(eq(schema.memberships.userId, userId), isNull(schema.workspaces.deletedAt)))
      .orderBy(asc(schema.workspaces.createdAt));

    // A user can hold several memberships (workspace + project scopes...);
    // collapse to one row per workspace keeping the strongest role.
    const byId = new Map<string, WorkspaceSummary>();
    for (const row of rows) {
      const existing = byId.get(row.id);
      const candidate: WorkspaceSummary = {
        id: row.id,
        name: row.name,
        slug: row.slug,
        isPersonal: row.isPersonal === 'true',
        role: row.role,
      };
      if (!existing || (ROLE_ORDER[candidate.role] ?? 99) < (ROLE_ORDER[existing.role] ?? 99)) {
        byId.set(row.id, candidate);
      }
    }
    return { workspaces: [...byId.values()] };
  }

  /** Full nested tree (projects → channels → topics) for one workspace. */
  async workspaceTree(workspaceId: string): Promise<WorkspaceTreeResponse> {
    const projects = await this.db
      .select({ id: schema.projects.id, name: schema.projects.name, slug: schema.projects.slug })
      .from(schema.projects)
      .where(and(eq(schema.projects.workspaceId, workspaceId), isNull(schema.projects.deletedAt)))
      .orderBy(asc(schema.projects.createdAt));
    if (projects.length === 0) return { workspaceId, projects: [] };

    const projectIds = projects.map((p) => p.id);
    const channels = await this.db
      .select({
        id: schema.channels.id,
        projectId: schema.channels.projectId,
        name: schema.channels.name,
        slug: schema.channels.slug,
      })
      .from(schema.channels)
      .where(and(inArray(schema.channels.projectId, projectIds), isNull(schema.channels.deletedAt)))
      .orderBy(asc(schema.channels.createdAt));

    const channelIds = channels.map((c) => c.id);
    const topics = channelIds.length
      ? await this.db
          .select({
            id: schema.topics.id,
            channelId: schema.topics.channelId,
            name: schema.topics.name,
            slug: schema.topics.slug,
          })
          .from(schema.topics)
          .where(and(inArray(schema.topics.channelId, channelIds), isNull(schema.topics.deletedAt)))
          .orderBy(asc(schema.topics.createdAt))
      : [];

    const topicsByChannel = new Map<string, { id: string; name: string; slug: string }[]>();
    for (const t of topics) {
      const list = topicsByChannel.get(t.channelId) ?? [];
      list.push({ id: t.id, name: t.name, slug: t.slug });
      topicsByChannel.set(t.channelId, list);
    }
    const channelsByProject = new Map<string, { id: string; name: string; slug: string; topics: { id: string; name: string; slug: string }[] }[]>();
    for (const c of channels) {
      const list = channelsByProject.get(c.projectId) ?? [];
      list.push({ id: c.id, name: c.name, slug: c.slug, topics: topicsByChannel.get(c.id) ?? [] });
      channelsByProject.set(c.projectId, list);
    }

    return {
      workspaceId,
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        channels: channelsByProject.get(p.id) ?? [],
      })),
    };
  }

  /** Threads under a topic, oldest first (chat-like ordering). */
  async listThreads(topicId: string): Promise<ListThreadsResponse> {
    const rows = await this.db
      .select({ id: schema.threads.id, title: schema.threads.title, createdAt: schema.threads.createdAt })
      .from(schema.threads)
      .where(and(eq(schema.threads.topicId, topicId), isNull(schema.threads.deletedAt)))
      .orderBy(asc(schema.threads.createdAt));
    return {
      threads: rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.createdAt.toISOString() })),
    };
  }
}
