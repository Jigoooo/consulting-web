import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { ListNotificationsResponse, NotificationType } from '@consulting/contracts';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { NOTIFICATION_PUSH_REQUESTED_EVENT } from '../queues/outbox-routing.js';

/** Per-user notification feed (Phase 2-C). Fan-out on write: domain services
 * call notifyWorkspace() which inserts one row per recipient. Reads are a
 * simple per-user query — no joins at read time, cheap to poll.
 * 2026-07-06: additionally fans out via Web Push (best-effort, non-blocking). */
@Injectable()
export class NotificationStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Insert a notification for every workspace member except `excludeUserId`. */
  async notifyWorkspace(input: {
    workspaceId: string;
    excludeUserId?: string;
    dedupKey?: string;
    type: NotificationType;
    title: string;
    body: string;
    refType: 'thread' | 'artifact' | 'workspace';
    refId: string;
  }, db?: Db): Promise<number> {
    if (!db) {
      return this.db.transaction((tx) => this.notifyWorkspace(input, tx));
    }
    const members = await db
      .select({ userId: schema.memberships.userId })
      .from(schema.memberships)
      .where(eq(schema.memberships.workspaceId, input.workspaceId));

    const recipients = [...new Set(members.map((m) => m.userId))].filter(
      (id) => id !== input.excludeUserId,
    );
    if (recipients.length === 0) return 0;

    const dedupKey = input.dedupKey?.trim().slice(0, 200) || null;
    const inserted = await db.insert(schema.notifications).values(
      recipients.map((userId) => ({
        workspaceId: input.workspaceId,
        userId,
        type: input.type,
        title: input.title.slice(0, 200),
        body: input.body.slice(0, 500),
        refType: input.refType,
        refId: input.refId,
        dedupKey,
      })),
    ).onConflictDoNothing().returning({ userId: schema.notifications.userId });
    const insertedRecipients = inserted.map((row) => row.userId);
    if (insertedRecipients.length === 0) return 0;

    const url = input.refType === 'thread' ? `/th/${input.refId}` : '/';
    const subscriptions = await db
      .select({ id: schema.pushSubscriptions.id, userId: schema.pushSubscriptions.userId })
      .from(schema.pushSubscriptions)
      .where(inArray(schema.pushSubscriptions.userId, insertedRecipients));
    if (subscriptions.length > 0) {
      const eventIdentity = dedupKey
        ? createHash('sha256').update(`${input.workspaceId}:${dedupKey}`).digest('hex')
        : randomUUID();
      await db
        .insert(schema.outboxEvents)
        .values(subscriptions.map((subscription) => ({
          workspaceId: input.workspaceId,
          eventType: NOTIFICATION_PUSH_REQUESTED_EVENT,
          aggregateType: 'notification',
          aggregateId: input.refId,
          payload: {
            subscriptionId: subscription.id,
            recipientUserId: subscription.userId,
            title: input.title.slice(0, 200),
            body: input.body.slice(0, 500),
            url,
            tag: dedupKey ?? `${input.refType}:${input.refId}`,
          },
          status: 'pending' as const,
          idempotencyKey: `notification-push:${eventIdentity}:${subscription.id}`,
        })))
        .onConflictDoNothing({ target: schema.outboxEvents.idempotencyKey });
    }

    return insertedRecipients.length;
  }

  async listForUser(userId: string, limit = 50): Promise<ListNotificationsResponse> {
    const rows = await this.db
      .select({
        id: schema.notifications.id,
        type: schema.notifications.type,
        title: schema.notifications.title,
        body: schema.notifications.body,
        refType: schema.notifications.refType,
        refId: schema.notifications.refId,
        readAt: schema.notifications.readAt,
        createdAt: schema.notifications.createdAt,
      })
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userId))
      .orderBy(desc(schema.notifications.createdAt))
      .limit(limit);

    const [unread] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)));

    return {
      notifications: rows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        body: r.body,
        refType: r.refType as 'thread' | 'artifact' | 'workspace',
        refId: r.refId,
        readAt: r.readAt ? r.readAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      })),
      unreadCount: unread?.count ?? 0,
    };
  }

  /** Mark given ids (or ALL unread when ids omitted) as read. Scoped to the user. */
  async markRead(userId: string, ids?: string[]): Promise<void> {
    const base = and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt));
    const where = ids && ids.length > 0
      ? and(base, inArray(schema.notifications.id, ids))
      : base;
    await this.db.update(schema.notifications).set({ readAt: new Date() }).where(where);
  }
}
