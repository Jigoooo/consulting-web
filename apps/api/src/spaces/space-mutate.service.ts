import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type {
  ThreadDetailResponse,
  ListMembersResponse,
} from '@consulting/contracts';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

type NodeKind = 'project' | 'channel' | 'topic';
type ScopeKind = NodeKind | 'thread';
type LifecycleStatus = (typeof schema.projects.$inferSelect)['status'];
type LifecycleOperation = 'archive' | 'soft_delete';
type LifecycleSnapshot = {
  status: LifecycleStatus;
  deletedAt: Date | null;
  version: number;
};
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type LifecycleEvent = {
  eventId: string;
  rootScopeType: ScopeKind;
  rootScopeId: string;
  now: Date;
};
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
    const eventId = randomUUID();
    await this.db.transaction((tx) => this.archiveNodeWithin(tx, kind, id, {
      eventId,
      rootScopeType: kind,
      rootScopeId: id,
      now,
    }));
  }

  async archiveThread(id: string, at = new Date()): Promise<void> {
    const eventId = randomUUID();
    await this.db.transaction((tx) => this.archiveThreadWithin(tx, id, {
      eventId,
      rootScopeType: 'thread',
      rootScopeId: id,
      now: at,
    }));
  }

  private async archiveNodeWithin(
    tx: Tx,
    kind: NodeKind,
    id: string,
    event: LifecycleEvent,
  ): Promise<void> {
    const t = tables[kind]();
    const [row] = await tx
      .select({ status: t.status, deletedAt: t.deletedAt })
      .from(t)
      .where(eq(t.id, id))
      .for('update')
      .limit(1);
    if (!row || row.status !== 'active' || row.deletedAt !== null) return;

    await this.recordTransition(tx, event, kind, id, row.status, row.deletedAt, 'archive');
    await tx.update(t).set({
      status: 'archived',
      deletedAt: null,
      updatedAt: event.now,
      version: sql`${t.version} + 1`,
    }).where(eq(t.id, id));

    if (kind === 'project') {
      const channels = await tx.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.projectId, id));
      for (const channel of channels) await this.archiveNodeWithin(tx, 'channel', channel.id, event);
    } else if (kind === 'channel') {
      const topics = await tx.select({ id: schema.topics.id }).from(schema.topics).where(eq(schema.topics.channelId, id));
      for (const topic of topics) await this.archiveNodeWithin(tx, 'topic', topic.id, event);
    } else {
      const threads = await tx.select({ id: schema.threads.id }).from(schema.threads).where(eq(schema.threads.topicId, id));
      for (const thread of threads) await this.archiveThreadWithin(tx, thread.id, event);
    }
  }

  private async archiveThreadWithin(tx: Tx, id: string, event: LifecycleEvent): Promise<void> {
    const [row] = await tx
      .select({ status: schema.threads.status, deletedAt: schema.threads.deletedAt })
      .from(schema.threads)
      .where(eq(schema.threads.id, id))
      .for('update')
      .limit(1);
    if (!row || row.status !== 'active' || row.deletedAt !== null) return;

    await this.recordTransition(tx, event, 'thread', id, row.status, row.deletedAt, 'archive');
    await tx.update(schema.threads)
      .set({
        status: 'archived',
        deletedAt: null,
        updatedAt: event.now,
        version: sql`${schema.threads.version} + 1`,
      })
      .where(eq(schema.threads.id, id));
  }

  /** Restore archived/deleted_soft scopes to active and revive graph rows whose opposite endpoint is live. */
  async restoreNode(kind: NodeKind, id: string): Promise<void> {
    const observed = await this.observeScope(kind, id);
    if (!observed) return;
    const now = new Date();
    await this.db.transaction(async (tx) => {
      const current = await this.lockScope(tx, kind, id);
      if (!current || current.version !== observed.version) return;
      await this.requireRestoreParentActive(tx, kind, id);
      const operation = this.restoreOperation(current);
      if (!operation) return;
      if (await this.restoreLatestTransition(tx, kind, id, operation, now)) return;
      await this.restoreScopeState(tx, kind, id, 'active', null, now);
    });
  }

  async restoreThread(id: string, at = new Date()): Promise<void> {
    const observed = await this.observeScope('thread', id);
    if (!observed) return;
    await this.db.transaction(async (tx) => {
      const current = await this.lockScope(tx, 'thread', id);
      if (!current || current.version !== observed.version) return;
      await this.requireRestoreParentActive(tx, 'thread', id);
      const operation = this.restoreOperation(current);
      if (!operation) return;
      if (await this.restoreLatestTransition(tx, 'thread', id, operation, at)) return;
      await this.restoreScopeState(tx, 'thread', id, 'active', null, at);
    });
  }

  private async observeScope(kind: ScopeKind, id: string): Promise<LifecycleSnapshot | null> {
    if (kind === 'thread') {
      const [row] = await this.db
        .select({
          status: schema.threads.status,
          deletedAt: schema.threads.deletedAt,
          version: schema.threads.version,
        })
        .from(schema.threads)
        .where(eq(schema.threads.id, id))
        .limit(1);
      return row ?? null;
    }
    const t = tables[kind]();
    const [row] = await this.db
      .select({ status: t.status, deletedAt: t.deletedAt, version: t.version })
      .from(t)
      .where(eq(t.id, id))
      .limit(1);
    return row ?? null;
  }

  private async lockScope(tx: Tx, kind: ScopeKind, id: string): Promise<LifecycleSnapshot | null> {
    if (kind === 'thread') {
      const [row] = await tx
        .select({
          status: schema.threads.status,
          deletedAt: schema.threads.deletedAt,
          version: schema.threads.version,
        })
        .from(schema.threads)
        .where(eq(schema.threads.id, id))
        .for('update')
        .limit(1);
      return row ?? null;
    }
    const t = tables[kind]();
    const [row] = await tx
      .select({ status: t.status, deletedAt: t.deletedAt, version: t.version })
      .from(t)
      .where(eq(t.id, id))
      .for('update')
      .limit(1);
    return row ?? null;
  }

  private restoreOperation(snapshot: LifecycleSnapshot): LifecycleOperation | null {
    if (snapshot.status === 'deleted_soft' || snapshot.deletedAt !== null) return 'soft_delete';
    if (snapshot.status === 'archived') return 'archive';
    return null;
  }

  private async requireRestoreParentActive(tx: Tx, kind: ScopeKind, id: string): Promise<void> {
    if (kind === 'project') return;

    if (kind === 'channel') {
      const [row] = await tx
        .select({ status: schema.projects.status, deletedAt: schema.projects.deletedAt })
        .from(schema.channels)
        .innerJoin(schema.projects, eq(schema.channels.projectId, schema.projects.id))
        .where(eq(schema.channels.id, id))
        .limit(1);
      if (!row || row.status !== 'active' || row.deletedAt !== null) throw new RestoreParentNotActiveError();
      return;
    }

    if (kind === 'topic') {
      const [row] = await tx
        .select({ status: schema.channels.status, deletedAt: schema.channels.deletedAt })
        .from(schema.topics)
        .innerJoin(schema.channels, eq(schema.topics.channelId, schema.channels.id))
        .where(eq(schema.topics.id, id))
        .limit(1);
      if (!row || row.status !== 'active' || row.deletedAt !== null) throw new RestoreParentNotActiveError();
      return;
    }

    const [row] = await tx
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
    const eventId = randomUUID();
    await this.db.transaction((tx) => this.softDeleteNodeWithin(tx, kind, id, {
      eventId,
      rootScopeType: kind,
      rootScopeId: id,
      now,
    }));
  }

  async softDeleteThread(id: string, at = new Date()): Promise<void> {
    const eventId = randomUUID();
    await this.db.transaction((tx) => this.softDeleteThreadWithin(tx, id, {
      eventId,
      rootScopeType: 'thread',
      rootScopeId: id,
      now: at,
    }));
  }

  private async softDeleteNodeWithin(
    tx: Tx,
    kind: NodeKind,
    id: string,
    event: LifecycleEvent,
  ): Promise<void> {
    const t = tables[kind]();
    const [row] = await tx
      .select({ status: t.status, deletedAt: t.deletedAt })
      .from(t)
      .where(eq(t.id, id))
      .for('update')
      .limit(1);
    if (!row || row.status === 'deleted_soft' || row.deletedAt !== null) return;

    await this.recordTransition(tx, event, kind, id, row.status, row.deletedAt, 'soft_delete');
    await tx.update(t)
      .set({
        status: 'deleted_soft',
        deletedAt: event.now,
        updatedAt: event.now,
        version: sql`${t.version} + 1`,
      })
      .where(eq(t.id, id));
    await this.tombstoneScopeGraph(tx, kind, id, event.now);

    if (kind === 'project') {
      const channels = await tx.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.projectId, id));
      for (const channel of channels) await this.softDeleteNodeWithin(tx, 'channel', channel.id, event);
    } else if (kind === 'channel') {
      const topics = await tx.select({ id: schema.topics.id }).from(schema.topics).where(eq(schema.topics.channelId, id));
      for (const topic of topics) await this.softDeleteNodeWithin(tx, 'topic', topic.id, event);
    } else {
      const threads = await tx.select({ id: schema.threads.id }).from(schema.threads).where(eq(schema.threads.topicId, id));
      for (const thread of threads) await this.softDeleteThreadWithin(tx, thread.id, event);
    }
  }

  private async softDeleteThreadWithin(tx: Tx, id: string, event: LifecycleEvent): Promise<void> {
    const [row] = await tx
      .select({ status: schema.threads.status, deletedAt: schema.threads.deletedAt })
      .from(schema.threads)
      .where(eq(schema.threads.id, id))
      .for('update')
      .limit(1);
    if (!row || row.status === 'deleted_soft' || row.deletedAt !== null) return;

    await this.recordTransition(tx, event, 'thread', id, row.status, row.deletedAt, 'soft_delete');
    await tx.update(schema.threads)
      .set({
        status: 'deleted_soft',
        deletedAt: event.now,
        updatedAt: event.now,
        version: sql`${schema.threads.version} + 1`,
      })
      .where(eq(schema.threads.id, id));
    await this.tombstoneScopeGraph(tx, 'thread', id, event.now);
  }

  private async recordTransition(
    tx: Tx,
    event: LifecycleEvent,
    scopeType: ScopeKind,
    scopeId: string,
    previousStatus: LifecycleStatus,
    previousDeletedAt: Date | null,
    operation: LifecycleOperation,
  ): Promise<void> {
    await tx.insert(schema.scopeLifecycleTransitions).values({
      eventId: event.eventId,
      rootScopeType: event.rootScopeType,
      rootScopeId: event.rootScopeId,
      operation,
      scopeType,
      scopeId,
      previousStatus,
      previousDeletedAt,
      createdAt: event.now,
      updatedAt: event.now,
    });
  }

  private async restoreLatestTransition(
    tx: Tx,
    rootScopeType: ScopeKind,
    rootScopeId: string,
    operation: LifecycleOperation,
    at: Date,
  ): Promise<boolean> {
    const [pending] = await tx
      .select({ eventId: schema.scopeLifecycleTransitions.eventId })
      .from(schema.scopeLifecycleTransitions)
      .where(and(
        eq(schema.scopeLifecycleTransitions.rootScopeType, rootScopeType),
        eq(schema.scopeLifecycleTransitions.rootScopeId, rootScopeId),
        eq(schema.scopeLifecycleTransitions.operation, operation),
        isNull(schema.scopeLifecycleTransitions.restoredAt),
      ))
      .orderBy(desc(schema.scopeLifecycleTransitions.createdAt))
      .for('update')
      .limit(1);
    if (!pending) return false;

    const rows = await tx
      .select({
        scopeType: schema.scopeLifecycleTransitions.scopeType,
        scopeId: schema.scopeLifecycleTransitions.scopeId,
        previousStatus: schema.scopeLifecycleTransitions.previousStatus,
        previousDeletedAt: schema.scopeLifecycleTransitions.previousDeletedAt,
      })
      .from(schema.scopeLifecycleTransitions)
      .where(eq(schema.scopeLifecycleTransitions.eventId, pending.eventId));
    const rank: Record<ScopeKind, number> = { project: 0, channel: 1, topic: 2, thread: 3 };
    rows.sort((left, right) => {
      const leftRank = left.scopeType === 'workspace' ? 99 : rank[left.scopeType];
      const rightRank = right.scopeType === 'workspace' ? 99 : rank[right.scopeType];
      return leftRank - rightRank;
    });

    for (const row of rows) {
      if (row.scopeType === 'workspace') throw new Error('invalid workspace lifecycle transition');
      const current = await this.lockScope(tx, row.scopeType, row.scopeId);
      if (!current || this.restoreOperation(current) !== operation) continue;
      await this.restoreScopeState(
        tx,
        row.scopeType,
        row.scopeId,
        row.previousStatus,
        row.previousDeletedAt,
        at,
      );
    }
    await tx.update(schema.scopeLifecycleTransitions)
      .set({ restoredAt: at, updatedAt: at })
      .where(eq(schema.scopeLifecycleTransitions.eventId, pending.eventId));
    return true;
  }

  private async restoreScopeState(
    tx: Tx,
    scopeType: ScopeKind,
    scopeId: string,
    status: LifecycleStatus,
    deletedAt: Date | null,
    at: Date,
  ): Promise<void> {
    if (scopeType === 'thread') {
      await tx.update(schema.threads)
        .set({
          status,
          deletedAt,
          updatedAt: at,
          version: sql`${schema.threads.version} + 1`,
        })
        .where(eq(schema.threads.id, scopeId));
    } else {
      const t = tables[scopeType]();
      await tx.update(t)
        .set({ status, deletedAt, updatedAt: at, version: sql`${t.version} + 1` })
        .where(eq(t.id, scopeId));
    }

    if (status === 'deleted_soft' || deletedAt !== null) {
      await this.tombstoneScopeGraph(tx, scopeType, scopeId, at);
    } else {
      await this.restoreScopeGraph(tx, scopeType, scopeId, at);
    }
  }

  private async tombstoneScopeGraph(tx: Tx, scopeType: ScopeKind, scopeId: string, at: Date): Promise<void> {
    await tx
      .update(schema.contextEdges)
      .set({ deletedAt: at, updatedAt: at })
      .where(or(eq(schema.contextEdges.fromScopeId, scopeId), eq(schema.contextEdges.toScopeId, scopeId)));
    await tx
      .update(schema.scopeTags)
      .set({ deletedAt: at, updatedAt: at })
      .where(and(eq(schema.scopeTags.scopeType, scopeType), eq(schema.scopeTags.scopeId, scopeId)));
  }

  private async restoreScopeGraph(tx: Tx, scopeType: ScopeKind, scopeId: string, at: Date): Promise<void> {
    await tx
      .update(schema.scopeTags)
      .set({ deletedAt: null, updatedAt: at })
      .where(and(eq(schema.scopeTags.scopeType, scopeType), eq(schema.scopeTags.scopeId, scopeId)));

    // Revive only edges whose opposite endpoint is still referenceable (active/archived).
    await tx.execute(sql`
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
