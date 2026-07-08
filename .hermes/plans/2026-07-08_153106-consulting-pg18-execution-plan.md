# Consulting PG18 실행 구현 계획

> **For Hermes:** 구현 시 `subagent-driven-development`, `test-driven-development`, `database-store-migration`, `consulting-web-architecture`를 로드하고 task-by-task로 진행한다.
> **Source plan:** `.hermes/plans/2026-07-08_1508-consulting-pg18-migration.md`
> **작성 시각:** 2026-07-08 15:31 KST

**Goal:** consulting-web product DB와 shared consulting brain을 PostgreSQL 18 + pgvector 기반으로 옮기되, 최종 cutover 승인 전에는 운영 PG16/SQLite writer path를 건드리지 않는다.

**Architecture:** 먼저 PG18 sidecar에서 product PG16 logical restore와 consulting SQLite logical import를 완전히 리허설한다. SQLite는 `brain_raw` faithful copy와 `brain_rag` 검색 파생층으로 나누고, Python runtime은 `sqlite|dual|pg` adapter 뒤로 숨긴다. cutover는 shadow 24–72h와 rollback dry-run이 통과한 뒤 별도 승인으로만 실행한다.

**Tech stack:** Docker Compose, `pgvector/pgvector:pg18`, PostgreSQL extensions(`vector`, `pg_trgm`, `uuid-ossp`, `btree_gin`), Python sqlite3/psql/pytest, NestJS + Drizzle + pnpm/vitest.

---

## 0. 실측 전제와 현재 상태

### 확인한 것

- `pgvector/pgvector:pg18` manifest 존재 확인: linux/amd64, linux/arm64.
- `consulting-web-pg-1`: PostgreSQL 16.14, `public` base tables 46개, extension은 `plpgsql`만 설치.
- shared brain SQLite: `/home/jigoo/.hermes/workspace/consulting/db/consulting.db`, 99,954,688 bytes, tables/virtual 231, topics 2, dialogue_chunks 132, file_chunks 1298, rag_chunks 1559, evidence_items 83, claims 37.
- PG18 관련 구현 파일은 아직 없음:
  - `consulting-web/*pg18*` 검색 결과 0
  - `consulting/scripts/pg_migration*` 검색 결과 0
  - `consulting/scripts/consulting_store*` 검색 결과 0
- 현재 runtime은 SQLite 직접 의존이 많음:
  - `consulting/scripts/dialogue_memory/store.py`의 `connect()`가 `sqlite3.connect(DB)` 후 DDL을 실행.
  - `consulting-web/apps/api/scripts/ingest_web_dialogue.py`가 `S.connect()`와 별도 `sqlite3.connect(S.DB)`를 직접 사용.
  - `consulting-web/scripts/sync_changwon_telegram.py`가 `CONSULTING_DB` SQLite를 직접 읽음.
  - `consulting-web/apps/api/src/consulting/consulting-graphrag-bridge.service.ts`가 `dialogue_memory_cli.py recall`을 subprocess로 호출.
- repo hygiene:
  - `consulting` repo는 clean 상태.
  - `consulting-web` repo에는 기존 web UI dirty changes와 untracked docs/plan이 있음. PG18 작업은 별도 브랜치/커밋으로 섞지 말고 시작 전 diff를 보존한다.

### 승인 경계

- 읽기전용 audit, sidecar compose 파일 작성, sidecar container 생성/삭제, sidecar restore/import 리허설: 진행 가능.
- 운영 compose/env 변경, 운영 cron pause/resume, 운영 DB schema/data write, final cutover, SQLite rename/delete: **주인님 명시 승인 전 금지**.
- API key/DB password 원문은 로그/문서에 쓰지 않는다. DSN은 `postgres://consulting:***@...` 형태로 마스킹한다.

---

## 1. 실행 원칙

1. **TDD vertical slice:** production code 전에 실패 테스트를 먼저 만든다. 특히 schema introspection, type map, backend resolver, no-live-sqlite guard는 반드시 RED를 본다.
2. **Faithful copy first:** SQLite 원본 테이블은 `brain_raw`에 1:1 논리 복사한다. 정규화/검색 최적화는 `brain_rag` 파생층에서만 한다.
3. **No in-place major upgrade:** PG16 volume을 PG18에 직접 물리지 않는다. 항상 `pg_dump -Fc` → PG18 restore.
4. **Shadow before cutover:** sidecar에서 DB/API/cron/browser 경로를 지구가 직접 조회·실행해 증거 파일을 남긴 뒤에만 cutover 후보가 된다.
5. **Rollback as artifact:** rollback script가 dry-run으로 정확한 원복 경로를 출력하지 않으면 cutover 금지.

---

## 2. 구현 작업 순서

## Phase 0 — repo hygiene + baseline audit

**Objective:** 현재 운영 상태와 SQLite/PG16 golden baseline을 재현 가능한 파일로 남긴다.

### Task 0.1 — 작업 브랜치와 dirty-state 방어

**Files:**
- Create: `consulting-web/docs/pg18-migration-worklog.md`

**Steps:**
1. `consulting-web`에서 현재 dirty diff를 저장만 확인한다.
   ```bash
   cd /home/jigoo/.hermes/workspace/consulting-web
   git status --short
   git diff --stat
   ```
2. PG18 작업 브랜치를 만든다. 기존 dirty change가 있으므로 commit/stash는 주인님 지시 없이는 하지 않는다.
   ```bash
   git switch -c pg18-consulting-migration
   ```
3. worklog에 시작 상태를 기록한다.

**Pass gate:** PG18 작업 파일과 기존 UI dirty 파일이 섞였는지 `git status --short`로 구분 가능해야 한다.

### Task 0.2 — SQLite baseline auditor

**Files:**
- Create: `/home/jigoo/.hermes/workspace/consulting/scripts/pg_migration/audit_sqlite_baseline.py`
- Test: `/home/jigoo/.hermes/workspace/consulting/scripts/tests/test_pg_migration_audit_sqlite_baseline.py`

**TDD:**
1. fixture SQLite를 만들고 integer/text/composite/PK-less 테이블을 넣는 테스트를 먼저 작성.
2. auditor가 `mode=ro` URI로 열고 table count, row count, PK checksum, FTS/shadow classification을 JSON으로 내는지 검증.
3. live 실행:
   ```bash
   cd /home/jigoo/.hermes/workspace/consulting
   python3 -m pytest scripts/tests/test_pg_migration_audit_sqlite_baseline.py -q
   python3 scripts/pg_migration/audit_sqlite_baseline.py --db db/consulting.db --json > /tmp/consulting_sqlite_baseline.json
   ```

**Pass gate:** live DB를 쓰지 않았고, JSON에 모든 logical table row-count/checksum이 포함된다.

### Task 0.3 — product PG16 baseline auditor

**Files:**
- Create: `/home/jigoo/.hermes/workspace/consulting-web/scripts/pg18_migration/audit_product_pg.py`
- Test: 가능한 pure SQL builder/unit test 또는 dry-run fixture.

**Steps:**
1. container/DSN 입력을 모두 지원하되 secret 출력 금지.
2. `information_schema.tables`, `pg_stat_user_tables`, PK checksum SQL을 생성.
3. live read-only 실행:
   ```bash
   cd /home/jigoo/.hermes/workspace/consulting-web
   python3 scripts/pg18_migration/audit_product_pg.py --container consulting-web-pg-1 --json > /tmp/product_pg16_baseline.json
   ```

**Pass gate:** 46 public tables와 row-count/checksum이 source artifact로 저장된다.

### Task 0.4 — baseline report 저장

**Files:**
- Create: `/home/jigoo/.hermes/workspace/consulting-web/docs/pg18-migration-baseline-YYYYMMDD.md`

**Content:**
- SQLite summary + checksum artifact path
- PG16 summary + checksum artifact path
- Docker container identity
- hardcoded SQLite dependency inventory
- initial golden recall query list 후보 10개

**Pass gate:** Phase 1 이후 restore/import 검증이 이 report를 기준으로 자동 비교 가능해야 한다.

---

## Phase 1 — PG18 sidecar rehearsal

**Objective:** 운영 PG16/SQLite를 건드리지 않고 PG18+pgvector cluster를 별도 volume/port로 띄운다.

### Task 1.1 — rehearsal compose와 extension smoke

**Files:**
- Create: `/home/jigoo/.hermes/workspace/consulting-web/docker-compose.pg18-rehearsal.yml`
- Create: `/home/jigoo/.hermes/workspace/consulting-web/scripts/pg18_migration/create_extensions.sql`
- Create: `/home/jigoo/.hermes/workspace/consulting-web/scripts/pg18_migration/smoke_pg18_extensions.sh`

**Implementation notes:**
- service name: `pg18`
- project name: `consulting-web-pg18-rehearsal`
- host port: `127.0.0.1:55418:5432`
- volume: `pg18-rehearsal-data`
- extensions:
  ```sql
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  CREATE EXTENSION IF NOT EXISTS btree_gin;
  ```

**Verify:**
```bash
cd /home/jigoo/.hermes/workspace/consulting-web
docker compose -f docker-compose.pg18-rehearsal.yml --env-file .env.docker up -d pg18
bash scripts/pg18_migration/smoke_pg18_extensions.sh
```

**Pass gate:** extension list에 4개가 모두 보이고, 운영 `consulting-web-pg-1` container/volume에는 변화가 없어야 한다.

### Task 1.2 — PG16 product dump/restore rehearsal

**Files:**
- Create: `consulting-web/scripts/pg18_migration/dump_product_pg16.sh`
- Create: `consulting-web/scripts/pg18_migration/restore_product_pg18.sh`
- Create: `consulting-web/scripts/pg18_migration/verify_product_restore.py`

**Steps:**
1. `consulting-web-pg-1`에서 `pg_dump -Fc`를 `backups/pg18-migration/`에 저장.
2. sidecar PG18에 `pg_restore --clean --if-exists --no-owner`.
3. baseline JSON과 target JSON을 비교.

**Verify:**
```bash
bash scripts/pg18_migration/dump_product_pg16.sh
bash scripts/pg18_migration/restore_product_pg18.sh
python3 scripts/pg18_migration/verify_product_restore.py \
  --baseline docs/pg18-migration-baseline-YYYYMMDD.product.json \
  --target-dsn 'postgres://consulting:***@127.0.0.1:55418/consulting'
```

**Pass gate:** 46 tables + row-count/checksum match. Drizzle migration runner가 PG18에서 pending destructive drift 없이 통과해야 한다.

---

## Phase 2 — SQLite logical import + brain schemas

**Objective:** consulting SQLite를 `brain_raw`에 faithful copy하고, `brain_rag` 검색 파생층을 만든다.

### Task 2.1 — SQLite schema introspector

**Files:**
- Create: `consulting/scripts/pg_migration/sqlite_schema_introspect.py`
- Test: `consulting/scripts/tests/test_pg_migration_schema_introspect.py`

**Required behavior:**
- `PRAGMA table_info`, `index_list`, `foreign_key_list`를 읽는다.
- real PK order를 `pk_order`로 보존한다. `id` hardcode 금지.
- FTS virtual/shadow table을 logical source에서 제외 후보로 분류한다.

**Verify:**
```bash
cd /home/jigoo/.hermes/workspace/consulting
python3 -m pytest scripts/tests/test_pg_migration_schema_introspect.py -q
python3 scripts/pg_migration/sqlite_schema_introspect.py --db db/consulting.db --json > /tmp/consulting_schema.json
```

### Task 2.2 — type map + DDL generator

**Files:**
- Create: `consulting/scripts/pg_migration/create_brain_schemas.sql`
- Extend: `consulting/scripts/pg_migration/sqlite_schema_introspect.py`
- Test: `consulting/scripts/tests/test_pg_migration_type_map.py`

**Rules:**
- SQLite `INTEGER` → PG `bigint` 기본, PK/rowid 의미는 보존.
- `REAL` → `double precision`.
- `TEXT` → `text`; JSON 승격은 derived layer에서만.
- `BLOB` → `bytea`; pgvector 변환은 dimension 검증 뒤 derived layer에서만.
- FTS virtual/shadow는 raw source of truth로 blindly copy하지 않는다.

**Pass gate:** generated DDL은 `CREATE SCHEMA IF NOT EXISTS brain_raw/brain_rag/brain_ops`를 포함하고 destructive token이 없어야 한다.

### Task 2.3 — idempotent SQLite→PG18 importer

**Files:**
- Create: `consulting/scripts/pg_migration/sqlite_to_pg18_brain.py`
- Create: `consulting/scripts/pg_migration/verify_pg18_brain.py`
- Test: `consulting/scripts/tests/test_sqlite_to_pg18_brain_importer.py`

**Implementation contract:**
- dry-run은 PG에 쓰지 않고 plan/checksum만 출력.
- apply는 temp/unlogged staging table → `INSERT ... ON CONFLICT` 방식.
- every run을 `brain_ops.migration_runs`에 기록.
- COPY는 Korean/JSON 안전을 위해 text escaping 또는 json-safe path를 사용.

**Verify:**
```bash
cd /home/jigoo/.hermes/workspace/consulting
python3 scripts/pg_migration/sqlite_to_pg18_brain.py --db db/consulting.db --dsn 'postgres://...' --dry-run
python3 scripts/pg_migration/sqlite_to_pg18_brain.py --db db/consulting.db --dsn 'postgres://...' --apply
python3 scripts/pg_migration/sqlite_to_pg18_brain.py --db db/consulting.db --dsn 'postgres://...' --apply
python3 scripts/pg_migration/verify_pg18_brain.py --db db/consulting.db --dsn 'postgres://...'
```

**Pass gate:** second apply duplicate 0, logical table row-count/checksum match, FTS/shadow exclusion 사유 기록.

---

## Phase 3 — PG-native GraphRAG recall parity

**Objective:** SQLite FTS5/BLOB 기반 recall을 PG18 `brain_rag`에서 재현 가능한 수준으로 만든다.

### Task 3.1 — embedding dimension audit + vector builder

**Files:**
- Create: `consulting/scripts/pg_migration/build_pg_vectors.py`
- Test: `consulting/scripts/tests/test_pg_vector_dimension_audit.py`

**Required behavior:**
- BLOB length % 4 검증.
- table/column별 dimension histogram 출력.
- fixed dimension인 것만 `vector(n)` 파생 테이블에 insert.
- invalid rows는 bytea raw에 남기고 `invalid_count`로 보고.

### Task 3.2 — trigram/tsvector search indexes

**Files:**
- Create: `consulting/scripts/pg_migration/create_brain_search_indexes.sql`
- Test: SQL artifact lint test.

**Pass gate:** `brain_rag`에 dialogue/file/rag chunk 검색용 GIN/GiST 또는 vector index가 생기고, re-run idempotent.

### Task 3.3 — recall parity eval

**Files:**
- Create: `consulting/scripts/pg_migration/recall_parity_eval.py`
- Create: `consulting/fixtures/pg18_recall_queries.json`
- Test: `consulting/scripts/tests/test_recall_parity_eval.py`

**Queries:** 창원/근속승진/보수체계/대행사업/조직진단 등 대표 Korean query 10개.

**Verify:**
```bash
python3 scripts/pg_migration/recall_parity_eval.py \
  --sqlite-db db/consulting.db \
  --pg-dsn 'postgres://...' \
  --queries fixtures/pg18_recall_queries.json \
  --output /tmp/pg18_recall_parity.json
```

**Pass gate:** empty regression 0. top-k overlap과 qualitative blocker를 report에 저장. 점수 threshold는 첫 리허설 결과를 보고 lock한다.

---

## Phase 4 — runtime adapter (`sqlite|dual|pg`)

**Objective:** 기존 SQLite 직접 호출을 `consulting_store` adapter 뒤로 옮기고, 기본은 계속 `sqlite`로 유지한다.

### Task 4.1 — backend resolver와 PG query helper

**Files:**
- Create: `consulting/scripts/consulting_store/__init__.py`
- Create: `consulting/scripts/consulting_store/backend.py`
- Create: `consulting/scripts/consulting_store/query_json.py`
- Test: `consulting/scripts/tests/test_consulting_store_backend.py`
- Test: `consulting/scripts/tests/test_consulting_store_pg_sql_builder.py`

**Rules:**
- `CONSULTING_STORE_BACKEND=sqlite|dual|pg`
- resolution: env → `~/.hermes/consulting_store_backend` → `sqlite`
- invalid backend fail-fast
- PG reader는 `json_agg` 기반으로 Korean/JSON fidelity 보존
- secret DSN은 repr/log에 raw 출력 금지

### Task 4.2 — sqlite backend wrapper

**Files:**
- Create: `consulting/scripts/consulting_store/sqlite_backend.py`
- Modify minimally: `consulting/scripts/dialogue_memory/store.py`
- Test: existing dialogue memory tests + new guard tests.

**Approach:**
- 기존 `store.py` API를 한 번에 갈아엎지 않는다.
- 먼저 `connect()`, `topic_id()`, `stats()` 등 read-heavy function을 adapter 호출로 감싼다.
- 기존 SQLite behavior는 default에서 동일해야 한다.

### Task 4.3 — PG backend minimal recall/read path

**Files:**
- Create: `consulting/scripts/consulting_store/pg_backend.py`
- Modify: `consulting/scripts/dialogue_memory_cli.py`
- Modify: `consulting/scripts/dialogue_memory/search.py`
- Test: `consulting/scripts/tests/test_dialogue_memory_pg_backend.py`

**Slice:**
- 처음에는 `recall`/`stats` read path만 PG 지원.
- write path는 다음 task에서 dual/pg로 추가.

**Pass gate:** `CONSULTING_STORE_BACKEND=pg python3 scripts/dialogue_memory_cli.py recall ...`이 sidecar PG18에서 non-empty result를 반환하거나 명확한 blocker를 출력.

### Task 4.4 — write/ingest path adapterization

**Files:**
- Modify: `consulting/scripts/dialogue_memory/ingest.py`
- Modify: `consulting/scripts/dialogue_memory/file_ingest.py`
- Modify: `consulting/scripts/dialogue_memory/md_ingest.py`
- Modify: `consulting/scripts/dialogue_state.py`
- Modify: `consulting/scripts/weekly_kpi_reporter.py`
- Test: no-live-SQLite-open guard per CLI path.

**Pass gate:** `pg` mode에서 live `/db/consulting.db` open 시도가 monkeypatch guard에 잡히지 않아야 한다. `dual` mode는 SQLite+PG write/readback delta를 marker로 검증한다.

---

## Phase 5 — consulting-web bridge PG mode

**Objective:** web API의 shared-brain 호출 경로가 PG backend를 사용할 수 있게 한다.

### Task 5.1 — web ingest script PG support

**Files:**
- Modify: `consulting-web/apps/api/scripts/ingest_web_dialogue.py`
- Test: `consulting-web/apps/api/test/fixtures/consulting_web_ingest_failopen.py` 또는 신규 Python test.

**Current blocker:** 이 파일은 현재 `S.connect()` + `sqlite3.connect(S.DB)`를 직접 호출한다.

**Implementation:**
- `CONSULTING_STORE_BACKEND`/`CONSULTING_PG_DSN`를 읽는다.
- `sqlite` default behavior는 유지.
- `pg` mode에서는 `consulting_store` API를 사용하고 live SQLite open 금지.

### Task 5.2 — Telegram sync PG support

**Files:**
- Modify: `consulting-web/scripts/sync_changwon_telegram.py`
- Test: 신규 dry-run/fixture test.

**Current blocker:** `CONSULTING_DB` SQLite를 직접 연다.

**Verify:**
```bash
cd /home/jigoo/.hermes/workspace/consulting-web
CONSULTING_STORE_BACKEND=pg CONSULTING_PG_DSN='postgres://...' python3 scripts/sync_changwon_telegram.py --quiet --dry-run
```

### Task 5.3 — Nest bridge env plumbing

**Files:**
- Modify if needed: `consulting-web/apps/api/src/consulting/consulting-graphrag-bridge.service.ts`
- Modify if needed: `consulting-web/apps/api/src/consulting/consulting-web-ingest.worker.ts`
- Test: `consulting-web/apps/api/test/consulting-graphrag-bridge.test.ts`

**Rules:**
- backend/env vars passed only server-side.
- browser never sees DSN/secrets.
- upstream failures return typed `empty/error/timeout`, not raw secret/error strings.

**Verify:**
```bash
pnpm --filter @consulting/api test
pnpm --filter @consulting/api build
```

---

## Phase 6 — 지구 직접 shadow operation

**Objective:** sidecar PG18이 실제 운영 경로와 연결되는지 DB/API/cron/browser 끝단에서 지구가 직접 증거를 남긴다.

**Files:**
- Create: `consulting-web/scripts/pg18_migration/shadow_compare.sh`
- Create: `consulting-web/scripts/pg18_migration/shadow_connectivity_probe.py`
- Create: `consulting-web/docs/pg18-shadow-report-YYYYMMDD.md`

**Checklist:**
1. Product PG16→PG18 checksum compare.
2. SQLite→`brain_raw` checksum compare.
3. `brain_raw`→`brain_rag` index/vector audit.
4. Golden Korean recall query JSON 저장.
5. `CONSULTING_STORE_BACKEND=pg` search CLI non-empty/topic-correct result.
6. `CONSULTING_STORE_BACKEND=dual` ingest marker run → PG18 delta/readback → cleanup/idempotency 확인.
7. `sync_changwon_telegram.py --quiet --dry-run` no duplicate/drop.
8. PG18 smoke stack 또는 script-level API health/thread/message readback.
9. Browser QA: login → project/thread load → search/evidence/chat smoke. TEST-only marker 사용.
10. no-live-SQLite-open guard.

**Pass gate:** `pg18-shadow-report-YYYYMMDD.md`에 모든 evidence path가 있고, blocker가 없거나 cutover blocker로 명시돼야 한다.

---

## Phase 7 — cutover/rollback runbook and scripts

**Objective:** final operation을 실행 전 dry-run 가능한 script로 고정한다.

**Files:**
- Create: `consulting-web/scripts/pg18_migration/cutover_pg18.sh`
- Create: `consulting-web/scripts/pg18_migration/rollback_pg16_sqlite.sh`
- Create: `consulting-web/docs/pg18-cutover-runbook.md`

**Script requirements:**
- default는 dry-run.
- `--apply` 없으면 mutation 금지.
- backup path, final dump hash, sqlite copy hash를 필수 입력/출력.
- cron pause/resume 명령은 실제 실행 전 주인님 승인을 다시 요구하는 주석/guard 포함.

**Verify:**
```bash
bash scripts/pg18_migration/cutover_pg18.sh --dry-run
bash scripts/pg18_migration/rollback_pg16_sqlite.sh --dry-run
```

**Pass gate:** dry-run이 실행 순서와 rollback path를 명확히 출력하고, 실제 운영 자원에는 변화가 없어야 한다.

---

## Phase 8 — approved cutover

**Objective:** 승인된 low-traffic window에서 PG18로 전환한다.

**Requires explicit approval:** yes.

**Preconditions:**
- Phase 0–7 pass.
- shadow 24h minimum, preferred 48–72h.
- final backup command와 rollback command가 dry-run 통과.
- consulting-only cron pause 목록 확정.

**Execution outline:**
1. consulting-only cron pause 또는 maintenance-aware 전환.
2. API/web write freeze.
3. final PG16 dump + SQLite copy + sha256.
4. final restore/import into PG18 final volume.
5. compose/env/backend switch.
6. migrate + api/web restart.
7. immediate DB/API/browser/script smoke.
8. consulting cron resume.

**Pass gate:** counts/checksums match, public health OK, recall/search non-empty, Telegram sync no duplicate, logs에 live SQLite open 없음.

---

## Phase 9 — SQLite runtime decommission

**Objective:** PG-only 안정화 후 SQLite live fallback을 물리적으로 불가능하게 만든다.

**Requires explicit approval:** yes, especially file rename/delete.

**Preconditions:**
- agreed stability window complete.
- consulting cron 전부 PG mode에서 1회 이상 성공.
- browser/API smoke after restart pass.
- no live SQLite opens.

**Steps:**
1. guard test를 CI/pre-commit에 추가.
2. `db/consulting.db`를 backup 후 rename.
3. runtime smoke with file absent.
4. docs/skills 업데이트.
5. archive/migration/test fixture 외 raw SQLite reference 금지.

---

## 3. 병렬화 전략

- **Lane A:** baseline/audit scripts — side effect 없음, 먼저 실행.
- **Lane B:** sidecar compose/extension/product restore — Docker sidecar만 사용.
- **Lane C:** SQLite importer/schema introspector — consulting repo 중심.
- **Lane D:** backend adapter — C의 DDL/import contract가 안정화된 뒤 시작.
- **Lane E:** consulting-web bridge — D의 `pg` API가 최소 동작한 뒤 시작.

동시에 구현해도 되는 것은 A/B/C 초반뿐이다. D/E는 같은 runtime boundary를 만지므로 main owner 1명 + read-only reviewer 방식이 안전하다.

---

## 4. 검증 명령 묶음

### consulting repo

```bash
cd /home/jigoo/.hermes/workspace/consulting
python3 -m pytest scripts/tests/test_pg_migration_schema_introspect.py -q
python3 -m pytest scripts/tests/test_pg_migration_type_map.py -q
python3 -m pytest scripts/tests/test_consulting_store_backend.py scripts/tests/test_consulting_store_pg_sql_builder.py -q
CONSULTING_STORE_BACKEND=pg CONSULTING_PG_DSN='postgres://...' python3 -m pytest scripts/tests -q
```

### consulting-web repo

```bash
cd /home/jigoo/.hermes/workspace/consulting-web
pnpm --filter @consulting/api test
pnpm --filter @consulting/api typecheck
pnpm --filter @consulting/api build
pnpm --filter @consulting/web build
```

### sidecar/prod readback

```bash
cd /home/jigoo/.hermes/workspace/consulting-web
bash scripts/pg18_migration/smoke_pg18_extensions.sh
python3 scripts/pg18_migration/verify_product_restore.py --source-container consulting-web-pg-1 --target-dsn 'postgres://...'
python3 scripts/pg18_migration/shadow_connectivity_probe.py --pg18-dsn 'postgres://...' --sqlite-db /home/jigoo/.hermes/workspace/consulting/db/consulting.db --json
```

---

## 5. 공격적 검토: 틀릴 수 있는 지점

| Risk | Failure mode | Countermeasure |
|---|---|---|
| SQLite FTS5와 PG 검색 랭킹 차이 | recall 품질 저하 | golden query top-k overlap + no-empty gate |
| BLOB vector dimension 불일치 | pgvector insert 실패 | dimension audit; invalid은 raw bytea 보존 |
| SQLite 직접 open 잔존 | PG-only가 사실상 SQLite fallback | monkeypatch guard + grep/pre-commit guard + file-absent smoke |
| product PG16 restore만 보고 성공 착각 | shared brain runtime은 여전히 SQLite | brain_raw/brain_rag/import/adapter 별도 gate |
| cron green status 착각 | 실제 데이터 연결 안 됨 | 지구가 직접 cron wrapper 실행 + DB delta/readback |
| dirty UI changes와 PG18 작업 섞임 | rollback/commit 위험 | 시작 전 status 기록, PG18 files만 stage/commit |
| `consulting-postgres` 이름 혼동 | wrong DB target | sidecar/final container/volume 이름 명시, script target validation |
| final cutover 중 writes 발생 | checksum drift/lost write | freeze window + cron pause + final backup hash |

---

## 6. 추천 첫 실행 범위

**바로 시작할 범위는 Phase 0–1.2까지만 추천한다.**

이 범위는 다음 이유로 안전하다:
- 운영 writer/read path 변경 없음.
- 운영 DB/SQLite에 write 없음.
- sidecar container/volume만 새로 생김.
- 실제 난이도와 데이터 모양을 baseline/restore에서 먼저 드러낸다.

Phase 2부터는 SQLite logical import를 sidecar PG에 쓰기 시작하므로 여전히 운영 안전하지만 코드량이 커진다. Phase 4 이후는 runtime behavior change라 TDD+review+shadow가 필수다. Phase 8/9는 별도 승인 없이는 절대 실행하지 않는다.
