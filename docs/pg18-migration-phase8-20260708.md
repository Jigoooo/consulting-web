# PG18 Migration Phase 8 — API runtime dual-read/write observation

## 결론

Phase 8은 **API 컨테이너의 PG18 runtime-locality blocker를 해소했고, web/API 경로를 `dual` 관찰 모드로 올렸다.**

다만 이것은 **PG-only source-of-truth cutover가 아니다.** 현재 판정은 다음과 같다.

- **허용/적용 완료:** API 컨테이너 read-dual, web-turn ingest write-dual.
- **조기 관찰 판정:** 약 33분 / 8개 샘플 모두 clean이므로 사용자 지시에 따라 다음 단계로 진행 가능.
- **계속 진행 중:** 90분 read-only 관찰 프로세스는 추가 증거용으로 계속 실행 중.
- **금지 유지:** PG-only 전환, SQLite archive/delete/rename.

## 실제 수행한 것

### 1) API 컨테이너 PG18 접속 경로 확보

- PG18 sidecar를 `consulting-web_default` Docker network에 추가 연결.
- sidecar alias: `pg18-rehearsal`.
- API runtime DSN은 container DNS를 사용:

```text
postgres://consulting:***@pg18-rehearsal:5432/consulting
```

Compose 변경:

```text
/home/jigoo/.hermes/workspace/consulting-web/docker-compose.pg18-rehearsal.yml
/home/jigoo/.hermes/workspace/consulting-web/docker-compose.prod.yml
```

### 2) container-safe Python PG client 추가

`psql`이 없는 API 컨테이너에서도 Python child process가 PG18에 붙을 수 있게 `psycopg[binary]` 경로를 추가했다.

Changed files:

```text
/home/jigoo/.hermes/workspace/consulting/scripts/dialogue_memory/pg_backend.py
/home/jigoo/.hermes/workspace/consulting/scripts/dialogue_memory/pg_store.py
/home/jigoo/.hermes/workspace/consulting-web/apps/api/requirements-graphrag.txt
```

Runtime/env check inside `consulting-web-api-1`:

```text
CONSULTING_BRAIN_BACKEND=dual
CONSULTING_BRAIN_WRITE_BACKEND=dual
CONSULTING_PG_DSN_DRIVER=psycopg
pg18-rehearsal:5432 = ok
psycopg import = ok
PG query = ok
```

### 3) API image rebuild/recreate

- `docker compose --env-file .env.docker -f docker-compose.prod.yml build api` → exit `0`.
- `docker compose --env-file .env.docker -f docker-compose.prod.yml up -d --no-deps --force-recreate api`.
- `consulting-web-api-1` health: `healthy`.

### 4) Real web-turn ingest smoke without LLM stream noise

Full `/chat/stream` would invoke Hermes model generation and add unrelated latency/noise, so the smoke hit the exact persisted event boundary instead:

1. Insert uniquely marked `ConsultingWebTurnCompleted` outbox event into app Postgres.
2. Let real outbox relay + BullMQ worker + `ingest_web_dialogue.py` process it.
3. Read back SQLite and PG18 raw/RAG layers.

Marker:

```text
PHASE8_DUAL_SMOKE_20260708_194739
content_hash=283716a6b9abc3ebd7e1c13a
```

Readback:

| Layer | Result |
|---|---:|
| app outbox | `published` |
| SQLite `dialogue_chunks` | `id=184`, `source=consulting-web`, `embed_dim=3072` |
| PG18 `brain_raw.dialogue_chunks` | `id=184`, `source=consulting-web`, `embed_dim=3072` |
| PG18 `brain_rag.chunk_texts` | marker body present |
| PG18 `brain_rag.chunk_embeddings` | row present |
| mismatch logs | `0` |
| API warning/error logs | `0` |

### 5) PG search ranking defect fixed

Smoke writeback passed, but marker recall initially exposed a real PG read-search ranking bug.

- Symptom: marker text existed in PG18 `brain_rag.chunk_texts`, but PG search top hits were unrelated `final_usable` file chunks.
- Root cause: final ordering used `trust_group DESC` before relevance, so high-trust file chunks could beat exact dialogue hits.
- Fix: final result ordering is now relevance-first:

```text
ORDER BY weighted_score DESC, trust_group DESC, source_table, source_pk
```

Regression:

```text
scripts/tests/test_dialogue_memory_backend_modes.py::test_pg_backend_orders_by_relevance_before_file_trust_tier
```

Live marker recall after fix:

```json
{
  "hits": 5,
  "top_kind": "dialogue",
  "top_chunk": 184,
  "top_has_marker": true,
  "top_score": 5.71384
}
```

## Observation evidence

### 90-minute watcher

Read-only observer:

```text
/home/jigoo/.hermes/workspace/consulting/scripts/pg_migration/phase8_observe_api_dual.py
```

Started command:

```text
python3 scripts/pg_migration/phase8_observe_api_dual.py \
  --duration-sec 5400 \
  --interval-sec 300 \
  --json-out backups/pg18-migration/phase8_api_dual_observation_20260708.json
```

Process:

```text
session_id=proc_ded978b6e9b9
```

Current early observation snapshot, around 2026-07-08 20:26 KST:

| Metric | Result |
|---|---:|
| elapsed | about `33 min` |
| samples | `8` |
| API health | all `healthy` |
| PG18 readiness | all `ok` |
| parity | all `true` |
| outbox | `published=3`, pending/processing `0` |
| mismatch dirs | files `0`, bytes `0` |
| API warn/error grep | `0` |

Direct parity recheck:

| Source | rows | max_id | sum_id | rag_text | embeddings |
|---|---:|---:|---:|---:|---:|
| SQLite `dialogue_chunks where source='consulting-web'` | `2` | `184` | `319` | n/a | n/a |
| PG18 consulting-web rows | `2` | `184` | `319` | `2` | `2` |

Interpretation: 90-minute process is still running, but the first ~33 minutes were clean enough to treat Phase 8 as a **short-window live observation pass** under the user's instruction to move on if the signal is clean.

## Verification commands

```text
python3 -m py_compile \
  scripts/dialogue_memory/pg_backend.py \
  scripts/dialogue_memory/pg_store.py \
  scripts/pg_migration/phase8_observe_api_dual.py

.venv/bin/pytest \
  scripts/tests/test_dialogue_memory_backend_modes.py \
  scripts/tests/test_dialogue_memory_write_backend_modes.py -q
# 20 passed in 0.06s
```

Compose validation:

```text
docker compose --env-file .env.docker -f docker-compose.prod.yml config --quiet
docker compose --env-file .env.docker -f docker-compose.pg18-rehearsal.yml config --quiet
# compose_config_ok
```

## Current judgment

| Decision | Status | Reason |
|---|---:|---|
| API read-dual | enabled | API container has psycopg + DSN + PG18 network reachability |
| Web-turn ingest write-dual | enabled | real outbox→worker→Python ingest smoke wrote SQLite and PG18 |
| Short live observation | pass so far | 8/8 samples clean, no mismatch/log errors |
| PG-only source-of-truth | **not ready** | broad SQLite writer surface and source-of-truth deletion safety still unresolved |
| SQLite archive/delete | **forbidden** | `sqlite_delete_safe=false` class blocker remains |

## Next required gate before PG-only

1. Let the 90-minute observer finish or keep the current 33-minute clean window as the accepted abbreviated gate.
2. Run a PG-only **preflight only** first, not a live flip:
   - effective runtime env plan,
   - all remaining direct SQLite readers/writers classified,
   - rollback command/path,
   - outbox drained,
   - marker smoke that proves PG readback without SQLite dependency.
3. Only after that should a separate explicit PG-only switch decision be considered.
