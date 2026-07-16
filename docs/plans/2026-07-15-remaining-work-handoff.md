# 남은 작업 핸드오프 — V3 historical / cross-channel / P6

- 작성 시각: 2026-07-15T21:59:58+09:00
- 주 저장소: `/home/jigoo/.hermes/workspace/consulting-web`
- 공유 두뇌 저장소: `/home/jigoo/.hermes/workspace/consulting`
- 목적: 새 Hermes 세션에서 아래 3개 TODO를 증거·승인 경계를 보존한 채 이어서 수행

## 새 세션 시작 지침

1. 이 문서를 먼저 읽는다.
2. `skill_view`로 `fable-thinking`, `long-task-orchestration`, `consulting-web-architecture`, `consulting-advanced-graphrag-hardening`을 로드한다.
3. 두 저장소의 `git status --short`를 다시 읽는다.
4. 아래 수치와 `/tmp` artifact는 현재 사실이 아니라 **재검증 대상**으로 취급한다.
5. synthetic sample, AI가 만든 human label, 가짜 causal data로 gate를 통과시키지 않는다.
6. 기존 W3 dirty 변경을 덮어쓰거나 정리하지 않는다. 커밋·푸시는 별도 요청 전 금지한다.

---

## 현재 TODO

| ID | 상태 | 완료 조건 |
|---|---|---|
| `v3-historical-data-gate` | IN PROGRESS | 최신 독립 리뷰 HIGH 0 → cron quiesce → 1,112행 apply → DB readback → reverse rehearsal → cron resume |
| `v3-cross-channel-pilot` | PENDING | Telegram과 Web 양쪽에 자연 발생 analysis 성공표본 확보 후 response-invariant 비교; synthetic 금지 |
| `p6-advanced-rag-reentry` | HOLD/PENDING | 사람 relevance label ≥50, lineaged community summary, 실제 causal 처치/결과 데이터 확보 후 재평가 |

---

# 1. V3 historical data gate

## 1.1 현재 결론

- 기존 preview blocker: `unproven_chat=60`.
- 원 `~/.hermes/state.db`의 exact message/session을 전수 확인하여 60건이 4개 Telegram 세션에 속함을 확인했다.
- 판정: 4개 세션 모두 당시 창원 컨설팅 topic `12`로 수동 adjudication.
- 근거:
  - source가 Telegram.
  - 원문에 JigooConsultingAi/컨설팅-창원 맥락이 존재.
  - 3개 세션의 당시 system prompt에 승인 그룹과 thread `12`가 명시.
  - 첫 세션은 topic 연결 작업 원문과 동일 승인 그룹 근거를 사용.
- raw `state.db`는 수정하지 않았다.

## 1.2 변경 파일 — 이 4개만 historical scope

```text
apps/api/test_python/test_apply_changwon_telegram_reclassification.py
apps/api/test_python/test_preview_changwon_telegram_reclassification.py
scripts/apply_changwon_telegram_reclassification.py
scripts/preview_changwon_telegram_reclassification.py
```

구현한 안전 계약:

- manual adjudication 입력은 regular file, 현재 UID 소유, mode `0600`, symlink 거부.
- session metadata/system prompt hash와 exact imported message role/timestamp/content hash로 source fingerprint 생성.
- raw source가 `telegram + chat_id NULL + thread_id NULL`인 세션만 adjudication 가능.
- 승인 chat, active registered route만 허용.
- duplicate session, stale fingerprint, foreign/exact provenance override를 거부.
- preview schema `v3-5-preview-4.0`에 adjudication rows/hash/input artifact SHA를 결박.
- apply loader와 commit 직전 fresh snapshot이 embedded adjudication을 raw A/B source에 다시 적용·검증.
- mapping/reverse/fixed-set/privacy hash 계약 유지.

## 1.3 마지막 검증값

- focused Python tests: **24 passed**.
- `py_compile`: 성공.
- `git diff --check`: 성공.
- manual adjudication artifact:
  - `/tmp/v3-historical-manual-adjudications.json`
  - mode `0600`
  - decisions `4`
  - 마지막 SHA `498c5d0abe04e2e1bf0fa300ee1e3c2e2a6fbd9b3fbd5cc92bf3065b6ada3890`
- adjudicated preview:
  - `/tmp/v3-historical-preview-adjudicated.json`
  - 마지막 SHA `938033ccb290325ec18280d4d39665ee5dfdc62bca58713936ee61fecd165553`
  - rows `1,112`
  - classifications: `exact=1,087`, `general=22`, `unknown_to_general=3`, `unproven_chat=0`
  - blockers `[]`, privacy violations `[]`
  - app/source snapshot fence 모두 `true`
- 운영 DB dry-run:
  - 1,112행 CAS/route/ancestor lock/affected-count 성공
  - `committed=false`, 최종 ROLLBACK

`/tmp`는 재부팅·정리 시 사라질 수 있으므로 존재하더라도 새 세션에서 fingerprint와 SHA를 다시 생성한다.

## 1.4 독립 리뷰 상태

- 오래된 설계 리뷰 `deleg_fd7e6c8e`는 600초 timeout, 결과 없음. 승인 근거로 사용 금지.
- 최신 구현 대상 보안/운영 리뷰 batch `deleg_a0c0f4ad`도 두 작업 모두 parent interruption으로 완료되지 않아 판정이 없다. 승인 근거로 사용 금지.
- 새 세션에서는 현재 diff를 대상으로 BLOCKER/HIGH 독립 리뷰를 **다시 실행**하고, `BLOCKER 0 / HIGH 0`이 아니면 apply 금지.

## 1.5 재개 명령

```bash
cd /home/jigoo/.hermes/workspace/consulting-web

git diff --check -- \
  scripts/preview_changwon_telegram_reclassification.py \
  scripts/apply_changwon_telegram_reclassification.py \
  apps/api/test_python/test_preview_changwon_telegram_reclassification.py \
  apps/api/test_python/test_apply_changwon_telegram_reclassification.py

python3 -m unittest \
  apps.api.test_python.test_preview_changwon_telegram_reclassification \
  apps.api.test_python.test_apply_changwon_telegram_reclassification -v

python3 -m py_compile \
  scripts/preview_changwon_telegram_reclassification.py \
  scripts/apply_changwon_telegram_reclassification.py
```

manual adjudication artifact는 현재 source fingerprint로 다시 생성한다. 기존 `/tmp` 파일을 맹신하지 않는다. 생성 후:

```bash
python3 scripts/preview_changwon_telegram_reclassification.py \
  --manual-adjudications /tmp/v3-historical-manual-adjudications.json \
  --output /tmp/v3-historical-preview-adjudicated.json \
  --stdout

sha256sum /tmp/v3-historical-preview-adjudicated.json
```

commit 전 dry-run:

```bash
python3 scripts/apply_changwon_telegram_reclassification.py \
  --artifact /tmp/v3-historical-preview-adjudicated.json \
  --approved-sha256 '<방금 실측한 SHA256>' \
  --direction apply
```

## 1.6 운영 apply 절차

동기화 cron:

- 이름: `sync-changwon-telegram-to-consulting-web`
- 마지막 확인 job ID: `42050479fd10`
- 문서 작성 당시 enabled/scheduled. 새 세션에서 `cronjob list`로 ID와 상태를 재확인한다.

HIGH 0 및 fresh preview/dry-run 성공 후에만:

1. cronjob `42050479fd10` pause.
2. 실제 scheduler state가 paused인지 readback.
3. 새 cryptographic nonce 생성.
4. artifact SHA 재계산.
5. 아래 commit 실행.
6. receipt와 DB row count/readback 검증.
7. 동일 artifact로 `--direction reverse` **non-commit rehearsal** 수행.
8. 성공/실패와 무관하게 cron resume 후 상태 readback.

```bash
python3 scripts/apply_changwon_telegram_reclassification.py \
  --artifact /tmp/v3-historical-preview-adjudicated.json \
  --approved-sha256 '<즉시 재계산한 SHA256>' \
  --direction apply \
  --sync-job-id 42050479fd10 \
  --quiesce-nonce '<새 nonce>' \
  --commit \
  --receipt /tmp/v3-historical-apply-receipt.json
```

주의:

- `--commit` 없는 실행은 ROLLBACK rehearsal이다.
- commit 결과가 timeout/nonzero이고 receipt가 없으면 상태를 추측하지 말고 ledger/readback으로 `committed true|false|unknown`을 판정한다.
- reverse용 원 artifact와 receipt를 삭제하지 않는다.
- apply 후 Telegram mirror와 Web 중복 공존은 현재 의도된 구조다. Telegram 폐기 작업으로 오인해 삭제하지 않는다.

---

# 2. V3 cross-channel natural pilot

## 2.1 현재 상태

Web 운영 API:

- `CONSULTING_INSIGHT_WEB_SHADOW_MODE=shadow`
- exact Web thread allowlist 설정됨.
- policy hash 길이 64, worker 활성 조건 충족.
- `consulting_insight_shadow_turns=0`
- `consulting_insight_shadow_results=0`

Telegram:

- gateway `CONSULTING_INSIGHT_SHADOW_ENABLED=true`.
- allowed route는 창원 보수체계 thread `524` 한정.
- store: `~/.hermes/consulting-insight/shadow.db`
- 마지막 확인 row 1건은 자연 성공표본이 아니라 과거 observer process loss 복구행:
  - `status=failed`
  - `replay_status=abstained`
  - `terminal_reason=observer_process_loss`
- replay timer/service 자체는 정상 실행되고 처리 대기건 0.

## 2.2 Gate

pilot을 실행하려면 양쪽 모두 다음을 만족해야 한다.

- 사람이 실제로 보낸 자연 analysis 요청.
- baseline response가 정상 완료.
- shadow replay가 `completed`.
- 동일 policy hash 및 대응 가능한 intent/근거 lineage.
- 사용자 응답·latency·tool side effect 불변.

금지:

- synthetic message 생성.
- marker 질문을 자연표본으로 계산.
- failed/abstained/process-loss 행을 성공 denominator에 포함.
- 다른 topic/channel의 표본 혼합.

## 2.3 다음 행동

- 새 자연 사용이 발생한 뒤 두 store를 read-only 재측정한다.
- 성공표본이 없으면 `v3-cross-channel-pilot`은 pending을 유지하고 “0 sample”을 실패로 포장하지 않는다.
- 양쪽 성공표본이 생기면 intent, policy hash, source hash, retrieval lineage, baseline/shadow outcome을 비교한 pilot report를 만든다.

---

# 3. P6 advanced RAG re-entry

## 3.1 마지막 운영 실측

App PostgreSQL:

- `retrieval_runs=10`
- `retrieval_hits=4`
- `judged_relevant IS NOT NULL=0`
- `failure_type IS NOT NULL=0`
- `retrieval_eval_runs=10`
- `retrieval_trace_spans=21`
- `decision_analytics_runs=0` — 운영 smoke cleanup 후 정상
- `decision_scorecards=6`
- `claim_verification_verdicts=24`

PG18 shared brain:

- `brain_raw.topics=254`
- `brain_rag.chunk_texts=2,789`
- `brain_raw.dialogue_edges=1,637`
- `brain_raw.file_edges=1,972`
- `brain_raw.community_summaries` table 존재
- community summary rows `0`

## 3.2 이미 있는 제품 경로

- retrieval hit feedback API/store가 이미 배포돼 있다.
- Web UI에서 `judgedRelevant`와 failure taxonomy를 기록할 수 있다.
- RAG metrics는 이 사람 라벨을 precision@k/MRR/coverage로 집계한다.
- 따라서 “AI가 대신 50개 라벨 생성”은 금지하며 새 labeling API를 중복 구축할 필요도 없다.

## 3.3 아직 충족되지 않은 Gate

1. 사람 relevance label: `0 / 50`.
2. lineaged materialized community summary: `0행`.
3. 실제 causal 처치·결과·교란변수 원장: 없음.

따라서 P6 heavy integration은 HOLD다.

## 3.4 community summary 주의

- `consulting/scripts/advanced_graphrag_layers.py`의 writer는 SQLite `advanced_graphrag_nodes`용이다.
- PG runtime은 `pg_backend.py`에서 no-dependency connected-component summary를 on-the-fly로 제공할 수 있다.
- PG18의 `brain_raw.community_summaries`는 optional cache지만 현재 0행이다.
- SQLite writer를 PG table에 억지로 사용하지 않는다.
- materialization을 진행하려면 PG-safe deterministic builder/upsert, member chunk lineage, idempotency, topic isolation, stale invalidation, read-path parity 테스트를 먼저 설계한다.

## 3.5 재진입 순서

1. 자연 retrieval hit가 충분히 축적될 때까지 기존 feedback UI를 사용해 사람이 판정.
2. label 50건 이상에서 precision/MRR/coverage를 다시 측정.
3. PG-safe community summary materializer를 별도 TDD/리뷰 후 운영 생성하고 lineage 100% 확인.
4. causal 데이터 계약을 먼저 정의:
   - treatment/exposure
   - outcome
   - timestamp
   - scope/entity
   - confounders
   - provenance
5. 실제 관찰 데이터가 쌓이기 전 causal ranking/product claim 금지.
6. 세 gate가 모두 충족된 뒤 `p6_precision_trace_loop.py` baseline 3회와 adversarial gate를 재실행해 재진입 판단.

---

# 4. Dirty worktree 보호

현재 `consulting-web`에는 W3 운영 배포 관련 다수 tracked/untracked 변경이 함께 존재한다. historical 변경은 위 4개 파일뿐이다.

금지:

- `git reset --hard`, `git clean`, stash-all.
- 백업본으로 전체 덮어쓰기.
- W3와 historical을 한 커밋으로 섞기.
- commit/push/rebase를 사용자 요청 없이 수행.

새 세션은 항상 대상 repo와 수정 파일을 먼저 명시한다.

---

# 5. 종료 기준

- Historical: independent HIGH 0 + committed receipt + 1,112행 readback + reverse rehearsal + cron resumed.
- Cross-channel: 자연 성공표본 기반 pilot report; 표본 없으면 pending 유지.
- P6: human labels ≥50 + lineaged community summaries + causal dataset 이후에만 re-entry GO/NO-GO.
