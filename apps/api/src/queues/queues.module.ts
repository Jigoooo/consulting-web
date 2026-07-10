import { Global, Module } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ENV_TOKEN } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { DrizzleModule } from '../infra/drizzle.module.js';
import { GenericDomainEventAuditWorker } from './generic-domain-event-audit.worker.js';
import { OutboxRelayService } from './outbox-relay.service.js';
import { CONSULTING_WEB_INGEST_QUEUE, OUTBOX_RELAY_QUEUE, QUEUE_NAMES } from './queue.tokens.js';

export { CONSULTING_WEB_INGEST_QUEUE, OUTBOX_RELAY_QUEUE, QUEUE_NAMES } from './queue.tokens.js';

function redisConnectionFromUrl(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379) };
}

@Global()
@Module({
  imports: [DrizzleModule],
  providers: [
    {
      provide: OUTBOX_RELAY_QUEUE,
      inject: [ENV_TOKEN],
      useFactory: (env: Env): Queue =>
        new Queue(QUEUE_NAMES.outboxRelay, {
          connection: redisConnectionFromUrl(env.REDIS_URL),
        }),
    },
    {
      provide: CONSULTING_WEB_INGEST_QUEUE,
      inject: [ENV_TOKEN],
      useFactory: (env: Env): Queue =>
        new Queue(QUEUE_NAMES.consultingWebIngest, {
          connection: redisConnectionFromUrl(env.REDIS_URL),
        }),
    },
    GenericDomainEventAuditWorker,
    OutboxRelayService,
  ],
  exports: [CONSULTING_WEB_INGEST_QUEUE, OUTBOX_RELAY_QUEUE, OutboxRelayService],
})
export class QueuesModule {}
