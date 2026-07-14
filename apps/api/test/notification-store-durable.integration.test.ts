import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import webPush from 'web-push';
import { and, eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@consulting/db-schema';
import { NotificationStore } from '../src/chat/notification.store.js';
import { PushService } from '../src/chat/push.service.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

d('durable notification fan-out', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const ownerId = randomUUID();
  const memberId = randomUUID();
  const workspaceId = randomUUID();
  const subscriptionIds = [randomUUID(), randomUUID()];

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    db = drizzle(pool, { schema });
    await db.insert(schema.users).values([
      { id: ownerId, email: `${ownerId}@example.com`, displayName: 'owner' },
      { id: memberId, email: `${memberId}@example.com`, displayName: 'member' },
    ]);
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      name: 'notification workspace',
      slug: `notification-${workspaceId}`,
      ownerUserId: ownerId,
    });
    await db.insert(schema.memberships).values([
      { workspaceId, userId: ownerId, scopeType: 'workspace', scopeId: workspaceId, role: 'owner' },
      { workspaceId, userId: memberId, scopeType: 'workspace', scopeId: workspaceId, role: 'viewer' },
    ]);
    await db.insert(schema.pushSubscriptions).values(subscriptionIds.map((id, index) => ({
      id,
      userId: memberId,
      endpoint: `https://push.example.test/${index}`,
      p256dh: `p256dh-${index}`,
      auth: `auth-${index}`,
    })));
  });

  afterAll(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
    await db.delete(schema.users).where(eq(schema.users.id, memberId));
    await pool.end();
  });

  it('deduplicates feed rows and the transactional push outbox on replay', async () => {
    const store = new NotificationStore(db as never);
    const input = {
      workspaceId,
      excludeUserId: ownerId,
      dedupKey: 'chat-settlement:settlement-1:assistant-reply',
      type: 'assistant_reply' as const,
      title: '지구의 새 답변',
      body: '검증된 알림',
      refType: 'workspace' as const,
      refId: workspaceId,
    };

    expect(await db.transaction((tx) => store.notifyWorkspace(input, tx as never))).toBe(1);
    expect(await db.transaction((tx) => store.notifyWorkspace(input, tx as never))).toBe(0);

    const feed = await db
      .select()
      .from(schema.notifications)
      .where(and(
        eq(schema.notifications.workspaceId, workspaceId),
        eq(schema.notifications.dedupKey, input.dedupKey),
      ));
    const outbox = await db
      .select()
      .from(schema.outboxEvents)
      .where(and(
        eq(schema.outboxEvents.workspaceId, workspaceId),
        eq(schema.outboxEvents.eventType, 'NotificationPushRequested'),
      ));
    expect(feed).toHaveLength(1);
    expect(outbox).toHaveLength(2);
    expect(outbox.map((event) => (event.payload as { subscriptionId: string }).subscriptionId).sort()).toEqual(
      [...subscriptionIds].sort(),
    );
    expect(outbox.every((event) => (
      event.payload as { recipientUserId?: string }
    ).recipientUserId === memberId)).toBe(true);
  });

  it('rolls back the feed when default-path push outbox insertion fails', async () => {
    const store = new NotificationStore(db as never);
    const dedupKey = 'chat-settlement:default-transaction-rollback:assistant-reply';
    await pool.query(`
      CREATE OR REPLACE FUNCTION cw_test_reject_notification_outbox()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.payload ->> 'tag' = '${dedupKey}' THEN
          RAISE EXCEPTION 'forced notification outbox failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER cw_test_reject_notification_outbox_trigger
      BEFORE INSERT ON outbox_events
      FOR EACH ROW EXECUTE FUNCTION cw_test_reject_notification_outbox();
    `);

    try {
      await expect(store.notifyWorkspace({
        workspaceId,
        excludeUserId: ownerId,
        dedupKey,
        type: 'assistant_reply',
        title: 'default rollback',
        body: 'default rollback body',
        refType: 'workspace',
        refId: workspaceId,
      })).rejects.toThrow();
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS cw_test_reject_notification_outbox_trigger ON outbox_events;
        DROP FUNCTION IF EXISTS cw_test_reject_notification_outbox();
      `);
    }

    const feed = await db
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .where(and(
        eq(schema.notifications.workspaceId, workspaceId),
        eq(schema.notifications.dedupKey, dedupKey),
      ));
    expect(feed).toHaveLength(0);
  });

  it('rolls back both feed and push intent when the caller transaction fails', async () => {
    const store = new NotificationStore(db as never);
    const dedupKey = 'chat-settlement:settlement-rollback:assistant-reply';
    await expect(db.transaction(async (tx) => {
      await store.notifyWorkspace({
        workspaceId,
        excludeUserId: ownerId,
        dedupKey,
        type: 'assistant_reply',
        title: 'rollback',
        body: 'rollback body',
        refType: 'workspace',
        refId: workspaceId,
      }, tx as never);
      throw new Error('force rollback');
    })).rejects.toThrow('force rollback');

    const feed = await db
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .where(and(
        eq(schema.notifications.workspaceId, workspaceId),
        eq(schema.notifications.dedupKey, dedupKey),
      ));
    const pushEvents = await db
      .select({ payload: schema.outboxEvents.payload })
      .from(schema.outboxEvents)
      .where(and(
        eq(schema.outboxEvents.workspaceId, workspaceId),
        eq(schema.outboxEvents.eventType, 'NotificationPushRequested'),
      ));
    expect(feed).toHaveLength(0);
    expect(pushEvents.filter((event) => (
      event.payload as { tag?: unknown }
    ).tag === dedupKey)).toHaveLength(0);
  });

  it('rejects cross-user endpoint rebinding and preserves the original owner', async () => {
    const service = new PushService(db, {
      APP_ENV: 'test',
      APP_PUBLIC_URL: 'http://localhost:3000',
      PORT: 3000,
      DATABASE_URL: databaseUrl!,
      REDIS_URL: 'redis://localhost:6379',
      JWT_ACCESS_SECRET: 'x'.repeat(16),
      JWT_REFRESH_SECRET: 'y'.repeat(16),
      HERMES_API_BASE_URL: 'http://localhost:8642',
      HERMES_API_KEY: 'test',
      CONSULTING_DEFAULT_TEMPLATE_ENABLED: true,
      VOYAGE_MULTIMODAL_ENABLED: false,
      VOYAGE_API_BASE_URL: 'https://api.voyageai.com',
      VOYAGE_MULTIMODAL_MODEL: 'voyage-multimodal-3.5',
      VERIFIER_LLM_ENABLED: false,
      VERIFIER_LLM_TIMEOUT_MS: 30_000,
      ARTIFACT_RED_TEAM_MODE: 'warning',
      ARTIFACT_RED_TEAM_TIMEOUT_MS: 45_000,
      REPORT_WORKFLOW_SHADOW_MODE: 'off',
      VAPID_SUBJECT: 'mailto:test@example.com',
    });
    const endpoint = 'https://push.example.test/0';

    await expect(service.subscribe(ownerId, {
      endpoint,
      p256dh: 'attacker-p256dh',
      auth: 'attacker-auth',
    })).rejects.toThrow(/another user/i);

    const [row] = await db
      .select()
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.endpoint, endpoint));
    expect(row).toMatchObject({
      id: subscriptionIds[0],
      userId: memberId,
      p256dh: 'p256dh-0',
      auth: 'auth-0',
    });
  });

  it('does not deliver an old outbox event after a subscription is rebound to another user', async () => {
    const service = new PushService(db as never, {
      VAPID_SUBJECT: 'mailto:test@example.com',
    } as never);
    Object.assign(service as unknown as Record<string, unknown>, { enabled: true });
    const send = vi.spyOn(webPush, 'sendNotification').mockResolvedValue({} as never);
    const payload = { title: 'tenant fence', body: 'private', url: '/', tag: 'tenant-fence' };

    await service.sendToSubscription(subscriptionIds[0]!, ownerId, payload);
    expect(send).not.toHaveBeenCalled();
    await service.sendToSubscription(subscriptionIds[0]!, memberId, payload);
    expect(send).toHaveBeenCalledOnce();
    send.mockRestore();
  });
});
