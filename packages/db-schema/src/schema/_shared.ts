import { sql } from 'drizzle-orm';
import { timestamp, uuid, integer } from 'drizzle-orm/pg-core';

/** Standard audit/lifecycle columns for every table. */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** Soft-delete marker (ADR-0016). Null = live. */
export const softDelete = {
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};

/** Optimistic-concurrency version (ADR-0020, design §26.3). */
export const optimisticVersion = {
  version: integer('version').notNull().default(1),
};

/** Primary uuid key with DB-side default. */
export const primaryId = uuid('id')
  .primaryKey()
  .default(sql`gen_random_uuid()`);
