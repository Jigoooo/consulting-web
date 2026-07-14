import { bigint, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { threads, chatMessages } from './space';

/**
 * Idempotent import ledger for Changwon Telegram → consulting-web message sync.
 *
 * One row per source message imported. `sync_changwon_telegram.py` inserts a row
 * inside the same transaction as the chat_messages insert, so an interrupted run
 * never double-imports and a second run reports imported_delta=0.
 *
 * Scope isolation invariants enforced by the sync script (V3-1 exact routing):
 * - only the approved Changwon Telegram chat id is imported (foreign chats blocked),
 * - an exact forum-thread id routes to its bound web thread,
 * - unknown / NULL thread ids route to the General/검토필요 review thread,
 * - archived/inactive targets are blocked (never a silent broad fallback).
 *
 * This table is append-only from the sync path; web_message_id/target_web_thread_id
 * form the reverse map used by the historical-reclassification preview/apply flow.
 */
export const telegramMessageImports = pgTable(
  'telegram_message_imports',
  {
    sourceSessionId: text('source_session_id').notNull(),
    sourceMessageId: bigint('source_message_id', { mode: 'number' }).notNull(),
    webMessageId: uuid('web_message_id')
      .notNull()
      .references(() => chatMessages.id, { onDelete: 'cascade' }),
    telegramChatId: text('telegram_chat_id'),
    telegramThreadId: text('telegram_thread_id'),
    // Nullable: pre-V3 historical rows predate exact routing and can only be backfilled by
    // the approved historical-reclassification flow (V3-5/V3-7). New sync rows always set it.
    targetWebThreadId: uuid('target_web_thread_id').references(() => threads.id, { onDelete: 'cascade' }),
    // Nullable for legacy rows. The V3 sync INSERT always writes the routing version explicitly;
    // only the approved historical reclassification flow may label pre-V3 rows later.
    routingVersion: text('routing_version'),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('telegram_message_imports_source_unique').on(t.sourceSessionId, t.sourceMessageId),
    uniqueIndex('telegram_message_imports_web_message_unique').on(t.webMessageId),
    index('telegram_message_imports_target_thread_idx').on(t.targetWebThreadId),
    index('telegram_message_imports_chat_thread_idx').on(t.telegramChatId, t.telegramThreadId),
  ],
);
