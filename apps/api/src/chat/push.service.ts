import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import webPush from 'web-push';
import { schema } from '@consulting/db-schema';
import { and, eq, inArray } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { ENV_TOKEN } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';

/**
 * Web Push sender (2026-07-06). Optional layer on top of the notification
 * feed: NotificationStore.notifyWorkspace() fans out DB rows (source of
 * truth); this service additionally pushes to any browser subscriptions the
 * recipients registered. When VAPID keys are absent it degrades to a no-op —
 * the in-app bell remains fully functional.
 *
 * Failure policy: notification creation is isolated by a transactional outbox.
 * 404/410 responses prune dead subscriptions; transient errors throw so the
 * dedicated BullMQ worker retries without rolling back the notification feed.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly enabled: boolean;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {
    this.enabled = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
    if (this.enabled) {
      webPush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
    } else {
      this.logger.log('Web Push disabled (VAPID keys not configured) — in-app bell only');
    }
  }

  publicKey(): string | null {
    return this.enabled ? (this.env.VAPID_PUBLIC_KEY ?? null) : null;
  }

  async subscribe(userId: string, input: { endpoint: string; p256dh: string; auth: string; userAgent?: string | undefined }): Promise<void> {
    const inserted = await this.db
      .insert(schema.pushSubscriptions)
      .values({
        userId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
      })
      .onConflictDoNothing({ target: schema.pushSubscriptions.endpoint })
      .returning({ id: schema.pushSubscriptions.id });
    if (inserted.length > 0) return;

    const refreshed = await this.db
      .update(schema.pushSubscriptions)
      .set({
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.pushSubscriptions.endpoint, input.endpoint),
        eq(schema.pushSubscriptions.userId, userId),
      ))
      .returning({ id: schema.pushSubscriptions.id });
    if (refreshed.length > 0) return;

    throw new ConflictException('push subscription endpoint belongs to another user');
  }

  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    // Scoped to the caller — one user cannot delete another's subscription.
    const rows = await this.db
      .select({ id: schema.pushSubscriptions.id, userId: schema.pushSubscriptions.userId })
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.endpoint, endpoint));
    const own = rows.filter((r) => r.userId === userId).map((r) => r.id);
    if (own.length > 0) {
      await this.db.delete(schema.pushSubscriptions).where(inArray(schema.pushSubscriptions.id, own));
    }
  }

  /** Push to one durable subscription; transient delivery failures throw for that subscription's queue retry. */
  async sendToSubscription(
    subscriptionId: string,
    expectedUserId: string,
    payload: { title: string; body: string; url?: string; tag?: string },
  ): Promise<void> {
    if (!this.enabled) return;
    const [subscription] = await this.db
      .select()
      .from(schema.pushSubscriptions)
      .where(and(
        eq(schema.pushSubscriptions.id, subscriptionId),
        eq(schema.pushSubscriptions.userId, expectedUserId),
      ))
      .limit(1);
    if (!subscription) return;

    try {
      await webPush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        JSON.stringify(payload),
        { TTL: 3600 },
      );
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await this.db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, subscription.id));
        this.logger.log('pruned 1 dead push subscription');
        return;
      }
      this.logger.warn(`push send failed (status=${status ?? 'unknown'})`);
      throw new Error('push delivery failed for subscription', { cause: error });
    }
  }
}
