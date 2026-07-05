import { pgEnum } from 'drizzle-orm/pg-core';

/** Lifecycle status shared by major entities (ADR-0016, design §26.2). */
export const entityStatus = pgEnum('entity_status', [
  'active',
  'archived',
  'suspended',
  'deleted_soft',
]);

/** Space hierarchy vocabulary — LOCKED by ADR-0002. */
export const scopeType = pgEnum('scope_type', [
  'workspace',
  'project',
  'channel',
  'topic',
  'thread',
]);

/** Space roles (design §8 권한 모델). */
export const spaceRole = pgEnum('space_role', [
  'owner',
  'admin',
  'editor',
  'commenter',
  'viewer',
]);

/** System-level roles. */
export const systemRole = pgEnum('system_role', [
  'platform_owner',
  'platform_admin',
  'user',
]);

/** Approval Inbox risk levels — LOCKED by ADR-0004. */
export const riskLevel = pgEnum('risk_level', ['low', 'medium', 'high', 'critical']);

/** Tag / edge / policy provenance (ADR-0002, design §21.3). */
export const originType = pgEnum('origin_type', [
  'manual',
  'inherited',
  'system',
  'bot',
  'classifier',
  'import',
]);

export const edgeType = pgEnum('edge_type', [
  'parent_of',
  'related_to',
  'derived_from',
  'shares_memory_with',
  'references',
  'supersedes',
]);

export const policyType = pgEnum('policy_type', [
  'permission',
  'memory',
  'bot',
  'retention',
  'visibility',
]);

/** Outbox delivery lifecycle (ADR-0005). */
export const outboxStatus = pgEnum('outbox_status', [
  'pending',
  'processing',
  'published',
  'failed',
  'dead',
]);

/** Bot invocation policy per installation (ADR-0004). */
export const botInvokePolicy = pgEnum('bot_invoke_policy', [
  'mention_only',
  'any_message',
  'admin_only',
  'disabled',
]);

/** Approval request lifecycle (design §27.4). */
export const approvalStatus = pgEnum('approval_status', [
  'pending',
  'approved',
  'rejected',
  'expired',
  'cancelled',
]);

/** Account auth providers (ADR-0009). */
export const authProvider = pgEnum('auth_provider', [
  'password',
  'email_otp',
  'google',
  'microsoft',
  'cloudflare',
]);

/** Chat message author kind (Phase 1.5 persistence). */
export const chatRole = pgEnum('chat_role', ['user', 'assistant']);
