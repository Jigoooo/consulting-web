# Final Audit / Bugfix / Advanced GraphRAG Handoff

**Date:** 2026-07-07
**Scope:** `consulting-web` + shared consulting brain GraphRAG bridge
**Instruction boundary:** 7개 고급 고도화 본구현은 새 세션에서 진행한다. 이 문서는 그 직전까지의 버그픽스·검증·핸드오프다.

---

## 0. 결론

릴리즈 전 필수 결함은 두 개를 닫았다.

1. **legacy deleted_soft scope와 연결된 live context edge 잔존**
   - live DB에서 `context_edges.deleted_at is null`인 dangling edge 3건 확인.
   - 백업 후 `0012_backfill_deleted_scope_graph_tombstones.sql` 적용.
   - 적용 후 `live_edges_to_deleted=0`, `live_tags_to_deleted=0` 확인.

2. **보관된 thread가 직접 URL/detail 조회로 노출되는 결함**
   - `SpaceMutateService.threadDetail()`이 `deleted_at`만 보고 `status='archived'`를 보지 않았다.
   - RED 테스트 추가: channel archive 후 descendant thread detail은 `null`이어야 함.
   - active-only status filter 추가 후 lifecycle 테스트 GREEN.

`pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm lint`, Docker compose config, DB ghost-reference probe는 모두 GREEN이다. 과거 contracts/runtime model failure는 중간 상태였고 현재 재현되지 않는다.

---

## 1. 실제 수정 파일

### 1.1 DB migration/backfill

- `packages/db-schema/drizzle/0012_backfill_deleted_scope_graph_tombstones.sql`

역할:

- `projects/channels/topics/threads` 중 `deleted_at is not null` 또는 `status='deleted_soft'`인 scope를 모은다.
- 그 scope가 from/to endpoint인 live `context_edges`에 `deleted_at=now()`를 각인한다.
- 그 scope에 붙은 live `scope_tags`도 tombstone 처리한다.
- 물리 삭제 없음. 멱등 실행 가능.

적용 전 backup:

```text
/tmp/cw-backups/cw_pre_graph_tombstone_fix.dump
```

실제 적용 결과:

```text
UPDATE 3  -- context_edges
UPDATE 0  -- scope_tags
```

검증:

```text
live_edges_to_deleted = 0
live_tags_to_deleted  = 0
```

### 1.2 Thread detail active-only guard

- `apps/api/src/spaces/space-mutate.service.ts`
- `apps/api/test/lifecycle-tombstone.test.ts`

추가된 회귀 규칙:

```text
보관된 channel 아래 thread는 tree에서 숨겨질 뿐 아니라 threadDetail() 직접 조회에서도 null이어야 한다.
```

수정 내용:

```ts
threadDetail where:
  thread.status = 'active'
  topic.status = 'active'
  channel.status = 'active'
  project.status = 'active'
  and all deleted_at is null
```

---

## 2. 검증 명령과 결과

### 2.1 p4 A0 tag seed

```bash
DATABASE_URL=... pnpm --filter @consulting/api exec vitest run test/scope-tag-seed.test.ts --reporter=verbose
```

결과:

```text
1 passed / 1 test file
```

### 2.2 lifecycle/tombstone regression

```bash
DATABASE_URL=... pnpm --filter @consulting/api exec vitest run test/lifecycle-tombstone.test.ts --reporter=verbose
```

결과:

```text
5 passed / 1 test file
```

### 2.3 contracts full test

```bash
pnpm --filter @consulting/contracts test -- --reporter=verbose
```

결과:

```text
39 passed / 7 test files
```

### 2.4 monorepo full test

```bash
pnpm test -- --reporter=dot
```

결과:

```text
Tasks: 10 successful, 10 total
@consulting/api: 27 passed / 43 skipped
@consulting/web: 41 passed
@consulting/contracts: 39 passed
@consulting/api-client: 15 passed
@consulting/shared: 6 passed
```

### 2.5 schema/api compile

```bash
pnpm --filter @consulting/db-schema build
pnpm --filter @consulting/api typecheck
```

결과: GREEN.

### 2.6 final full gates

```bash
pnpm test -- --reporter=dot
pnpm typecheck
pnpm build
pnpm lint
docker compose --env-file .env.docker -f docker-compose.prod.yml config --quiet
```

결과:

```text
pnpm test: Tasks 10 successful / 10 total
pnpm typecheck: Tasks 10 successful / 10 total
pnpm build: Tasks 6 successful / 6 total
pnpm lint: Tasks 6 successful / 6 total
compose config: compose_config_ok
```

주의: `pnpm lint`는 기존 `eslint.config.js` module type 경고만 출력했고 exit code는 0이다.

### 2.7 DB ghost-reference final probe

```text
live_edges_to_deleted = 0
live_tags_to_deleted  = 0
```

### 2.8 운영 Docker 배포 및 smoke/browser QA

```bash
docker compose --env-file .env.docker -f docker-compose.prod.yml build migrate api web
docker compose --env-file .env.docker -f docker-compose.prod.yml up --force-recreate --no-deps migrate
docker compose --env-file .env.docker -f docker-compose.prod.yml up -d --force-recreate --no-deps api
docker compose --env-file .env.docker -f docker-compose.prod.yml up -d --force-recreate --no-deps web
```

결과:

```text
migrate: 0012_backfill_deleted_scope_graph_tombstones.sql skip/complete, exit 0
api: consulting-web-api-1 healthy
web: consulting-web-web-1 running, 127.0.0.1:8088->80
version.json: 20260707-0025, assets=589
/api/health/ready: api/db/redis/bullmq/hermes all ok
operational smoke: root/version/sw/cache header/signup/login/scope CRUD/chat SSE/message persistence/search contract GREEN
browser QA: login→AppShell render OK, console JS error 0
cleanup: smoke_users_remaining = 0
```

---

## 3. 남은 위험 — 7개 고도화 전 선결조건

아래는 아직 “고급 고도화”가 아니라, 고도화 전 품질 기반이다.

| 순서 | 선결조건 | 상태 | 이유 |
|---:|---|---|---|
| 1 | 현재 변경분 전체 typecheck/build/test 재실행 | 완료 | `test/typecheck/build/lint/compose config` GREEN |
| 2 | API/web Docker image 재빌드·재배포 여부 결정 | 완료 | `migrate/api/web` 이미지 재빌드, migrate 재실행(`0012` skip/complete), api healthy, web `127.0.0.1:8088->80` 교체 완료 |
| 3 | p4 A0 `ScopeTagSeedService` CLI/운영 dry-run | 미완 | 서비스 테스트는 GREEN, 운영 CLI는 다음 구현 시작 전 필요 |
| 4 | GraphRAG ingest outbox/queue 설계 | 남음 | 현재 fire-and-forget라 인제스트 실패가 조용히 유실될 수 있음 |
| 5 | active/archive/deleted 상태 정책 공통 helper | 남음 | 일부 access/read path가 개별 조건을 가진다. 큰 리팩터는 새 세션 판단 필요 |

---

## 4. 7개 고도화 목록 — 새 세션에서 진행

이 세션에서는 아래 본구현을 시작하지 않는다.

1. **Hybrid RRF + reranker 복원**
   - Dense Gemini vector + FTS5/BM25 + graph proximity + reranker.
2. **CRAG/Self-RAG식 retrieval evaluator**
   - 검색 결과가 질문에 충분한지 `correct/ambiguous/insufficient`로 분기.
3. **Citation/evidence post-check / CiteFix류 검증**
   - 생성 답변의 인용/근거가 실제 retrieved chunk와 맞는지 후검증.
4. **RAGAS/STaRK식 자체 평가셋**
   - consulting 전용 검색/답변 평가 질문셋과 metric harness.
5. **RAPTOR 계층 요약 검색**
   - 긴 대화·문서 corpus를 recursive summary tree로 검색.
6. **Microsoft GraphRAG Leiden community summary**
   - global sensemaking 질문을 위한 community report layer.
7. **ToG-2식 KG×Text iterative deep mode**
   - deep research 질문에서 graph hop과 text retrieval을 교대로 수행.

---

## 5. 다음 세션 운영 원칙

- 먼저 full gate를 재측정하고 시작한다.
- 고급 고도화는 반드시 **평가셋 먼저** 만든 뒤 구현한다.
- `consulting.db`는 기존 GraphRAG SoT다. 새 pgvector/store부터 만들지 않는다.
- cross-workspace는 hard block. cross-project는 workspace 내부에서만 0.6 감쇠 + “다른 프로젝트” 라벨.
- 보관 자료는 referenceable하되, 답변에는 archive/cross-project 라벨이 붙어야 한다.
- 질문에 직접 답하지 못하는 근거는 prompt에 주입하지 않거나 `근거 부족`으로 표시한다.

---

## 6. 새 세션에서 첫 명령 후보

```bash
cd /home/jigoo/.hermes/workspace/consulting-web
pnpm test -- --reporter=dot
pnpm typecheck
pnpm build
```

그 다음 `.hermes/plans/2026-07-07_next-session-advanced-graphrag-prompt.md`의 프롬프트를 그대로 사용한다.
