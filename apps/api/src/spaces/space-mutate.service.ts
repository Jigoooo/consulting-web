import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq, isNull } from 'drizzle-orm';
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

  /** Soft delete — children stay in place but tree queries filter by parent's deletedAt cascade. */
  async softDeleteNode(kind: NodeKind, id: string): Promise<void> {
    const now = new Date();
    const t = tables[kind]();
    await this.db.update(t).set({ deletedAt: now, updatedAt: now }).where(eq(t.id, id));
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
      await this.db
        .update(schema.threads)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(schema.threads.topicId, id), isNull(schema.threads.deletedAt)));
    }
  }

  async softDeleteThread(id: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(schema.threads)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(schema.threads.id, id));
  }

  async threadDetail(id: string): Promise<ThreadDetailResponse | null> {
    const [row] = await this.db
      .select({
        id: schema.threads.id,
        title: schema.threads.title,
        topicId: schema.threads.topicId,
        createdAt: schema.threads.createdAt,
      })
      .from(schema.threads)
      .where(and(eq(schema.threads.id, id), isNull(schema.threads.deletedAt)))
      .limit(1);
    if (!row) return null;
    return { id: row.id, title: row.title, topicId: row.topicId, createdAt: row.createdAt.toISOString() };
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
