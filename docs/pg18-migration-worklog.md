# PG18 Migration Worklog

## Scope

Approved scope for this run: Phase 0–9 PG18 sidecar rehearsal, no-wait shadow-read/write verification, graph/vector parity scaffolding, write-path audit/shadow plan, opt-in write-backend facade implementation, final refresh/backfill, host-side cron dual-write observation, API-runtime dual-read/write observation, and PG-only preflight. Full PG-only cutover and SQLite archive/delete remain out of scope until the remaining source-of-truth/delete-safety gates are resolved.

Allowed in this run:
- read-only SQLite / PG16 baseline audit
- create scripts/tests/docs
- create and use PG18 sidecar rehearsal container/volume
- pg_dump from product PG16 and restore into PG18 sidecar
- create isolated PG18 sidecar schemas `brain_raw`, `brain_rag`, `brain_ops`
- import shared consulting SQLite logical tables into PG18 sidecar and verify parity
- add opt-in `sqlite|dual|pg` recall adapter at the Python CLI boundary
- run no-wait read-only SQLite↔PG18 recall parity verification
- refresh PG18 sidecar from still-live SQLite before parity checks
- add read-only PG18 graph scoring over `claims` / `dialogue_edges` / `file_edges`
- build PG18 `brain_rag.chunk_embeddings` vector layer from imported embedding BLOBs
- run read-only SQLite BLOB cosine ↔ PG18 pgvector parity verification
- run static SQLite writer-path audit
- add opt-in dual-read shadow mismatch JSONL logging
- document dual/backfill write-path and cutover/rollback/archive plan
- add opt-in `CONSULTING_BRAIN_WRITE_BACKEND=sqlite|dual|pg` write facade
- add PG18 writer helper `scripts/dialogue_memory/pg_store.py`
- validate PG18 write SQL with transaction rollback smoke
- run final SQLite → PG18 refresh/backfill
- run raw/read/graph/vector/write-path parity gates
- run no-wait dual-write marker replay with cleanup
- enable host-side `consulting-dialogue-ingest` cron wrapper dual-write observation only
- add container-safe `psycopg` DSN runners for PG18 read/write helpers
- attach PG18 sidecar to the consulting-web Docker network with alias `pg18-rehearsal`
- rebuild/recreate the API container for `dual` read/write observation
- enable API runtime `CONSULTING_BRAIN_BACKEND=dual` and `CONSULTING_BRAIN_WRITE_BACKEND=dual`
- run real app outbox → worker → Python ingest marker smoke against SQLite + PG18
- run a shortened live observation window when the signal is clean and the user asks to move on
- run read-only PG-only preflight and residual SQLite writer/reader surface audit

Not allowed in this run:
- edit `.env.docker`
- pause/resume cron jobs
- enable PG-only without a separate explicit cutover decision
- switch to PG-only source-of-truth
- SQLite rename/delete `/home/jigoo/.hermes/workspace/consulting/db/consulting.db`
- require a 24–72h live shadow wait when a bounded 60–90m or shorter clean window is explicitly accepted
- final cutover

## Phase 9 preflight result — 2026-07-08 20:37 KST

- Decision: PG-only live flip remains BLOCKED. API/web dual is viable, but whole-system SQLite ownership is not yet eliminated.
- API dual state: PASS. `consulting-web-api-1` is `healthy`, env remains `CONSULTING_BRAIN_BACKEND=dual`, `CONSULTING_BRAIN_WRITE_BACKEND=dual`, `CONSULTING_PG_DSN_DRIVER=psycopg`, and PG18 is reachable via `pg18-rehearsal:5432`.
- Outbox: PASS, app Postgres status `[{"status":"published","count":154}]`, non-published rows `[]`.
- API SQLite↔PG18 parity: PASS, SQLite consulting-web rows `(2,184,319)` equals PG18 raw `(2,184,319)`, with PG18 `rag_text_rows=2`, `embedding_rows=2`.
- Direct PG marker recall: PASS, API-container direct `pg_backend.search` returns marker `PHASE8_DUAL_SMOKE_20260708_194739` as top `dialogue` chunk `184`, `top_has_marker=true`.
- Diagnostic shadow mismatch: one `shadow-api` row was intentionally induced by a marker `dual recall`; SQLite returned older file chunks while PG returned the marker dialogue chunk. Classified as read-ranking divergence/diagnostic noise, not write/parity failure. Original long observer was killed to avoid mixing this diagnostic row with Phase8 clean-window evidence.
- Replacement delta observer: STARTED, `proc_6f9967664497`, output `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/phase9_api_dual_observation_after_diag_20260708.json`; first sample `healthy`, `pg18_ready=ok`, `parity=true`.
- Writer audit: BLOCKER, artifact `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_write_path_audit_p9_20260708_203355.json`, `writer_files=63`, `core_writer_files=4`, `high_risk_files=4`, `sqlite_delete_safe=false`; blockers are `scripts/dialogue_memory/store.py`, `ingest.py`, `file_ingest.py`, `md_ingest.py`.
- Reader/writer surface audit: BLOCKER, artifact `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_reader_writer_surface_p9_20260708_203521.json`, `sqlite_connect_files=39`, `runtimeish_sqlite_connect_files=32`, `write_like_files=28`, `high_risk_files=3`, `medium_risk_files=29`.
- Human report: `docs/pg18-migration-phase9-preflight-20260708.md`.
- Interpretation: next implementation unit is SQLite surface reduction / backend-aware read bridge / pg-only simulation, not live PG-only cutover.

## Phase 8 result — 2026-07-08 20:26 KST

- API runtime blocker: RESOLVED. PG18 sidecar is reachable from `consulting-web-api-1` through Docker DNS alias `pg18-rehearsal:5432`; API image has `psycopg[binary]` and uses `CONSULTING_PG_DSN_DRIVER=psycopg`.
- API dual env: ENABLED. `CONSULTING_BRAIN_BACKEND=dual`, `CONSULTING_BRAIN_WRITE_BACKEND=dual`, `CONSULTING_PG_DSN=postgres://consulting:***@pg18-rehearsal:5432/consulting`.
- API container rebuild/recreate: PASS, `consulting-web-api-1` health `healthy`.
- Web-turn marker smoke: PASS, marker `PHASE8_DUAL_SMOKE_20260708_194739`, `content_hash=283716a6b9abc3ebd7e1c13a`; app outbox `published`, SQLite `dialogue_chunks id=184`, PG18 `brain_raw.dialogue_chunks id=184`, PG18 `brain_rag.chunk_texts` and `chunk_embeddings` rows present.
- PG read-search defect found/fixed: relevance now orders before file trust tier (`weighted_score DESC, trust_group DESC`), so exact marker dialogue chunk `184` is PG top hit.
- Short live observation: PASS, about `33 min` / `8` samples clean; all samples `api_health=healthy`, `pg18_ready=ok`, `parity=true`, outbox `published=3`, pending/processing `0`. The later long observer was stopped during Phase 9 after a diagnostic `dual recall` intentionally created a `shadow-api` mismatch row; the Phase 8 clean-window evidence remains the pre-diagnostic sample set.
- Direct parity at early checkpoint: SQLite consulting-web rows `(count=2, max_id=184, sum_id=319)` equals PG18 raw `(2,184,319)`, and PG18 `rag_text_rows=2`, `embedding_rows=2`.
- Mismatch/API error evidence: `write-shadow-api`, `shadow-api`, `write-shadow-cron` mismatch files `0`; API warn/error/failed/traceback grep over the observation window returned `0` lines.
- Verification: PASS, `python3 -m py_compile scripts/dialogue_memory/pg_backend.py scripts/dialogue_memory/pg_store.py scripts/pg_migration/phase8_observe_api_dual.py`; focused pytest `20 passed in 0.06s`; compose config for prod + PG18 sidecar `compose_config_ok`.
- Human report: `docs/pg18-migration-phase8-20260708.md`.
- Interpretation: API/web runtime dual observation is viable and live. PG-only source-of-truth remains a separate decision; SQLite archive/delete remains forbidden.

## Phase 7 result — 2026-07-08 19:24 KST

- Final refresh/backfill: PASS, artifact `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_to_pg18_apply_p7_20260708_191317.json`, `source_rows=22642`, `target_rows_after=22642`, `row_delta_sum=0`.
- Raw parity: PASS, artifact `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_to_pg18_verify_p7_20260708_191546.json`, `sqlite_rows=22642`, `pg_rows=22642`, `failure_count=0`.
- Graph parity: PASS, artifact `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_graph_parity_p7_20260708_191801.json`, `dialogue_edges=383`, `file_edges=1931`, `dangling_sqlite=0`, `dangling_pg=0`, `failure_count=0`.
- Vector parity: PASS, artifact `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_vector_parity_p7_20260708_191546.json`, `cases=6`, `avg_overlap=1.0`, `failures=0`.
- Read parity: PASS as sidecar feasibility, artifact `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_read_parity_p7_20260708_191546.json`, `queries=4`, `sqlite_nonempty=4`, `pg_nonempty=4`, `avg_top_overlap=0.45`, `failures=0`.
- No-wait dual-write replay: PASS, artifact `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/dual_write_replay_p7_20260708_191934.json`, marker readback succeeded in SQLite and PG18 raw+`brain_rag`; cleanup restored pre-smoke counts; `failures=0`.
- Host cron write-dual observation: ENABLED by updating `/home/jigoo/.hermes/scripts/consulting_dialogue_ingest.py` to pass `CONSULTING_BRAIN_WRITE_BACKEND=dual` and `CONSULTING_WRITE_LOG_DIR=.../write-shadow-cron` to dialogue/file/md ingest child processes. Rollback: set `CONSULTING_BRAIN_WRITE_BACKEND=sqlite` or `CONSULTING_DIALOGUE_INGEST_WRITE_BACKEND=sqlite`.
- Host cron verification: PASS, `python3 -m py_compile /home/jigoo/.hermes/scripts/consulting_dialogue_ingest.py` exit `0`; manual `python3 /home/jigoo/.hermes/scripts/consulting_dialogue_ingest.py` exit `0`, `stdout_bytes=0`, `log_bytes_before=0`, `log_bytes_after=0`.
- Web API read-dual: BLOCKED/not enabled. Runtime probe inside `consulting-web-api-1` showed no `CONSULTING_BRAIN_BACKEND`, no `psql`, no `docker`, no `psycopg/psycopg2`, and no reachable PG18 sidecar path (`host.docker.internal:55418` refused; sidecar container DNS unavailable from API network).
- Web-turn ingest write-dual: BLOCKED/not enabled for the same API-container PG access reason; enabling `CONSULTING_BRAIN_WRITE_BACKEND=dual` in the API container would create noisy PG failures rather than useful observation.
- PG-only cutover: NOT READY. Writer audit still reports `writer_files=63`, `core_writer_files=4`, `sqlite_delete_safe=false`; SQLite remains the full source-of-truth.
- Human report: `docs/pg18-migration-phase7-20260708.md`.
- Interpretation: PG18 mirror/backfill/parity is ready and host cron dual-write observation is live, but web read/write dual and PG-only require a container-safe PG client/network path before rollout.

## Phase 6 result — 2026-07-08 19:01 KST

- Write facade: PASS, `scripts/dialogue_memory/store.py` now resolves `CONSULTING_BRAIN_WRITE_BACKEND=sqlite|dual|pg`; default/unset remains `sqlite`.
- PG writer helper: PASS, new `scripts/dialogue_memory/pg_store.py` upserts raw `brain_raw` rows and derived `brain_rag.chunk_texts` / `chunk_embeddings` rows for dialogue/file chunks.
- Dual-write safety: PASS, `dual` writes SQLite first, then PG; PG failure logs content-minimized mismatch metadata and preserves SQLite success.
- PG-only boundary: implemented but not rolled out; `pg` skips SQLite only when explicitly selected and raises on PG failure.
- Live PG18 DDL check: PASS, `information_schema` / `pg_constraint` verified raw tables and `brain_rag` constraints. A RED test caught that raw edge tables have only `PRIMARY KEY(id)`, not SQLite's unique edge constraint; PG edge upserts now conflict on `id`.
- Vector dimension guard: PASS, PG writer rejects non-3072 embeddings before building `brain_rag.chunk_embeddings` SQL.
- Rollback SQL smoke: PASS, PG18 sidecar transaction inserted marked dialogue/file rows, observed `inside_dialogue=1`, `inside_file=1`, then `ROLLBACK` left `after_dialogue=0`, `after_file=0`.
- Writer-path audit after facade: PASS/blocked as expected, artifact `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_write_path_audit_phase6_20260708_185432.json`, `writer_files=63`, `core_writer_files=4`, `sqlite_delete_safe=false`.
- Related tests: PASS, `40 passed in 0.39s` across write backend, backend modes, exact Telegram binding, PG18 vector/parity/import/audit tests.
- Compile coverage: PASS, `py_compile` over dialogue-memory store/backend/PG backend/CLI and `scripts/pg_migration/*.py` returned exit `0`.
- Full-suite note: broader `pytest scripts/tests -q` is not globally green because unrelated `test_b7_claimsynth_richness_dedup.py` prompt-richness checks fail on missing `함의` in axis prompt constants (`176 passed, 2 failed, 7 warnings`). Axis prompt files were not touched in Phase 6.
- Operational no-touch boundary: PASS, no production compose/env/cron/backend switch or SQLite rename/delete was performed; `/home/jigoo/.hermes/workspace/consulting/db/consulting.db` still exists.
- Human report: `docs/pg18-migration-phase6-20260708.md`.
- Interpretation: PG18 write-path scaffold is now present, but SQLite remains source-of-truth until an approved dual-write observation/replay proves real ingest traffic parity.

## Phase 5 result — 2026-07-08 18:38 KST

- Writer-path audit: PASS, artifact `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_write_path_audit_20260708_183832.json`, `writer_files=62`, `core_writer_files=4`, `sqlite_delete_safe=false`.
- Core cutover blockers: `scripts/dialogue_memory/store.py`, `scripts/dialogue_memory/ingest.py`, `scripts/dialogue_memory/file_ingest.py`, `scripts/dialogue_memory/md_ingest.py`.
- Dual shadow mismatch logging: PASS, implemented in `/home/jigoo/.hermes/workspace/consulting/scripts/dialogue_memory/backend.py`; returns SQLite result and logs only key/count/error metadata when PG shadow diverges.
- Shadow observation artifact: PASS, `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/shadow/pg18_shadow_mismatches_20260708.jsonl`, 2 mismatch rows from representative no-wait dual recalls at `CONSULTING_SHADOW_MIN_OVERLAP=0.6`.
- Test coverage: PASS, `26 passed in 0.35s` across backend, writer audit, vector layer/parity, schema/type/importer tests.
- Compile coverage: PASS, `py_compile` over dialogue-memory backend, PG backend, pg_migration scripts, and CLI returned exit `0`.
- Operational no-touch boundary: PASS, no production compose/env/cron/backend switch or SQLite rename/delete was performed.
- Human plan: `docs/pg18-migration-phase5-20260708.md`.
- Interpretation: PG18 cutover remains viable, but the blocker has moved from feasibility to live write ownership; SQLite is still source-of-truth and not archive/delete safe.

## Phase 4 result — 2026-07-08 18:20 KST

- Sidecar refresh: PASS, artifact `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_to_pg18_apply_p4_refresh_20260708_180852.json`, `source_rows=22642`, `target_rows_after=22642`, `row_delta_sum=6` from still-live SQLite drift.
- Graph parity: PASS, artifact `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_graph_parity_20260708_182037.json`, `cases=3`, `failures=0`, `avg_top_overlap=0.40`, explicit `CL-RP03` overlap `0.80`.
- Read parity after graph: PASS, artifact `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_read_parity_p4_20260708_182039.json`, `queries=4`, `failures=0`, `sqlite_nonempty=4`, `pg_nonempty=4`, `avg_top_overlap=0.45`.
- Vector layer: PASS, artifact `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_vector_layer_20260708_181711.json`, `source_rows=1443`, `target_rows=1443`, `row_delta=0`.
- Vector parity: PASS, artifact `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_vector_parity_20260708_182010.json`, `cases=6`, `failures=0`, `avg_overlap=1.00`.
- PG18 measured counts after refresh: `dialogue_chunks=145`, `dialogue_edges=383`, `file_chunks=1298`, `file_edges=1931`, `chunk_texts=1446`, `chunk_embeddings=1443`.
- pgvector note: direct HNSW on `vector(3072)` is unsupported (`>2000 dimensions`); verified `embedding::halfvec(3072)` HNSW expression index works.
- Human report: `docs/pg18-migration-phase4-20260708.md`.
- Interpretation: graph/vector feasibility is proven in sidecar; production cutover still requires approved live shadow window + write-path plan + rollback window.

## Phase 3 result — 2026-07-08 17:00 KST

- Backend adapter: PASS, default remains `sqlite`; opt-in modes are `sqlite|dual|pg` via `--backend` or `CONSULTING_BRAIN_BACKEND`.
- CLI boundary: PASS, `dialogue_memory_cli.py recall --backend sqlite|dual|pg`.
- PG18 read-only backend: PASS, reads `brain_rag.chunk_texts` from sidecar; no writes/deletes.
- Dual mode: PASS, returns SQLite recall and attaches PG18 shadow comparison metadata.
- Read parity: PASS, artifact `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_read_parity_final_20260708_170242.json`, `queries=4`, `failures=0`, `sqlite_nonempty=4`, `pg_nonempty=4`, `avg_top_overlap=0.30`.
- Human report: `docs/pg18-migration-phase3-20260708.md`.
- Interpretation: this proves same CLI boundary can reach PG18 recall without production switch; it is not full semantic/vector/graph parity yet.

## Phase 2 result — 2026-07-08 16:32 KST

- SQLite schema introspection: PASS, artifact `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_schema_introspect_20260708_163112.json`.
- PG18 sidecar schemas: PASS, `brain_raw=208` tables, `brain_rag=1` table, `brain_ops=3` tables.
- SQLite → PG18 import: PASS, artifact `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_to_pg18_apply_final_20260708_163800.json`.
- Idempotency: PASS, artifact `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_to_pg18_apply_idempotent_20260708_162140.json`, `row_delta_sum=0`.
- Final parity verification: PASS, artifact `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_to_pg18_verify_final_20260708_163800.json`, matched `208/208` tables and `22636/22636` rows, failures `0`.
- RAG smoke: PASS, sidecar summary `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_brain_sidecar_summary_final_20260708_163800.json`, `chunk_texts=1441`, `chunk_texts_with_tsv=1441`.
- Human report: `docs/pg18-migration-phase2-20260708.md`.
- Fixed Phase 2 pitfalls:
  - SQLite `INTEGER` affinity can contain text; mixed numeric columns are downgraded to `text` for faithful copy.
  - PostgreSQL `text` cannot store NUL bytes; affected SQLite text columns are downgraded to `bytea`.
  - PK-less checksum verification must canonicalize row order outside DB collation/NULL ordering.
  - Live SQLite can drift during verification; final proof used refresh import → verify bundle.

## Initial measured state

- `consulting-web-pg-1`: PostgreSQL 16.14, 46 public base tables, extensions: `plpgsql`.
- shared consulting brain SQLite: `/home/jigoo/.hermes/workspace/consulting/db/consulting.db`, 99,954,688 bytes, 231 table/virtual entries.
- PG18 target image manifest exists: `pgvector/pgvector:pg18` supports linux/amd64 and linux/arm64.
- No previous `scripts/pg18_migration` or `scripts/pg_migration` implementation files existed at start.

## Evidence artifact convention

- JSON evidence: `backups/pg18-migration/*.json`
- Dumps/logs: `backups/pg18-migration/*`
- Human report: `docs/pg18-migration-baseline-YYYYMMDD.md`

## Notes

Secrets must not be written to this file. DSNs in reports should be masked.

## Phase 0–1.2 result — 2026-07-08 15:52 KST

- SQLite baseline auditor: PASS, artifact `backups/pg18-migration/sqlite_baseline_20260708_154008.json`.
- Product PG16 auditor: PASS, latest source artifact `backups/pg18-migration/product_pg16_baseline_20260708_155257.json`.
- PG18 sidecar: PASS, `consulting-web-pg18-rehearsal-pg18-1`, `pgvector/pgvector:pg18`, localhost `55418`.
- Extension smoke: PASS, `btree_gin`, `pg_trgm`, `plpgsql`, `uuid-ossp`, `vector`.
- PG16 dump: PASS, `backups/pg18-migration/product_pg16_20260708_155257.dump`.
- PG18 restore verification: PASS, `backups/pg18-migration/product_pg18_verify_20260708_155257.json`, matched `46/46` tables and `1683/1683` rows.
- Fixed rehearsal pitfalls:
  - PG18 Docker volume must mount `/var/lib/postgresql`, not `/var/lib/postgresql/data`.
  - Product checksum ordering must use `COLLATE "C"` for text/composite PKs across PG16/PG18.
  - Product baseline can drift during live writes; compare a tight audit→dump→restore→audit bundle.
