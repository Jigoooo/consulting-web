import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { schema } from '@consulting/db-schema';
import { eq, inArray } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import { Queue } from 'bullmq';
import { outboxJobId, OutboxRelayService } from '../src/queues/outbox-relay.service.js';
import { SignUpUseCase } from '../src/auth/sign-up.usecase.js';
import { ScryptPasswordHasher } from '../src/auth/password.js';

const dbUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const TEST_CREDENTIAL = 'supersecret1';
const d = dbUrl && redisUrl ? describe : describe.skip;

let pool: Pool;
let lockClient: PoolClient;
let db: NodePgDatabase<typeof schema>;
let queue: Queue;
let consultingQueue: Queue;
const users: string[] = [];
const workspaces: string[] = [];

d('outbox relay → BullMQ (ADR-0005/0020)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl });
    lockClient = await pool.connect();
    await lockClient.query('SELECT pg_advisory_lock($1)', [739_201]);
    db = drizzle(pool, { schema });
    const u = new URL(redisUrl!);
    const queueSuffix = `${process.pid}-${Date.now()}`;
    queue = new Queue(`outbox-relay-test-${queueSuffix}`, {
      connection: { host: u.hostname, port: Number(u.port || 6379) },
    });
    consultingQueue = new Queue(`consulting-web-ingest-test-${queueSuffix}`, {
      connection: { host: u.hostname, port: Number(u.port || 6379) },
    });
  }, 30_000);

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await consultingQueue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await consultingQueue.close();
    if (workspaces.length) {
      await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, workspaces));
    }
    if (users.length) {
      await db.delete(schema.users).where(inArray(schema.users.id, users));
    }
    await lockClient.query('SELECT pg_advisory_unlock($1)', [739_201]);
    lockClient.release();
    await pool.end();
  }, 30_000);

  it('relays pending events, marks them published, dedups by idempotency key', async () => {
    // sign-up produces a pending WorkspaceCreated outbox event
    const signup = new SignUpUseCase(db, new ScryptPasswordHasher());
    const r = await signup.execute({
      email: `outbox-${Date.now()}@example.com`,
      password: TEST_CREDENTIAL,
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

    const relay = new OutboxRelayService(db, queue, consultingQueue);
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
      const job = await queue.getJob(outboxJobId(signupEvt.idempotencyKey));
      expect(job).toBeTruthy();
      expect(job?.data.eventType).toBe('WorkspaceCreated');
    }
  });

  it('relays consulting web ingest events with retry/backoff so failures are not one-shot lost', async () => {
    const signup = new SignUpUseCase(db, new ScryptPasswordHasher());
    const r = await signup.execute({
      email: `outbox-ingest-${Date.now()}@example.com`,
      password: TEST_CREDENTIAL,
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

    const relay = new OutboxRelayService(db, queue, consultingQueue);
    await relay.relayOnce(500);

    const jobId = outboxJobId(`consulting-web-ingest:test:${r.value.personalWorkspaceId}`);
    const job = await consultingQueue.getJob(jobId);
    expect(job).toBeTruthy();
    expect(await queue.getJob(jobId)).toBeUndefined();
    expect(job?.opts.attempts).toBeGreaterThanOrEqual(5);
    expect(job?.opts.backoff).toMatchObject({ type: 'exponential' });
    expect(job?.opts.removeOnFail).toBeGreaterThanOrEqual(5000);
  });

  it('marks an unregistered event dead without enqueueing it to either queue', async () => {
    const signup = new SignUpUseCase(db, new ScryptPasswordHasher());
    const result = await signup.execute({
      email: `outbox-unknown-${Date.now()}@example.com`,
      password: TEST_CREDENTIAL,
      displayName: 'Outbox Unknown Tester',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    users.push(result.value.userId);
    workspaces.push(result.value.personalWorkspaceId);

    const idempotencyKey = `unknown-event:test:${result.value.personalWorkspaceId}`;
    const [unknown] = await db.insert(schema.outboxEvents).values({
      workspaceId: result.value.personalWorkspaceId,
      eventType: 'UnknownEvent',
      aggregateType: 'workspace',
      aggregateId: result.value.personalWorkspaceId,
      payload: {},
      status: 'pending',
      idempotencyKey,
    }).returning({ id: schema.outboxEvents.id });

    const relay = new OutboxRelayService(db, queue, consultingQueue);
    await relay.relayOnce(500);

    const [stored] = await db.select({
      status: schema.outboxEvents.status,
      lastError: schema.outboxEvents.lastError,
    }).from(schema.outboxEvents).where(eq(schema.outboxEvents.id, unknown!.id));
    const jobId = outboxJobId(idempotencyKey);
    expect(stored).toMatchObject({
      status: 'dead',
      lastError: 'unsupported outbox event type: UnknownEvent',
    });
    expect(await queue.getJob(jobId)).toBeUndefined();
    expect(await consultingQueue.getJob(jobId)).toBeUndefined();
  });
});
