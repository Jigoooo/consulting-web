#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

mapfile -t staged < <(git diff --cached --name-only --diff-filter=ACMR)

if [[ ${#staged[@]} -eq 0 ]]; then
  exit 0
fi

architecture_regex='^(docker-compose.*\.ya?ml|packages/(db-schema|contracts)/|apps/api/src/(consulting|chat|infra|config)/|apps/api/scripts/(graphrag_eval_gate\.py|ralph_graphrag_hardening\.py|ingest_web_dialogue\.py)|apps/web/src/(widgets/(chat-thread|evidence-panel|app-shell)|features|shared)/)'
doc_regex='^docs/(consulting-layer-map\.md|consulting-db-postgres-review\.md)$'

architecture_changed=0
doc_changed=0
for path in "${staged[@]}"; do
  if [[ "$path" =~ $architecture_regex ]]; then
    architecture_changed=1
  fi
  if [[ "$path" =~ $doc_regex ]]; then
    doc_changed=1
  fi
done

if [[ $architecture_changed -eq 1 && $doc_changed -eq 0 ]]; then
  cat >&2 <<'MSG'
[consulting-doc-sync] 아키텍처 영향 파일이 staged 되었지만 문서가 함께 갱신되지 않았습니다.

필수 확인/갱신 문서:
  - docs/consulting-layer-map.md
  - docs/consulting-db-postgres-review.md

의도적으로 문서 변경이 필요 없으면, 커밋 전에 위 문서 중 하나에 "No architecture doc change needed" 근거를 남기거나
CONSULTING_DOC_SYNC_SKIP=1 git commit ... 으로 1회 우회하세요.
MSG
  if [[ "${CONSULTING_DOC_SYNC_SKIP:-}" == "1" ]]; then
    echo "[consulting-doc-sync] CONSULTING_DOC_SYNC_SKIP=1 set; allowing commit." >&2
    exit 0
  fi
  exit 1
fi

for doc in docs/consulting-layer-map.md docs/consulting-db-postgres-review.md; do
  if [[ -f "$doc" && ! -s "$doc" ]]; then
    echo "[consulting-doc-sync] $doc exists but is empty" >&2
    exit 1
  fi
done

exit 0
