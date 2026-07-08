#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.pg18-rehearsal.yml"
ENV_FILE="$ROOT/.env.docker"
SQL_FILE="$ROOT/scripts/pg18_migration/create_extensions.sql"
SERVICE="pg18"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing env file: $ENV_FILE" >&2
  exit 2
fi

# Apply extensions inside the isolated rehearsal container only.
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T "$SERVICE" \
  sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f -' < "$SQL_FILE"

EXT_JSON="$(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T "$SERVICE" \
  sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -AtX -v ON_ERROR_STOP=1 -f -' <<'SQL'
SELECT COALESCE(json_agg(extname ORDER BY extname), '[]'::json)::text FROM pg_extension;
SQL
)"

python3 - "$EXT_JSON" <<'PY'
import json
import sys
expected = {"vector", "pg_trgm", "uuid-ossp", "btree_gin"}
extensions = set(json.loads(sys.argv[1]))
missing = sorted(expected - extensions)
if missing:
    raise SystemExit(f"missing extensions: {missing}; installed={sorted(extensions)}")
print(json.dumps({"ok": True, "extensions": sorted(extensions)}, ensure_ascii=False))
PY
