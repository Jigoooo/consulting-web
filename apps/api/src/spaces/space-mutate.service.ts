import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type {
  ThreadDetailResponse,
  ListMembersResponse,
} from '@consulting/contracts';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

type NodeKind = 'project' | 'channel' | 'topic';
const tables = {
  project: () => schema.projects,
  channel: () => schema.channels,
  topic: () => schema.topics,
} as const;

export class RestoreParentNotActiveError extends Error {
  constructor() {
    super('parent scope must be active before restoring this child scope');
  }
}

/**
 * Write-side mutations for space nodes (N-4) + single-thread read (N-6) +
 * workspace members (N-7). Access checks stay in the controller.
 */
@Injectable()
export class SpaceMutateService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** workspaceId of a node, or null if missing/soft-deleted. */
  async nodeWorkspace(kind: NodeKind, id: string): Promise<string | null> {
    const t = tables[kind]();
    const [row] = await this.db
      .select({ workspaceId: t.workspaceId })
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    return row?.workspaceId ?? null;
  }

  async threadWorkspace(id: string): Promise<string | null> {
    const [row] = await this.db
      .select({ workspaceId: schema.threads.workspaceId })
      .from(schema.threads)
      .where(and(eq(schema.threads.id, id), isNull(schema.threads.deletedAt)))
      .limit(1);
    return row?.workspaceId ?? null;
  }

  async renameNode(kind: NodeKind, id: string, name: string): Promise<void> {
    const t = tables[kind]();
    await this.db.update(t).set({ name, updatedAt: new Date() }).where(eq(t.id, id));
  }

  async renameThread(id: string, title: string): Promise<void> {
    await this.db
      .update(schema.threads)
      .set({ title, updatedAt: new Date() })
      .where(eq(schema.threads.id, id));
  }

  /** Archive keeps knowledge referenceable: status changes, deleted_at/graph tombstones stay clear. */
  async archiveNode(kind: NodeKind, id: string): Promise<void> {
    const now = new Date();
    const t = tables[kind]();
    await this.db.update(t).set({ status: 'archived', deletedAt: null, updatedAt: now }).where(eq(t.id, id));
    if (kind === 'project') {
      const channels = await this.db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.projectId, id));
      for (const c of channels) await this.archiveNode('channel', c.id);
    } else if (kind === 'channel') {
      const topics = await this.db.select({ id: schema.topics.id }).from(schema.topics).where(eq(schema.topics.channelId, id));
      for (const t2 of topics) await this.archiveNode('topic', t2.id);
    } else {
      const threads = await this.db.select({ id: schema.threads.id }).from(schema.threads).where(eq(schema.threads.topicId, id));
      for (const thread of threads) await this.archiveThread(thread.id, now);
    }
  }

  async archiveThread(id: string, at = new Date()): Promise<void> {
    await this.db.update(schema.threads).set({ status: 'archived', deletedAt: null, updatedAt: at }).where(eq(schema.threads.id, id));
  }

  /** Restore archived/deleted_soft scopes to active and revive graph rows whose opposite endpoint is live. */
  async restoreNode(kind: NodeKind, id: string): Promise<void> {
    await this.requireRestoreParentActive(kind, id);
    const now = new Date();
    const t = tables[kind]();
    await this.db.update(t).set({ status: 'active', deletedAt: null, updatedAt: now }).where(eq(t.id, id));
    await this.restoreScopeGraph(kind, id, now);
    if (kind === 'project') {
      const channels = await this.db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.projectId, id));
      for (const c of channels) await this.restoreNode('channel', c.id);
    } else if (kind === 'channel') {
      const topics = await this.db.select({ id: schema.topics.id }).from(schema.topics).where(eq(schema.topics.channelId, id));
      for (const t2 of topics) await this.restoreNode('topic', t2.id);
    } else {
      const threads = await this.db.select({ id: schema.threads.id }).from(schema.threads).where(eq(schema.threads.topicId, id));
      for (const thread of threads) await this.restoreThread(thread.id, now);
    }
  }

  async restoreThread(id: string, at = new Date()): Promise<void> {
    await this.requireRestoreParentActive('thread', id);
    await this.db.update(schema.threads).set({ status: 'active', deletedAt: null, updatedAt: at }).where(eq(schema.threads.id, id));
    await this.restoreScopeGraph('thread', id, at);
  }

  private async requireRestoreParentActive(kind: NodeKind | 'thread', id: string): Promise<void> {
    if (kind === 'project') return;

    if (kind === 'channel') {
      const [row] = await this.db
        .select({ status: schema.projects.status, deletedAt: schema.projects.deletedAt })
        .from(schema.channels)
        .innerJoin(schema.projects, eq(schema.channels.projectId, schema.projects.id))
        .where(eq(schema.channels.id, id))
        .limit(1);
      if (!row || row.status !== 'active' || row.deletedAt !== null) throw new RestoreParentNotActiveError();
      return;
    }

    if (kind === 'topic') {
      const [row] = await this.db
        .select({ status: schema.channels.status, deletedAt: schema.channels.deletedAt })
        .from(schema.topics)
        .innerJoin(schema.channels, eq(schema.topics.channelId, schema.channels.id))
        .where(eq(schema.topics.id, id))
        .limit(1);
      if (!row || row.status !== 'active' || row.deletedAt !== null) throw new RestoreParentNotActiveError();
      return;
    }

    const [row] = await this.db
      .select({ status: schema.topics.status, deletedAt: schema.topics.deletedAt })
      .from(schema.threads)
      .innerJoin(schema.topics, eq(schema.threads.topicId, schema.topics.id))
      .where(eq(schema.threads.id, id))
      .limit(1);
    if (!row || row.status !== 'active' || row.deletedAt !== null) throw new RestoreParentNotActiveError();
  }

  /** Soft delete — mark scope as deleted_soft, cascade descendants, and tombstone graph references. */
  async softDeleteNode(kind: NodeKind, id: string): Promise<void> {
    const now = new Date();
    const t = tables[kind]();
    await this.db.update(t).set({ status: 'deleted_soft', deletedAt: now, updatedAt: now }).where(eq(t.id, id));
    await this.tombstoneScopeGraph(kind, id, now);

    // Cascade soft-delete downwards so orphaned children never resurface.
    if (kind === 'project') {
      const channels = await this.db
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(eq(schema.channels.projectId, id));
      for (const c of channels) await this.softDeleteNode('channel', c.id);
    } else if (kind === 'channel') {
      const topics = await this.db
        .select({ id: schema.topics.id })
        .from(schema.topics)
        .where(eq(schema.topics.channelId, id));
      for (const t2 of topics) await this.softDeleteNode('topic', t2.id);
    } else {
      const threads = await this.db
        .select({ id: schema.threads.id })
        .from(schema.threads)
        .where(eq(schema.threads.topicId, id));
      for (const thread of threads) await this.softDeleteThread(thread.id, now);
    }
  }

  async softDeleteThread(id: string, at = new Date()): Promise<void> {
    await this.db
      .update(schema.threads)
      .set({ status: 'deleted_soft', deletedAt: at, updatedAt: at })
      .where(eq(schema.threads.id, id));
    await this.tombstoneScopeGraph('thread', id, at);
  }

  private async tombstoneScopeGraph(scopeType: NodeKind | 'thread', scopeId: string, at: Date): Promise<void> {
    await this.db
      .update(schema.contextEdges)
      .set({ deletedAt: at, updatedAt: at })
      .where(or(eq(schema.contextEdges.fromScopeId, scopeId), eq(schema.contextEdges.toScopeId, scopeId)));
    await this.db
      .update(schema.scopeTags)
      .set({ deletedAt: at, updatedAt: at })
      .where(and(eq(schema.scopeTags.scopeType, scopeType), eq(schema.scopeTags.scopeId, scopeId)));
  }

  private async restoreScopeGraph(scopeType: NodeKind | 'thread', scopeId: string, at: Date): Promise<void> {
    await this.db
      .update(schema.scopeTags)
      .set({ deletedAt: null, updatedAt: at })
      .where(and(eq(schema.scopeTags.scopeType, scopeType), eq(schema.scopeTags.scopeId, scopeId)));

    // Revive only edges whose opposite endpoint is still referenceable (active/archived).
    await this.db.execute(sql`
      update context_edges e
      set deleted_at = null, updated_at = ${at}
      where (
        e.from_scope_type = ${scopeType}::scope_type
        and e.from_scope_id = ${scopeId}::uuid
        and (
          (e.to_scope_type = 'project' and exists (select 1 from projects p where p.id = e.to_scope_id and p.status <> 'deleted_soft' and p.deleted_at is null))
          or (e.to_scope_type = 'channel' and exists (select 1 from channels c where c.id = e.to_scope_id and c.status <> 'deleted_soft' and c.deleted_at is null))
          or (e.to_scope_type = 'topic' and exists (select 1 from topics t where t.id = e.to_scope_id and t.status <> 'deleted_soft' and t.deleted_at is null))
          or (e.to_scope_type = 'thread' and exists (select 1 from threads th where th.id = e.to_scope_id and th.status <> 'deleted_soft' and th.deleted_at is null))
        )
      ) or (
        e.to_scope_type = ${scopeType}::scope_type
        and e.to_scope_id = ${scopeId}::uuid
        and (
          (e.from_scope_type = 'project' and exists (select 1 from projects p where p.id = e.from_scope_id and p.status <> 'deleted_soft' and p.deleted_at is null))
          or (e.from_scope_type = 'channel' and exists (select 1 from channels c where c.id = e.from_scope_id and c.status <> 'deleted_soft' and c.deleted_at is null))
          or (e.from_scope_type = 'topic' and exists (select 1 from topics t where t.id = e.from_scope_id and t.status <> 'deleted_soft' and t.deleted_at is null))
          or (e.from_scope_type = 'thread' and exists (select 1 from threads th where th.id = e.from_scope_id and th.status <> 'deleted_soft' and th.deleted_at is null))
        )
      )
    `);
  }

  async threadDetail(id: string): Promise<ThreadDetailResponse | null> {
    const [row] = await this.db
      .select({
        id: schema.threads.id,
        title: schema.threads.title,
        topicId: schema.threads.topicId,
        topicName: schema.topics.name,
        channelId: schema.channels.id,
        channelName: schema.channels.name,
        projectId: schema.projects.id,
        projectName: schema.projects.name,
        createdAt: schema.threads.createdAt,
      })
      .from(schema.threads)
      .innerJoin(schema.topics, eq(schema.threads.topicId, schema.topics.id))
      .innerJoin(schema.channels, eq(schema.topics.channelId, schema.channels.id))
      .innerJoin(schema.projects, eq(schema.channels.projectId, schema.projects.id))
      .where(and(
        eq(schema.threads.id, id),
        eq(schema.threads.status, 'active'),
        eq(schema.topics.status, 'active'),
        eq(schema.channels.status, 'active'),
        eq(schema.projects.status, 'active'),
        isNull(schema.threads.deletedAt),
        isNull(schema.topics.deletedAt),
        isNull(schema.channels.deletedAt),
        isNull(schema.projects.deletedAt),
      ))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      topicId: row.topicId,
      topicName: row.topicName,
      channelId: row.channelId,
      channelName: row.channelName,
      projectId: row.projectId,
      projectName: row.projectName,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listMembers(workspaceId: string): Promise<ListMembersResponse> {
    const rows = await this.db
      .select({
        userId: schema.memberships.userId,
        displayName: schema.users.displayName,
        email: schema.users.email,
        role: schema.memberships.role,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
      .where(eq(schema.memberships.workspaceId, workspaceId));

    // One user can hold several scope memberships; show the strongest role.
    const order: Record<string, number> = { owner: 0, admin: 1, editor: 2, commenter: 3, viewer: 4 };
    const byUser = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const prev = byUser.get(r.userId);
      if (!prev || (order[r.role] ?? 99) < (order[prev.role] ?? 99)) byUser.set(r.userId, r);
    }
    return { members: [...byUser.values()] };
  }
}
