# PG18 Migration Phase 9 — PG-only preflight, no cutover

## 결론

Phase 9 preflight 결과, **PG-only 전환은 아직 보류**한다.

API/web 경로의 `dual` 관찰은 정상이다. 하지만 전체 consulting brain은 아직 SQLite를 안전하게 archive/delete할 수 없다. 정적 감사 기준으로 직접 SQLite writer/reader 표면이 남아 있고, `sqlite_delete_safe=false`가 유지된다.

따라서 현재 허용 상태는 다음과 같다.

| 항목 | 판정 | 이유 |
|---|---:|---|
| API read/write dual 유지 | 허용 | API 컨테이너 PG18 접속, outbox ingest, SQLite↔PG18 parity 정상 |
| PG direct marker recall | 통과 | PG backend가 marker dialogue chunk `184`를 top hit로 반환 |
| PG-only live flip | **금지** | writer/read surface audit에서 SQLite 잔여 표면 확인 |
| SQLite archive/delete/rename | **금지** | `sqlite_delete_safe=false` |

## 측정 시각

```text
2026-07-08 20:37 KST
```

## Green evidence

### 1) API runtime 상태

API 컨테이너 env:

```text
CONSULTING_BRAIN_BACKEND=dual
CONSULTING_BRAIN_WRITE_BACKEND=dual
CONSULTING_PG_DSN=postgres://consulting:***@pg18-rehearsal:5432/consulting
CONSULTING_PG_DSN_DRIVER=psycopg
```

Runtime checks:

| Check | Result |
|---|---:|
| `consulting-web-api-1` health | `healthy` |
| PG18 sidecar readiness | `ok` / accepting connections |
| API container TCP to `pg18-rehearsal:5432` | `ok` |
| API child process resolved write backend | `dual` |

### 2) Outbox drained

App Postgres outbox status:

```json
[{"status":"published","count":154}]
```

Non-published outbox rows:

```json
[]
```

### 3) SQLite↔PG18 consulting-web parity

Direct parity recheck:

| Source | count | max_id | sum_id | rag_text | embeddings |
|---|---:|---:|---:|---:|---:|
| SQLite `dialogue_chunks where source='consulting-web'` | `2` | `184` | `319` | n/a | n/a |
| PG18 `brain_raw` / `brain_rag` | `2` | `184` | `319` | `2` | `2` |

### 4) PG direct marker recall

Inside API container, direct PG backend search:

```json
{
  "backend": "pg",
  "hits": 5,
  "ok": true,
  "top_chunk": 184,
  "top_has_marker": true,
  "top_kind": "dialogue",
  "top_score": 5.71384
}
```

Interpretation: PG18 can independently retrieve the newly ingested web-turn marker. This validates the PG read path itself.

## Caution evidence

### 1) Diagnostic shadow mismatch was intentionally induced

A diagnostic `dual recall` against the marker produced one `shadow-api` mismatch row:

```text
/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/shadow-api/pg18_shadow_mismatches_20260708.jsonl
```

The row says:

| Side | Top keys |
|---|---|
| SQLite returned | `file:2`, `file:30`, `file:28` |
| PG shadow returned | `dialogue:184`, `file:35`, `file:31` |
| top overlap | `0.0` |

This is **not a PG write failure**. It is a read-ranking divergence caused by asking SQLite and PG to search for a marker that only PG ranking now surfaces correctly. Direct PG marker recall is green, so this row is classified as **diagnostic-induced divergence**, not a storage/parity failure.

Because that diagnostic row polluted the original long observer's mismatch baseline, the original observer was killed and a fresh delta observer was started from the new baseline.

Fresh delta observer:

```text
session_id=proc_6f9967664497
json_out=/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/phase9_api_dual_observation_after_diag_20260708.json
```

First sample:

```json
{
  "api_health": "healthy",
  "pg18_ready": "ok",
  "parity": true,
  "sqlite_rows": 2,
  "pg18_raw_rows": 2,
  "outbox": {"published": 3}
}
```

### 2) SQLite writer/read surface remains too broad for PG-only

Writer audit artifact:

```text
/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_write_path_audit_p9_20260708_203355.json
```

Summary:

```json
{
  "writer_files": 63,
  "core_writer_files": 4,
  "high_risk_files": 4,
  "sqlite_delete_safe": false,
  "cutover_blockers": [
    "scripts/dialogue_memory/store.py",
    "scripts/dialogue_memory/ingest.py",
    "scripts/dialogue_memory/file_ingest.py",
    "scripts/dialogue_memory/md_ingest.py"
  ]
}
```

Reader/writer surface artifact:

```text
/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_reader_writer_surface_p9_20260708_203521.json
```

Summary:

```json
{
  "sqlite_connect_files": 39,
  "runtimeish_sqlite_connect_files": 32,
  "write_like_files": 28,
  "high_risk_files": 3,
  "medium_risk_files": 29,
  "low_risk_files": 7
}
```

High-risk runtime files:

```text
scripts/dialogue_memory/file_ingest.py
scripts/dialogue_memory/ingest.py
scripts/dialogue_memory/store.py
```

Medium-risk sample includes:

```text
scripts/audit_evidence_chain.py
scripts/build_rag_fts.py
scripts/consulting_cli.py
scripts/consulting_db_utils.py
scripts/consulting_hardening_phase2.py
scripts/consulting_phase3_os.py
scripts/db_migrate.py
scripts/dialogue_memory/md_ingest.py
scripts/dialogue_memory/search.py
scripts/dialogue_state.py
scripts/init_consulting_db.py
scripts/llm_layer/executive_decisions.py
```

## Judgment

PG18 sidecar is a valid, live dual mirror for the API path, but it is **not yet the sole source-of-truth**.

The remaining blocker is no longer container reachability or PG18 vector capability. The blocker is ownership:

```text
many runtime scripts still open consulting.db directly
```

A PG-only flip now would produce one of two bad states:

1. some writers continue writing SQLite while API reads PG, causing freshness split;
2. SQLite is archived while scripts still require it, causing runtime failures.

## Next implementation unit

Do not flip config yet. The next safe unit is **SQLite surface reduction**:

1. Split residual files into categories:
   - core dialogue-memory writer;
   - read-only runtime reader;
   - migration/audit tool;
   - archive/dead script.
2. Add a central backend-aware read bridge for runtime readers:
   - SQLite path remains default unless explicitly switched;
   - PG path reads `brain_raw`/`brain_rag` via JSON-safe queries;
   - tests prove Korean/JSON/text round-trip.
3. Add pg-only guard tests for the core ingesters:
   - `ingest.py`;
   - `file_ingest.py`;
   - `md_ingest.py`;
   - `store.py`.
4. Only then run a no-write PG-only simulation:
   - env says `pg`;
   - SQLite DB temporarily made inaccessible in a fixture or copy;
   - read/search/ingest smoke proves no hidden SQLite dependency.
5. Separate explicit approval is still required before any live PG-only config change or SQLite archive/delete.

## Files produced in Phase 9 preflight

```text
/home/jigoo/.hermes/workspace/consulting-web/docs/pg18-migration-phase9-preflight-20260708.md
/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_write_path_audit_p9_20260708_203355.json
/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_reader_writer_surface_p9_20260708_203521.json
```
