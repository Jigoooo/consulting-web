CREATE UNIQUE INDEX IF NOT EXISTS "sessions_refresh_token_hash_unique"
  ON "sessions" ("refresh_token_hash");