import { pgTable, text, timestamp, uuid, index, unique } from 'drizzle-orm/pg-core';
import { entityStatus, spaceRole, scopeType } from './enums';
import { users } from './identity';
import { primaryId, timestamps, softDelete } from './_shared';

/** Workspace = tenant boundary (ADR-0001). Personal + shared. */
export const workspaces = pgTable('workspaces', {
  id: primaryId,
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  isPersonal: text('is_personal').notNull().default('false'),
  ownerUserId: uuid('owner_user_id')
    .notNull()
    .references(() => users.id),
  status: entityStatus('status').notNull().default('active'),
  ...timestamps,
  ...softDelete,
});

/**
 * Membership grants a user a role at a scope (ADR-0009).
 * scopeType/scopeId identify workspace/project/channel/topic.
 * workspace_id is denormalized for tenant filtering (ADR-0001).
 */
export const memberships = pgTable(
  'memberships',
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
    role: spaceRole('role').notNull(),
    ...timestamps,
  },
  (t) => [
    unique('memberships_unique').on(t.scopeType, t.scopeId, t.userId),
    index('memberships_workspace_idx').on(t.workspaceId),
    index('memberships_user_idx').on(t.userId),
  ],
);

/** Invitations — the only way to grant shared access (ADR-0009). token hash only. */
export const invitations = pgTable(
  'invitations',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      .references(() => users.id),
    scopeType: scopeType('scope_type').notNull(),
    scopeId: uuid('scope_id').notNull(),
    role: spaceRole('role').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique('invitations_token_unique').on(t.tokenHash),
    index('invitations_workspace_idx').on(t.workspaceId),
    index('invitations_email_idx').on(t.email),
  ],
);

/** Contacts — convenience only; grants NO access (ADR-0009). */
export const contacts = pgTable(
  'contacts',
  {
    id: primaryId,
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    contactUserId: uuid('contact_user_id').references(() => users.id),
    email: text('email'),
    displayName: text('display_name'),
    status: text('status').notNull().default('pending'),
    ...timestamps,
  },
  (t) => [index('contacts_owner_idx').on(t.ownerUserId)],
);
