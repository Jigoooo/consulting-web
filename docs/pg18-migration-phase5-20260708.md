# PG18 Migration Phase 5 — Write-path audit, shadow logging, and cutover plan

## 결론

Phase 5는 운영 전환 없이 완료했다. 현재 판단은 명확하다: **PG18 cutover 방향은 가능하지만 SQLite 삭제/rename은 아직 안전하지 않다.** 이번 단계에서 확인된 핵심 blocker는 SQLite writer가 아직 살아 있다는 점이며, 특히 dialogue-memory 핵심 writer 4개가 PG write path 없이 SQLite에 직접 기록한다.

## Scope actually executed

Allowed and executed:

- static SQLite writer-path audit
- opt-in `dual` read shadow mismatch JSONL logging
- representative no-wait dual shadow observation
- write-path dual/backfill design
- cutover / rollback / SQLite archive plan
- tests and docs

Not executed:

- production backend switch
- cron pause/resume or cron env edit
- `.env.docker` edit
- production compose edit
- SQLite rename/delete
- 24–72h live shadow wait
- PG-only writer rollout

## Evidence artifacts

| Gate | Result | Evidence |
|---|---|---|
| Writer-path audit | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_write_path_audit_20260708_183832.json` |
| Shadow mismatch log | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/shadow/pg18_shadow_mismatches_20260708.jsonl` |
| Unit/regression tests | PASS | `26 passed in 0.35s` |
| Python compile check | PASS | `py_compile` over backend + pg_migration scripts returned exit `0` |
| Operational no-touch boundary | PASS | no `docker-compose.prod.yml`, `.env.docker`, cron, production switch, or SQLite rename/delete changes |
| Human plan | PASS | this document |

## Writer audit result

Summary from `sqlite_write_path_audit_20260708_183832.json`:

```json
{
  "writer_files": 62,
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

Interpretation:

- `scripts/dialogue_memory/store.py` is the core SQLite write boundary.
- `ingest.py`, `file_ingest.py`, and `md_ingest.py` call the store helpers and therefore remain SQLite writer entrypoints.
- 57 additional runtime scripts still contain SQLite writes, mostly consulting OS / source OS / QA / derived-layer writers. Those are not all cutover blockers for recall, but they prove the broader consulting OS is still SQLite-backed.
- Therefore **SQLite is not delete-safe**.

## Shadow mismatch logging result

Implementation:

- `scripts/dialogue_memory/backend.py`
- only fires in opt-in `dual` recall mode
- returns SQLite result exactly as before
- appends JSONL only when PG shadow has an error, empty result against non-empty SQLite, or top overlap below threshold
- logs only keys/counts/errors, not raw hit body text

Observed no-wait shadow sample with `CONSULTING_SHADOW_MIN_OVERLAP=0.6`:

| Query | SQLite hits | PG hits | Top overlap | Logged |
|---|---:|---:|---:|---|
| `정원 근속승진` | 5 | 5 | 0.20 | yes |
| `수익구조 경륜 취약` | 5 | 5 | 0.20 | yes |

Interpretation:

- PG18 is alive and returning non-empty results.
- Some queries still diverge materially from SQLite ranking.
- This is expected because PG18 shadow read is not yet the full production-quality path; vector parity exists as a layer, but `backend.py` read mode still uses lexical+graph scoring and does not yet fuse PG vector in the same production ranking contract.
- Live shadow logging is now sufficient to observe mismatch during a later approved dual window.

## Write-path dual/backfill design

### Target invariant

One backend switch, no silent cutover:

```text
CONSULTING_BRAIN_WRITE_BACKEND=sqlite|dual|pg
CONSULTING_BRAIN_BACKEND=sqlite|dual|pg   # existing read switch
```

Defaults must remain:

```text
read  = sqlite
write = sqlite
```

### Phase 5-A — PG writer helper layer

Add a new PG writer module, preferably separate from the read-only `pg_backend.py`:

```text
scripts/dialogue_memory/pg_store.py
```

Required helper parity with `store.py`:

| SQLite helper | PG helper requirement |
|---|---|
| `insert_chunk` | upsert `brain_raw.dialogue_chunks`, then upsert derived `brain_rag.chunk_texts` and `brain_rag.chunk_embeddings` |
| `add_edge` | upsert `brain_raw.dialogue_edges` |
| `insert_file_chunk` | upsert `brain_raw.file_chunks`, then derived `brain_rag.chunk_texts` and `brain_rag.chunk_embeddings` |
| `add_file_edge` | upsert `brain_raw.file_edges` |
| `set_checkpoint` | upsert `brain_raw.dialogue_ingest_checkpoint` |
| `bind_session` | upsert `brain_raw.dialogue_topic_sessions` |
| `map_telegram_user/thread` | upsert topic binding tables |
| `update_file_chunk_tier` | update raw + derived metadata consistently |

Important sequencing for `dual` writes:

1. SQLite write runs first and returns the canonical SQLite `id`.
2. PG writer upserts the same row with the same primary key and `content_hash`.
3. If PG write fails, SQLite success is not rolled back in dual mode; error is logged as a dual-write mismatch.
4. Dual-write mismatch must be visible in a JSONL artifact and in a later audit command.

Reason: preserving SQLite row IDs while SQLite remains source-of-truth keeps Phase 2/4 parity verifiers meaningful.

### Phase 5-B — Store facade

Do not branch inside every ingester. Add a facade layer around `store.py` helpers:

```text
write_backend = resolve_write_backend()
insert_chunk(...)        # sqlite only / sqlite+pg / pg only
insert_file_chunk(...)
add_edge(...)
add_file_edge(...)
set_checkpoint(...)
```

TDD gates:

- default/unset write backend never calls PG
- `dual` calls SQLite first, then PG
- `pg` skips SQLite writes only after explicit approval
- invalid backend fails fast
- PG failure in `dual` logs mismatch and returns SQLite success
- PG failure in `pg` fails the command
- no raw consulting text duplicated in mismatch logs beyond what is already stored in the DB row payload

### Phase 5-C — Backfill before any switch

Before any live write/read switch:

1. freeze or pause relevant writers only after explicit approval
2. run final SQLite→PG18 refresh importer
3. rebuild/refresh `brain_rag.chunk_texts`
4. rebuild/refresh `brain_rag.chunk_embeddings`
5. run table parity verifier
6. run read parity verifier
7. run graph parity verifier
8. run vector parity verifier
9. run writer audit again and confirm remaining blockers are understood

Minimum backfill gates:

| Gate | Required result |
|---|---|
| raw table parity | `failure_count=0` |
| vector parity | `failures=0`, avg overlap `1.00` on representative cases |
| read parity | no `pg_empty_while_sqlite_nonempty`; threshold to be set from live shadow baseline |
| writer audit | no unclassified dialogue-memory writer |
| rollback material | SQLite backup + PG dump + artifact manifest exists |

### Phase 5-D — Live dual window

Only after approval:

```text
read backend  = dual   # returns SQLite, logs PG shadow
write backend = dual   # writes SQLite first, PG second
```

Window: 24–72h or a no-wait accelerated equivalent with representative traffic replay.

Pass criteria:

- no PG write errors
- no PG empty result against non-empty SQLite for critical queries
- mismatch JSONL either empty or reviewed and explained
- row-count and content-hash deltas reconcile after every ingest batch
- checkpoint/session binding rows match between SQLite and PG

## Cutover plan

### Cutover prerequisites

Do not start cutover until all are true:

- `sqlite_delete_safe=false` has been resolved into a planned archive state, not ignored
- read `dual` window passed
- write `dual` window passed
- final refresh/backfill artifacts are green
- rollback artifact bundle exists
- user explicitly approves production switch

### Proposed cutover sequence

1. Announce short freeze window.
2. Stop/pause only relevant consulting brain writers after approval.
3. Copy SQLite DB and WAL/SHM sidecars.
4. Take PG18 dump.
5. Run final SQLite→PG18 refresh import.
6. Rebuild PG vector layer.
7. Run raw/read/graph/vector parity gates.
8. Set write backend to `dual` if not already in dual.
9. Set read backend to `dual` and observe.
10. Switch read backend to `pg` only after dual read is clean.
11. Keep write backend `dual` for the rollback window.
12. Switch write backend to `pg` only after rollback window passes and reverse-delta procedure is proven.

Key point: **read PG-only can precede write PG-only; SQLite should remain dual-written during the first rollback window.**

## Rollback plan

### If read PG-only fails while write is still dual

Fast rollback:

```text
CONSULTING_BRAIN_BACKEND=sqlite
CONSULTING_BRAIN_WRITE_BACKEND=dual or sqlite
```

Then inspect mismatch logs and PG query artifacts. No data loss expected because SQLite stayed current.

### If write PG-only has already started

Rollback requires a freeze and delta recovery:

1. stop writers
2. identify PG rows newer than the write cutover marker
3. export PG delta rows for `dialogue_chunks`, `file_chunks`, edges, checkpoints, bindings
4. import those deltas into SQLite with conflict-safe upsert
5. rebuild SQLite FTS/vector side indexes if needed
6. switch write backend back to `sqlite` or `dual`
7. run parity gates again

This is why immediate PG-only write is not recommended. Keep `dual` writes through the rollback window.

## SQLite archive/delete plan

Current status:

```text
SQLite archive-safe: not yet
SQLite delete-safe: no
```

Archive conditions:

- PG read path has been production source for an agreed window
- PG write path has been production source or dual source with no unresolved errors
- reverse-delta rollback has been tested or declared unnecessary after the rollback window
- all cron/scripts that call `consulting.db` are classified as retired, migrated, or intentionally SQLite-local
- final backup bundle is read-verified

Archive action, when approved later:

```text
mv db/consulting.db db/consulting.db.archive-YYYYMMDD
mv db/consulting.db-wal db/consulting.db-wal.archive-YYYYMMDD  # if present
mv db/consulting.db-shm db/consulting.db-shm.archive-YYYYMMDD  # if present
```

Delete action:

- separate explicit approval only
- not bundled with cutover
- not bundled with archive

## Phase 5 judgment

- PG18 sidecar is increasingly credible as the future store.
- The current blocker is not PG18 feasibility; it is **live write ownership**.
- The next implementation unit should be `pg_store.py` + write-backend facade with strict TDD.
- Until that exists and dual-write shadow is clean, SQLite remains the source of truth.

## Final verification run

Commands executed from `/home/jigoo/.hermes/workspace/consulting`:

```text
.venv/bin/python -m pytest scripts/tests/test_dialogue_memory_backend_modes.py scripts/tests/test_pg18_write_path_audit.py scripts/tests/test_pg18_vector_layer.py scripts/tests/test_pg18_vector_parity_verifier.py scripts/tests/test_pg_migration_audit_sqlite_baseline.py scripts/tests/test_pg_migration_schema_introspect.py scripts/tests/test_pg_migration_type_map.py scripts/tests/test_sqlite_to_pg18_brain_importer.py -q
```

Result:

```text
26 passed in 0.35s
```

Compile check:

```text
.venv/bin/python -m py_compile scripts/dialogue_memory/backend.py scripts/dialogue_memory/pg_backend.py scripts/pg_migration/audit_sqlite_write_paths.py scripts/pg_migration/verify_pg18_read_parity.py scripts/pg_migration/verify_pg18_vector_parity.py scripts/pg_migration/rebuild_pg18_vector_layer.py scripts/dialogue_memory_cli.py
```

Result: exit `0`.
