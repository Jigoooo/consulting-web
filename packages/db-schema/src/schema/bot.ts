import { bigserial, boolean, pgTable, text, uuid, jsonb, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { scopeType, botInvokePolicy, riskLevel, approvalStatus } from './enums';
import { workspaces } from './organization';
import { users } from './identity';
import { primaryId, timestamps } from './_shared';

/** Bot definition (ADR-0004). */
export const botAgents = pgTable(
  'bot_agents',
  {
    id: primaryId,
    name: text('name').notNull(),
    handle: text('handle').notNull(),
    ...timestamps,
  },
  (t) => [unique('bot_agents_handle_unique').on(t.handle)],
);

/** Bot installed at a scope with an invoke policy (ADR-0004). */
export const botInstallations = pgTable(
  'bot_installations',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    botAgentId: uuid('bot_agent_id')
      .notNull()
      .references(() => botAgents.id, { onDelete: 'cascade' }),
    scopeType: scopeType('scope_type').notNull(),
    scopeId: uuid('scope_id').notNull(),
    invokePolicy: botInvokePolicy('invoke_policy').notNull().default('mention_only'),
    ...timestamps,
  },
  (t) => [
    unique('bot_installations_unique').on(t.botAgentId, t.scopeType, t.scopeId),
    index('bot_installations_workspace_idx').on(t.workspaceId),
  ],
);

/** Capability grants — separate from invoke permission (ADR-0004). */
export const botCapabilityGrants = pgTable(
  'bot_capability_grants',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => botInstallations.id, { onDelete: 'cascade' }),
    capability: text('capability').notNull(),
    scopeType: scopeType('scope_type').notNull(),
    scopeId: uuid('scope_id').notNull(),
    grantedByUserId: uuid('granted_by_user_id')
      .notNull()
      .references(() => users.id),
    ...timestamps,
  },
  (t) => [
    unique('bot_capability_unique').on(t.installationId, t.capability, t.scopeType, t.scopeId),
    index('bot_capability_workspace_idx').on(t.workspaceId),
  ],
);

/** One bot execution triggered by a user (ADR-0004). idempotency-keyed. */
export const botInvocations = pgTable(
  'bot_invocations',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => botInstallations.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id),
    scopeType: scopeType('scope_type').notNull(),
    scopeId: uuid('scope_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull().default('created'),
    ...timestamps,
  },
  (t) => [
    unique('bot_invocations_idem_unique').on(t.idempotencyKey),
    index('bot_invocations_workspace_idx').on(t.workspaceId),
  ],
);

/** Approval Inbox for sensitive actions (design §27.4). */
export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id),
    requestedByBotId: uuid('requested_by_bot_id').references(() => botAgents.id),
    actionType: text('action_type').notNull(),
    payload: jsonb('payload').notNull(),
    riskLevel: riskLevel('risk_level').notNull(),
    status: approvalStatus('status').notNull().default('pending'),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('approval_requests_workspace_idx').on(t.workspaceId)],
);

export const toolPolicyAuditEvents = pgTable(
  'tool_policy_audit_events',
  {
    id: primaryId,
    sequenceNo: bigserial('sequence_no', { mode: 'number' }).notNull(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    decision: text('decision').notNull(),
    enabledToolsets: jsonb('enabled_toolsets').$type<string[]>().notNull().default([]),
    allowedToolsets: jsonb('allowed_toolsets').$type<string[]>().notNull().default([]),
    blockedToolsets: jsonb('blocked_toolsets').$type<string[]>().notNull().default([]),
    rejectedHighBlastGrants: jsonb('rejected_high_blast_grants').$type<string[]>().notNull().default([]),
    enforced: boolean('enforced').notNull(),
    policyHash: text('policy_hash').notNull(),
    previousHash: text('previous_hash'),
    eventHash: text('event_hash').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    unique('tool_policy_audit_workspace_run_unique').on(t.workspaceId, t.runId),
    unique('tool_policy_audit_event_hash_unique').on(t.eventHash),
    index('tool_policy_audit_workspace_sequence_idx').on(t.workspaceId, t.sequenceNo),
  ],
);
