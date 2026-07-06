CREATE INDEX IF NOT EXISTS "chat_messages_thread_cursor_idx" ON "chat_messages" ("thread_id", "created_at", "id");
