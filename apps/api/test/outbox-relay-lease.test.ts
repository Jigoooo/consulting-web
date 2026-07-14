import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { schema } from '@consulting/db-schema';
import { eq, inArray } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import { Queue } from 'bullmq';
import { outboxJobId, OutboxRelayService } from '../src/queues/outbox-relay.service.js';
import { SignUpUseCase } from '../src/auth/sign-up.usecase.js';
import { ScryptPasswordHasher } from '../src/auth/password.js';

const dbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const TEST_CREDENTIAL = 'supersecret1';
const d = dbUrl && redisUrl ? describe : describe.skip;

let pool: Pool;
let lockClient: PoolClient;
let db: NodePgDatabase<typeof schema>;
let genericQueue: Queue;
let consultingQueue: Queue;
const users: string[] = [];
const workspaces: string[] = [];

async function createWorkspace(label: string): Promise<{ userId: string; workspaceId: string }> {
  const signup = new SignUpUseCase(db, new ScryptPasswordHasher());
  const result = await signup.execute({
    email: `outbox-lease-${label}-${Date.now()}@example.com`,
    password: TEST_CREDENTIAL,
    displayName: 'Outbox Lease Tester',
  });
  if (!result.ok) throw new Error('test workspace signup failed');
  users.push(result.value.userId);
  workspaces.push(result.value.personalWorkspaceId);
  await db.update(schema.outboxEvents)
    .set({ status: 'published' })
    .where(eq(schema.outboxEvents.workspaceId, result.value.personalWorkspaceId));
  return { userId: result.value.userId, workspaceId: result.value.personalWorkspaceId };
}

async function waitForProcessing(eventId: string): Promise<{ leaseToken: string; leaseExpiresAt: Date }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await db.select({
      status: schema.outboxEvents.status,
      leaseToken: schema.outboxEvents.leaseToken,
      leaseExpiresAt: schema.outboxEvents.leaseExpiresAt,
    }).from(schema.outboxEvents).where(eq(schema.outboxEvents.id, eventId));
    if (row?.status === 'processing' && row.leaseToken && row.leaseExpiresAt) {
      return { leaseToken: row.leaseToken, leaseExpiresAt: row.leaseExpiresAt };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`event ${eventId} was not claimed`);
}

d('outbox processing lease recovery', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl });
    lockClient = await pool.connect();
    await lockClient.query('SELECT pg_advisory_lock($1)', [739_201]);
    db = drizzle(pool, { schema });
    const redis = new URL(redisUrl!);
    const suffix = `${process.pid}-${Date.now()}`;
    const connection = { host: redis.hostname, port: Number(redis.port || 6379) };
    genericQueue = new Queue(`outbox-lease-generic-test-${suffix}`, { connection });
    consultingQueue = new Queue(`outbox-lease-consulting-test-${suffix}`, { connection });
  }, 30_000);

  afterAll(async () => {
    await genericQueue.obliterate({ force: true }).catch(() => undefined);
    await consultingQueue.obliterate({ force: true }).catch(() => undefined);
    await genericQueue.close();
    await consultingQueue.close();
    if (workspaces.length) await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, workspaces));
    if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
    await lockClient.query('SELECT pg_advisory_unlock($1)', [739_201]);
    lockClient.release();
    await pool.end();
  }, 30_000);

  it('reclaims an expired processing row after relay restart and publishes it once', async () => {
    const { workspaceId } = await createWorkspace('expired');

    const idempotencyKey = `lease-reclaim:test:${workspaceId}`;
    const [event] = await db.insert(schema.outboxEvents).values({
      workspaceId,
      eventType: 'WorkspaceCreated',
      aggregateType: 'workspace',
      aggregateId: workspaceId,
      payload: {},
      status: 'processing',
      idempotencyKey,
      updatedAt: new Date(Date.now() - 10 * 60_000),
    }).returning({ id: schema.outboxEvents.id });

    const relay = new OutboxRelayService(db, genericQueue, consultingQueue);
    await relay.relayOnce(100);

    const [stored] = await db.select({ status: schema.outboxEvents.status })
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.id, event!.id));
    expect(stored?.status).toBe('published');
    expect(await genericQueue.getJob(outboxJobId(idempotencyKey))).toBeTruthy();
  });

  it('does not reclaim a processing row whose lease is still active', async () => {
    const { workspaceId } = await createWorkspace('active');
    const idempotencyKey = `lease-active:test:${workspaceId}`;
    const [event] = await db.insert(schema.outboxEvents).values({
      workspaceId,
      eventType: 'WorkspaceCreated',
      aggregateType: 'workspace',
      aggregateId: workspaceId,
      payload: {},
      status: 'processing',
      idempotencyKey,
      leaseToken: 'active-owner',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    }).returning({ id: schema.outboxEvents.id });

    const relay = new OutboxRelayService(db, genericQueue, consultingQueue);
    await relay.relayOnce(100);

    const [stored] = await db.select({ status: schema.outboxEvents.status })
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.id, event!.id));
    expect(stored?.status).toBe('processing');
    expect(await genericQueue.getJob(outboxJobId(idempotencyKey))).toBeUndefined();
  });

  it('heartbeats a claimed row while queue enqueue is still in flight', async () => {
    const { workspaceId } = await createWorkspace('heartbeat');
    const [event] = await db.insert(schema.outboxEvents).values({
      workspaceId,
      eventType: 'WorkspaceCreated',
      aggregateType: 'workspace',
      aggregateId: workspaceId,
      payload: {},
      status: 'pending',
      idempotencyKey: `lease-heartbeat:test:${workspaceId}`,
    }).returning({ id: schema.outboxEvents.id });

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const blockingQueue = { add: () => blocked } as unknown as Queue;
    const relay = new OutboxRelayService(db, blockingQueue, consultingQueue);
    const relayPromise = relay.relayOnce(100);
    const first = await waitForProcessing(event!.id);

    await new Promise((resolve) => setTimeout(resolve, 10_500));
    const second = await waitForProcessing(event!.id);
    expect(second.leaseToken).toBe(first.leaseToken);
    expect(second.leaseExpiresAt.getTime()).toBeGreaterThan(first.leaseExpiresAt.getTime());

    release();
    await relayPromise;
    relay.onModuleDestroy();
  }, 15_000);

  it('prevents an expired owner from reverting a row after a new owner publishes it', async () => {
    const { workspaceId } = await createWorkspace('owner-race');
    const [event] = await db.insert(schema.outboxEvents).values({
      workspaceId,
      eventType: 'WorkspaceCreated',
      aggregateType: 'workspace',
      aggregateId: workspaceId,
      payload: {},
      status: 'pending',
      idempotencyKey: `lease-owner-race:test:${workspaceId}`,
    }).returning({ id: schema.outboxEvents.id });

    let rejectOld!: (error: Error) => void;
    const blocked = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
    const oldQueue = { add: () => blocked } as unknown as Queue;
    const currentQueue = { add: async () => undefined } as unknown as Queue;
    const oldRelay = new OutboxRelayService(db, oldQueue, consultingQueue);
    const currentRelay = new OutboxRelayService(db, currentQueue, consultingQueue);

    const oldAttempt = oldRelay.relayOnce(100);
    await waitForProcessing(event!.id);
    await db.update(schema.outboxEvents)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.outboxEvents.id, event!.id));
    await currentRelay.relayOnce(100);
    rejectOld(new Error('old enqueue failed after lease loss'));
    await oldAttempt;

    const [stored] = await db.select({
      status: schema.outboxEvents.status,
      leaseToken: schema.outboxEvents.leaseToken,
      lastError: schema.outboxEvents.lastError,
    }).from(schema.outboxEvents).where(eq(schema.outboxEvents.id, event!.id));
    expect(stored).toMatchObject({ status: 'published', leaseToken: null, lastError: null });
    oldRelay.onModuleDestroy();
    currentRelay.onModuleDestroy();
  });

  it('recovers after queue add succeeds but the published-state finalize fails', async () => {
    const { workspaceId } = await createWorkspace('finalize-recovery');
    const idempotencyKey = `lease-finalize-recovery:test:${workspaceId}`;
    const [event] = await db.insert(schema.outboxEvents).values({
      workspaceId,
      eventType: 'WorkspaceCreated',
      aggregateType: 'workspace',
      aggregateId: workspaceId,
      payload: {},
      status: 'pending',
      idempotencyKey,
    }).returning({ id: schema.outboxEvents.id });

    let updateCalls = 0;
    const failingFinalizeDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'update') return Reflect.get(target, property, receiver);
        return (table: typeof schema.outboxEvents) => {
          updateCalls += 1;
          if (updateCalls === 2) throw new Error('simulated finalize outage');
          return target.update(table);
        };
      },
    }) as typeof db;
    const failingRelay = new OutboxRelayService(failingFinalizeDb, genericQueue, consultingQueue);

    await expect(failingRelay.relayOnce(100)).rejects.toThrow('simulated finalize outage');
    const [processing] = await db.select({ status: schema.outboxEvents.status })
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.id, event!.id));
    expect(processing?.status).toBe('processing');

    await db.update(schema.outboxEvents)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.outboxEvents.id, event!.id));
    const recoveryRelay = new OutboxRelayService(db, genericQueue, consultingQueue);
    await recoveryRelay.relayOnce(100);

    const [published] = await db.select({ status: schema.outboxEvents.status })
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.id, event!.id));
    const jobId = outboxJobId(idempotencyKey);
    const matchingJobs = (await genericQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']))
      .filter((job) => job.id === jobId);
    expect(published?.status).toBe('published');
    expect(matchingJobs).toHaveLength(1);
    failingRelay.onModuleDestroy();
    recoveryRelay.onModuleDestroy();
  });

  it('records enqueue failure, releases the lease, and clears the error after retry success', async () => {
    const { workspaceId } = await createWorkspace('failure-retry');
    const [event] = await db.insert(schema.outboxEvents).values({
      workspaceId,
      eventType: 'WorkspaceCreated',
      aggregateType: 'workspace',
      aggregateId: workspaceId,
      payload: {},
      status: 'pending',
      idempotencyKey: `lease-failure-retry:test:${workspaceId}`,
    }).returning({ id: schema.outboxEvents.id });

    const sensitiveRedisUrl = 'redis://relay:topsecret@127.0.0.1:6379';
    const failingQueue = {
      add: async () => { throw new Error(`redis temporarily unavailable: ${sensitiveRedisUrl}`); },
    } as unknown as Queue;
    const successQueue = { add: async () => undefined } as unknown as Queue;
    const failingRelay = new OutboxRelayService(db, failingQueue, consultingQueue);
    const successRelay = new OutboxRelayService(db, successQueue, consultingQueue);

    await failingRelay.relayOnce(100);
    const [failed] = await db.select({
      status: schema.outboxEvents.status,
      leaseToken: schema.outboxEvents.leaseToken,
      leaseExpiresAt: schema.outboxEvents.leaseExpiresAt,
      attemptCount: schema.outboxEvents.attemptCount,
      lastError: schema.outboxEvents.lastError,
      nextAttemptAt: schema.outboxEvents.nextAttemptAt,
    }).from(schema.outboxEvents).where(eq(schema.outboxEvents.id, event!.id));
    expect(failed).toMatchObject({
      status: 'pending',
      leaseToken: null,
      leaseExpiresAt: null,
      attemptCount: 1,
      lastError: 'redis temporarily unavailable: [REDACTED_DATABASE_URL]',
      nextAttemptAt: expect.any(Date),
    });
    expect(failed?.lastError).not.toContain('topsecret');

    await successRelay.relayOnce(100);
    const [deferred] = await db.select({
      status: schema.outboxEvents.status,
      attemptCount: schema.outboxEvents.attemptCount,
    }).from(schema.outboxEvents).where(eq(schema.outboxEvents.id, event!.id));
    expect(deferred).toMatchObject({ status: 'pending', attemptCount: 1 });

    await db.update(schema.outboxEvents)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.outboxEvents.id, event!.id));
    await successRelay.relayOnce(100);
    const [published] = await db.select({
      status: schema.outboxEvents.status,
      attemptCount: schema.outboxEvents.attemptCount,
      lastError: schema.outboxEvents.lastError,
    }).from(schema.outboxEvents).where(eq(schema.outboxEvents.id, event!.id));
    expect(published).toMatchObject({ status: 'published', attemptCount: 2, lastError: null });
    failingRelay.onModuleDestroy();
    successRelay.onModuleDestroy();
  });

  it('dead-letters an enqueue after the twelfth failed claim', async () => {
    const { workspaceId } = await createWorkspace('dead-letter');
    const [event] = await db.insert(schema.outboxEvents).values({
      workspaceId,
      eventType: 'WorkspaceCreated',
      aggregateType: 'workspace',
      aggregateId: workspaceId,
      payload: {},
      status: 'pending',
      attemptCount: 11,
      idempotencyKey: `lease-dead-letter:test:${workspaceId}`,
    }).returning({ id: schema.outboxEvents.id });
    const failingQueue = {
      add: async () => { throw new Error('broker unavailable'); },
    } as unknown as Queue;
    const relay = new OutboxRelayService(db, failingQueue, consultingQueue);

    await relay.relayOnce(100);
    const [stored] = await db.select({
      status: schema.outboxEvents.status,
      attemptCount: schema.outboxEvents.attemptCount,
      nextAttemptAt: schema.outboxEvents.nextAttemptAt,
      lastError: schema.outboxEvents.lastError,
    }).from(schema.outboxEvents).where(eq(schema.outboxEvents.id, event!.id));
    expect(stored).toMatchObject({
      status: 'dead',
      attemptCount: 12,
      nextAttemptAt: null,
      lastError: 'broker unavailable',
    });
    relay.onModuleDestroy();
  });
});
