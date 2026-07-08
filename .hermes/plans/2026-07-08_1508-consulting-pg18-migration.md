# Consulting PG18 + pgvector Migration Plan

> **For Hermes:** Use `database-store-migration`, `consulting-web-architecture`, `test-driven-development`, and `subagent-driven-development` skills to implement this plan task-by-task.
> **운영 원칙:** 운영 DB/SQLite를 in-place로 갈아끼우지 않는다. PG18 sidecar 리허설이 통과하기 전에는 운영 writer/read path를 건드리지 않는다.
> **작성 시각:** 2026-07-08 15:08 KST

**Goal:** consulting 범위만 PostgreSQL 18 + pgvector 기반으로 전환하고, shared consulting brain의 SQLite runtime 의존성을 최종 폐기한다.

**Architecture:** 현재 `consulting-web` product DB는 PostgreSQL 16이고, shared consulting brain은 `/home/jigoo/.hermes/workspace/consulting/db/consulting.db` SQLite다. 목표는 하나의 consulting 전용 PG18+pgvector cluster 안에 product schema와 brain schema를 함께 두되, stock/crypto/research/surge 계열 PG16/Timescale/SQLite는 이번 작업에서 건드리지 않는 것이다. 운영 안전을 위해 PG18 sidecar에서 dump/restore + SQLite logical import + recall/e2e smoke를 먼저 통과시키고, 마지막 cutover만 짧은 freeze window에서 수행한다.

**Tech Stack:** PostgreSQL 18, `pgvector/pgvector:pg18`, `pg_trgm`, `uuid-ossp`, Drizzle migrations, NestJS API, Python consulting scripts, Docker Compose, Hermes cron jobs.

---

## 0. 현재 실측 상태

### 0.1 운영 컨테이너 / DB

```text
consulting-web-pg-1      postgres:16-alpine       product DB, docker-internal only
consulting-postgres      postgres:16              older/stale-looking consulting PG on 127.0.0.1:5434
research-app-postgres    timescale/timescaledb:latest-pg16  stock/crypto/research_app; out of scope
honcho-database-1        pgvector/pgvector:pg15    out of scope
gbrain-postgres          pgvector/pgvector:pg16    out of scope
```

Important: 이번 migration target은 `consulting-web`/shared `consulting` 범위만이다. `research-app-postgres`, stock/crypto/watchlist/surge 계열은 건드리지 않는다.

### 0.2 consulting-web product PG16

```text
container: consulting-web-pg-1
version: PostgreSQL 16.14 on Alpine
extensions: plpgsql only
tables: 46 public base tables
largest live row estimates:
  chat_messages 417
  telegram_message_imports 304
  context_edges 167
  audit_events 163
  outbox_events 152
  sessions 70
  scope_profiles 57
  threads 56
  topics 56
```

### 0.3 shared consulting brain SQLite

```text
path: /home/jigoo/.hermes/workspace/consulting/db/consulting.db
size: 99,954,688 bytes
tables / virtual tables: 231
topics: 2
dialogue_chunks: 132
file_chunks: 1298
rag_chunks: 1559
evidence_items: 83
claims: 37
FTS virtual tables: 4
```

### 0.4 active consulting cron/jobs that matter

```text
consulting-dialogue-ingest
  schedule: every 30m
  script: ~/.hermes/scripts/consulting_dialogue_ingest.py
  current behavior: reads topics from consulting.db, then runs dialogue/file/md ingest scripts.

sync-changwon-telegram-to-consulting-web
  schedule: every 5m
  script: ~/.hermes/scripts/sync_changwon_telegram_to_consulting_web.sh
  current behavior: runs consulting-web/scripts/sync_changwon_telegram.py.

consulting-web-public-health
  schedule: every 5m
  script: ~/.hermes/scripts/consulting-web-public-health.sh
  current behavior: health watchdog; should be paused or maintenance-aware during cutover to avoid false alerts.

Consulting Logic v2 weekly KPI report
  schedule: weekly
  script: ~/.hermes/scripts/consulting_weekly_kpi.sh
  current behavior: calls consulting/scripts/weekly_kpi_reporter.py, which opens consulting.db.
```

---

## 1. Non-negotiable 운영 안전 원칙

1. **No in-place major upgrade.** PG16 data volume을 PG18 컨테이너에 바로 물리지 않는다. PostgreSQL major version은 on-disk 호환이 깨질 수 있으므로 `pg_dump -Fc` → PG18 sidecar restore로 증명한다.
2. **No direct SQLite delete before PG-only proof.** “SQLite 폐기”의 의미는 먼저 runtime 의존성 0개를 만드는 것이다. 물리 파일은 rollback artifact로 보존했다가 안정화 후 승인받아 제거한다.
3. **No stock/crypto/research collateral damage.** `research-app-postgres`, stock/crypto/watchlist/surge cron/DB는 이번 scope 밖이다.
4. **Sidecar rehearsal first.** 새 PG18 cluster는 별도 volume/port/name으로 띄운다. 운영 API/web/cron은 리허설 중 기존 PG16+SQLite를 계속 사용한다.
5. **Freeze only at final cutover.** 마지막 전환 시에만 consulting-specific cron과 web writer를 짧게 멈춘다. freeze 전후 row-count/checksum을 남긴다.
6. **Rollback must be one command path.** old PG16 volume과 SQLite 파일은 cutover 직후에도 그대로 남겨둔다. 실패하면 compose/env/backend switch를 원복하고 consulting cron을 재개한다.

---

## 2. Target architecture

### 2.1 Target image

Use:

```text
pgvector/pgvector:pg18
```

Required extensions in target DB:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS btree_gin;
```

`postgres:18` is valid, but for GraphRAG we want `vector`, so `pgvector/pgvector:pg18` is the default target.

### 2.2 Target DB layout

Keep the existing consulting-web product schema intact:

```text
public.*        existing consulting-web product tables restored from PG16
```

Add brain schemas instead of dumping all SQLite tables into `public`:

```text
brain_raw.*     faithful 1:1 logical copy of SQLite source tables, preserving source column names
brain_rag.*     pgvector/trigram/search-ready derived tables and indexes
brain_ops.*     migration ledger, source snapshot checksums, cutover/audit metadata
```

Rationale:

- `public` remains Drizzle/Nest product schema.
- `brain_raw` is the verifiable faithful copy layer.
- `brain_rag` is where SQLite FTS5/vector behavior is translated to Postgres-native search.
- `brain_ops` stores migration proofs so future sessions do not rely on chat memory.

### 2.3 SQLite 폐기 definition

```text
Phase A: runtime no longer opens /db/consulting.db for reads/writes.
Phase B: compatibility tests fail fast if a code path tries sqlite3.connect(live consulting.db).
Phase C: compressed SQLite backup is retained only as rollback artifact, not source of truth.
Phase D: after stability window and explicit approval, remove/rename the live consulting.db path so accidental fallback cannot happen.
```

This satisfies “SQLite 폐기” without risking unrecoverable data loss during cutover.

---

## 3. Phase plan

## Phase 0 — Read-only inventory and golden baseline

**Objective:** Find every consulting runtime path that reads/writes SQLite or PG16 and define golden outputs before touching production.

**Files / paths to inspect:**

- consulting shared brain:
  - `/home/jigoo/.hermes/workspace/consulting/scripts/dialogue_memory/*.py`
  - `/home/jigoo/.hermes/workspace/consulting/scripts/source_os/*.py`
  - `/home/jigoo/.hermes/workspace/consulting/scripts/weekly_kpi_reporter.py`
  - `/home/jigoo/.hermes/workspace/consulting/changwon/scripts/*.py`
  - `/home/jigoo/.hermes/workspace/consulting/db/migrations/*.sql`
- consulting-web:
  - `docker-compose.prod.yml`
  - `apps/api/scripts/ingest_web_dialogue.py`
  - `scripts/sync_changwon_telegram.py`
  - `apps/api/src/chat/chat-stream.usecase.ts`
  - `apps/api/src/graphrag` or bridge-related services if present
  - `packages/db-schema/drizzle/*.sql`
- Hermes cron:
  - `consulting-dialogue-ingest`
  - `sync-changwon-telegram-to-consulting-web`
  - `consulting-web-public-health`
  - `Consulting Logic v2 weekly KPI report`

**Commands:**

```bash
cd /home/jigoo/.hermes/workspace/consulting
python3 - <<'PY'
import sqlite3, pathlib, json
p=pathlib.Path('db/consulting.db')
con=sqlite3.connect(f'file:{p.resolve()}?mode=ro', uri=True)
cur=con.cursor()
print(json.dumps({
  'db_bytes': p.stat().st_size,
  'tables': cur.execute("select count(*) from sqlite_master where type in ('table','virtual')").fetchone()[0],
  'topics': cur.execute('select count(*) from topics').fetchone()[0],
  'dialogue_chunks': cur.execute('select count(*) from dialogue_chunks').fetchone()[0],
  'file_chunks': cur.execute('select count(*) from file_chunks').fetchone()[0],
  'rag_chunks': cur.execute('select count(*) from rag_chunks').fetchone()[0],
}, ensure_ascii=False, indent=2))
PY
```

```bash
cd /home/jigoo/.hermes/workspace/consulting-web
docker exec -i consulting-web-pg-1 psql -U consulting -d consulting -At <<'SQL'
select 'tables ' || count(*) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE';
select schemaname || '.' || relname || ' ' || n_live_tup
from pg_stat_user_tables
order by n_live_tup desc, relname
limit 50;
SQL
```

**Golden outputs to capture:**

1. SQLite table count and per-table row counts.
2. SQLite primary-key checksum per table:
   - integer PK: `count`, `sum(pk)`, `min(pk)`, `max(pk)`
   - text PK: `count(distinct pk)`
   - composite PK: row count + md5 aggregate of ordered key tuples
3. Product PG16 row counts for every `public` table.
4. Search/recall golden set:
   - 10 representative Korean queries from Changwon/current consulting topics.
   - top-10 chunk IDs and titles from current SQLite FTS/vector/RRF path.
   - answer-context snapshot for web chat GraphRAG bridge.
5. Runtime golden set:
   - `consulting_dialogue_ingest.py` dry run or no-op behavior.
   - `sync_changwon_telegram.py --quiet` no-write/no-new-message behavior.
   - weekly KPI report output hash on current data.
   - consulting-web public health.

**Pass gate:** Read-only baseline report saved under:

```text
consulting-web/docs/pg18-migration-baseline-YYYYMMDD.md
```

No production mutation in this phase.

---

## Phase 1 — PG18 sidecar rehearsal cluster

**Objective:** Create a parallel PG18+pgvector cluster without touching existing `consulting-web-pg-1` or `consulting-postgres`.

**New files:**

- `docker-compose.pg18-rehearsal.yml`
- `scripts/pg18_rehearsal/create_extensions.sql`
- `scripts/pg18_rehearsal/restore_product_pg16.sh`
- `scripts/pg18_rehearsal/audit_product_restore.sh`

**Compose target:**

```yaml
name: consulting-web-pg18-rehearsal
services:
  pg18:
    image: pgvector/pgvector:pg18
    environment:
      POSTGRES_USER: consulting
      POSTGRES_PASSWORD: ${PG_PASSWORD:?set in .env.docker}
      POSTGRES_DB: consulting
    ports:
      - '127.0.0.1:55418:5432'
    volumes:
      - pg18-rehearsal-data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U consulting -d consulting']
      interval: 5s
      timeout: 3s
      retries: 20
volumes:
  pg18-rehearsal-data:
```

**Product DB rehearsal:**

1. Dump current product PG16:

```bash
mkdir -p /home/jigoo/.hermes/workspace/consulting-web/backups/pg18-migration
TS=$(date +%Y%m%d_%H%M%S)
docker exec consulting-web-pg-1 pg_dump -U consulting -d consulting -Fc > backups/pg18-migration/product_pg16_${TS}.dump
```

2. Restore into sidecar PG18:

```bash
docker compose -f docker-compose.pg18-rehearsal.yml --env-file .env.docker up -d pg18
pg_isready -h 127.0.0.1 -p 55418 -U consulting -d consulting
pg_restore --clean --if-exists --no-owner --dbname postgres://consulting:${PG_PASSWORD}@127.0.0.1:55418/consulting backups/pg18-migration/product_pg16_${TS}.dump
psql postgres://consulting:${PG_PASSWORD}@127.0.0.1:55418/consulting -f scripts/pg18_rehearsal/create_extensions.sql
```

3. Verify:

```sql
select extname from pg_extension order by extname;
select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE';
select schemaname, relname, n_live_tup from pg_stat_user_tables order by n_live_tup desc;
```

**Pass gate:**

- `vector`, `pg_trgm`, `uuid-ossp`, `btree_gin` installed.
- All 46 product tables restored.
- Product row-count/checksum matches PG16 baseline.
- Existing Drizzle migration runner can run against PG18 and reports no pending destructive drift.

---

## Phase 2 — SQLite logical import into PG18 sidecar

**Objective:** Faithfully copy the shared consulting SQLite logical data into PG18 sidecar, then build Postgres-native search/vector layers.

**New files:**

- `consulting/scripts/pg_migration/sqlite_schema_introspect.py`
- `consulting/scripts/pg_migration/sqlite_to_pg18_brain.py`
- `consulting/scripts/pg_migration/verify_pg18_brain.py`
- `consulting/scripts/pg_migration/create_brain_schemas.sql`
- `consulting/scripts/pg_migration/create_brain_search_indexes.sql`
- `consulting/scripts/tests/test_pg_migration_schema_introspect.py`
- `consulting/scripts/tests/test_pg_migration_type_map.py`

**Migration contract:**

1. Read SQLite schema from source of truth:

```sql
PRAGMA table_info(<table>);
PRAGMA index_list(<table>);
PRAGMA foreign_key_list(<table>);
```

2. Use real PKs from `PRAGMA table_info.pk`; never hardcode `id`.
3. Copy logical source tables into `brain_raw`.
4. Do not blindly copy FTS shadow tables as source of truth. Recreate search in `brain_rag`:
   - text search: `pg_trgm` GIN/GiST and optional `tsvector` where useful
   - vector search: `vector(n)` if BLOB dimensions are stable; otherwise keep `bytea` in raw and create derived vector rows only for valid embeddings
5. Make import idempotent:
   - COPY into temp/unlogged staging table
   - `INSERT ... ON CONFLICT DO NOTHING` or `DO UPDATE` only where source semantics demand it
6. Store every run in `brain_ops.migration_runs`:
   - source db path
   - source db size
   - source sqlite `page_count`, `schema_version`
   - table row counts/checksums
   - importer git SHA if available

**Type mapping:**

| SQLite | PG raw | PG derived/search |
|---|---|---|
| INTEGER | bigint / integer | same |
| REAL | double precision | same |
| TEXT | text | jsonb only in separate derived column if validated |
| BLOB | bytea | vector(n) only after dimension validation |
| FTS virtual/shadow | not SoT | recreate as `brain_rag` indexes/tables |

**Pass gate:**

- Every non-FTS-shadow logical table has matching row count.
- Every PK table has matching checksum.
- Embedding BLOB conversion report shows: `valid_count`, `invalid_count`, dimensions by table/column.
- Representative recall query top-k overlap is measured, not guessed.
- Import is re-runnable: second run creates zero duplicate rows and produces same checksums.

---

## Phase 3 — Backend adapter and compatibility layer

**Objective:** Make consulting Python/runtime code able to read/write PG18 without breaking current SQLite production path.

**New files:**

- `consulting/scripts/consulting_store/__init__.py`
- `consulting/scripts/consulting_store/backend.py`
- `consulting/scripts/consulting_store/sqlite_backend.py`
- `consulting/scripts/consulting_store/pg_backend.py`
- `consulting/scripts/consulting_store/query_json.py`
- `consulting/scripts/tests/test_consulting_store_backend.py`
- `consulting/scripts/tests/test_consulting_store_pg_sql_builder.py`

**Backend flag:**

```text
CONSULTING_STORE_BACKEND=sqlite|dual|pg
```

Resolution order:

```text
explicit env → ~/.hermes/consulting_store_backend → sqlite default until cutover approval
```

Rules:

- Default remains `sqlite` until the cutover phase is explicitly approved.
- `dual` writes SQLite + PG18 and reads SQLite by default, with optional shadow PG read comparison.
- `pg` reads/writes PG18 only and must not open `/db/consulting.db`.
- If backend is `pg` and code attempts live SQLite connect, fail fast.

**First code paths to adapterize:**

1. `scripts/dialogue_memory/store.py`
2. `scripts/dialogue_memory/search.py`
3. `scripts/dialogue_memory/vsearch.py`
4. `scripts/dialogue_memory/ingest.py`
5. `scripts/dialogue_memory/file_ingest.py`
6. `scripts/dialogue_memory/md_ingest.py`
7. `scripts/dialogue_state.py`
8. `scripts/weekly_kpi_reporter.py`
9. `scripts/search_consulting_db.py`
10. `apps/api/scripts/ingest_web_dialogue.py` in consulting-web
11. `scripts/sync_changwon_telegram.py` in consulting-web

**TDD gates:**

- backend resolver tests:
  - unset → sqlite
  - switch file → pg
  - env overrides switch file
  - invalid value fails
- pg SQL builder tests:
  - identifier quoting
  - limit/order validation
  - Korean text/json round-trip via `json_agg`
- no-live-sqlite tests for pg mode:
  - monkeypatch `sqlite3.connect`
  - run each converted CLI path in `CONSULTING_STORE_BACKEND=pg`
  - assert live `consulting.db` path is never opened

**Pass gate:**

- Converted paths pass tests in `sqlite`, `dual`, and `pg` modes against fixture DB/sidecar PG18.
- No unconverted critical writer remains in consulting cron/web bridge path.

---

## Phase 4 — 지구 주도 Shadow mode on PG18 sidecar

**Objective:** 지구가 직접 PG18 sidecar를 병렬 운영하면서 product DB, shared brain, cron, web/API, GraphRAG recall이 실제로 연결되는지 끝단까지 실측한다. Shadow 통과 전에는 final cutover를 진행하지 않는다.

**Ownership rule:**

```text
Owner: 지구(Hermes)가 직접 실행·기록·검증한다.
Allowed help: subagent/리뷰어는 결함 찾기와 독립 리뷰에만 사용한다.
Not allowed: shadow 성공 여부를 스크립트 자기보고, cron green status, subagent self-report만으로 인정하지 않는다.
Completion rule: 지구가 원본/PG18 양쪽을 직접 조회하고, web/API/cron 경로를 실제 실행한 증거가 있어야 pass.
```

**Setup:**

- Production remains PG16 + SQLite.
- PG18 sidecar receives:
  - product PG16 restore snapshots
  - repeated SQLite logical imports
  - controlled dual writes from adapterized scripts when adapter tests pass
- User-facing production reads remain on current production unless an explicit PG18 smoke stack/test command is running.
- Shadow writes must use unique markers or idempotent paths so cleanup/readback can prove no duplicate/drop.

**지구가 직접 실행할 shadow smoke commands:**

```bash
cd /home/jigoo/.hermes/workspace/consulting
CONSULTING_STORE_BACKEND=dual CONSULTING_PG_DSN='postgres://...' python3 ~/.hermes/scripts/consulting_dialogue_ingest.py
CONSULTING_STORE_BACKEND=pg   CONSULTING_PG_DSN='postgres://...' python3 scripts/search_consulting_db.py --topic changwon-org-mgmt-diagnosis --q '근속승진' --limit 5
```

```bash
cd /home/jigoo/.hermes/workspace/consulting-web
CONSULTING_STORE_BACKEND=pg CONSULTING_PG_DSN='postgres://...' python3 scripts/sync_changwon_telegram.py --quiet --dry-run
```

**Data connectivity checks 지구가 직접 확인:**

| Path | Check | Pass condition |
|---|---|---|
| Product PG16 → PG18 | dump/restore + table checksum | 46 product tables match final snapshot |
| SQLite brain → `brain_raw` | per-table count + PK checksum | all logical tables match; FTS shadow excluded/rebuilt |
| `brain_raw` → `brain_rag` | vector/trigram index build + dimension audit | valid embeddings indexed; invalid rows reported, not silently dropped |
| GraphRAG recall | golden Korean query set | no empty regression; top-k overlap/quality report saved |
| Web API → PG18 product DB | API health + thread/message readback | thread/message rows visible from PG18 restored DB |
| Web API → PG18 brain | marked TEST-only chat/ingest smoke where safe | generated/ingested context appears in PG18 brain tables or explicit fail reason recorded |
| Telegram sync → consulting-web PG18 | dry-run + marker/readback if safe | no duplicate telegram_message_imports; expected thread/topic mapping |
| consulting-dialogue-ingest cron path | run wrapper under shadow env | no SQLite-only dependency in pg mode; PG18 delta/readback measured |
| weekly KPI/report readers | run in PG mode or prove adapter gap | output hash comparable or blocker filed before cutover |
| no-SQLite-open guard | syscall/log/monkeypatch test | `pg` mode does not open live `db/consulting.db` |

**Shadow evidence files:**

```text
consulting-web/docs/pg18-shadow-report-YYYYMMDD.md
consulting-web/backups/pg18-migration/shadow_YYYYMMDD_HHMMSS/*.json
consulting-web/backups/pg18-migration/shadow_YYYYMMDD_HHMMSS/*.log
```

**Shadow duration recommendation:**

```text
minimum: 24h
preferred: 48-72h including at least one 지구-executed consulting-dialogue-ingest shadow run, one Telegram sync shadow run, one public-health period, one API smoke, and one browser/web chat smoke.
```

**Pass gate:**

- No PG18 sidecar data drift after repeated imports/dual writes, proven by direct PG queries.
- Search/recall golden queries have acceptable overlap and no empty regressions, with saved result JSON.
- Web chat GraphRAG context still includes correct consulting brain evidence, proven by API/browser smoke or recorded blocker.
- Telegram sync dry-run/readback does not duplicate or drop messages.
- consulting-dialogue-ingest and weekly KPI/report readers are either PG-mode green or explicitly listed as cutover blockers.
- Public health remains green against the current production stack and PG18 smoke stack.
- 지구 signs off with measured artifacts, not inferred green status.

---

## Phase 5 — Final cutover with short freeze window

**Objective:** Move consulting-web product DB and shared consulting brain runtime to PG18 without user-visible breakage.

**Preconditions:**

- Phase 0-4 pass reports exist.
- Rollback script is written and tested on rehearsal names.
- Old PG16 volume is not deleted.
- SQLite file is not deleted.
- All changed code is committed or at least cleanly staged for rollback visibility.
- User approves the cutover window.

**Recommended window:**

```text
KST low-traffic window, avoiding:
- every 5m Telegram sync tick
- every 30m dialogue ingest tick
- stock/crypto market critical times, though those are out of scope
```

**Freeze steps:**

1. Pause consulting-only cron jobs:

```text
consulting-dialogue-ingest
sync-changwon-telegram-to-consulting-web
consulting-web-public-health or make it maintenance-aware
Consulting Logic v2 weekly KPI report if the window overlaps Saturday 11:00
```

2. Put consulting-web into maintenance/read-only mode or stop only `api`/`web` while leaving old PG16 available for final dump.

3. Take final backups:

```bash
cd /home/jigoo/.hermes/workspace/consulting-web
TS=$(date +%Y%m%d_%H%M%S)
docker exec consulting-web-pg-1 pg_dump -U consulting -d consulting -Fc > backups/pg18-migration/product_pg16_final_${TS}.dump
cp -a /home/jigoo/.hermes/workspace/consulting/db/consulting.db backups/pg18-migration/consulting_sqlite_final_${TS}.db
sha256sum backups/pg18-migration/product_pg16_final_${TS}.dump backups/pg18-migration/consulting_sqlite_final_${TS}.db > backups/pg18-migration/final_${TS}.sha256
```

4. Restore final product dump into the final PG18 volume.
5. Run final SQLite→PG18 brain import.
6. Run extension and migration checks.
7. Switch compose/env/backend:

```text
image: pgvector/pgvector:pg18
DATABASE_URL → new PG18 service
CONSULTING_STORE_BACKEND=pg
CONSULTING_PG_DSN → internal PG18 service DSN
```

8. Start services:

```bash
docker compose --env-file .env.docker -f docker-compose.prod.yml up -d pg
# wait for pg_isready
docker compose --env-file .env.docker -f docker-compose.prod.yml run --rm migrate
docker compose --env-file .env.docker -f docker-compose.prod.yml up -d api web
```

9. Run immediate smoke:

```bash
curl -fsS http://127.0.0.1:8088/health || true
curl -fsS http://127.0.0.1:8088/api/health || true
```

Then browser/API smoke:

- login existing QA account
- open `창원시 컨설팅` or `TEST`
- load existing thread
- send a marked TEST-only message if needed
- verify assistant generation / GraphRAG context if auth config is healthy
- verify search/evidence/library panel still works

10. Run consulting script smoke in PG mode:

```bash
cd /home/jigoo/.hermes/workspace/consulting
CONSULTING_STORE_BACKEND=pg python3 ~/.hermes/scripts/consulting_dialogue_ingest.py
CONSULTING_STORE_BACKEND=pg python3 scripts/search_consulting_db.py --topic changwon-org-mgmt-diagnosis --q '근속승진' --limit 5
```

11. Resume consulting cron jobs.

**Pass gate:**

- Product PG row-count/checksum equals final PG16 backup baseline.
- Brain PG row-count/checksum equals final SQLite baseline for logical tables.
- `CONSULTING_STORE_BACKEND=pg` smoke returns valid recall/search.
- Web public health OK.
- Telegram sync job next/manual run OK.
- No logs show `sqlite3.connect('/home/jigoo/.hermes/workspace/consulting/db/consulting.db')` in pg mode.

---

## Phase 6 — Rollback path

**Objective:** If cutover fails, return to PG16 + SQLite quickly and without data loss.

**Rollback trigger examples:**

- API fails to start after PG18 restore/migration.
- Login/thread/chat breaks.
- GraphRAG recall returns empty or wrong topic context.
- Telegram sync creates duplicates or fails hard.
- Any checksum mismatch not explained by frozen writes.

**Rollback steps:**

1. Stop new API/web.
2. Restore previous compose/env:

```text
image: postgres:16-alpine
DATABASE_URL → old pg service/volume
CONSULTING_STORE_BACKEND=sqlite
```

3. Start old stack on old PG16 volume.
4. Ensure `/home/jigoo/.hermes/workspace/consulting/db/consulting.db` is still present and hash matches final backup unless legitimate writes occurred before freeze.
5. Resume consulting cron jobs.
6. Run public health and manual web smoke.
7. Keep failed PG18 volume for forensic diff; do not delete until root cause is identified.

**Rollback time target:**

```text
< 10 minutes after deciding rollback
```

---

## Phase 7 — SQLite runtime decommission

**Objective:** Make SQLite impossible to accidentally resurrect as the live store.

**Preconditions:**

- PG-only operation stable for agreed window.
- All consulting cron jobs have run at least once successfully in PG mode.
- Browser/API smoke passed after at least one restart.
- No SQLite live-open detections.

**Steps:**

1. Add a guard test:

```text
CONSULTING_STORE_BACKEND=pg must fail if any converted path opens /db/consulting.db.
```

2. Rename live SQLite file path after backup:

```bash
mv /home/jigoo/.hermes/workspace/consulting/db/consulting.db \
   /home/jigoo/.hermes/workspace/consulting/db/consulting.db.decommissioned-YYYYMMDD
```

3. Keep compressed artifact elsewhere:

```bash
gzip -9 backups/pg18-migration/consulting_sqlite_final_*.db
```

4. Remove or quarantine old SQLite-only scripts if fully replaced.
5. Update docs:

- `consulting-web/docs/consulting-layer-map.md`
- `consulting-web/docs/consulting-db-postgres-review.md`
- `consulting-web/docs/pg18-migration-final-report.md`
- relevant Hermes skills if commands/procedure changed

6. Add pre-commit guard:

```text
New consulting runtime code must not introduce raw sqlite3.connect('/.../consulting.db') except in migration/archive tools.
```

**Pass gate:**

- Runtime works with no file at `db/consulting.db`.
- All smoke tests still pass.
- The only SQLite references left are archive/migration/test fixtures.

---

## 4. Implementation task breakdown

### Task 1: Baseline audit report

**Objective:** Save current row counts, checksums, writers/readers, cron dependencies.

**Files:**

- Create: `consulting-web/docs/pg18-migration-baseline-YYYYMMDD.md`
- Create: `consulting/scripts/pg_migration/audit_sqlite_baseline.py`
- Create: `consulting-web/scripts/pg18_migration/audit_product_pg.py`

**Verify:**

```bash
python3 /home/jigoo/.hermes/workspace/consulting/scripts/pg_migration/audit_sqlite_baseline.py --db /home/jigoo/.hermes/workspace/consulting/db/consulting.db --json
cd /home/jigoo/.hermes/workspace/consulting-web
python3 scripts/pg18_migration/audit_product_pg.py --container consulting-web-pg-1 --json
```

Expected: JSON includes row counts, checksums, no write operations.

### Task 2: PG18 sidecar compose + extension smoke

**Objective:** Start PG18+pgvector rehearsal without touching production.

**Files:**

- Create: `consulting-web/docker-compose.pg18-rehearsal.yml`
- Create: `consulting-web/scripts/pg18_migration/create_extensions.sql`
- Create: `consulting-web/scripts/pg18_migration/smoke_pg18_extensions.sh`

**Verify:**

```bash
cd /home/jigoo/.hermes/workspace/consulting-web
docker compose -f docker-compose.pg18-rehearsal.yml --env-file .env.docker up -d pg18
bash scripts/pg18_migration/smoke_pg18_extensions.sh
```

Expected: `vector`, `pg_trgm`, `uuid-ossp`, `btree_gin` installed.

### Task 3: Product PG16 dump/restore rehearsal

**Objective:** Prove consulting-web product DB survives PG16→PG18 logical restore.

**Files:**

- Create: `consulting-web/scripts/pg18_migration/dump_product_pg16.sh`
- Create: `consulting-web/scripts/pg18_migration/restore_product_pg18.sh`
- Create: `consulting-web/scripts/pg18_migration/verify_product_restore.py`

**Verify:**

```bash
bash scripts/pg18_migration/dump_product_pg16.sh
bash scripts/pg18_migration/restore_product_pg18.sh
python3 scripts/pg18_migration/verify_product_restore.py --source-container consulting-web-pg-1 --target-dsn postgres://...
```

Expected: 46 tables restored; row counts/checksums match.

### Task 4: SQLite schema introspector

**Objective:** Generate faithful PG DDL plan from SQLite schema without hardcoded PK assumptions.

**Files:**

- Create: `consulting/scripts/pg_migration/sqlite_schema_introspect.py`
- Test: `consulting/scripts/tests/test_pg_migration_schema_introspect.py`

**Verify:**

```bash
cd /home/jigoo/.hermes/workspace/consulting
python3 -m pytest scripts/tests/test_pg_migration_schema_introspect.py -q
python3 scripts/pg_migration/sqlite_schema_introspect.py --db db/consulting.db --json > /tmp/consulting_schema.json
```

Expected: all tables listed; PK order captured; FTS virtual/shadow tables classified.

### Task 5: SQLite→PG18 faithful importer

**Objective:** Copy logical SQLite tables to `brain_raw` idempotently.

**Files:**

- Create: `consulting/scripts/pg_migration/sqlite_to_pg18_brain.py`
- Create: `consulting/scripts/pg_migration/create_brain_schemas.sql`
- Test: `consulting/scripts/tests/test_pg_migration_type_map.py`

**Verify:**

```bash
python3 scripts/pg_migration/sqlite_to_pg18_brain.py --db db/consulting.db --dsn postgres://... --dry-run
python3 scripts/pg_migration/sqlite_to_pg18_brain.py --db db/consulting.db --dsn postgres://... --apply
python3 scripts/pg_migration/sqlite_to_pg18_brain.py --db db/consulting.db --dsn postgres://... --apply
python3 scripts/pg_migration/verify_pg18_brain.py --db db/consulting.db --dsn postgres://...
```

Expected: second apply is idempotent; counts/checksums match.

### Task 6: PG-native search/vector layer

**Objective:** Recreate GraphRAG retrieval behavior in PG18.

**Files:**

- Create: `consulting/scripts/pg_migration/create_brain_search_indexes.sql`
- Create: `consulting/scripts/pg_migration/build_pg_vectors.py`
- Create: `consulting/scripts/pg_migration/recall_parity_eval.py`

**Verify:**

```bash
python3 scripts/pg_migration/build_pg_vectors.py --dsn postgres://...
python3 scripts/pg_migration/recall_parity_eval.py --sqlite-db db/consulting.db --pg-dsn postgres://... --queries fixtures/pg18_recall_queries.json
```

Expected: no empty regressions; overlap/quality report saved.

### Task 7: Backend adapter + pg mode tests

**Objective:** Add `sqlite|dual|pg` backend abstraction and prevent accidental SQLite fallback.

**Files:**

- Create: `consulting/scripts/consulting_store/*.py`
- Modify: first adapterized critical paths listed in Phase 3
- Test: `consulting/scripts/tests/test_consulting_store_backend.py`

**Verify:**

```bash
cd /home/jigoo/.hermes/workspace/consulting
python3 -m pytest scripts/tests/test_consulting_store_backend.py scripts/tests/test_consulting_store_pg_sql_builder.py -q
CONSULTING_STORE_BACKEND=pg python3 -m pytest scripts/tests -q
```

Expected: pg mode does not open live SQLite.

### Task 8: consulting-web bridge pg mode

**Objective:** Ensure web chat ingest, Telegram sync, and GraphRAG bridge use PG backend.

**Files:**

- Modify: `consulting-web/apps/api/scripts/ingest_web_dialogue.py`
- Modify: `consulting-web/scripts/sync_changwon_telegram.py`
- Modify: bridge service/env wiring if needed
- Test: relevant API/Python tests

**Verify:**

```bash
cd /home/jigoo/.hermes/workspace/consulting-web
CONSULTING_STORE_BACKEND=pg python3 scripts/sync_changwon_telegram.py --quiet --dry-run
pnpm --filter @consulting/api test
pnpm --filter @consulting/api build
```

Expected: no duplicate import; build/test pass.

### Task 9: 지구 직접 Shadow 운영 + 데이터 연결성 검증

**Objective:** 지구가 PG18 sidecar shadow를 직접 운영하고, “데이터가 제대로 연결되는지”를 DB/API/cron/browser 끝단에서 실측한다. 이 작업이 green이 아니면 cutover 금지.

**Files:**

- Create: `consulting-web/docs/pg18-shadow-report-YYYYMMDD.md`
- Create: `consulting-web/scripts/pg18_migration/shadow_compare.sh`
- Create: `consulting-web/scripts/pg18_migration/shadow_connectivity_probe.py`
- Create: `consulting-web/scripts/pg18_migration/shadow_browser_smoke.md` or equivalent browser QA log

**지구 실행 checklist:**

1. Run product PG16→PG18 checksum compare.
2. Run SQLite brain→PG18 `brain_raw` checksum compare.
3. Run `brain_raw`→`brain_rag` vector/trigram build verification.
4. Run golden Korean GraphRAG recall queries and save JSON.
5. Run `CONSULTING_STORE_BACKEND=pg` search CLI and confirm non-empty topic-correct hits.
6. Run `consulting_dialogue_ingest.py` under shadow env and measure PG18 row deltas/readback.
7. Run `sync_changwon_telegram.py --quiet --dry-run` under PG env and verify no duplicate/drop.
8. Run consulting-web API health + thread/message readback against PG18 smoke stack if available.
9. Run browser QA on existing QA account for login → project/thread load → search/evidence/chat smoke where safe.
10. Run no-live-SQLite-open guard in pg mode.
11. Save all evidence paths in `pg18-shadow-report-YYYYMMDD.md`.

**Verify:**

```bash
cd /home/jigoo/.hermes/workspace/consulting-web
bash scripts/pg18_migration/shadow_compare.sh
python3 scripts/pg18_migration/shadow_connectivity_probe.py --pg18-dsn 'postgres://...' --sqlite-db /home/jigoo/.hermes/workspace/consulting/db/consulting.db --json
```

Expected: no count/checksum drift; recall/search report acceptable; API/cron/browser connectivity proven or blocker explicitly filed. 지구가 직접 원본과 PG18을 조회한 증거 없이는 pass 처리하지 않는다.

### Task 10: Cutover script + rollback script

**Objective:** Make final operation scripted and reversible before executing it.

**Files:**

- Create: `consulting-web/scripts/pg18_migration/cutover_pg18.sh`
- Create: `consulting-web/scripts/pg18_migration/rollback_pg16_sqlite.sh`
- Create: `consulting-web/docs/pg18-cutover-runbook.md`

**Verify:**

```bash
bash scripts/pg18_migration/cutover_pg18.sh --dry-run
bash scripts/pg18_migration/rollback_pg16_sqlite.sh --dry-run
```

Expected: dry-run prints exact actions and refuses to run without explicit `--apply` and backup paths.

### Task 11: Approved cutover

**Objective:** Execute the final PG18 transition during approved window.

**Requires explicit approval.**

**Verify:**

- DB counts/checksums.
- API/web health.
- Browser QA.
- Consulting cron manual run.
- No live SQLite opens.

### Task 12: SQLite decommission

**Objective:** Remove SQLite as runtime dependency after stability window.

**Requires explicit approval for physical removal/rename.**

**Verify:**

- `db/consulting.db` absent/renamed.
- Runtime still passes in PG mode.
- Grep allows SQLite only in archive/migration/test paths.

---

## 5. Validation matrix

| Layer | Validation | Pass condition |
|---|---|---|
| PG18 image | extension smoke | `vector`, `pg_trgm`, `uuid-ossp`, `btree_gin` installed |
| Product DB | PG16 dump→PG18 restore | 46 tables + row checksums match |
| Brain raw | SQLite→`brain_raw` import | logical table counts/checksums match |
| Brain search | recall parity eval | no empty regressions; acceptable top-k overlap |
| Python runtime | backend tests | `pg` mode opens no live SQLite |
| Web bridge | API tests + smoke | chat/ingest/sync still works |
| Shadow ownership | 지구 직접 DB/API/cron/browser probe | measured artifacts saved; no pass from green status alone |
| Cron | 지구-executed shadow run + next scheduled run | no duplicate/drop/error |
| Browser | real click QA | login, thread load, chat/search/evidence healthy |
| Rollback | dry-run + rehearsal | rollback path prints/restores old PG16+SQLite route |

---

## 6. Risks and mitigations

| Risk | Why it matters | Mitigation |
|---|---|---|
| Major PG upgrade breaks volume | PG16→PG18 on-disk incompatible | logical dump/restore only; old volume preserved |
| SQLite FTS5 ranking differs | Korean GraphRAG quality can regress | recall golden set + top-k overlap gate |
| Vector BLOB dimensions inconsistent | pgvector requires fixed dimension | dimension audit; invalid rows stay bytea until repaired |
| Hardcoded `consulting.db` paths | Many scripts open SQLite directly | backend adapter + no-live-sqlite tests + grep guard |
| Active cron writes during migration | Data drift / missing final rows | pause consulting-specific cron during final freeze |
| Confusing duplicate PG containers | `consulting-postgres` also exists | explicitly target sidecar/final names; never use by name ambiguity |
| Health watchdog false alarms | public health every 5m | pause or maintenance-aware during cutover |
| Rollback loses writes | failed cutover after accepting writes | freeze writes until smoke passes; rollback before unfreezing |
| Stock/crypto collateral damage | other PG16 jobs are live | do not alter research-app/surge/stock/crypto jobs/DBs |

---

## 7. Decision points for 주인님

These are not blockers for planning, but must be decided before execution:

1. **Maintenance window length:** recommend 30-60 minutes reserved, target actual downtime under 10 minutes.
2. **SQLite artifact retention:** recommend runtime 폐기 immediately after PG-only proof, compressed rollback artifact retained 7-14 days before physical deletion.
3. **Target cluster name:** recommend new clear name like `consulting-web-pg18-1` / volume `consulting-web_pg18-data`, not reusing ambiguous `consulting-postgres`.
4. **Shadow duration:** recommend 48h if user-facing reliability matters more than speed; minimum 24h.

---

## 8. Recommended execution order

```text
1. Baseline audit
2. PG18 sidecar + product PG restore rehearsal
3. SQLite logical importer + brain_raw verification
4. PG search/vector layer + recall parity
5. Backend adapter + pg-mode tests
6. consulting-web bridge pg-mode smoke
7. 지구 직접 24-72h shadow + DB/API/cron/browser connectivity proof
8. Cutover/rollback scripts dry-run
9. Approved cutover
10. Stability window
11. SQLite runtime decommission
```

**Recommendation:** Start with Tasks 1-3 only. They are read-only or sidecar-only and cannot break current operation. Do not touch production compose/env/cron until Tasks 1-9 pass and 주인님 approves the final cutover window.
