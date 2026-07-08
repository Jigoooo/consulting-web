# PG18 Migration Phase 6 — Opt-in write backend facade

## 결론

Phase 6는 **운영 전환 없이 코드 구현/테스트까지만 완료**했다. `CONSULTING_BRAIN_WRITE_BACKEND=sqlite|dual|pg` write facade와 `pg_store.py` PG18 writer helper를 추가했고, 기본값은 계속 `sqlite`다. 따라서 현재 운영 writer/source-of-truth는 여전히 SQLite이며, SQLite archive/delete는 아직 금지다.

## Scope actually executed

Allowed and executed:

- add `scripts/dialogue_memory/pg_store.py`
- add `store.py` write facade around existing helper functions
- keep unset/default write backend as `sqlite`
- add TDD tests for `sqlite|dual|pg` behavior
- verify PG18 sidecar SQL using a transaction `ROLLBACK` smoke
- regenerate static writer-path audit
- document Phase 6 state

Not executed:

- production backend switch
- cron pause/resume or cron env edit
- `.env.docker` edit
- production compose edit
- SQLite rename/delete
- 24–72h live shadow wait
- PG-only writer rollout

## Implementation summary

### New writer switch

```text
CONSULTING_BRAIN_WRITE_BACKEND=sqlite|dual|pg
```

Default/unset behavior remains:

```text
write = sqlite
```

### Write facade behavior

| Mode | Behavior |
|---|---|
| `sqlite` | calls only existing SQLite helpers |
| `dual` | writes SQLite first, then attempts PG18 write; PG failure is logged and SQLite success is preserved |
| `pg` | skips SQLite write and calls PG18 writer; PG failure raises |
| invalid | fails fast with `ValueError` |

### Covered helper surface

| `store.py` helper | Phase 6 behavior |
|---|---|
| `insert_chunk` | SQLite/dual/PG facade; PG upserts `brain_raw.dialogue_chunks`, `brain_rag.chunk_texts`, `brain_rag.chunk_embeddings` |
| `insert_file_chunk` | SQLite/dual/PG facade; PG upserts `brain_raw.file_chunks`, `brain_rag.chunk_texts`, `brain_rag.chunk_embeddings` |
| `add_edge` | SQLite/dual/PG facade for `brain_raw.dialogue_edges` |
| `add_file_edge` | SQLite/dual/PG facade for `brain_raw.file_edges` |
| `set_checkpoint` | SQLite/dual/PG facade for `brain_raw.dialogue_ingest_checkpoint` |
| `bind_session` | SQLite/dual/PG facade for `brain_raw.dialogue_topic_sessions` |
| `map_telegram_user` | SQLite/dual/PG facade for `brain_raw.dialogue_topic_telegram` |
| `map_telegram_thread` | SQLite/dual/PG facade for `brain_raw.dialogue_telegram_thread_bindings` |
| `update_file_chunk_tier` | SQLite/dual/PG facade; PG updates raw file row and derived metadata |

## Important implementation constraints found

### PG18 constraints differ from SQLite assumptions

Live sidecar `information_schema` / `pg_constraint` showed that imported raw edge tables currently have only `PRIMARY KEY (id)`, not `UNIQUE(chunk_id, target_type, target_ref)`. Therefore Phase 6 PG edge upserts use:

```sql
ON CONFLICT (id) DO UPDATE SET ...
```

not:

```sql
ON CONFLICT (chunk_id, target_type, target_ref)
```

This was caught by a RED test and fixed before final verification.

### pgvector dimension must be guarded

`brain_rag.chunk_embeddings` has:

```text
embedding vector(3072) NOT NULL
CHECK (embed_dim = 3072)
```

Phase 6 `pg_store.py` rejects non-3072 embeddings before building PG write SQL. This prevents a dual-write path from silently generating SQL that would fail only after SQLite had already accepted a row.

### PG-only id allocation is still an operational boundary

For `pg` mode with no SQLite row id, Phase 6 uses `max(id)+1` fallback to match the existing imported schema, which has no sequence/default on these raw tables. This is acceptable only as an implementation scaffold / single-writer controlled phase. Before production PG-only writer rollout, either keep a single-writer freeze/rollback window or approve additive DDL for database-owned id allocation.

## Evidence artifacts

| Gate | Result | Evidence |
|---|---|---|
| TDD RED | PASS | `test_pg_store_rejects_non_pgvector_dimension` and `test_pg_edge_upsert_uses_existing_primary_key_conflict_target` failed before fix |
| Write-backend unit tests | PASS | `11 passed in 0.03s` for `test_dialogue_memory_write_backend_modes.py` |
| Related PG18/dialogue tests | PASS | `40 passed in 0.39s` across write backend, backend modes, exact Telegram binding, PG18 vector/parity/import/audit tests |
| Python compile | PASS | `py_compile` over dialogue-memory store/backend/PG backend/CLI and `scripts/pg_migration/*.py` returned exit `0` |
| PG18 rollback SQL smoke | PASS | sidecar transaction inserted dialogue/file rows inside `BEGIN`, observed `inside_dialogue=1`, `inside_file=1`, then `ROLLBACK` left `after_dialogue=0`, `after_file=0` |
| Writer-path audit | PASS/blocked as expected | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_write_path_audit_phase6_20260708_185432.json` |
| Operational no-touch boundary | PASS | no production compose/env/cron/backend switch; SQLite file still exists |

## Phase 6 writer audit result

From `sqlite_write_path_audit_phase6_20260708_185432.json`:

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

Interpretation:

- `store.py` is now the facade, but static audit still correctly classifies it as the core dialogue-memory writer.
- `ingest.py`, `file_ingest.py`, and `md_ingest.py` still call the store helpers, so they remain high-risk writer entrypoints until an approved live dual/PG rollout proves the facade under real ingest traffic.
- `sqlite_delete_safe=false` remains correct.

## Full-suite note

A broader `pytest scripts/tests -q` run produced:

```text
176 passed, 2 failed, 7 warnings in 6.68s
```

The 2 failures are unrelated prompt-richness tests in `test_b7_claimsynth_richness_dedup.py` requiring the string `함의` in `AXIS_GENERATE_TASK` / `AXIS1_GENERATE_TASK`. The axis prompt files were not modified in this Phase 6 DB write-backend work. Therefore Phase 6 DB gates are green, but the repository-wide test suite is not globally green.

## Current operational judgment

- PG18 write-path scaffold: implemented.
- Default production behavior: unchanged (`sqlite`).
- SQLite source-of-truth status: unchanged.
- SQLite archive/delete safe: **false**.
- Next approved step before any switch: controlled dual-write observation using real ingest/replay, with row-count/content-hash/checkpoint/session parity gates.

## Next gates before production switch

1. Run final refresh/backfill from live SQLite into PG18 sidecar.
2. Run read/vector/graph parity again.
3. Run `CONSULTING_BRAIN_WRITE_BACKEND=dual` in a no-wait replay or approved short live window.
4. Confirm no PG write mismatch JSONL errors.
5. Confirm raw row deltas and content hashes reconcile after ingest.
6. Only then consider read/backend switch; keep SQLite through rollback window.
