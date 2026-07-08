# PG18 Migration Phase 2 — SQLite Logical Import into PG18 Brain Schemas

## 결론

Phase 2는 운영 전환 없이 PG18 sidecar 안에서 완료했다. `consulting.db`의 SQLite logical tables를 `brain_raw`로 1:1 이관했고, `brain_rag.chunk_texts` 검색 파생층과 `brain_ops` 감사 ledger를 생성했다. 최종 refresh 기준 SQLite와 PG18 sidecar는 `208/208` tables, `22,636/22,636` rows, checksum failures `0`으로 정합한다.

## Scope boundary

Executed:
- SQLite schema introspection and faithful PG18 DDL generation.
- Additive `brain_raw`, `brain_rag`, `brain_ops` schemas in PG18 sidecar.
- Idempotent SQLite → PG18 sidecar import.
- Row-count + canonical checksum verification.
- RAG text search smoke using `tsvector`/GIN.

Not executed:
- production compose/env switch
- production writer/reader backend switch
- cron changes
- SQLite rename/delete/decommission
- final cutover

## Final evidence artifacts

| Gate | Result | Evidence |
|---|---|---|
| Unit tests | PASS | `14 passed` via `/home/jigoo/.hermes/workspace/consulting/.venv/bin/python -m pytest scripts/tests/test_pg_migration_*.py scripts/tests/test_sqlite_to_pg18_brain_importer.py -q` |
| Schema introspection | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_schema_introspect_20260708_163112.json` |
| Initial import | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_to_pg18_apply_20260708_161905.json` |
| Idempotency import | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_to_pg18_apply_idempotent_20260708_162140.json`, `row_delta_sum=0` |
| Final refresh import | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_to_pg18_apply_final_20260708_163800.json` |
| Final verification | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_to_pg18_verify_final_20260708_163800.json` |
| Sidecar summary | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_brain_sidecar_summary_final_20260708_163800.json` |

## Final measured state

| Metric | Value |
|---|---:|
| PG18 server | `18.4 (Debian 18.4-1.pgdg12+1)` |
| Extensions | `btree_gin`, `pg_trgm`, `pgcrypto`, `uuid-ossp`, `vector` |
| `brain_raw` tables | `208` |
| `brain_raw` rows | `22,636` |
| `brain_ops.migration_runs` | `4` |
| Excluded SQLite objects | `24` (`4` FTS virtual, `18` FTS shadow, `1` view, plus internal/non-logical objects as classified) |
| `brain_rag.chunk_texts` | `1,441` |
| `chunk_texts_with_tsv` | `1,441` |
| RAG source split | `dialogue_chunks=140`, `file_chunks=1298`, `chunks=3` |
| Final checksum failures | `0` |

## Type fidelity decisions

SQLite dynamic typing forced two explicit, tested downgrades:

| Source table.column | SQLite reality | PG18 raw type | Reason |
|---|---|---|---|
| `evidence_sources.http_status` | declared `INTEGER`, contains `integer=99`, `text=10` | `text` | faithful copy; empty-string status cannot fit `bigint` |
| `rag_chunks.text` | declared `TEXT`, contains 8 text values with NUL bytes | `bytea` | PostgreSQL `text` cannot store NUL; raw bytes preserved |

`rag_chunks.text` was intentionally excluded from `brain_rag.chunk_texts` because its raw field is now `bytea`. Searchable text still comes from `dialogue_chunks`, `file_chunks`, and `chunks`.

## Issues caught and closed

1. **SQLite `INTEGER` column contained empty strings**
   - Failed gate: import into `evidence_sources.http_status bigint`.
   - Fix: introspector now scans stored SQLite types and downgrades mixed numeric columns to `text`.
   - Verification: unit regression + final import/verify PASS.

2. **SQLite `TEXT` column contained NUL bytes**
   - Failed gate: PostgreSQL rejected NUL in `text`.
   - Fix: introspector maps affected text columns to `bytea`; importer encodes UTF-8 bytes for those columns.
   - Verification: unit regression + final import/verify PASS.

3. **False checksum mismatch from canonicalization**
   - Failed gate: 30 checksum mismatches despite equal row counts.
   - Root causes: PG JSON emits `double precision 1.0` as `1`; PK-less table order differs across engines.
   - Fix: verifier canonicalizes row order by JSON payload and normalizes SQLite values to PG storage shape.
   - Verification: final `sqlite_to_pg18_verify_final_20260708_163800.json` has `failure_count=0`.

4. **Live SQLite drift during verification**
   - Observation: after initial import/verify at `22,633` rows, source SQLite grew to `22,636` rows.
   - Fix: ran refresh import immediately followed by verify.
   - Verification: final refresh result `22,636/22,636`, failures `0`.

## Operational interpretation

Phase 2 proves the shared consulting brain can be logically represented inside PG18 sidecar under isolated schemas. It does **not** mean production has migrated. The current live writer remains SQLite until a later adapter/shadow/cutover phase is approved.
