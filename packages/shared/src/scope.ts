/**
 * Space hierarchy vocabulary — LOCKED by ADR-0002.
 * Internal DB/API always uses these; UI labels are localized separately.
 */
export const SCOPE_TYPES = [
  'workspace',
  'project',
  'channel',
  'topic',
  'thread',
] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

/** Ordered parent→child. Index gives depth; used for scope-chain math. */
export const SCOPE_ORDER: readonly ScopeType[] = SCOPE_TYPES;

export const scopeDepth = (t: ScopeType): number => SCOPE_ORDER.indexOf(t);

export const parentScopeType = (t: ScopeType): ScopeType | null => {
  const i = SCOPE_ORDER.indexOf(t);
  return i <= 0 ? null : (SCOPE_ORDER[i - 1] as ScopeType);
};

/** Lifecycle status shared by all major entities (ADR-0016, design §26.2). */
export const ENTITY_STATUSES = [
  'active',
  'archived',
  'suspended',
  'deleted_soft',
] as const;
export type EntityStatus = (typeof ENTITY_STATUSES)[number];

/** Risk levels for the Approval Inbox — LOCKED by ADR-0004/design §27.4. */
export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
