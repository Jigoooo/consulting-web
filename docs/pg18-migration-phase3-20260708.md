# PG18 Migration Phase 3 — Shadow Adapter + No-wait Read Parity

## 결론

Phase 3의 1순위/2순위는 운영 전환 없이 완료했다. `dialogue_memory_cli.py recall` 경계에 `sqlite|dual|pg` backend adapter를 추가했고, PG18 sidecar의 `brain_rag.chunk_texts`를 읽는 read-only recall backend를 붙였다. 기본값은 계속 `sqlite`라 운영 동작은 바뀌지 않는다.

요청에 따라 24–72h shadow 대기는 하지 않았고, 대표 질의 4개로 즉시 read parity를 검증했다.

## Scope

Implemented:

- `CONSULTING_BRAIN_BACKEND=sqlite|dual|pg` backend mode
- `dialogue_memory_cli.py recall --backend sqlite|dual|pg`
- `dual` mode: SQLite 결과를 그대로 반환하고 PG18 shadow comparison만 붙임
- `pg` mode: PG18 sidecar `brain_rag.chunk_texts` read-only recall
- no-wait read parity verifier

Not executed:

- production compose/env switch
- production cron pause/resume
- production writer/read-path cutover
- SQLite rename/delete/decommission
- 24–72h live shadow wait
- final cutover

## Changed files

Consulting repo:

- `/home/jigoo/.hermes/workspace/consulting/scripts/dialogue_memory_cli.py`
- `/home/jigoo/.hermes/workspace/consulting/scripts/dialogue_memory/backend.py`
- `/home/jigoo/.hermes/workspace/consulting/scripts/dialogue_memory/pg_backend.py`
- `/home/jigoo/.hermes/workspace/consulting/scripts/pg_migration/verify_pg18_read_parity.py`
- `/home/jigoo/.hermes/workspace/consulting/scripts/tests/test_dialogue_memory_backend_modes.py`

Docs repo:

- `/home/jigoo/.hermes/workspace/consulting-web/docs/pg18-migration-phase3-20260708.md`
- `/home/jigoo/.hermes/workspace/consulting-web/docs/pg18-migration-worklog.md`
- `/home/jigoo/.hermes/workspace/consulting-web/docs/pg18-migration-baseline-20260708.md`

## Adapter behavior

| Mode | Activation | Returned answer path | PG18 behavior | Operational risk |
|---|---|---|---|---|
| `sqlite` | default / unset | current SQLite RAG | none | unchanged |
| `dual` | opt-in env or CLI | SQLite RAG | read-only PG18 shadow compare in `shadow` field | no production switch |
| `pg` | opt-in env or CLI | PG18 sidecar read-only recall | read-only query against `brain_rag.chunk_texts` | no SQLite writes/deletes |

The web API still calls the same Python CLI boundary via `ConsultingGraphRagBridge`. Because the backend default is `sqlite`, existing web behavior remains unchanged unless the operator explicitly passes `--backend` or sets `CONSULTING_BRAIN_BACKEND`.

## Read parity evidence

Artifact:

- `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_read_parity_final_20260708_170242.json`

Command:

```bash
CONSULTING_EMBED_FAKE=1 .venv/bin/python scripts/pg_migration/verify_pg18_read_parity.py --output backups/pg18-migration/pg18_read_parity_final_20260708_170242.json
```

Summary:

| Metric | Result |
|---|---:|
| `ok` | `true` |
| representative queries | `4` |
| failures | `0` |
| SQLite non-empty | `4 / 4` |
| PG18 non-empty | `4 / 4` |
| average top-5 overlap | `0.30` |
| minimum overlap threshold | `0.20` |

Per-query top-5 overlap:

| Query | SQLite hits | PG18 hits | Top overlap |
|---|---:|---:|---:|
| `정원 근속승진` | `5` | `5` | `0.20` |
| `수익구조 경륜 취약` | `5` | `5` | `0.20` |
| `CL-RP03 공무직 승진체계` | `5` | `5` | `0.40` |
| `대행사업 적정인력` | `5` | `5` | `0.40` |

## Important interpretation

This is a **shadow-read readiness gate**, not quality parity with the current full SQLite retriever.

- SQLite path uses semantic embeddings + FTS5 + graph fusion.
- PG18 sidecar path currently uses read-only lexical/trigram/tsvector scoring over `brain_rag.chunk_texts`.
- Therefore low overlap is expected. The verified property is: PG18 can serve non-empty relevant recall over the same imported brain layer through the same CLI adapter boundary.
- Actual production-quality parity still requires a later PG18 graph/vector parity phase before cutover.

## Test evidence

Latest local gate:

```text
.venv/bin/python -m py_compile scripts/dialogue_memory/backend.py scripts/dialogue_memory/pg_backend.py scripts/dialogue_memory_cli.py scripts/pg_migration/verify_pg18_read_parity.py
.venv/bin/python -m pytest scripts/tests/test_dialogue_memory_backend_modes.py scripts/tests/test_pg_migration_schema_introspect.py scripts/tests/test_pg_migration_type_map.py scripts/tests/test_sqlite_to_pg18_brain_importer.py scripts/tests/test_pg_migration_audit_sqlite_baseline.py -q
```

Observed result before final docs update:

```text
17 passed in 0.20s
```

## Next required gate before any cutover

Before a real PG18 production switch, implement/verify at least:

1. PG18 graph parity for `dialogue_edges` / `file_edges` / `claims`.
2. PG18 vector parity or a deliberate replacement strategy for semantic retrieval.
3. Dual-mode production dry run with mismatch logging.
4. Explicit approval for production compose/env/runtime changes.
