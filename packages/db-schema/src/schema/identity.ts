import { pgTable, text, timestamp, uuid, index, unique } from 'drizzle-orm/pg-core';
import { entityStatus, systemRole, authProvider } from './enums';
import { primaryId, timestamps, softDelete } from './_shared';

/** Users — global identity. Access to spaces comes via memberships (ADR-0009). */
export const users = pgTable(
  'users',
  {
    id: primaryId,
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash'),
    systemRole: systemRole('system_role').notNull().default('user'),
    status: entityStatus('status').notNull().default('active'),
    ...timestamps,
    ...softDelete,
  },
  (t) => [unique('users_email_unique').on(t.email)],
);

/** External auth linkages (ADR-0009). */
export const accounts = pgTable(
  'accounts',
  {
    id: primaryId,
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: authProvider('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique('accounts_provider_unique').on(t.provider, t.providerAccountId),
    index('accounts_user_idx').on(t.userId),
  ],
);

/** Refresh-token backed sessions (design §13). Only token hashes stored. */
export const sessions = pgTable(
  'sessions',
  {
    id: primaryId,
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    userAgent: text('user_agent'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);
