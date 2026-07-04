import { Global, Module } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ENV_TOKEN } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { DrizzleModule } from '../infra/drizzle.module.js';
import { OutboxRelayService } from './outbox-relay.service.js';
import { OUTBOX_RELAY_QUEUE, QUEUE_NAMES } from './queue.tokens.js';

export { OUTBOX_RELAY_QUEUE, QUEUE_NAMES } from './queue.tokens.js';

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
    OutboxRelayService,
  ],
  exports: [OUTBOX_RELAY_QUEUE, OutboxRelayService],
})
export class QueuesModule {}
