#!/usr/bin/env bash
set -euo pipefail

URL="${CONSULTING_HEALTH_URL:-https://consulting.jigooo.com/api/health/ready}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${CONSULTING_HEALTH_LOG_DIR:-$ROOT/logs/healthcheck}"
mkdir -p "$LOG_DIR"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LOG_FILE="$LOG_DIR/health-$(date -u +%Y%m%d).log"
TMP="$(mktemp)"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

status="curl_failed"
code="000"
if response_headers=$(curl -fsS -m 15 -w '\n%{http_code}' "$URL" -o "$TMP" 2>&1); then
  code="$(printf '%s' "$response_headers" | tail -n 1)"
  if python3 - "$TMP" >/tmp/consulting-health-parse.$$ 2>&1 <<'PY'
import json, sys
p=sys.argv[1]
d=json.load(open(p, encoding='utf-8'))
components=d.get('components') or {}
assert d.get('status') in {'ok', 'ready'}, d
assert components.get('api', 'ok') == 'ok', d
assert components.get('db', d.get('db')) == 'ok', d
assert components.get('redis', d.get('redis')) == 'ok', d
PY
  then
    echo "$TS ok code=$code" >> "$LOG_FILE"
    find "$LOG_DIR" -type f -name 'health-*.log' -mtime +14 -delete || true
    rm -f /tmp/consulting-health-parse.$$
    exit 0
  else
    status="bad_payload"
    detail="$(cat /tmp/consulting-health-parse.$$ 2>/dev/null || true)"
    rm -f /tmp/consulting-health-parse.$$
  fi
else
  status="curl_failed"
  detail="$response_headers"
fi

body="$(tr -d '\000' < "$TMP" | head -c 1200 || true)"
echo "$TS fail status=$status code=$code detail=${detail:-} body=$body" >> "$LOG_FILE"
cat <<EOF
컨설팅 웹앱 공개 헬스체크 실패
시간(UTC): $TS
URL: $URL
상태: $status
HTTP: $code
상세: ${detail:-없음}
본문: ${body:-없음}
EOF
exit 2
