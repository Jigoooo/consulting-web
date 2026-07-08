# PG18 Migration Phase 4 — Graph + Vector Parity Scaffold

## 결론

Phase 4는 운영 전환 없이 완료했다. SQLite 최종 폐기 방향은 맞지만, 이번 단계에서는 SQLite를 삭제하거나 production backend를 바꾸지 않았다. 대신 PG18 sidecar가 SQLite의 핵심 검색 신호 중 graph와 vector를 재현할 수 있는지 증명했다.

핵심 결과:

- PG18 graph recall: `dialogue_edges` / `file_edges` / `claims` 기반 graph boost 추가.
- 명시 claim 질의 `CL-RP03 공무직 승진체계`: dual shadow top-5 overlap `0.80`.
- PG18 vector layer: `brain_raw.*.embedding` BLOB → `brain_rag.chunk_embeddings embedding vector(3072)` 파생층 생성.
- SQLite BLOB cosine ↔ PG18 pgvector cosine parity: `6/6` cases pass, average overlap `1.00`.
- Still not executed: production switch, cron pause/resume, SQLite rename/delete, final cutover.

## Scope

Implemented:

- PG18 read-only graph scoring in `/home/jigoo/.hermes/workspace/consulting/scripts/dialogue_memory/pg_backend.py`
- PG18 vector layer builder in `/home/jigoo/.hermes/workspace/consulting/scripts/pg_migration/rebuild_pg18_vector_layer.py`
- PG18 vector parity verifier in `/home/jigoo/.hermes/workspace/consulting/scripts/pg_migration/verify_pg18_vector_parity.py`
- Regression tests:
  - `scripts/tests/test_dialogue_memory_backend_modes.py`
  - `scripts/tests/test_pg18_vector_layer.py`
  - `scripts/tests/test_pg18_vector_parity_verifier.py`

Not executed:

- production compose/env switch
- production runtime backend switch
- production cron pause/resume
- production writer cutover
- SQLite rename/delete/decommission
- 24–72h live shadow wait
- final cutover

## Evidence artifacts

| Gate | Result | Evidence |
|---|---:|---|
| SQLite→PG18 sidecar refresh | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_to_pg18_apply_p4_refresh_20260708_180852.json` |
| Graph shadow parity | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_graph_parity_20260708_182037.json` |
| No-wait read parity after graph | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_read_parity_p4_20260708_182039.json` |
| Vector layer build | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_vector_layer_20260708_181711.json` |
| Vector parity | PASS | `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_vector_parity_20260708_182010.json` |

## Measured state after Phase 4 refresh

PG18 sidecar counts:

| Layer | Count |
|---|---:|
| `brain_raw.dialogue_chunks` | `145` |
| `brain_raw.dialogue_edges` | `383` |
| `brain_raw.file_chunks` | `1298` |
| `brain_raw.file_edges` | `1931` |
| `brain_raw.claims` | `37` |
| `brain_raw.kg_entities` | `1949` |
| `brain_raw.kg_relations` | `1815` |
| `brain_rag.chunk_texts` | `1446` |
| `brain_rag.chunk_embeddings` | `1443` |

The Phase 2 sidecar had drifted because SQLite is still the live source during this rehearsal. Phase 4 refreshed the sidecar before parity checks.

## Graph parity result

Graph recall now uses:

- exact claim/evidence refs from the query, e.g. `CL-RP03`
- claim-text overlap against `brain_raw.claims`
- chunk links from `brain_raw.dialogue_edges` and `brain_raw.file_edges`
- source-local candidate pooling to avoid dialogue raw graph scores crowding out file claim chunks
- SQLite-like tier weighting: `final_usable=1.0`, `qualified_usable=0.75`, raw/unknown `0.20`

Graph artifact summary:

| Metric | Result |
|---|---:|
| cases | `3` |
| failures | `0` |
| average top overlap | `0.40` |
| explicit graph query overlap | `0.80` |

Explicit graph query:

| Query | SQLite top keys | PG18 top keys | overlap |
|---|---|---|---:|
| `CL-RP03 공무직 승진체계` | `file:3`, `file:6`, `file:30`, `file:5`, `file:11` | `file:3`, `file:6`, `file:5`, `file:12`, `file:11` | `0.80` |

## Read parity after graph result

Artifact: `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_read_parity_p4_20260708_182039.json`

| Metric | Result |
|---|---:|
| representative queries | `4` |
| failures | `0` |
| SQLite non-empty | `4 / 4` |
| PG18 non-empty | `4 / 4` |
| average top-5 overlap | `0.45` |

This improved from Phase 3 average overlap `0.30` because graph scoring now exists in PG18.

## Vector parity result

Vector layer build:

- Source rows: `1443`
- `dialogue_chunks`: `145`
- `file_chunks`: `1298`
- Target rows: `1443`
- Row delta: `0`
- Models:
  - `gemini-embedding-001`: `145`
  - `gemini-embedding-2`: `1298`

Vector parity verifier:

| Metric | Result |
|---|---:|
| cases | `6` |
| failures | `0` |
| average overlap | `1.00` |

Important implementation note:

- Full precision is stored as `embedding vector(3072)`.
- Direct HNSW over `vector(3072)` failed in PG18/pgvector with: `column cannot have more than 2000 dimensions for hnsw index`.
- Verified workaround: HNSW expression index over `embedding::halfvec(3072)` is accepted.
- Therefore Phase 4 stores exact vectors and creates ANN-ready halfvec index, but cutover quality should still be validated with real query traffic before relying on ANN behavior.

## SQLite 폐기 경로 판단

Final direction remains: **SQLite 폐기 → PG18 단일 brain store**.

But the safe order is:

1. Keep SQLite as production source for now.
2. Continue PG18 sidecar shadow parity.
3. Add write-path dual logging/backfill, still no cutover.
4. Run approved live shadow window with mismatch logs.
5. Only after approval: production backend switch.
6. Only after rollback window: SQLite rename/archive.
7. Only after additional approval: SQLite deletion/decommission.

Phase 4 proves graph/vector feasibility. It does not by itself prove production cutover safety.

## Test evidence

Latest local gates:

```text
.venv/bin/python -m pytest scripts/tests/test_dialogue_memory_backend_modes.py -q
4 passed in 0.03s

.venv/bin/python -m pytest scripts/tests/test_pg18_vector_parity_verifier.py scripts/tests/test_pg18_vector_layer.py -q
4 passed in 0.03s
```

Full final test sweep is recorded in the worklog.
