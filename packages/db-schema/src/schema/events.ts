import { check, pgTable, text, uuid, jsonb, numeric, integer, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { outboxStatus, scopeType } from './enums';
import { workspaces } from './organization';
import { users } from './identity';
import { botAgents } from './bot';
import { primaryId, timestamps } from './_shared';
import { chatMessages, threads } from './space';
import { retrievalRuns } from './evidence-decision';

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

/**
 * Durable post-stream settlement ledger. The assistant transcript row and the
 * first settlement outbox event are created in the same transaction; each
 * downstream step advances independently so one failure cannot erase another.
 */
export const chatTurnSettlements = pgTable(
  'chat_turn_settlements',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    userMessageId: uuid('user_message_id')
      .notNull()
      .references(() => chatMessages.id, { onDelete: 'cascade' }),
    assistantMessageId: uuid('assistant_message_id')
      .notNull()
      .references(() => chatMessages.id, { onDelete: 'cascade' }),
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    userPrompt: text('user_prompt').notNull(),
    userText: text('user_text').notNull(),
    assistantText: text('assistant_text').notNull(),
    runId: text('run_id'),
    finishState: text('finish_state').notNull(),
    toolUses: jsonb('tool_uses').$type<Array<{ tool: string; preview: string | null }>>().notNull().default([]),
    status: text('status').notNull().default('pending'),
    evidenceStatus: text('evidence_status').notNull().default('pending'),
    verificationStatus: text('verification_status').notNull().default('pending'),
    brainStatus: text('brain_status').notNull().default('pending'),
    notificationStatus: text('notification_status').notNull().default('pending'),
    verifiedContradictions: jsonb('verified_contradictions').$type<Array<Record<string, unknown>>>().notNull().default([]),
    leaseToken: text('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    verificationLeaseToken: text('verification_lease_token'),
    verificationLeaseExpiresAt: timestamp('verification_lease_expires_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),
    recoveryCount: integer('recovery_count').notNull().default(0),
    lastError: text('last_error'),
    stepErrors: jsonb('step_errors').$type<Record<string, string>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    unique('chat_turn_settlements_user_message_unique').on(t.userMessageId),
    unique('chat_turn_settlements_assistant_message_unique').on(t.assistantMessageId),
    index('chat_turn_settlements_workspace_status_idx').on(t.workspaceId, t.status, t.createdAt),
    index('chat_turn_settlements_status_lease_idx').on(t.status, t.leaseExpiresAt),
    index('chat_turn_settlements_thread_idx').on(t.threadId, t.createdAt),
    index('chat_turn_settlements_run_idx').on(t.runId),
  ],
);

/** Response-invariant Web insight shadow denominator; contains references and hashes only. */
export const consultingInsightShadowTurns = pgTable(
  'consulting_insight_shadow_turns',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
    settlementId: uuid('settlement_id').notNull().references(() => chatTurnSettlements.id, { onDelete: 'cascade' }),
    userMessageId: uuid('user_message_id').notNull().references(() => chatMessages.id, { onDelete: 'cascade' }),
    assistantMessageId: uuid('assistant_message_id').references(() => chatMessages.id, { onDelete: 'set null' }),
    retrievalRunId: uuid('retrieval_run_id').references(() => retrievalRuns.id, { onDelete: 'restrict' }),
    runId: text('run_id'),
    status: text('status').notNull().default('pending'),
    intentDecision: text('intent_decision').notNull(),
    intentConfidence: numeric('intent_confidence').notNull(),
    sourceMessageHash: text('source_message_hash').notNull(),
    retrievalSnapshotHash: text('retrieval_snapshot_hash'),
    policyHash: text('policy_hash').notNull(),
    baselineResponseHash: text('baseline_response_hash'),
    replayStatus: text('replay_status').notNull().default('pending'),
    replayLeaseToken: text('replay_lease_token'),
    replayLeaseExpiresAt: timestamp('replay_lease_expires_at', { withTimezone: true }),
    replayAttemptCount: integer('replay_attempt_count').notNull().default(0),
    replayError: text('replay_error'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique('consulting_insight_shadow_settlement_unique').on(t.settlementId),
    unique('consulting_insight_shadow_user_message_unique').on(t.userMessageId),
    index('consulting_insight_shadow_workspace_status_idx').on(t.workspaceId, t.status, t.createdAt),
    index('consulting_insight_shadow_retrieval_idx').on(t.retrievalRunId),
    check('consulting_insight_shadow_status_check', sql`${t.status} IN ('pending','response_completed','succeeded','failed','cancelled','timed_out','failed_settlement','snapshot_invalid')`),
    check('consulting_insight_shadow_intent_check', sql`${t.intentDecision} = 'analysis'`),
    check('consulting_insight_shadow_confidence_check', sql`${t.intentConfidence} >= 0 AND ${t.intentConfidence} <= 1`),
    check('consulting_insight_shadow_hash_check', sql`${t.sourceMessageHash} ~ '^[a-f0-9]{64}$' AND ${t.retrievalSnapshotHash} ~ '^[a-f0-9]{64}$' AND ${t.policyHash} ~ '^[a-f0-9]{64}$' AND (${t.baselineResponseHash} IS NULL OR ${t.baselineResponseHash} ~ '^[a-f0-9]{64}$')`),
    check('consulting_insight_shadow_replay_status_check', sql`${t.replayStatus} IN ('pending','processing','completed','failed','snapshot_invalid')`),
  ],
);

export const consultingInsightShadowResults = pgTable(
  'consulting_insight_shadow_results',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    shadowTurnId: uuid('shadow_turn_id').notNull().references(() => consultingInsightShadowTurns.id, { onDelete: 'cascade' }),
    resultHash: text('result_hash').notNull(),
    result: jsonb('result').$type<Record<string, unknown>>().notNull(),
    ...timestamps,
  },
  (t) => [
    unique('consulting_insight_shadow_results_turn_unique').on(t.shadowTurnId),
    check('consulting_insight_shadow_results_hash_check', sql`${t.resultHash} ~ '^[a-f0-9]{64}$'`),
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
