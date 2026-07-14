ALTER TABLE chat_turn_settlements
  DROP CONSTRAINT IF EXISTS chat_turn_settlements_status_check;
--> statement-breakpoint
ALTER TABLE chat_turn_settlements
  ADD CONSTRAINT chat_turn_settlements_status_check
  CHECK (status IN ('capturing', 'pending', 'processing', 'completed', 'dead'));
