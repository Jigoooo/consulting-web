import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import { z } from 'zod';
import { ENV_TOKEN } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { CONSULTING_INSIGHT_SHADOW_REQUESTED_EVENT } from '../queues/outbox-routing.js';
import { QUEUE_NAMES } from '../queues/queue.tokens.js';
import { ConsultingInsightShadowWorkerService } from './consulting-insight-shadow.worker.service.js';

const PayloadSchema = z.object({
  shadowTurnId: z.string().uuid(),
  settlementId: z.string().uuid(),
  retrievalRunId: z.string().uuid(),
  assistantMessageId: z.string().uuid(),
}).strict();

interface ConsultingInsightShadowOutboxJob {
  eventType: string;
  workspaceId: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
}

function redisConnectionFromUrl(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379) };
}

@Injectable()
export class ConsultingInsightShadowWorker implements OnModuleInit, OnModuleDestroy {
  private worker: Worker | null = null;

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(ConsultingInsightShadowWorkerService) private readonly service: ConsultingInsightShadowWorkerService,
  ) {}

  onModuleInit(): void {
    if (this.env.CONSULTING_INSIGHT_WEB_SHADOW_MODE !== 'shadow') return;
    this.worker = new Worker(
      QUEUE_NAMES.consultingInsightShadow,
      async (job) => this.processOutboxJob(job.data as ConsultingInsightShadowOutboxJob),
      { connection: redisConnectionFromUrl(this.env.REDIS_URL), concurrency: 1 },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    this.worker = null;
  }

  async processOutboxJob(envelope: ConsultingInsightShadowOutboxJob): Promise<void> {
    if (envelope.eventType !== CONSULTING_INSIGHT_SHADOW_REQUESTED_EVENT) {
      throw new Error(`unsupported outbox event type: ${envelope.eventType}`);
    }
    if (envelope.aggregateType !== 'thread' || envelope.aggregateId.length === 0) {
      throw new Error('consulting insight shadow aggregate must be an exact thread');
    }
    const payload = PayloadSchema.parse(envelope.payload);
    const result = await this.service.process(payload.shadowTurnId, {
      workspaceId: envelope.workspaceId,
      threadId: envelope.aggregateId,
      settlementId: payload.settlementId,
      retrievalRunId: payload.retrievalRunId,
      assistantMessageId: payload.assistantMessageId,
    });
    if (result === 'busy') throw new Error('consulting insight shadow replay lease busy');
  }
}
