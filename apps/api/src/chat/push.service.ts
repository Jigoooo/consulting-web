import { Inject, Injectable, Logger } from '@nestjs/common';
import webPush from 'web-push';
import { schema } from '@consulting/db-schema';
import { eq, inArray } from 'drizzle-orm';
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
 * Failure policy: push is best-effort. Errors are logged, never thrown into
 * the calling domain flow. 404/410 responses prune the dead subscription.
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
    await this.db
      .insert(schema.pushSubscriptions)
      .values({
        userId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
      })
      .onConflictDoUpdate({
        target: schema.pushSubscriptions.endpoint,
        set: { userId, p256dh: input.p256dh, auth: input.auth, updatedAt: new Date() },
      });
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

  /** Best-effort push to every subscription of the given users. Never throws. */
  async sendToUsers(
    userIds: string[],
    payload: { title: string; body: string; url?: string; tag?: string },
  ): Promise<void> {
    if (!this.enabled || userIds.length === 0) return;
    try {
      const subs = await this.db
        .select()
        .from(schema.pushSubscriptions)
        .where(inArray(schema.pushSubscriptions.userId, userIds));
      if (subs.length === 0) return;

      const body = JSON.stringify(payload);
      const dead: string[] = [];
      await Promise.allSettled(
        subs.map(async (sub) => {
          try {
            await webPush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              body,
              { TTL: 3600 },
            );
          } catch (err) {
            const status = (err as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
              dead.push(sub.id);
            } else {
              this.logger.warn(`push send failed (status=${status ?? 'unknown'})`);
            }
          }
        }),
      );
      if (dead.length > 0) {
        await this.db.delete(schema.pushSubscriptions).where(inArray(schema.pushSubscriptions.id, dead));
        this.logger.log(`pruned ${dead.length} dead push subscription(s)`);
      }
    } catch (err) {
      this.logger.warn(`push fan-out failed: ${(err as Error).message}`);
    }
  }
}
