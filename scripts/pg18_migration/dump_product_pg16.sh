#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP_DIR="$ROOT/backups/pg18-migration"
SOURCE_CONTAINER="${SOURCE_CONTAINER:-consulting-web-pg-1}"
TS="$(date +%Y%m%d_%H%M%S)"
OUT="${1:-$BACKUP_DIR/product_pg16_${TS}.dump}"

mkdir -p "$(dirname "$OUT")"

docker exec "$SOURCE_CONTAINER" sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-acl' > "$OUT"
sha256sum "$OUT" > "$OUT.sha256"
python3 - "$OUT" <<'PY'
import json, os, sys
path = sys.argv[1]
print(json.dumps({"ok": True, "dump": path, "bytes": os.path.getsize(path), "sha256_file": path + ".sha256"}, ensure_ascii=False))
PY
