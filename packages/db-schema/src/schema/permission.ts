import { pgTable, text, uuid, boolean, index, unique } from 'drizzle-orm/pg-core';
import { scopeType } from './enums';
import { workspaces } from './organization';
import { users } from './identity';
import { primaryId, timestamps } from './_shared';

/**
 * Direct permission overrides on top of role inheritance (ADR-0010).
 * deny takes precedence over allow in the engine.
 */
export const permissionOverrides = pgTable(
  'permission_overrides',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scopeType: scopeType('scope_type').notNull(),
    scopeId: uuid('scope_id').notNull(),
    permission: text('permission').notNull(),
    /** true = allow, false = deny (deny wins). */
    allow: boolean('allow').notNull(),
    ...timestamps,
  },
  (t) => [
    unique('permission_overrides_unique').on(
      t.userId,
      t.scopeType,
      t.scopeId,
      t.permission,
    ),
    index('permission_overrides_workspace_idx').on(t.workspaceId),
    index('permission_overrides_user_idx').on(t.userId),
  ],
);
