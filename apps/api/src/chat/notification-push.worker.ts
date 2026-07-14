import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import { ENV_TOKEN } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { NOTIFICATION_PUSH_REQUESTED_EVENT } from '../queues/outbox-routing.js';
import { QUEUE_NAMES } from '../queues/queue.tokens.js';
import { redactLogText } from '../security/redact-sensitive-text.js';
import { PushService } from './push.service.js';

interface NotificationPushOutboxJob {
  eventId: string;
  eventType: string;
  workspaceId: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
}

interface NotificationPushPayload {
  subscriptionId: string;
  recipientUserId: string;
  title: string;
  body: string;
  url: string;
  tag: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function redisConnectionFromUrl(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379) };
}

function parsePayload(value: unknown): NotificationPushPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid notification push payload');
  }
  const record = value as Record<string, unknown>;
  const subscriptionId = typeof record.subscriptionId === 'string' ? record.subscriptionId.trim() : '';
  const recipientUserId = typeof record.recipientUserId === 'string' ? record.recipientUserId.trim() : '';
  if (!UUID_RE.test(subscriptionId)) throw new Error('invalid notification push subscription');
  if (!UUID_RE.test(recipientUserId)) throw new Error('invalid notification push recipient');
  const title = typeof record.title === 'string' ? record.title.trim().slice(0, 200) : '';
  const body = typeof record.body === 'string' ? record.body.trim().slice(0, 500) : '';
  const url = typeof record.url === 'string' ? record.url.trim().slice(0, 500) : '';
  const tag = typeof record.tag === 'string' ? record.tag.trim().slice(0, 200) : '';
  if (!title || !body || !url.startsWith('/') || !tag) throw new Error('invalid notification push payload');
  return { subscriptionId, recipientUserId, title, body, url, tag };
}

@Injectable()
export class NotificationPushWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationPushWorker.name);
  private worker: Worker | null = null;

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    private readonly push: PushService,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker(
      QUEUE_NAMES.notificationPush,
      async (job) => {
        try {
          await this.processOutboxJob(job.data as NotificationPushOutboxJob);
        } catch (error) {
          this.logger.error(`notification push job failed: ${redactLogText(error instanceof Error ? error.message : String(error))}`);
          throw error;
        }
      },
      { connection: redisConnectionFromUrl(this.env.REDIS_URL), concurrency: 4 },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    this.worker = null;
  }

  async processOutboxJob(job: NotificationPushOutboxJob): Promise<void> {
    if (job.eventType !== NOTIFICATION_PUSH_REQUESTED_EVENT) {
      throw new Error(`unsupported outbox event type: ${job.eventType}`);
    }
    if (job.aggregateType !== 'notification' || !UUID_RE.test(job.aggregateId)) {
      throw new Error('notification push envelope mismatch');
    }
    const payload = parsePayload(job.payload);
    await this.push.sendToSubscription(payload.subscriptionId, payload.recipientUserId, {
      title: payload.title,
      body: payload.body,
      url: payload.url,
      tag: payload.tag,
    });
  }
}
