# Consulting AI OS Full Implementation Roadmap — Fable Review

> **For Hermes:** 이 계획을 실행할 때는 `subagent-driven-development` + `test-driven-development`로 태스크 단위 구현/리뷰를 분리한다. DB migration apply, Docker 재시작, 외부 telemetry 활성화, MCP/tool 권한 변경은 주인님 명시 승인 후 진행한다.

**Goal:** `consulting` shared brain + `consulting-web` 제품 레이어를 “답변형 챗봇”이 아니라, claim/evidence/exactness/retrieval/memory/artifact가 추적·검증·학습되는 컨설팅 AI 업무 OS로 고도화한다.

**Architecture:** 현재 구조는 유지하되, 최근 커밋/런타임 변화를 반영한다. `consulting`은 공유 두뇌/GraphRAG 코어, `consulting-web`은 scope tree·Hermes SSE·검증·리뷰·산출물·운영 UI 레이어다. web/API 경로는 PG18 sidecar `brain_raw/brain_rag` 런타임 사용까지 전진했지만, 전체 consulting brain은 아직 SQLite 표면이 남아 있으므로 “완전 PG-only source-of-truth”로 선언하지 않는다. 새 Neo4j/Temporal/Langfuse는 먼저 도입하지 않고, 기존 Postgres + PG18 sidecar/SQLite rollback + BullMQ/outbox + local eval을 채운 뒤 병목이 실측될 때만 확장한다.

**Tech Stack:** NestJS 11, Drizzle/Postgres 16 app DB, PG18+pgvector sidecar for consulting brain runtime, Redis/BullMQ, React 19/Vite/TanStack, shared `consulting` GraphRAG, Gemini embeddings, Hermes Gateway, Vitest/Python eval scripts.

---

## 0. 읽은 근거 / 현재 실측 기준

### 기준 문서
- `docs/consulting-layer-map.md`
- `docs/plans/consulting-ai-system-improvement-roadmap.md`
- 관련 스킬: `fable-thinking`, `consulting-web-architecture`, `consulting-evidence-production-system`, `plan`, `writing-plans`

### 현재 구조의 핵심 사실 — 2026-07-08 23:54 KST 재측정
- `consulting`은 deprecated/legacy가 아니라 **shared consulting brain/core repo**다.
- web 채팅 흐름은 `ChatStreamController → ConsultingMemoryContextBuilder → ConsultingGraphRagBridge → HermesRunsClient → EvidenceDecisionStore → ConsultingWebIngestService`다.
- GraphRAG는 dialogue/file vector space를 분리하고 semantic/lexical/graph 신호를 RRF로 합친다.
- 최근 real embedding eval: `context_precision=0.2881`, `recall/hit=0.8667`, `p95=4.1242s`.
- live API container env는 현재 `CONSULTING_BRAIN_BACKEND=pg`, `CONSULTING_BRAIN_WRITE_BACKEND=pg`, `CONSULTING_PG_DSN_DRIVER=psycopg`다.
- PG18 sidecar `consulting-web-pg18-rehearsal-pg18-1`가 live이고, API compose/diff는 `pg18-rehearsal:5432`를 runtime DSN으로 사용한다.
- 단, 이것은 **web/API runtime PG path active**이지 **전체 shared brain PG-only source-of-truth 완료**가 아니다. Phase9 문서 기준 잔여 SQLite 표면: `writer_files=63`, `core_writer_files=4`, `sqlite_delete_safe=false`, `sqlite_connect_files=39`, `runtimeish_sqlite_connect_files=32`.
- App PG readback: `claim_verification_verdicts=0`, `exactness_runs=0`, `judgment_guard_runs=0`, `evidence_items=2`, `consulting_topic_links_non_project=0`, outbox는 `published=176`.

### 최근 커밋/런타임 고도화 delta
- `5c8b9df feat: add consulting judgment guard`: `ConsultingJudgmentGuardService`, `judgment_guard_runs` migration `0021`, verifier gate issue codes, prompt contract, regression tests가 추가됐다. 하지만 운영 row는 아직 0이라 “구조 완료 / 실사용 검증 미완” 상태다.
- `acce5a7 feat(spaces): add guided project setup`: project create wizard, project profile seed, strong/weak project connection(`shares_memory_with`/`related_to`), project settings modal, `scope_profiles(project)` migration `0020`가 추가됐다. 따라서 “프로젝트 생성/연결 UX”는 P4 신규개발이 아니라 QA·하드닝 트랙으로 재분류한다.
- `86ced82` + `32c6924`: 채팅 표 복사 버튼과 Excel/Sheets 서식 유지가 들어갔다. 보고서/표 기반 컨설팅 UX의 기본 생산성은 이미 개선됐다.
- `6ce50c4` 등 UI 커밋: cached channel switching, scroll/tail 안정화가 진행됐다. P4는 “기본 UI 생성”보다 Evidence/Review/Trace 업무 UI에 집중한다.
- PG18 Phase8/9 문서와 현재 diff: Phase9 문서는 PG-only live flip 보류를 기록하지만, 현재 live API env/diff는 `pg/pg`다. 이 불일치를 계획의 최우선 리스크로 올린다.

### 현재 repo/runtime 상태 주의
- 2026-07-08 23:54 KST 기준 `consulting-web`는 `pg18-consulting-migration` 브랜치이며 dirty/untracked 작업이 많다.
- `docker-compose.prod.yml`, GraphRAG bridge, ingest worker/script에 PG-only runtime diff가 존재하고 live API container도 `pg/pg`로 떠 있다.
- 반면 `docs/pg18-migration-phase9-preflight-20260708.md`와 `docs/pg18-migration-worklog.md`는 “PG-only live flip 보류”를 기록한다.
- 따라서 다음 구현 전 0순위는 **PG18 runtime truth reconciliation**이다: 현재 live `pg/pg`를 승인된 Phase10/11 상태로 문서화·검증·커밋할지, 아니면 `dual`/rollback 상태로 되돌릴지 먼저 정해야 한다.
- 이 계획 문서는 구현이 아니라 planning artifact다.

---

## 1. Fable 5-gate 판단

### 1.1 Scoping
이 로드맵의 산출물은 “새 기술 목록”이 아니라 **전부 적용 가능한 실행 순서**다. 기존 `P0~P6` 라벨은 유지하되, 실제 구현 전에 `M0 Baseline/Safety Gate`를 추가한다.

### 1.2 Evidence
문서와 코드에서 이미 확인된 사실:
- `claimVerificationVerdicts`, `exactnessRuns`, `activeReviewItems`, `decisionScorecards`, `documentRetrievalUnits`는 이미 schema에 있다.
- `evidenceItems`도 이미 있다. 다만 source tier/freshness/promotion/locator/usage 같은 ledger 성숙도가 부족하다.
- `consultingTopicLinks`는 이미 `project/channel/topic/thread` 필드를 갖지만 운영 데이터는 project-level only다.
- `recordCompletedAnswer()`는 post-answer verification을 호출할 수 있으나 운영 row가 0이라 실전 데이터가 아직 거의 없다.
- `ingestCompletedTurn()`는 assistant answer를 outbox로 brain에 재주입하므로, memory quarantine 없이 확장하면 오염 위험이 있다.

### 1.3 Attack — 기존 고도화안의 보강/수정점
1. **중복 schema 위험:** 새 `claim_ledger`를 무작정 만들면 기존 `claim_verification_verdicts`와 겹친다. 정답은 “canonical claim table + occurrences + existing verdict rows 연결”이다.
2. **Evidence ledger는 대체가 아니라 확장:** 기존 `evidence_items`를 버리지 말고, utility tier/source freshness/promotion event/locator를 additive migration으로 붙인다.
3. **정확성 row가 0인 것이 우선 병목:** FActScore/AlignScore보다 먼저 “수치/법령/DB 요청이 실제로 `exactness_runs`에 남는지”를 테스트로 고정해야 한다.
4. **retrieval precision은 tuning 전 데이터셋:** weight 감 조정 전에 `retrieval_runs/hits`와 failure labels가 필요하다.
5. **memory feedback loop는 오염 차단이 먼저:** completed answer ingest를 늘리기 전에 unsupported/refuted/exactness-blocked answer를 quarantine해야 한다.
6. **외부 telemetry/Temporal/LangGraph는 후순위:** runtime/config/운영위험이 있으므로 local trace + BullMQ state-machine으로 먼저 계측한다. Phoenix/Langfuse/Temporal은 실측 병목과 승인 후.
7. **고급 retrieval은 P6 labs:** ColBERT/SPLADE/RAPTOR/Leiden은 매력적이지만, 현재는 evidence/verdict/exactness 데이터가 비어 있으므로 P0~P3 이후 ROI가 보일 때 적용한다.
8. **PG18 상태 불일치 위험:** 문서는 PG-only 금지/보류인데 live API env는 `pg/pg`다. 이 상태를 방치한 채 새 기능을 얹으면 rollback·원인분석·ROI 판단이 모두 흐려진다.
9. **Judgment Guard는 완료가 아니라 미사용 구조:** service/schema/tests는 들어갔지만 `judgment_guard_runs=0`이다. “게이트가 있다”가 아니라 “운영 답변에서 row가 생기고 export/review에 반영된다”를 완료 기준으로 바꾼다.
10. **Project wizard는 로드맵에서 내려야 함:** 이미 커밋된 guided setup을 다시 P4 신규개발로 잡지 말고, browser QA·자료 업로드·연결 편집/삭제 readback·프로필 오염방지로 좁힌다.

### 1.4 Verify 기준
각 phase는 “기능이 있다”가 아니라 아래 중 하나로 닫는다.
- row count/readback 증가
- API contract strict schema 통과
- target test + full relevant suite 통과
- GraphRAG eval metric 개선
- browser QA에서 실제 UI 표시/승인/차단 확인
- artifact export가 실제 blocker를 막는지 검증

### 1.5 Report 원칙
보고 시 항상 `산출물 완료 ≠ 실질 이득`을 분리한다. 예: schema 추가는 이득이 아니라 기반이고, `context_precision >= 0.45`처럼 측정 가능한 변화가 이득이다.

---

## 2. 고정 불변식

1. **두뇌 단일성:** `consulting-web`은 새 두뇌가 아니라 기존 `consulting` shared brain의 제품화 레이어다.
2. **workspace hard boundary:** cross-workspace 자동 참조/주입 금지. cross-project는 허용하되 dampening + 라벨 필수.
3. **raw는 후보, final 근거 아님:** `raw_document`는 recall 후보로 남기되 final/export authority로 쓰지 않는다.
4. **숫자/법령/DB/계산은 exactness:** LLM mental math 금지. Decimal/SQL/source locator/read-only DB로 검산한다.
5. **verifier hard block은 단계별:** general chat은 warning 중심, report/final export는 exactness/citation/refute/high-impact unsupported를 block.
6. **memory write는 검증 후:** assistant answer는 검증/정책 판단 전 장기 brain에 바로 들어가면 안 된다.
7. **외부 권한/telemetry는 승인제:** MCP/tool registry, external tracing, Docker redeploy, DB migration apply는 승인 경계다.
8. **trace/run correlation first:** P0에서 새로 생기는 claim/evidence/exactness/retrieval/memory/artifact gate row는 같은 answer/run을 재구성할 수 있어야 한다.
9. **P0 schema부터 tenant-safe:** workspace boundary는 P5 사후감사가 아니라 모든 migration의 선행 gate다. 신규 table/side table은 `workspace_id` 또는 명시적 workspace lookup guard와 cross-workspace negative test를 갖는다.

---

## 2.5. P-label reconciliation / P0 schema gate

### P-label reconciliation

기준 개선안은 앞부분 요약과 backlog에서 P5/P6 의미가 일부 충돌한다. 이 실행 로드맵의 canonical mapping은 아래로 고정한다.

| Canonical label | 이 문서의 의미 | 원문 충돌 처리 |
|---|---|---|
| P0 | 검증 데이터/ledger/write guard | 운영 row가 0인 병목을 먼저 닫음 |
| P1 | retrieval precision | recall 확대보다 precision/failure data 우선 |
| P2 | graph/memory/scope 정밀화 | advanced Leiden/RAPTOR는 제외 |
| P3 | observability/eval CI | 외부 telemetry 전 local trace 우선 |
| P4 | workflow/product UI | guided setup은 QA hardening, Evidence/Review/Trace 중심 |
| P5 | security/tool governance | MCP/tool/PII/tenant 정책 |
| P6 | advanced analytics/labs | ColBERT/SPLADE/RAPTOR/Leiden/causal/MCDA 등 opt-in labs |

### P0 common schema/migration contract

P0에서 schema를 추가/변경하는 모든 PR은 아래를 통과해야 한다.

```text
- workspace_id 또는 workspace lookup FK/guard가 있다.
- trace_id 또는 consulting_ai_run_id가 있다. 없는 경우 왜 해당 row가 run-scoped가 아닌지 문서화한다.
- cross-workspace insert/select/update leakage negative test가 있다.
- PG18 runtime mode(`pg|dual|sqlite`)와 fallback 여부가 trace/readback에 남는다.
- raw_document/candidate_evidence만으로 final_export를 통과하지 않는다.
- migration 번호는 consulting-web + consulting 두 repo 상태를 같이 본 뒤 확정한다.
```

---

## 3. 전체 순서

| Stage | 목적 | 완료 기준 |
|---|---|---|
| M0 | baseline/branch/runtime truth safety gate | dirty 상태·recent commits·live `pg/pg` 여부·DB counts·테스트 baseline·metric baseline 문서화 |
| P0-0 | PG18 runtime reconciliation | live `pg/pg`를 승인/검증/문서화/커밋하거나, `dual` rollback으로 정리 |
| P0-0b | Memory Write Guard | any chat/write smoke 전에 assistant payload가 quarantine/allowed segment로 분리됨 |
| P0 | claim/evidence/exactness/retrieval/memory ledger를 실제로 쌓기 | row count가 0에서 벗어나고 post-answer→review/export/memory gate가 readback됨 |
| P1 | retrieval precision 개선 | real embedding eval `precision >= 0.45`, `recall >= 0.80`, p95 악화 없음 |
| P2 | graph/memory/scope binding 정밀화 | topic/thread binding과 contradiction/provenance/temporal graph가 query에 반영됨 |
| P3 | observability/eval CI | run trace·eval dashboard·regression case 자동 축적 |
| P4 | workflow/product UI | Evidence Panel/Review Queue/Trace Viewer/Artifact Preflight가 실사용 가능 |
| P5 | security/tool governance | prompt injection, PII, tenant isolation, MCP/tool policy가 테스트·감사 가능 |
| P6 | advanced analytics/labs | 고급 retrieval/문서지능/수리분석이 feature-flag + eval-gate로 선택 적용 |

---

## 4. M0 — Baseline & Safety Gate

**Objective:** 현 dirty branch 위에서 무턱대고 구현하지 않고, 기준 상태와 성공척도를 잠근다.

**Files likely to touch:**
- Create: `.hermes/plans/<timestamp>-consulting-ai-os-full-roadmap.md` — 이 문서
- Create: `docs/consulting-ai-os-baseline-YYYYMMDD.md` 또는 기존 `docs/consulting-layer-map.md` append
- Optional create: `apps/api/scripts/ai_os_baseline_readback.ts`

**Read-only commands:**
```bash
git status --short
git branch --show-current
git log --oneline --decorate --max-count=25
git -C /home/jigoo/.hermes/workspace/consulting status --short
git -C /home/jigoo/.hermes/workspace/consulting branch --show-current
git -C /home/jigoo/.hermes/workspace/consulting log --oneline --decorate --max-count=15
docker exec consulting-web-api-1 sh -lc 'printf "BRAIN=%s\nWRITE=%s\nPG_DRIVER=%s\n" "$CONSULTING_BRAIN_BACKEND" "$CONSULTING_BRAIN_WRITE_BACKEND" "$CONSULTING_PG_DSN_DRIVER"'
pnpm --filter @consulting/api test:quality
pnpm --filter @consulting/api test:graphrag
python3 apps/api/scripts/graphrag_eval_gate.py --rerank --top-k 5 --no-fake-embeddings --output /tmp/graphrag-real-baseline.json
```

**DB readback:**
```bash
docker exec consulting-web-pg-1 sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT count(*) FROM claim_verification_verdicts;
SELECT count(*) FROM exactness_runs;
SELECT count(*) FROM judgment_guard_runs;
SELECT count(*) FROM evidence_items;
SELECT count(*) FROM consulting_topic_links WHERE link_level <> '\''project'\'';
SELECT status, count(*) FROM outbox_events GROUP BY status ORDER BY status;
"'
```

**Gate:**
- [ ] `consulting-web`와 `/home/jigoo/.hermes/workspace/consulting` 두 repo의 dirty/untracked 작업 owner를 확인한다.
- [ ] 두 repo가 모두 같은 전략을 따른다: pg18 위에 stack / paired worktree / clean base. `consulting-web`만 worktree로 빼고 shared brain은 live bind mount를 직접 수정하는 조합은 금지.
- [ ] migration 번호 확정. `0020_scope_profiles_project_scope.sql`, `0021_judgment_guard_runs.sql`는 이미 커밋됨. 다음 schema migration은 현재 branch 기준 `0022+`가 후보지만 branch 정리 후 산정.
- [ ] PG18 Phase8/9 문서와 live `pg/pg` runtime의 불일치를 해소.
- [ ] GraphRAG baseline real/fake를 분리 저장.
- [ ] 현 `docs/consulting-layer-map.md`가 실측과 다르면 먼저 갱신.

---

## 5. P0 — Ledger & Write Loop 실제화

### P0 공통 guardrails

- 모든 P0 schema는 `workspace_id` 또는 workspace-resolved FK/guard를 포함한다.
- 모든 answer/run 관련 row는 `trace_id` 또는 `consulting_ai_run_id`로 서로 연결한다.
- migration PR마다 cross-workspace negative tests를 포함한다.
- raw-only evidence, source-less numeric/legal claim, exactness/judgment/verifier blocked answer는 export/memory로 바로 통과하지 않는다.
- memory write guard가 들어가기 전에는 새 chat/write smoke를 shared brain에 남기지 않는다. 필요한 smoke는 test workspace + cleanup/readback 또는 dry-run으로 제한한다.

### P0-0. PG18 runtime truth reconciliation — 최우선 추가

**Objective:** 현재 live API가 `pg/pg`인데 문서/워크로그는 PG-only 보류를 말하는 상태를 먼저 정리한다. 이 단계 없이는 이후 GraphRAG/evidence/memory 성과 측정이 오염된다.

**Files likely to touch:**
- Modify/settle: `docker-compose.prod.yml`
- Modify/settle: `apps/api/src/consulting/consulting-graphrag-bridge.service.ts`
- Modify/settle: `apps/api/scripts/ingest_web_dialogue.py`
- Modify/settle: `apps/api/src/consulting/consulting-web-ingest.worker.ts`
- Modify: `docs/pg18-migration-worklog.md`
- Create/modify: `docs/pg18-migration-phase10-or-11-runtime-reconciliation-20260708.md`
- Modify: `plans/consulting-web-roadmap.md`
- Tests: `apps/api/test/consulting-graphrag-bridge-advanced.test.ts`, `apps/api/test_python/test_pg18_*`, shared brain `scripts/tests/test_dialogue_memory_*`

**Decision fork:**

| Fork | When | Required proof |
|---|---|---|
| Accept current `pg/pg` as controlled runtime cutover | 주인님이 이미 승인했고 rollback path가 명확할 때 | API health, direct PG recall, outbox ingest, no hidden SQLite dependency for web path, mismatch log clean, docs updated, diff committed |
| Roll back to `dual` | 승인/검증 이력이 불명확하거나 Phase9 blocker가 여전히 치명적일 때 | compose/env/code reverted to dual, API recreated, outbox/retrieval still green, docs say rollback |
| Hold dirty state without deploy change | 지금 당장 runtime을 건드리지 않을 때 | no new feature work, branch/worktree isolation, explicit risk note |

**Verification commands:**
```bash
docker exec consulting-web-api-1 sh -lc 'env | grep -E "CONSULTING_BRAIN_(BACKEND|WRITE_BACKEND)|CONSULTING_PG_DSN_DRIVER"'
docker exec consulting-web-pg-1 sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT status, count(*) FROM outbox_events GROUP BY status ORDER BY status"'
python3 -m py_compile apps/api/scripts/ingest_web_dialogue.py
pnpm --filter @consulting/api test -- consulting-graphrag-bridge-advanced.test.ts
```

**Done when:** plan/docs/runtime/git 상태가 같은 말을 한다. 즉 “PG runtime active” 또는 “dual rollback” 중 하나로 정리되어야 하며, `docs/pg18-migration-worklog.md`와 `plans/consulting-web-roadmap.md`가 현재 runtime과 충돌하지 않는다.

---

### P0-0b. Memory Write Guard — 첫 write-path 코드 변경

**Objective:** P0의 deterministic chat/post-answer 테스트가 shared brain을 오염시키지 않도록, assistant answer는 정책 판단 전 장기 brain ingest에서 분리한다.

**Files:**
- Modify: `apps/api/src/consulting/consulting-web-ingest.service.ts`
- Modify: `apps/api/src/consulting/consulting-web-ingest.worker.ts`
- Modify: `apps/api/scripts/ingest_web_dialogue.py`
- Modify: `apps/api/src/consulting/evidence-decision.store.ts`
- Add schema: `memory_candidates`, `memory_policy_decisions` 또는 outbox payload side table
- Tests: `apps/api/test/consulting-web-ingest*.test.ts`, Python ingest fixture test

**Payload contract:**
```text
ConsultingWebTurnCompleted payload MUST NOT be a single opaque user+assistant blob.
It must separate:
- allowedSegments[]: user original text, uploaded doc chunk, sourced tool result
- assistantCandidate: assistant answer pending verifier/exactness/judgment policy
- blockedSegments[]: refuted/mixed/not_enough_info/exactness-blocked/source-less high-impact text
- policyDecisionId / trace_id / consulting_ai_run_id
```

**Regression:**
- blocked assistant answer is not written to PG18 brain nor rollback SQLite brain.
- user original text remains allowed when safe.
- outbox published count can grow without assistant hallucination entering long-term memory.

**Done when:** first P0 chat/write smoke proves `allowedSegments[]` and `assistantCandidate` are stored separately, and blocked assistant text is visible in review/quarantine but absent from shared brain search.

### P0-1. Canonical Claim Ledger를 기존 verdict table 위에 추가

**Objective:** 같은 주장을 메시지/아티팩트마다 새로 검증하지 않고 dedup·version·validity를 가진 장부로 남긴다.

**Do not duplicate:** 기존 `claim_verification_verdicts`는 “검증 결과 row”로 유지한다. 새 layer는 “정규화된 claim identity”다.

**Files:**
- Modify: `packages/db-schema/src/schema/evidence-decision.ts`
- Create migration: `packages/db-schema/drizzle/00NN_consulting_ai_claim_ledger.sql`
- Modify: `apps/api/src/consulting/evidence-decision.store.ts`
- Modify: `apps/api/src/consulting/claim-verifier.service.ts`
- Modify contracts: `packages/contracts/src/collab.ts`
- Tests: `apps/api/test/evidence-decision-api.test.ts`, `apps/api/test/claim-verifier-cascade.test.ts`

**Schema shape:**
```text
consulting_claims
- id
- workspace_id
- normalized_hash unique(workspace_id, normalized_hash)
- normalized_claim
- latest_claim_text
- claim_type factual|numeric|legal|causal|recommendation|assumption|forecast
- text identity only; no project-specific truth status here
- created_at / updated_at / deleted_at

claim_scope_status
- id
- workspace_id
- claim_id
- project_id / channel_id? / topic_id? / thread_id?
- source_status supported|contradicted|mixed|insufficient|stale
- confidence
- decision_impact
- valid_from / valid_to
- latest_verification_verdict_id
- cross_project_source_label / dampening_weight
- created_at / updated_at / deleted_at

claim_occurrences
- id
- workspace_id
- trace_id or consulting_ai_run_id
- claim_id
- assistant_message_id?
- artifact_version_id?
- thread_id?
- occurrence_text
- occurrence_locator
- created_at
```

**Implementation steps:**
1. Write failing schema/Drizzle export test for `consulting_claims` and `claim_occurrences`.
2. Add migration + Drizzle schema.
3. Add deterministic `normalizeClaim(text)` utility: whitespace, punctuation, citation stripping, lowercasing where safe, Hangul preserved.
4. In `recordCompletedAnswer()`, upsert `consulting_claims` before inserting `claim_verification_verdicts`.
5. Link verdict rows to canonical claim id via new nullable `canonical_claim_id` column or side table.
6. Add summary response fields: claimCount, supported/contradicted/mixed/insufficient/stale.

**Validation:**
```bash
pnpm --filter @consulting/db-schema build
pnpm --filter @consulting/contracts build
pnpm --filter @consulting/api test -- evidence-decision-api.test.ts claim-verifier-cascade.test.ts
```

**Done when:** exact-normalized duplicate claims from two messages create 1 canonical claim + 2 occurrences + 2 verdict rows, while project/topic-specific truth status stays in `claim_scope_status`. Near-identical/semantic duplicates are review candidates, not automatic merges in the first slice.

---

### P0-2. Evidence Ledger v2 — 기존 `evidence_items` 확장

**Objective:** evidence가 “tool excerpt 2개” 수준이 아니라 source tier, locator, freshness, promotion 상태를 가진다.

**Files:**
- Modify: `packages/db-schema/src/schema/collab.ts`
- Modify: `packages/contracts/src/collab.ts`, `packages/contracts/src/library.ts`
- Modify: `apps/api/src/chat/evidence.store.ts`
- Modify: `apps/api/src/consulting/evidence-decision.store.ts`
- Modify UI: `apps/web/src/components/evidence/EvidencePanel.tsx`, `apps/web/src/widgets/evidence-panel/ui/EvidencePanel.tsx`
- Tests: `apps/api/test/evidence-decision-api.test.ts`, web evidence panel tests if present

**Additive fields / side tables:**
```text
evidence_items additions:
- utility_tier raw_document|candidate_evidence|verified_evidence|qualified_usable|final_usable
- locator_json page/section/row/bbox/source_path
- source_quality_score
- freshness_score
- human_review_status pending|approved|rejected|needs_source_check
- usage_count
- contradiction_count

source_freshness:
- workspace_id
- source_ref
- source_kind / source_id
- published_at / collected_at / effective_date / expires_at
- superseded_by
- freshness_policy

evidence_promotion_events:
- workspace_id
- evidence_item_id
- from_tier / to_tier
- policy_version
- source_kind / source_id
- reason
- promoted_by_user_id?
- reviewer_user_id?
- review_note
- previous_locator_hash
- created_at
```

**Critical policy:** raw `GraphRAG hit` can create `candidate_evidence`, not `final_usable`. Final/export requires approved or verified tier.

**Done when:** Evidence Panel shows tier/freshness/locator, and high-impact claim using raw-only evidence is warning/review, not final pass.

---

### P0-3. Exactness Gate row creation and check coverage

**Objective:** `exactness_runs=0` 병목을 닫는다. exact trigger가 걸리면 row가 반드시 남고, final/export에서 사용된다.

**Files:**
- Modify: `apps/api/src/consulting/exactness-gate.service.ts`
- Modify: `apps/api/src/consulting/evidence-decision.store.ts`
- Modify: `packages/db-schema/src/schema/evidence-decision.ts`
- Modify: `packages/contracts/src/collab.ts`
- Tests: `apps/api/test/exactness-gate.service.test.ts`, `apps/api/test/verifier-gate-policy.service.test.ts`

**Sub-slices:**
1. `P0-3a numeric Decimal`: `sum_equals_total`, `percentage_change`, `ratio_percent`, `weighted_average`, `cagr` with Decimal/SQL-safe arithmetic.
2. `P0-3b read-only SQL/DB-state checker`: read-only adapter, allowlisted query templates, row/table/count fixtures. Until adapter exists, DB-state claims are `required=true status=blocked`, not “verified”.
3. `P0-3c source locator/page/legal quote matcher`: page/section/quote/legal-clause locator fixtures. Until locator exists, legal/page quote claims are `required=true status=blocked` or `review_required`, not “verified”.
4. Later: `table_row_count`, `groupby_sum`, `date_range_overlap`, `unit_consistency_check`.

**Invariant tests:**
- numeric/legal/DB trigger + no supplied checks ⇒ `blocked` and persisted row.
- legal/DB/page quote fixtures cannot pass until the corresponding adapter/locator produced a deterministic check result.
- exactness blocked + `final_export` ⇒ export blocked.
- general chat ⇒ warning/instruction, not full UX dead-end.

**Done when:** a deterministic test message containing “증감률/총액/법령/DB” creates `exactness_runs` and the UI/API summary reads it back.

---

### P0-3b. Judgment Guard 운영 row activation — 최근 커밋 반영

**Current state:** commit `5c8b9df`로 judgment guard service/schema/contracts/tests는 들어갔다. `judgment_guard_runs` table도 live App PG에 존재한다. 다만 2026-07-08 23:54 KST readback 기준 row count는 `0`이다.

**Objective:** “컨설팅 판단 안전 게이트 v1”이 prompt contract로만 존재하지 않고, 실제 assistant answer / review / export gate에 남도록 한다.

**Files:**
- Existing: `apps/api/src/consulting/consulting-judgment-guard.service.ts`
- Modify/check: `apps/api/src/consulting/evidence-decision.store.ts`
- Modify/check: `apps/api/src/consulting/verifier-gate-policy.service.ts`
- Modify/check: `packages/contracts/src/collab.ts`
- Tests: `apps/api/test/consulting-judgment-guard.service.test.ts`, `apps/api/test/judgment-guard-schema.test.ts`, `apps/api/test/verifier-gate-policy.service.test.ts`, plus one end-to-end post-answer persistence test.

**Activation cases:**
- source intake parse failure: short OCR/PDF hit.
- applicability map required: policy/legal query with applicability terms.
- latest authority required: 법령/판례/지침 + 최신성.
- comparator consistency: 유사기관/벤치마킹.
- counterargument/overclaim: 불가/금지/확정 표현.
- user correction pattern: “이거 아니야/틀렸어/다시 봐” 류.

**Done when:** deterministic post-answer test creates at least one `judgment_guard_runs` row, summary API exposes it, and final/export gate can turn relevant blocker/warning into user-visible review action.

---

### P0-4. Retrieval Run/Hits ledger

**Objective:** precision을 감으로 튜닝하지 않고 실패 데이터를 모은다.

**Files:**
- Create/modify schema: `packages/db-schema/src/schema/evidence-decision.ts` or new `retrieval-ledger.ts`
- Migration: `00NN_retrieval_runs_hits.sql`
- Modify: `apps/api/src/consulting/consulting-memory-context.builder.ts`
- Modify: `apps/api/src/consulting/consulting-graphrag-bridge.service.ts`
- Tests: `apps/api/test/consulting-memory-context.builder.test.ts`, `apps/api/test/consulting-graphrag-bridge.test.ts`

**Schema:**
```text
retrieval_runs
- id, workspace_id, project_id, channel_id, topic_id, thread_id
- trace_id or consulting_ai_run_id
- query, query_type, retrieval_mode, top_k
- backend `sqlite|dual|pg`, pg18 sidecar health, shadow_mismatch_id?
- evidence_sufficiency_status, required_action
- latency_ms, rerank_latency_ms, model_route?
- created_at

retrieval_hits
- retrieval_run_id
- trace_id or consulting_ai_run_id
- source_topic_slug, source_relation, scope_weight
- kind, source_id, chunk_id, doc_title
- rank_before_rerank, rank_after_rerank
- score_semantic, score_lexical, score_graph, score_rrf, score_rerank, adjusted_score
- utility_tier
- selected_for_context
- selected_rank / context_slot
- judged_relevant nullable
- failure_type nullable
```

**Done when:** every chat context build can be traced from query → backend(`pg`/`dual`/`sqlite`) → scopes → hits → final selected 5 → CRAG decision. PG18 runtime 상태에서 SQLite fallback이 발생하면 trace에 명시된다.

---

### P0-5. Memory Candidate / Quarantine Review UI — extends P0-0b

**Objective:** P0-0b의 write guard를 운영 가능한 review/approval loop로 확장한다. completed assistant answer를 무조건 shared brain에 넣지 않는다.

**Files:**
- Modify: `apps/api/src/consulting/consulting-web-ingest.service.ts`
- Modify: `apps/api/src/consulting/consulting-web-ingest.worker.ts`
- Modify: `apps/api/src/consulting/evidence-decision.store.ts`
- Add schema: `memory_candidates`, `memory_policy_decisions`
- UI later: Review Queue / Memory approval panel
- Tests: `apps/api/test/consulting-web-ingest*.test.ts` 또는 신규

**Policy:**
```text
auto_allow:
- user original text
- uploaded document chunks
- tool result with source
- supported claim with evidence
- approved artifact/meeting decision/action item

quarantine/block:
- refuted/mixed/not_enough_info high-impact claim
- exactness blocked answer
- source-less numeric/legal claim
- brainstorming/temp idea
- cross-project only evidence answer
- PII/confidential unreviewed
- prompt injection-like retrieved text
```

**Done when:** `ConsultingWebTurnCompleted` outbox event uses segmented payloads only. Allowed user/doc/tool segments may be emitted, assistant candidates require policy decision, and quarantined candidates are visible for review but absent from the shared brain runtime store(PG18 path 및 rollback SQLite path 모두).

---

### P0-6. Topic/Thread-level Scope Binding 실제 데이터화

**Objective:** 이미 존재하는 `consulting_topic_links.channel_id/web_topic_id/thread_id`를 운영 데이터로 채운다.

**Files:**
- Modify: `packages/db-schema/src/schema/consulting-bridge.ts` only if constraints/indexes insufficient
- Modify: `apps/api/src/consulting/consulting-topic-resolver.service.ts`
- Add/read-only scripts: `apps/api/scripts/scope_binding_audit.ts`, `apps/api/scripts/scope_binding_backfill_preview.ts`
- Tests: `apps/api/test/consulting-topic-resolver.service.test.ts`

**Rules:**
- `thread > topic > channel > project` priority remains.
- backfill starts with preview/read-only; apply requires approval.
- TEST/qa scopes must not accidentally bind to Changwon brain.
- Telegram exact binding is a sibling track: `dialogue_telegram_thread_bindings=0` must be explicit risk until populated.

**Done when:** active target scopes have an audit list, resolver priority regression proves `thread > topic > channel > project`, TEST/qa scopes cannot route into Changwon, and broad/null Telegram binding cannot hijack exact topic routing. “One safe binding exists” is not enough to close this item.

---

### P0-7. Artifact final_export gate coverage

**Objective:** PDF/DOCX/PPT/report export가 verifier/exactness/citation blocker를 실제로 막는다.

**Files:**
- Modify: `apps/api/src/artifacts/artifacts.controller.ts`
- Modify: `apps/api/src/artifacts/artifacts.module.ts`
- Modify: `apps/api/src/consulting/evidence-decision.store.ts`
- Modify: `packages/contracts/src/error.ts`
- Tests: existing `artifact-export-gate.test.ts` if present, 신규 export gate tests

**Export gate rules:**
- source assistant message가 `BLOCKED`이면 exporter 실행 전 차단.
- high-impact claim이 `raw_document` 또는 `candidate_evidence`만 갖는 경우 `evidence_tier_issue`로 block 또는 `review_required`.
- numeric/legal/DB/page quote claim은 exactness/source locator pass 없이는 final authority로 승격 불가.
- contract error body와 UI 문구는 한국어 조치 문구를 반환한다.

**Tests:** raw-only evidence fixture, candidate-only fixture, exactness-blocked fixture, verified/final evidence pass fixture.

**Done when:** raw-only/candidate-only high-impact evidence가 final_export를 통과하지 않고, UI가 raw Hermes/stack string이 아닌 한국어 조치 문구를 보여준다.

---

## 6. P1 — Retrieval Precision Roadmap

**Objective:** 현재 recall 0.8667은 유지하면서 precision 0.2881을 1차 0.45 이상으로 올린다.

### P1-1. Query Type Classifier

**Files:**
- Create: `apps/api/src/consulting/query-intent-classifier.service.ts`
- Modify: `apps/api/src/consulting/consulting-memory-context.builder.ts`
- Contract optional: `packages/contracts/src/collab.ts` trace response
- Tests: `apps/api/test/query-intent-classifier.service.test.ts`

**Query types:** `fact_lookup`, `numeric`, `legal`, `strategy`, `diagnosis`, `comparison`, `summary_global`, `artifact_write`, `memory_lookup`, `action_execution`.

**Routing:**
- numeric/legal ⇒ exactness/source locator first.
- fact_lookup ⇒ lexical/exact-code + rerank.
- strategy/diagnosis ⇒ graph + qualified evidence.
- artifact_write ⇒ claim/evidence ledger + export gate.

### P1-2. Query Decomposition + Multi-query RRF

**Files:**
- Modify: `apps/api/src/consulting/consulting-graphrag-bridge.service.ts`
- Modify shared brain CLI only if needed: `/home/jigoo/.hermes/workspace/consulting/scripts/dialogue_memory_cli.py`
- Tests: API bridge + consulting repo Python tests

**Guardrails:**
- max variants 3 for chat, 5 for artifact/report.
- HyDE only for insufficient/short/semantic-gap queries, never evidence.
- Each variant’s results logged to `retrieval_runs/hits`.

### P1-3. Reranker trace + MMR diversity

**Files:**
- Modify: `apps/api/src/consulting/consulting-graphrag-bridge.service.ts`
- Modify: shared brain `scripts/dialogue_memory/search.py` if missing rerank metadata
- Tests: `consulting-graphrag-bridge.test.ts`, `test_graphrag_eval_gate.py`

**Policy:**
```text
recall pool 30~50 → RRF → cross-encoder rerank top 10~16 → MMR/source diversity → final top 3~7
```

**Done when:** duplicate chunks do not fill final top-5, and trace shows before/after ranks.

### P1-4. Dynamic Context Budget

**Budgets:**
- fact_lookup: 3~5 chunks
- numeric/legal: 2~4 chunks + exact check
- strategy: 5~8 chunks
- summary_global: community summary + 5 chunks
- artifact_write: section별 3~5 chunks

**Done when:** final prompt injection count is no longer hard-coded 5 for every query type.

### P1 validation
```bash
pnpm --filter @consulting/api test -- consulting-memory-context.builder.test.ts consulting-graphrag-bridge.test.ts
python3 apps/api/scripts/graphrag_eval_gate.py --rerank --top-k 5 --no-fake-embeddings --output /tmp/graphrag-p1.json
```

**Metric gate:**
- Baseline: p95 = 4.1242s.
- 1차: precision >= 0.45, recall >= 0.80, p95 <= baseline_p95 * 1.2.
- 2차: precision >= 0.60, recall 0.75~0.85, p95 <= baseline_p95 * 1.5 unless 주인님이 latency tradeoff를 별도 승인.
- p95 6s+는 자동 통과가 아니라 “승인된 precision/latency tradeoff” decision이 필요하다.

---

## 7. P2 — Graph / Memory / Scope Intelligence

### P2-1. Contradiction & Provenance Graph

**Files:**
- Schema: `packages/db-schema/src/schema/evidence-decision.ts`
- Service: `apps/api/src/consulting/evidence-to-decision.service.ts`
- Store: `apps/api/src/consulting/evidence-decision.store.ts`
- Tests: `apps/api/test/evidence-to-decision.service.test.ts`

**Edges:** `SUPPORTS`, `REFUTES`, `QUALIFIES`, `DEPENDS_ON`, `ASSUMES`, `DERIVED_FROM`, `SUPERSEDES`, `STALE_AFTER`.

**Done when:** Review Queue can show “근거가 갈리는 쟁점” and answer/report can surface counter-evidence.

### P2-2. Temporal Knowledge Graph

**Fields:** `valid_from`, `valid_to`, `observed_at`, `published_at`, `collected_at`, `superseded_by`.

**Rule:** 법령/조례/계약/조직도는 “최신성”보다 “해당 시점 유효성”을 우선한다.

### P2-3. Component summary fallback only — Leiden/RAPTOR deferred to P6

**Decision gate:** P2에서는 no-dependency connected component summary/cache까지만 허용한다. Leiden/RAPTOR/community detection은 P3 trace/eval metric과 graph size threshold가 생긴 뒤 P6 labs에서 opt-in으로 다룬다.

**Files:**
- shared brain: `scripts/dialogue_memory/advanced_graphrag_layers.py` or new module
- API: `apps/api/src/consulting/consulting-memory-context.builder.ts`
- Eval: `apps/api/scripts/graphrag_eval_gate.py`

**Not in P2:** Leiden, RAPTOR, Microsoft GraphRAG community detection. 이들은 P6 advanced labs 항목이다.

### P2-4. Telegram exact topic bridge

**Goal:** `dialogue_telegram_thread_bindings=0`을 운영 위험으로 남기지 않는다.

**Steps:**
1. Read-only audit: live Telegram topic ids and current broad binding.
2. Web channel/topic/thread mapping preview.
3. Human approval.
4. Apply exact binding.
5. Regression: broad null binding no longer hijacks exact topic route.

---

## 8. P3 — Observability / Evaluation / CI

### P3-1. Local trace first

**Do first, before Phoenix/Langfuse:**
- Add `trace_spans` table locally.
- Capture: intent, scope fanout, retrieval, rerank, CRAG, Hermes run, claim extraction, verifier, exactness, memory policy, artifact gate.
- UI later reads from local DB.

**Files:**
- Schema: `trace_spans` in db schema
- Service: `apps/api/src/consulting/consulting-run-trace.service.ts`
- Integrations: `consulting-memory-context.builder.ts`, `evidence-decision.store.ts`, `hermes-runs-client.ts`

### P3-2. Eval case lifecycle

**Files:**
- Create schema: `eval_cases`, `eval_runs`, `eval_scores`
- Modify scripts: `apps/api/scripts/graphrag_eval_gate.py`, `apps/api/scripts/nli_verifier_bench.ts`, `apps/api/scripts/hallucination_reduction_eval.ts`

**Auto-create cases from:**
- retrieval failure labels
- unsupported/refuted high-impact claims
- exactness blocked answers
- human feedback buttons
- artifact export blockers

### P3-3. Dashboard

**UI:**
- `apps/web/src/widgets/evidence-panel/ui/EvidencePanel.tsx` or new `TracePanel`
- show: precision trend, unsupported claim rate, exactness block rate, artifact export block rate, p95, token/cost if available.

**External tracing:** Phoenix/Langfuse only after explicit approval and secret/config boundary review.

---

## 9. P4 — Workflow / Product Layer

### P4-0. Guided project setup — 최근 커밋 반영 / QA-harden only

**Current state:** commit `acce5a7`로 새 프로젝트 생성 wizard, 기본 템플릿 적용 선택, project profile seed, strong/weak project connection, project settings modal이 들어갔다. 따라서 이 항목은 신규 구축이 아니라 안정화/실사용 검증이다.

**Remaining hardening:**
- browser QA: create → default template channels/topics/threads → defaultThread/intakeThread 이동 확인.
- settings modal: rename/profile save 후 tree/breadcrumb/thread detail cache invalidation 확인.
- connections: `related_to`/`shares_memory_with` 생성·삭제를 양방향/중복 없이 readback.
- materials: project-scoped 자료 추가/라이브러리 진입이 실제 intake thread와 연결되는지 확인.
- safety: 프로젝트 프로필 빈 로드가 기존 값을 덮어쓰지 않음, cross-workspace connection 불가, template opt-out이 서버 기본값을 이김.

**Done when:** 생성된 프로젝트가 “비어있는 껍데기”가 아니라 기본 컨설팅 구조 + 편집 가능한 목표/프로필 + 명시적 프로젝트 연결 + 자료 투입 위치를 갖고, 브라우저 QA에서 새로고침 후에도 동일하게 읽힌다.

### P4-1. Evidence Panel v2
Shows:
- claim list per answer
- support/refute/insufficient status
- evidence tier/freshness/locator
- “보고서에 사용 가능” approval button
- source quote/page/section

### P4-2. Review Queue v2
Shows:
- high-impact unsupported/refuted claims
- exactness blocked answers
- stale source/citation mismatch
- memory approval candidates
- tool approval requests only after P5-1 minimal `tool_registry/approval_requests` schema + policy evaluator exists. Until then this is shown as blocked/not-enabled, not as an ad-hoc approval button.

### P4-3. Trace Viewer
Shows:
- query rewrite/decomposition
- scope fanout and cross-project labels
- RRF/rerank scores
- selected context
- verifier/exactness/memory decisions

### P4-4. Durable workflows
Start with BullMQ/outbox state machine:
- document ingest workflow
- graph rebuild workflow
- batch verification workflow
- report generation workflow
- artifact export workflow

Only then consider Temporal. LangGraph is reserved for report/decision `draft → verify → targeted repair → re-verify → publish` loops, not one-shot chat.

**Prerequisite for any tool/action workflow:** P5-1 minimal tool governance schema and approval policy must exist before UI can approve L4+ actions.

---

## 10. P5 — Security / Tool / MCP Governance

### P5-1. Tool Registry

**Schema:** `tool_registry`, `tool_invocations`, `approval_requests`.

**Levels:**
- L0 internal read-only search
- L1 external read-only search
- L2 draft/artifact creation
- L3 DB write/memory write
- L4 external send/email/messenger/webhook
- L5 delete/shell/credential/billing/admin

**Policy:** L4+ human approval, L5 default deny.

### P5-2. Prompt Injection Defense

**Where:** before retrieved text enters prompt.

**Files:**
- Create: `apps/api/src/consulting/prompt-injection-scan.service.ts`
- Modify: `consulting-memory-context.builder.ts`
- Tests: malicious retrieved doc fixtures

**Rules:** retrieved text is data, never instruction. Mask/label suspicious instructions.

### P5-3. PII / Confidentiality

**Add:** sensitivity level on sources/evidence/artifacts, export scan, cross-workspace invariant tests.

### P5-4. Tenant isolation audit

This is not a late-only audit. P0 schema changes already require cross-workspace negative tests; P5-4 is the system-wide sweep after those local gates.

Regression tests for:
- context_edges polymorphic endpoint workspace mismatch
- unresolved endpoints
- archived/deleted scope leakage
- cross-workspace `consulting_topic_links` leak

---

## 11. P6 — Advanced Analytics / Labs

**Apply only after P0~P3 metrics exist.**

### Retrieval/document labs
- Late interaction: ColBERT for text, ColPali/ColQwen for PDF pages.
- SPLADE/neural sparse for Korean terms/codes/proper nouns.
- RAPTOR for long documents/interview bundles.
- Leiden/community detection only after P3 trace/eval and graph size threshold justify it.
- Docling/Marker/MinerU for PDF/PPTX/XLSX/HWP-like document intelligence.

### Consulting analytics labs
- Causal inference assistant: causal claim ⇒ confounder/data/method checklist, not hard causal assertion.
- Bayesian evidence updating: hypothesis confidence update with evidence likelihood labels.
- Monte Carlo simulation: cost/schedule/ROI uncertainty.
- MCDA/AHP/TOPSIS: alternatives + criteria + sensitivity analysis.
- Optimization/OR: staffing/budget/project selection constraints.
- Organization network analysis: department/process/interview graph centrality.

**Feature flag rule:** each lab module must be opt-in, eval-gated, and never part of final_export authority without exactness/evidence gates.

---

## 12. Cross-phase validation contract

### API/schema checks
```bash
pnpm --filter @consulting/db-schema build
pnpm --filter @consulting/contracts build
pnpm --filter @consulting/api test
```

Required for every P0 migration:
- cross-workspace negative tests for new tables/endpoints.
- `trace_id`/`consulting_ai_run_id` correlation test across claim/exactness/retrieval/memory/artifact rows.
- PG18 runtime mode/fallback captured in readback.

### Quality/eval checks
```bash
pnpm --filter @consulting/api test:quality
pnpm --filter @consulting/api test:graphrag
python3 apps/api/scripts/graphrag_eval_gate.py --rerank --top-k 5 --no-fake-embeddings --output /tmp/graphrag-real.json
```

### Web checks, when UI touched
```bash
pnpm --filter @consulting/web build
```
Then browser QA on dev `http://127.0.0.1:5273/login` or prod `http://127.0.0.1:8088` only after approved rebuild.

### DB readback minimum
- `claim_verification_verdicts > 0` after deterministic chat/post-answer test.
- `exactness_runs > 0` after numeric/legal/DB trigger test.
- `judgment_guard_runs > 0` after deterministic consulting-judgment trigger test.
- `evidence_items` grows with verified/candidate tier metadata.
- `retrieval_runs/hits` exists and selected_context is traceable.
- memory candidates are quarantined when verifier/exactness blocks.
- live API runtime backend state is intentional and documented: either `pg/pg` accepted or `dual/dual` rollback.

---

## 13. Implementation branch strategy

Because both `consulting-web` and shared `/home/jigoo/.hermes/workspace/consulting` are dirty on `pg18-consulting-migration`, choose one paired strategy before implementation:

### Option A — reconcile/finish pg18 branch first
Best now because live API runtime is already `pg/pg` and both repos own the GraphRAG read/write boundary. Pros: prevents split-brain and false ROI measurement. Cons: AI OS feature work waits until runtime truth is clean.

### Option B — new worktree from clean master
```bash
git worktree add ../consulting-web-ai-os master
git -C /home/jigoo/.hermes/workspace/consulting worktree add ../consulting-ai-os master
```
Useful only if both repos have a confirmed clean/base branch and the PG18 runtime dependency is intentionally excluded or merged first. Pros: clean scope. Cons: it misses current branch commits/diffs, so it is risky for this roadmap until pg18 reconciliation is done.

### Option C — stack on current branch
Only if pg18 changes are prerequisite. Must first commit/stash or explicitly own existing work in both repos and document which files belong to PG18 vs AI OS.

Default recommendation: **Option A first.** Current live runtime already uses PG18 `pg/pg`, so the next safe move is to reconcile/commit/rollback that state before starting new AI OS feature slices.

---

## 14. First execution slice recommendation

Do not start with LangGraph/Temporal/ColBERT. Start with this vertical slice:

1. P0-0 PG18 runtime truth reconciliation: live `pg/pg` accept/rollback decision + docs/git/runtime alignment.
2. P0-0b Memory Write Guard: any chat/write smoke 전에 outbox payload를 `allowedSegments[]`/`assistantCandidate`/`blockedSegments[]`로 분리.
3. P0 common schema gate: workspace boundary + trace/run correlation contract를 첫 migration에 고정.
4. P0-3b Judgment Guard 운영 row activation: `judgment_guard_runs=0`을 deterministic row로 깨기.
5. P0-3 exactness deterministic row creation: `exactness_runs=0`을 깨기.
6. P0-1 canonical claim ledger minimal: exact-normalized duplicate only, scope-specific truth 분리.
7. P0-4 retrieval_runs/hits ledger with backend=`pg|dual|sqlite`, trace_id, selected context slot.
8. P0-7 final_export gate readback: raw-only/candidate-only high-impact evidence block.
9. P1-1 query_type classifier using retrieval ledger.

**Why this slice:** it first prevents PG18/SQLite split-brain and memory contamination, then converts the current “검증 가능한 구조” into “검증 데이터가 실제로 쌓이는 시스템.” 이후 RAG/Graph/Workflow/UI 고도화가 ROI를 낼 수 있다.

---

## 15. Open decisions for 주인님

1. 현재 live `pg/pg`를 승인된 controlled runtime cutover로 인정하고 문서화/커밋할지, 아니면 `dual`로 rollback할지.
2. 구현 브랜치: pg18 reconciliation 후 두 repo 같은 branch에서 이어갈지 / paired clean worktree로 분리할지.
3. 첫 릴리즈 목표: 내부 QA-only인지, 실제 창원/TEST 프로젝트에 바로 적용할지.
4. External observability: Langfuse/Phoenix는 지금은 보류가 기본. 나중에 승인할지.
5. Memory policy: general chat assistant answer도 기본 quarantine할지, supported-only auto ingest할지.
6. P6 advanced labs 우선순위: 문서지능(PDF/표) vs causal/MCDA/Monte Carlo 중 무엇이 먼저 실무 ROI가 큰지.

---

## 16. Success metrics

### Realized technical gain metrics
- PG18 runtime truth: docs/git/live env가 `pg/pg` 또는 `dual` 중 하나로 일치.
- `claim_verification_verdicts`: 0 → deterministic/chat 운영 row 축적
- `exactness_runs`: 0 → numeric/legal/DB trigger row 축적
- `judgment_guard_runs`: 0 → deterministic consulting-judgment 운영 row 축적
- `ConsultingWebTurnCompleted` / outbox: published count 유지, approved/quarantined 분리된 ingest count
- `context_precision`: per `eval_run`, 0.2881 → P1 0.45+ → P2/P3 0.60 target
- `recall/hit`: per `eval_run`, 0.80 이상 유지
- unsupported/refuted high-impact claim export rate: per prod export attempt and per eval_run = 0
- memory contamination incident: weekly rolling window + trace/readback source = 0, quarantine reviewable
- p95 latency: per eval_run, P1 <= baseline_p95 * 1.2 unless approved tradeoff

### Product gain metrics
- 새 프로젝트 생성 wizard는 이미 들어갔으므로, 다음 gain은 생성→설정→연결→자료투입까지 브라우저에서 끊기지 않는 것이다.
- 컨설턴트가 “이 답변을 보고서에 써도 되는지”를 Evidence Panel에서 판단 가능.
- Review Queue가 다음 할 일을 자동으로 정렬.
- Trace Viewer가 왜 이런 답변/근거가 나왔는지 설명.
- Artifact export가 근거 없는 고위험 문장을 막음.

### Not a gain yet
- schema만 추가
- 외부 tool 이름만 도입
- LangGraph/Temporal/Phoenix 설치만 완료
- GraphRAG 알고리즘 추가했지만 precision/recall/eval 개선 없음
