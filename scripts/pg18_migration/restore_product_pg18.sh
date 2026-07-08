#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET_CONTAINER="${TARGET_CONTAINER:-consulting-web-pg18-rehearsal-pg18-1}"
DUMP="${1:?usage: restore_product_pg18.sh /path/to/product_pg16.dump}"

if [[ ! -s "$DUMP" ]]; then
  echo "missing or empty dump: $DUMP" >&2
  exit 2
fi

cat "$DUMP" | docker exec -i "$TARGET_CONTAINER" sh -lc 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-acl --exit-on-error'
# Restore product objects first; then ensure PG18 rehearsal-only extensions remain available.
docker exec -i "$TARGET_CONTAINER" sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f -' < "$ROOT/scripts/pg18_migration/create_extensions.sql"
python3 - "$DUMP" "$TARGET_CONTAINER" <<'PY'
import json, os, sys
print(json.dumps({"ok": True, "restored_dump": sys.argv[1], "target_container": sys.argv[2], "dump_bytes": os.path.getsize(sys.argv[1])}, ensure_ascii=False))
PY
