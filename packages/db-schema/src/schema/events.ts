import { pgTable, text, uuid, jsonb, numeric, integer, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { outboxStatus, scopeType } from './enums';
import { workspaces } from './organization';
import { users } from './identity';
import { botAgents } from './bot';
import { primaryId, timestamps } from './_shared';

/** Transactional outbox (ADR-0005). Written inside the same tx as state change. */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, {
        onDelete: 'cascade',
      }),
    eventType: text('event_type').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    payload: jsonb('payload').notNull(),
    status: outboxStatus('status').notNull().default('pending'),
    idempotencyKey: text('idempotency_key').notNull(),
    requestId: text('request_id'),
    leaseToken: text('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique('outbox_idem_unique').on(t.idempotencyKey),
    index('outbox_status_idx').on(t.status),
    index('outbox_status_created_idx').on(t.status, t.createdAt),
    index('outbox_status_lease_idx').on(t.status, t.leaseExpiresAt),
    index('outbox_status_next_attempt_idx').on(t.status, t.nextAttemptAt),
    index('outbox_workspace_idx').on(t.workspaceId),
  ],
);

/** Audit log (ADR-0001/0016). Never store secret values here. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id').references(() => workspaces.id, {
      onDelete: 'cascade',
    }),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    actorBotId: uuid('actor_bot_id').references(() => botAgents.id),
    action: text('action').notNull(),
    scopeType: scopeType('scope_type'),
    scopeId: uuid('scope_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    requestId: text('request_id'),
    traceId: text('trace_id'),
    ...timestamps,
  },
  (t) => [
    index('audit_workspace_idx').on(t.workspaceId),
    index('audit_actor_idx').on(t.actorUserId),
  ],
);

/** Usage metering (ADR-0012). Cost/quota guardrails. */
export const usageMeterEvents = pgTable(
  'usage_meter_events',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    botId: uuid('bot_id').references(() => botAgents.id),
    meterType: text('meter_type').notNull(),
    quantity: numeric('quantity').notNull(),
    unit: text('unit').notNull(),
    sourceRef: text('source_ref'),
    ...timestamps,
  },
  (t) => [
    index('usage_workspace_idx').on(t.workspaceId),
    index('usage_meter_type_idx').on(t.meterType),
  ],
);

/** Permission-aware search index jobs (ADR-0013). */
export const searchIndexJobs = pgTable(
  'search_index_jobs',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    scopeType: scopeType('scope_type').notNull(),
    scopeId: uuid('scope_id').notNull(),
    op: text('op').notNull(),
    status: text('status').notNull().default('pending'),
    ...timestamps,
  },
  (t) => [index('search_jobs_workspace_idx').on(t.workspaceId)],
);
