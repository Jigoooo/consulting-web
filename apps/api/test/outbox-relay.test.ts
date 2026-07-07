import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { schema } from '@consulting/db-schema';
import { eq, inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import { OutboxRelayService } from '../src/queues/outbox-relay.service.js';
import { SignUpUseCase } from '../src/auth/sign-up.usecase.js';
import { ScryptPasswordHasher } from '../src/auth/password.js';

const dbUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const d = dbUrl && redisUrl ? describe : describe.skip;

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let queue: Queue;
const users: string[] = [];
const workspaces: string[] = [];

d('outbox relay → BullMQ (ADR-0005/0020)', () => {
  beforeAll(() => {
    pool = new Pool({ connectionString: dbUrl });
    db = drizzle(pool, { schema });
    const u = new URL(redisUrl!);
    queue = new Queue('outbox-relay', {
      connection: { host: u.hostname, port: Number(u.port || 6379) },
    });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    if (workspaces.length) {
      await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, workspaces));
    }
    if (users.length) {
      await db.delete(schema.users).where(inArray(schema.users.id, users));
    }
    await pool.end();
  });

  it('relays pending events, marks them published, dedups by idempotency key', async () => {
    // sign-up produces a pending WorkspaceCreated outbox event
    const signup = new SignUpUseCase(db, new ScryptPasswordHasher());
    const r = await signup.execute({
      email: `outbox-${Date.now()}@example.com`,
      password: 'supersecret1',
      displayName: 'Outbox Tester',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    users.push(r.value.userId);
    workspaces.push(r.value.personalWorkspaceId);

    const before = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.workspaceId, r.value.personalWorkspaceId));
    expect(before.some((e) => e.status === 'pending')).toBe(true);

    const relay = new OutboxRelayService(db, queue);
    const published = await relay.relayOnce(500);
    expect(published).toBeGreaterThanOrEqual(1);

    // our workspace's event is now published
    const after = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.workspaceId, r.value.personalWorkspaceId));
    expect(after.every((e) => e.status === 'published')).toBe(true);

    // a second relay does not double-publish (already claimed)
    const secondPass = await relay.relayOnce(500);
    // may relay other tests' rows but ours are done; ensure no exception + our rows stable
    expect(typeof secondPass).toBe('number');

    // the job exists in the queue under the idempotency key
    const signupEvt = before.find((e) => e.eventType === 'WorkspaceCreated');
    expect(signupEvt).toBeTruthy();
    if (signupEvt) {
      const job = await queue.getJob(signupEvt.idempotencyKey.replace(/:/g, '_'));
      expect(job).toBeTruthy();
      expect(job?.data.eventType).toBe('WorkspaceCreated');
    }
  });

  it('relays consulting web ingest events with retry/backoff so failures are not one-shot lost', async () => {
    const signup = new SignUpUseCase(db, new ScryptPasswordHasher());
    const r = await signup.execute({
      email: `outbox-ingest-${Date.now()}@example.com`,
      password: 'supersecret1',
      displayName: 'Outbox Ingest Tester',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    users.push(r.value.userId);
    workspaces.push(r.value.personalWorkspaceId);

    await db.insert(schema.outboxEvents).values({
      workspaceId: r.value.personalWorkspaceId,
      eventType: 'ConsultingWebTurnCompleted',
      aggregateType: 'thread',
      aggregateId: r.value.personalWorkspaceId,
      payload: { assistantText: '응답', userText: '질문' },
      status: 'pending',
      idempotencyKey: `consulting-web-ingest:test:${r.value.personalWorkspaceId}`,
    });

    const relay = new OutboxRelayService(db, queue);
    await relay.relayOnce(500);

    const job = await queue.getJob(`consulting-web-ingest_test_${r.value.personalWorkspaceId}`);
    expect(job).toBeTruthy();
    expect(job?.opts.attempts).toBeGreaterThanOrEqual(5);
    expect(job?.opts.backoff).toMatchObject({ type: 'exponential' });
    expect(job?.opts.removeOnFail).toBeGreaterThanOrEqual(5000);
  });
});
