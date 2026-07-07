import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type {
  ArchivedScopeItem,
  ListArchivedScopesResponse,
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
      .where(and(eq(schema.projects.workspaceId, workspaceId), eq(schema.projects.status, 'active'), isNull(schema.projects.deletedAt)))
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
      .where(and(inArray(schema.channels.projectId, projectIds), eq(schema.channels.status, 'active'), isNull(schema.channels.deletedAt)))
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
          .where(and(inArray(schema.topics.channelId, channelIds), eq(schema.topics.status, 'active'), isNull(schema.topics.deletedAt)))
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
      .innerJoin(schema.topics, eq(schema.threads.topicId, schema.topics.id))
      .innerJoin(schema.channels, eq(schema.topics.channelId, schema.channels.id))
      .innerJoin(schema.projects, eq(schema.channels.projectId, schema.projects.id))
      .where(and(
        eq(schema.threads.topicId, topicId),
        eq(schema.threads.status, 'active'),
        eq(schema.topics.status, 'active'),
        eq(schema.channels.status, 'active'),
        eq(schema.projects.status, 'active'),
        isNull(schema.threads.deletedAt),
        isNull(schema.topics.deletedAt),
        isNull(schema.channels.deletedAt),
        isNull(schema.projects.deletedAt),
      ))
      .orderBy(asc(schema.threads.createdAt));
    return {
      threads: rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.createdAt.toISOString() })),
    };
  }

  /** Archived scopes for the workspace archive view. Deleted_soft rows stay hidden. */
  async listArchivedScopes(workspaceId: string): Promise<ListArchivedScopesResponse> {
    const [projects, channels, topics, threads] = await Promise.all([
      this.db
        .select({ id: schema.projects.id, name: schema.projects.name, updatedAt: schema.projects.updatedAt })
        .from(schema.projects)
        .where(and(eq(schema.projects.workspaceId, workspaceId), eq(schema.projects.status, 'archived'), isNull(schema.projects.deletedAt)))
        .orderBy(asc(schema.projects.updatedAt)),
      this.db
        .select({
          id: schema.channels.id,
          name: schema.channels.name,
          updatedAt: schema.channels.updatedAt,
          projectName: schema.projects.name,
        })
        .from(schema.channels)
        .innerJoin(schema.projects, eq(schema.channels.projectId, schema.projects.id))
        .where(and(eq(schema.channels.workspaceId, workspaceId), eq(schema.channels.status, 'archived'), isNull(schema.channels.deletedAt)))
        .orderBy(asc(schema.channels.updatedAt)),
      this.db
        .select({
          id: schema.topics.id,
          name: schema.topics.name,
          updatedAt: schema.topics.updatedAt,
          projectName: schema.projects.name,
          channelName: schema.channels.name,
        })
        .from(schema.topics)
        .innerJoin(schema.channels, eq(schema.topics.channelId, schema.channels.id))
        .innerJoin(schema.projects, eq(schema.channels.projectId, schema.projects.id))
        .where(and(eq(schema.topics.workspaceId, workspaceId), eq(schema.topics.status, 'archived'), isNull(schema.topics.deletedAt)))
        .orderBy(asc(schema.topics.updatedAt)),
      this.db
        .select({
          id: schema.threads.id,
          name: schema.threads.title,
          updatedAt: schema.threads.updatedAt,
          projectName: schema.projects.name,
          channelName: schema.channels.name,
          topicName: schema.topics.name,
        })
        .from(schema.threads)
        .innerJoin(schema.topics, eq(schema.threads.topicId, schema.topics.id))
        .innerJoin(schema.channels, eq(schema.topics.channelId, schema.channels.id))
        .innerJoin(schema.projects, eq(schema.channels.projectId, schema.projects.id))
        .where(and(eq(schema.threads.workspaceId, workspaceId), eq(schema.threads.status, 'archived'), isNull(schema.threads.deletedAt)))
        .orderBy(asc(schema.threads.updatedAt)),
    ]);

    const items: ArchivedScopeItem[] = [
      ...projects.map((p) => ({ kind: 'project' as const, id: p.id, name: p.name, parentPath: [], archivedAt: p.updatedAt.toISOString() })),
      ...channels.map((c) => ({ kind: 'channel' as const, id: c.id, name: c.name, parentPath: [c.projectName], archivedAt: c.updatedAt.toISOString() })),
      ...topics.map((t) => ({ kind: 'topic' as const, id: t.id, name: t.name, parentPath: [t.projectName, t.channelName], archivedAt: t.updatedAt.toISOString() })),
      ...threads.map((t) => ({ kind: 'thread' as const, id: t.id, name: t.name, parentPath: [t.projectName, t.channelName, t.topicName], archivedAt: t.updatedAt.toISOString() })),
    ];
    return { items };
  }
}
