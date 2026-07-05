#!/usr/bin/env bash
set -euo pipefail

# Phase 3 C-4: snapshot the Docker production Postgres database.
# Secrets stay inside the pg container env; this script never prints them.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT}/backups/postgres"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CONTAINER="${POSTGRES_CONTAINER:-consulting-web-pg-1}"
mkdir -p "$OUT_DIR"
OUT="${OUT_DIR}/consulting-${STAMP}.dump"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "[backup] missing container: $CONTAINER" >&2
  exit 1
fi

# Custom format (-Fc) supports pg_restore and is compact/validated.
docker exec "$CONTAINER" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-acl' > "$OUT"

# Sanity-check the archive inside a disposable Postgres image/tooling context.
docker run --rm -i postgres:16-alpine pg_restore -l < "$OUT" >/dev/null
sha256sum "$OUT" > "${OUT}.sha256"
bytes="$(wc -c < "$OUT")"
sha="$(cut -d' ' -f1 "${OUT}.sha256")"
echo "[backup] ok path=$OUT bytes=$bytes sha256=$sha"
