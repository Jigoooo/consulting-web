import { pgTable, text, uuid, index, unique } from 'drizzle-orm/pg-core';
import { scopeType } from './enums';
import { workspaces } from './organization';
import { users } from './identity';
import { primaryId, timestamps, softDelete } from './_shared';

/**
 * User-visible prompt/profile metadata for channel/topic scopes.
 * Polymorphic scope_id is runtime-validated by ScopeProfileService.
 */
export const scopeProfiles = pgTable(
  'scope_profiles',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    scopeType: scopeType('scope_type').notNull(),
    scopeId: uuid('scope_id').notNull(),
    purpose: text('purpose').notNull().default(''),
    role: text('role').notNull().default(''),
    style: text('style').notNull().default(''),
    rules: text('rules').notNull().default(''),
    source: text('source').notNull().default('manual'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    unique('scope_profiles_scope_unique').on(t.workspaceId, t.scopeType, t.scopeId),
    index('scope_profiles_workspace_idx').on(t.workspaceId),
    index('scope_profiles_scope_idx').on(t.scopeType, t.scopeId),
  ],
);
