import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { Queue, type JobsOptions } from 'bullmq';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { redactLogText, redactSensitiveText } from '../security/redact-sensitive-text.js';
import {
  CONSULTING_WEB_TURN_COMPLETED_EVENT,
  routeOutboxEvent,
  UnsupportedOutboxEventError,
} from './outbox-routing.js';
import { CONSULTING_WEB_INGEST_QUEUE, OUTBOX_RELAY_QUEUE } from './queue.tokens.js';

const OUTBOX_LEASE_SECONDS = 30;
const OUTBOX_HEARTBEAT_MS = 10_000;
const OUTBOX_MAX_ENQUEUE_ATTEMPTS = 12;

export function outboxRetryDelaySeconds(attempt: number): number {
  return Math.min(300, 5 * (2 ** Math.max(0, attempt - 1)));
}

export function outboxJobId(idempotencyKey: string): string {
  return `outbox_${createHash('sha256').update(idempotencyKey).digest('hex')}`;
}

function reclaimableOutboxEvent() {
  return or(
    and(
      eq(schema.outboxEvents.status, 'pending'),
      or(
        isNull(schema.outboxEvents.nextAttemptAt),
        lte(schema.outboxEvents.nextAttemptAt, sql`now()`),
      ),
    ),
    and(
      eq(schema.outboxEvents.status, 'processing'),
      or(
        isNull(schema.outboxEvents.leaseExpiresAt),
        lte(schema.outboxEvents.leaseExpiresAt, sql`now()`),
      ),
    ),
  );
}

export function outboxJobOptions(eventType: string, idempotencyKey: string): JobsOptions {
  const base: JobsOptions = {
    jobId: outboxJobId(idempotencyKey),
    removeOnComplete: 1000,
    removeOnFail: 5000,
  };
  if (eventType === CONSULTING_WEB_TURN_COMPLETED_EVENT) {
    return {
      ...base,
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
    };
  }
  return base;
}

/**
 * Outbox relay (ADR-0005): reads pending outbox_events, enqueues each to BullMQ
 * with the event's idempotencyKey as the job id (dedup, ADR-0020), then marks
 * the row published. At-least-once; consumers must be idempotent.
 */
@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private relayTimer: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatTimers = new Set<ReturnType<typeof setInterval>>();
  private relayInFlight = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(OUTBOX_RELAY_QUEUE) private readonly genericQueue: Queue,
    @Inject(CONSULTING_WEB_INGEST_QUEUE) private readonly consultingWebQueue: Queue,
  ) {}

  private queueFor(eventType: string): Queue {
    return routeOutboxEvent(eventType) === 'consulting-web-ingest'
      ? this.consultingWebQueue
      : this.genericQueue;
  }

  onModuleInit(): void {
    void this.relayTick();
    this.relayTimer = setInterval(() => {
      void this.relayTick();
    }, 2_000);
  }

  onModuleDestroy(): void {
    if (this.relayTimer) clearInterval(this.relayTimer);
    this.relayTimer = null;
    for (const timer of this.heartbeatTimers) clearInterval(timer);
    this.heartbeatTimers.clear();
  }

  private startHeartbeat(eventId: string, leaseToken: string): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      void this.db
        .update(schema.outboxEvents)
        .set({
          leaseExpiresAt: sql`now() + interval '${sql.raw(String(OUTBOX_LEASE_SECONDS))} seconds'`,
          updatedAt: sql`now()`,
        })
        .where(and(
          eq(schema.outboxEvents.id, eventId),
          eq(schema.outboxEvents.status, 'processing'),
          eq(schema.outboxEvents.leaseToken, leaseToken),
        ))
        .catch((error: unknown) => {
          const message = redactLogText(error instanceof Error ? error.message : String(error));
          this.logger.warn(`outbox lease heartbeat failed for ${eventId}: ${message}`);
        });
    }, OUTBOX_HEARTBEAT_MS);
    timer.unref();
    this.heartbeatTimers.add(timer);
    return timer;
  }

  private stopHeartbeat(timer: ReturnType<typeof setInterval>): void {
    clearInterval(timer);
    this.heartbeatTimers.delete(timer);
  }

  private async relayTick(): Promise<void> {
    if (this.relayInFlight) return;
    this.relayInFlight = true;
    try {
      await this.relayOnce(100);
    } catch (err) {
      const message = redactLogText(err instanceof Error ? err.message : String(err));
      this.logger.warn(`outbox relay tick failed: ${message}`);
    } finally {
      this.relayInFlight = false;
    }
  }

  /** Relay up to `limit` pending events. Returns how many were published. */
  async relayOnce(limit = 100): Promise<number> {
    const pending = await this.db
      .select()
      .from(schema.outboxEvents)
      .where(reclaimableOutboxEvent())
      .orderBy(schema.outboxEvents.createdAt)
      .limit(limit);

    let published = 0;
    for (const evt of pending) {
      const leaseToken = randomUUID();
      const claimed = await this.db
        .update(schema.outboxEvents)
        .set({
          status: 'processing',
          leaseToken,
          leaseExpiresAt: sql`now() + interval '${sql.raw(String(OUTBOX_LEASE_SECONDS))} seconds'`,
          attemptCount: sql`${schema.outboxEvents.attemptCount} + 1`,
          lastError: null,
          nextAttemptAt: null,
          updatedAt: sql`now()`,
        })
        .where(
          and(eq(schema.outboxEvents.id, evt.id), reclaimableOutboxEvent()),
        )
        .returning({ id: schema.outboxEvents.id });
      if (claimed.length === 0) continue;

      const heartbeat = this.startHeartbeat(evt.id, leaseToken);
      try {
        await this.queueFor(evt.eventType).add(
          evt.eventType,
          {
            eventId: evt.id,
            eventType: evt.eventType,
            aggregateType: evt.aggregateType,
            aggregateId: evt.aggregateId,
            workspaceId: evt.workspaceId,
            payload: evt.payload,
          },
          outboxJobOptions(evt.eventType, evt.idempotencyKey),
        );
      } catch (error) {
        const message = redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 2_000);
        const attempt = evt.attemptCount + 1;
        const terminal = error instanceof UnsupportedOutboxEventError
          || attempt >= OUTBOX_MAX_ENQUEUE_ATTEMPTS;
        const status = terminal ? 'dead' : 'pending';
        const nextAttemptAt = terminal
          ? null
          : sql`now() + interval '${sql.raw(String(outboxRetryDelaySeconds(attempt)))} seconds'`;
        try {
          await this.db
            .update(schema.outboxEvents)
            .set({
              status,
              leaseToken: null,
              leaseExpiresAt: null,
              lastError: message,
              nextAttemptAt,
              updatedAt: sql`now()`,
            })
            .where(and(
              eq(schema.outboxEvents.id, evt.id),
              eq(schema.outboxEvents.status, 'processing'),
              eq(schema.outboxEvents.leaseToken, leaseToken),
            ));
        } finally {
          this.stopHeartbeat(heartbeat);
        }
        continue;
      }

      try {
        const finalized = await this.db
          .update(schema.outboxEvents)
          .set({
            status: 'published',
            leaseToken: null,
            leaseExpiresAt: null,
            lastError: null,
            nextAttemptAt: null,
            updatedAt: sql`now()`,
          })
          .where(and(
            eq(schema.outboxEvents.id, evt.id),
            eq(schema.outboxEvents.status, 'processing'),
            eq(schema.outboxEvents.leaseToken, leaseToken),
          ))
          .returning({ id: schema.outboxEvents.id });
        published += finalized.length;
      } finally {
        this.stopHeartbeat(heartbeat);
      }
    }
    return published;
  }
}
