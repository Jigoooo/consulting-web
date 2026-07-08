# PG18 Migration Baseline — 2026-07-08

## 결론

Phase 0 baseline은 운영 writer path 변경 없이 완료했다. 현재 product DB는 PostgreSQL 16.14 + 46개 base table이고, shared consulting brain SQLite는 208개 logical table + 4개 FTS virtual table + 18개 FTS shadow table 구조다. PG18 리허설의 비교 기준 artifact는 아래 JSON 2개다.

## Evidence artifacts

| 영역 | artifact |
|---|---|
| SQLite shared brain baseline | `/home/jigoo/.hermes/workspace/consulting-web/backups/pg18-migration/sqlite_baseline_20260708_154008.json` |
| Product PG16 baseline | `/home/jigoo/.hermes/workspace/consulting-web/backups/pg18-migration/product_pg16_baseline_20260708_154415.json` |

## Product PG16 baseline

- Container: `consulting-web-pg-1`
- DB: `consulting`
- User: `consulting`
- Server: `PostgreSQL 16.14 on x86_64-pc-linux-musl`
- Extensions: `plpgsql`
- Base tables: `46`
- Total rows: `1665`

### Top product tables by row count

| table | rows | PK |
|---|---:|---|
| `public.chat_messages` | 431 | `id` |
| `public.telegram_message_imports` | 318 | `source_session_id,source_message_id` |
| `public.context_edges` | 167 | `id` |
| `public.audit_events` | 163 | `id` |
| `public.outbox_events` | 152 | `id` |
| `public.sessions` | 70 | `id` |
| `public.scope_profiles` | 57 | `id` |
| `public.threads` | 56 | `id` |
| `public.topics` | 56 | `id` |
| `public.scope_tags` | 37 | `id` |

## Shared consulting brain SQLite baseline

- DB path: `/home/jigoo/.hermes/workspace/consulting/db/consulting.db`
- File size: `99,954,688 bytes`
- Table/view entries: `232`
- Logical tables: `208`
- FTS virtual tables: `4`
- FTS shadow tables: `18`
- Views: `1`
- Logical rows: `22,625`

### Top logical SQLite tables by row count

| table | rows |
|---|---:|
| `lineage_graph_nodes` | 1951 |
| `kg_entities` | 1949 |
| `file_edges` | 1931 |
| `lineage_graph_edges` | 1817 |
| `kg_relations` | 1815 |
| `rag_chunks` | 1559 |
| `file_chunks` | 1298 |
| `acquisition_attempts` | 905 |
| `atomic_statements` | 662 |
| `statement_verification_events` | 662 |

## Implementation notes from Phase 0

- SQLite auditor opens DB via `file:...?...mode=ro` URI.
- SQLite views are now classified separately as `view`, not copied as logical tables.
- Product PG auditor uses `docker exec -i <container> sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" ...'`; no password/DSN is read or printed.
- Product auditor checksum uses real PK metadata, including composite PKs such as `telegram_message_imports(source_session_id, source_message_id)`; it does not hardcode `id`.
- Two live-audit defects were caught and regression-tested before continuing:
  1. SQLite view counted as logical table → fixed with `classification=view`.
  2. Product PG JSON fields emitted SQL identifiers/arrays instead of SQL literals → fixed with `sql_literal()` and composite JSON literal tests.

## Next Phase 1.1 / 1.2 gates

Status: **completed in rehearsal**.

| Gate | Result | Evidence |
|---|---|---|
| PG18 sidecar | PASS | `consulting-web-pg18-rehearsal-pg18-1`, image `pgvector/pgvector:pg18`, host `127.0.0.1:55418` |
| Extensions | PASS | `btree_gin`, `pg_trgm`, `plpgsql`, `uuid-ossp`, `vector` |
| PG16 dump | PASS | `backups/pg18-migration/product_pg16_20260708_155257.dump`, sha file alongside |
| PG18 restored audit | PASS | `backups/pg18-migration/product_pg18_restored_20260708_155257.json` |
| Restore compare | PASS | `backups/pg18-migration/product_pg18_verify_20260708_155257.json` |

Restore verification summary:

- Source: PostgreSQL `16.14`
- Target: PostgreSQL `18.4 (Debian 18.4-1.pgdg12+1)`
- Matched tables: `46 / 46`
- Source rows: `1683`
- Target rows: `1683`
- Failures: `0`

Operational notes from rehearsal:

- `pgvector/pgvector:pg18` inherits the PostgreSQL 18 Docker entrypoint change: mount the fresh volume at `/var/lib/postgresql`, not `/var/lib/postgresql/data`. This was caught by the first failed sidecar readiness attempt and fixed with a regression test.
- Product DB changed during the run (`chat_messages`/`telegram_message_imports` grew), so a stale baseline can mismatch a later dump. The successful verification used a tight source audit → dump → restore → target audit sequence.
- Checksum ordering is now collation-stable via `COLLATE "C"` for text/composite PK checksums, after PG16→PG18 collation differences exposed a false checksum mismatch.

## Approval boundary reminder

Still not approved and not executed:

- production compose/env switch
- production cron pause/resume
- production runtime backend switch
- SQLite rename/delete
- 24–72h live shadow wait
- final cutover

## Phase 2 sidecar logical import result

Status: **completed in rehearsal**.

| Gate | Result | Evidence |
|---|---|---|
| SQLite schema introspection | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_schema_introspect_20260708_163112.json` |
| PG18 brain schemas | PASS | `brain_raw=208`, `brain_rag=1`, `brain_ops=3` |
| SQLite→PG18 import | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_to_pg18_apply_final_20260708_163800.json` |
| Import idempotency | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_to_pg18_apply_idempotent_20260708_162140.json`, `row_delta_sum=0` |
| Final parity verify | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_to_pg18_verify_final_20260708_163800.json` |
| RAG text search smoke | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_brain_sidecar_summary_final_20260708_163800.json` |

Final verification summary:

- Source SQLite logical tables: `208`
- Target PG18 `brain_raw` tables: `208`
- Source rows: `22636`
- Target rows: `22636`
- Matched tables: `208 / 208`
- Failures: `0`
- `brain_rag.chunk_texts`: `1441`
- `chunk_texts_with_tsv`: `1441`
- RAG source split: `dialogue_chunks=140`, `file_chunks=1298`, `chunks=3`

Phase 2 implementation notes:

- `brain_raw` is a faithful logical copy layer; normalization/search reinterpretation stays in `brain_rag`.
- SQLite dynamic typing required two explicit downgrades: `evidence_sources.http_status` → `text`; `rag_chunks.text` → `bytea` because 8 values contain NUL bytes.
- Checksum verifier canonicalizes PK-less row order and PG JSON numeric shape to avoid false mismatches.
- The source SQLite changed during the run (`22633 → 22636` rows), so final proof uses a refresh import immediately followed by verification.
- Full Phase 2 report: `docs/pg18-migration-phase2-20260708.md`

## Phase 3 shadow adapter + no-wait read parity result

Status: **completed without production switch**.

| Gate | Result | Evidence |
|---|---|---|
| Backend mode adapter | PASS | `CONSULTING_BRAIN_BACKEND=sqlite|dual|pg`, default `sqlite` |
| CLI opt-in | PASS | `dialogue_memory_cli.py recall --backend sqlite|dual|pg` |
| PG18 read-only recall | PASS | `brain_rag.chunk_texts` read path in sidecar |
| Dual-mode shadow compare | PASS | SQLite result returned; PG18 compare attached under `shadow` |
| No-wait read parity | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_read_parity_final_20260708_170242.json` |

No-wait read parity summary:

- Representative queries: `4`
- Failures: `0`
- SQLite non-empty: `4 / 4`
- PG18 non-empty: `4 / 4`
- Average top-5 overlap: `0.30`
- Minimum overlap threshold used: `0.20`

Interpretation:

- This is a shadow-read readiness gate, not production cutover.
- PG18 currently provides lexical/trigram/tsvector recall over imported `brain_rag.chunk_texts`.
- SQLite remains the full-quality path with semantic embeddings + FTS5 + graph fusion.
- Full Phase 3 report: `docs/pg18-migration-phase3-20260708.md`

## Phase 4 graph + vector parity scaffold result

Status: **completed without production switch**.

| Gate | Result | Evidence |
|---|---|---|
| Sidecar refresh from live SQLite | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_to_pg18_apply_p4_refresh_20260708_180852.json` |
| PG18 graph parity | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_graph_parity_20260708_182037.json` |
| Read parity after graph | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_read_parity_p4_20260708_182039.json` |
| PG18 vector layer build | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_vector_layer_20260708_181711.json` |
| SQLite↔PG18 vector parity | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_vector_parity_20260708_182010.json` |

Phase 4 measured summary:

- Refreshed sidecar rows: `source_rows=22642`, `target_rows_after=22642`, `row_delta_sum=6`.
- PG18 `brain_rag.chunk_texts`: `1446`.
- PG18 `brain_rag.chunk_embeddings`: `1443`.
- Graph parity: `cases=3`, `failures=0`, average top overlap `0.40`, explicit `CL-RP03` overlap `0.80`.
- Read parity after graph: `queries=4`, `failures=0`, average top-5 overlap `0.45`.
- Vector layer: `source_rows=1443`, `target_rows=1443`, `row_delta=0`.
- Vector parity: `cases=6`, `failures=0`, average overlap `1.00`.

Implementation notes:

- PG18 graph scoring now uses `brain_raw.claims`, `brain_raw.dialogue_edges`, and `brain_raw.file_edges` in the read-only sidecar path.
- PG18 vector layer stores exact `embedding vector(3072)` rows derived from SQLite embedding BLOBs.
- Direct HNSW on `vector(3072)` is unsupported by pgvector (`>2000 dimensions`); `embedding::halfvec(3072)` HNSW expression index was verified.
- Full Phase 4 report: `docs/pg18-migration-phase4-20260708.md`

Cutover interpretation:

- SQLite remains production source for now.
- Phase 4 proves graph/vector feasibility in PG18 sidecar.
- Production cutover still requires explicit approval, live shadow window, write-path plan, rollback plan, and later SQLite archive/delete approval.

## Phase 5 write-path audit + shadow logging + cutover plan result

Status: **completed without production switch**.

| Gate | Result | Evidence |
|---|---|---|
| SQLite writer-path audit | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_write_path_audit_20260708_183832.json` |
| Dual shadow mismatch JSONL | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/shadow/pg18_shadow_mismatches_20260708.jsonl` |
| Write-path / backfill design | PASS | `docs/pg18-migration-phase5-20260708.md` |
| Cutover / rollback / SQLite archive plan | PASS | `docs/pg18-migration-phase5-20260708.md` |

Phase 5 measured summary:

- Runtime writer files found: `62`.
- Core dialogue-memory writer files: `4`.
- Core cutover blockers: `scripts/dialogue_memory/store.py`, `scripts/dialogue_memory/ingest.py`, `scripts/dialogue_memory/file_ingest.py`, `scripts/dialogue_memory/md_ingest.py`.
- SQLite delete-safe: `false`.
- Representative no-wait shadow mismatch rows logged: `2`.

Implementation notes:

- Dual read mode still returns SQLite results; PG18 shadow mismatch logging is observation-only.
- Shadow logs store top keys/counts/errors, not raw hit body text.
- Proposed next implementation unit is a PG writer helper layer (`pg_store.py`) plus a `CONSULTING_BRAIN_WRITE_BACKEND=sqlite|dual|pg` facade.

Cutover interpretation:

- PG18 migration remains viable.
- The remaining blocker is live write ownership, not sidecar feasibility.
- SQLite must stay source-of-truth until dual-write/backfill gates pass and production switch is explicitly approved.
