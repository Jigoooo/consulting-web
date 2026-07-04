import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq, sql } from 'drizzle-orm';
import { Queue } from 'bullmq';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { OUTBOX_RELAY_QUEUE } from './queue.tokens.js';

/**
 * Outbox relay (ADR-0005): reads pending outbox_events, enqueues each to BullMQ
 * with the event's idempotencyKey as the job id (dedup, ADR-0020), then marks
 * the row published. At-least-once; consumers must be idempotent.
 */
@Injectable()
export class OutboxRelayService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(OUTBOX_RELAY_QUEUE) private readonly queue: Queue,
  ) {}

  /** Relay up to `limit` pending events. Returns how many were published. */
  async relayOnce(limit = 100): Promise<number> {
    const pending = await this.db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.status, 'pending'))
      .orderBy(schema.outboxEvents.createdAt)
      .limit(limit);

    let published = 0;
    for (const evt of pending) {
      // claim: pending -> processing (guards double relay across workers)
      const claimed = await this.db
        .update(schema.outboxEvents)
        .set({ status: 'processing', updatedAt: sql`now()` })
        .where(
          and(eq(schema.outboxEvents.id, evt.id), eq(schema.outboxEvents.status, 'pending')),
        )
        .returning({ id: schema.outboxEvents.id });
      if (claimed.length === 0) continue;

      try {
        await this.queue.add(
          evt.eventType,
          {
            eventId: evt.id,
            eventType: evt.eventType,
            aggregateType: evt.aggregateType,
            aggregateId: evt.aggregateId,
            workspaceId: evt.workspaceId,
            payload: evt.payload,
          },
          {
            // BullMQ jobId cannot contain ':' — sanitize while preserving dedup semantics.
            jobId: evt.idempotencyKey.replace(/:/g, '_'),
            removeOnComplete: 1000,
            removeOnFail: 5000,
          },
        );
      } catch {
        // enqueue failed — revert the claim so the event is retried next pass,
        // never stuck in 'processing' (ADR-0005 at-least-once).
        await this.db
          .update(schema.outboxEvents)
          .set({ status: 'pending', updatedAt: sql`now()` })
          .where(eq(schema.outboxEvents.id, evt.id));
        continue;
      }

      await this.db
        .update(schema.outboxEvents)
        .set({ status: 'published', updatedAt: sql`now()` })
        .where(eq(schema.outboxEvents.id, evt.id));
      published += 1;
    }
    return published;
  }
}
