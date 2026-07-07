-- Bind uploaded chat attachments to the user message that sent them.
-- NULL = draft composer attachment not yet sent; non-null = visible message file card.

ALTER TABLE file_attachments
  ADD COLUMN IF NOT EXISTS message_id uuid REFERENCES chat_messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS file_attachments_message_idx
  ON file_attachments(message_id, created_at);
