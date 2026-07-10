import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import { ENV_TOKEN } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { redactLogText } from '../security/redact-sensitive-text.js';
import { isGenericAuditOutboxEvent, UnsupportedOutboxEventError } from './outbox-routing.js';
import { QUEUE_NAMES } from './queue.tokens.js';

export interface GenericOutboxJobData {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  workspaceId: string;
  payload: unknown;
}

function redisConnectionFromUrl(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379) };
}

@Injectable()
export class GenericDomainEventAuditWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GenericDomainEventAuditWorker.name);
  private worker: Worker | null = null;

  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  onModuleInit(): void {
    this.worker = new Worker(
      QUEUE_NAMES.outboxRelay,
      async (job) => this.processOutboxJob(job.data as GenericOutboxJobData),
      { connection: redisConnectionFromUrl(this.env.REDIS_URL) },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.warn(redactLogText(
        `generic outbox audit job failed (${job?.id ?? 'unknown'}): ${error.message}`,
      ));
    });
    this.worker.on('error', (error) => {
      this.logger.error(redactLogText(`generic outbox audit worker error: ${error.message}`));
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  processOutboxJob(job: GenericOutboxJobData): Promise<void> {
    if (!isGenericAuditOutboxEvent(job.eventType)) {
      return Promise.reject(new UnsupportedOutboxEventError(job.eventType));
    }
    this.logger.debug(redactLogText(`published ${job.eventType} ${job.aggregateType}:${job.aggregateId}`));
    return Promise.resolve();
  }
}
