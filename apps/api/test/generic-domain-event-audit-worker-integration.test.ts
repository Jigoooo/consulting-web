import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { GenericDomainEventAuditWorker } from '../src/queues/generic-domain-event-audit.worker.js';
import { QUEUE_NAMES } from '../src/queues/queue.tokens.js';

const redisUrl = process.env.OUTBOX_WORKER_TEST_REDIS_URL;
const d = redisUrl ? describe : describe.skip;

let queue: Queue;
let worker: GenericDomainEventAuditWorker;

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for BullMQ worker state');
}

d('GenericDomainEventAuditWorker BullMQ integration', () => {
  beforeAll(() => {
    const parsed = new URL(redisUrl!);
    const connection = { host: parsed.hostname, port: Number(parsed.port || 6379) };
    queue = new Queue(QUEUE_NAMES.outboxRelay, { connection });
    worker = new GenericDomainEventAuditWorker({ REDIS_URL: redisUrl! } as never);
    worker.onModuleInit();
  });

  afterAll(async () => {
    await worker.onModuleDestroy();
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
  });

  it('consumes a registered audit event instead of leaving it waiting forever', async () => {
    const job = await queue.add('WorkspaceCreated', {
      eventId: 'evt-known',
      eventType: 'WorkspaceCreated',
      aggregateType: 'workspace',
      aggregateId: 'workspace-1',
      workspaceId: 'workspace-1',
      payload: {},
    }, { removeOnComplete: true });

    await waitFor(async () => (await queue.getJob(job.id!)) === undefined);
  });

  it('fails an unregistered event instead of acknowledging it', async () => {
    const job = await queue.add('UnknownEvent', {
      eventId: 'evt-unknown',
      eventType: 'UnknownEvent',
      aggregateType: 'test',
      aggregateId: 'aggregate-1',
      workspaceId: 'workspace-1',
      payload: {},
    }, { removeOnFail: false });

    await waitFor(async () => (await job.getState()) === 'failed');
    expect(await job.getState()).toBe('failed');
  });
});
