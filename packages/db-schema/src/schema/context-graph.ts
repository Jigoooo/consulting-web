import { pgTable, text, uuid, numeric, boolean, jsonb, index, unique } from 'drizzle-orm/pg-core';
import { scopeType, originType, edgeType, policyType } from './enums';
import { workspaces } from './organization';
import { primaryId, timestamps } from './_shared';

/** Reusable tag vocabulary (ADR-0002, design §21.3). */
export const contextTags = pgTable(
  'context_tags',
  {
    id: primaryId,
    key: text('key').notNull(),
    value: text('value').notNull(),
    normalizedValue: text('normalized_value').notNull(),
    ...timestamps,
  },
  (t) => [unique('context_tags_unique').on(t.key, t.normalizedValue)],
);

/** Tag applied to a scope, with provenance (ADR-0002). */
export const scopeTags = pgTable(
  'scope_tags',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    scopeType: scopeType('scope_type').notNull(),
    scopeId: uuid('scope_id').notNull(),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => contextTags.id, { onDelete: 'cascade' }),
    origin: originType('origin').notNull(),
    confidence: numeric('confidence'),
    locked: boolean('locked').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    unique('scope_tags_unique').on(t.scopeType, t.scopeId, t.tagId),
    index('scope_tags_workspace_idx').on(t.workspaceId),
    index('scope_tags_scope_idx').on(t.scopeType, t.scopeId),
  ],
);

/** Context edges — the graph layer over the tree (ADR-0002). */
export const contextEdges = pgTable(
  'context_edges',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    fromScopeType: scopeType('from_scope_type').notNull(),
    fromScopeId: uuid('from_scope_id').notNull(),
    toScopeType: scopeType('to_scope_type').notNull(),
    toScopeId: uuid('to_scope_id').notNull(),
    edgeType: edgeType('edge_type').notNull(),
    origin: originType('origin').notNull(),
    confidence: numeric('confidence'),
    ...timestamps,
  },
  (t) => [
    unique('context_edges_unique').on(
      t.fromScopeType,
      t.fromScopeId,
      t.toScopeType,
      t.toScopeId,
      t.edgeType,
    ),
    index('context_edges_workspace_idx').on(t.workspaceId),
    index('context_edges_from_idx').on(t.fromScopeType, t.fromScopeId),
  ],
);

/** Per-scope policies (permission/memory/bot/retention/visibility). */
export const scopePolicies = pgTable(
  'scope_policies',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    scopeType: scopeType('scope_type').notNull(),
    scopeId: uuid('scope_id').notNull(),
    policyType: policyType('policy_type').notNull(),
    policy: jsonb('policy').notNull(),
    inheritedFromScopeType: scopeType('inherited_from_scope_type'),
    inheritedFromScopeId: uuid('inherited_from_scope_id'),
    locked: boolean('locked').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    unique('scope_policies_unique').on(t.scopeType, t.scopeId, t.policyType),
    index('scope_policies_workspace_idx').on(t.workspaceId),
  ],
);
