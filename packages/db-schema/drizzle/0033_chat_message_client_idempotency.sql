ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS client_message_id uuid;
--> statement-breakpoint
ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS client_request_hash text;
--> statement-breakpoint
ALTER TABLE chat_messages
  DROP CONSTRAINT IF EXISTS chat_messages_client_message_user_check;
--> statement-breakpoint
ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_client_message_user_check
  CHECK (
    (client_message_id IS NULL AND client_request_hash IS NULL)
    OR (
      client_message_id IS NOT NULL
      AND client_request_hash IS NOT NULL
      AND role = 'user'
      AND author_user_id IS NOT NULL
    )
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_workspace_user_client_message_unique
  ON chat_messages (workspace_id, author_user_id, client_message_id);
