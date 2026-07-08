# PG18 Migration Phase 7 — Final backfill, parity gates, and switch decision

## 결론

Phase 7는 **최종 refresh/backfill + parity + no-wait dual-write replay를 통과**했다. 다만 운영 전환 판단은 다음처럼 제한한다.

- **허용/적용:** host-side `consulting-dialogue-ingest` cron wrapper의 write path를 `dual` 관찰 모드로 전환.
- **보류:** web API read-dual/pg-only, web-turn ingest write-dual, full PG-only cutover.
- **금지 유지:** SQLite archive/delete/rename. `sqlite_delete_safe=false`이고 writer audit상 SQLite writer가 63개 남아 있다.

즉, 지금 상태는 “PG18 feasibility + host cron dual observation enabled”이지, “PG18 source-of-truth cutover complete”가 아니다.

## 승인된 범위에서 실제 수행한 것

### 1) 백업

- SQLite logical backup: `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/phase7_20260708_191239/consulting_sqlite_20260708_191239.db`
- PG18 sidecar dump: `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/phase7_20260708_191239/pg18_sidecar_20260708_191239.dump`
- Hash manifest: `/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/phase7_20260708_191239/SHA256SUMS.txt`
- SQLite backup open check: `sqlite_backup_open=ok`, `sqlite_master_entries=352`

### 2) Final SQLite → PG18 refresh/backfill

Artifact:

```text
/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_to_pg18_apply_p7_20260708_191317.json
```

Summary:

```json
{
  "logical_tables": 208,
  "rag_chunk_texts": 1446,
  "row_delta_sum": 0,
  "source_rows": 22642,
  "target_rows_after": 22642
}
```

Interpretation: live SQLite raw layer and PG18 raw mirror were already in sync at final refresh time; refresh was idempotent.

### 3) Parity gates

| Gate | Result | Evidence |
|---|---:|---|
| Raw table parity | PASS | `sqlite_rows=22642`, `pg_rows=22642`, `failure_count=0` |
| Graph edge parity | PASS | `dialogue_edges=383`, `file_edges=1931`, `dangling_sqlite=0`, `dangling_pg=0` |
| Vector parity | PASS | `cases=6`, `avg_overlap=1.0`, `failures=0` |
| Read parity | PASS | `queries=4`, `sqlite_nonempty=4`, `pg_nonempty=4`, `avg_top_overlap=0.45`, `failures=0` |
| Write-path audit | PASS as audit, FAIL for delete-safety | `writer_files=63`, `core_writer_files=4`, `sqlite_delete_safe=false` |

Artifacts:

```text
/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_to_pg18_verify_p7_20260708_191546.json
/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_graph_parity_p7_20260708_191801.json
/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_vector_parity_p7_20260708_191546.json
/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/pg18_read_parity_p7_20260708_191546.json
/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/sqlite_write_path_audit_p7_20260708_191546.json
```

### 4) No-wait dual-write replay

Artifact:

```text
/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/dual_write_replay_p7_20260708_191934.json
```

Summary:

```json
{
  "ok": true,
  "cleanup_restored_counts": true,
  "failures": 0
}
```

Readback during marker replay:

- SQLite: dialogue chunk/edge, file chunk/edge, checkpoint, session, telegram user/thread rows all `1`.
- PG18: same raw rows all `1`, plus `brain_rag.chunk_texts` and `brain_rag.chunk_embeddings` rows for dialogue/file chunks all `1`.
- Cleanup restored all pre-smoke counts.
- PG write mismatch log did not change.

## Operational switch decision

### A. Host cron write-dual — ENABLED

Updated file:

```text
/home/jigoo/.hermes/scripts/consulting_dialogue_ingest.py
```

Change:

- Child ingest processes now default to:

```text
CONSULTING_BRAIN_WRITE_BACKEND=dual
CONSULTING_WRITE_LOG_DIR=/home/jigoo/.hermes/workspace/consulting/backups/pg18-migration/write-shadow-cron
```

- Rollback is trivial:

```text
CONSULTING_BRAIN_WRITE_BACKEND=sqlite
# or
CONSULTING_DIALOGUE_INGEST_WRITE_BACKEND=sqlite
```

Verification:

```text
python3 -m py_compile /home/jigoo/.hermes/scripts/consulting_dialogue_ingest.py  # exit 0
python3 /home/jigoo/.hermes/scripts/consulting_dialogue_ingest.py
status=0
stdout_bytes=0
log_bytes_before=0
log_bytes_after=0
```

Interpretation: current manual run had no new ingest to write, but the cron wrapper is now configured so the next real dialogue/file/md ingest uses SQLite-first dual-write on the host, where Docker/PG18 sidecar access is available.

### B. Web API read-dual — BLOCKED, not enabled

Measured from `consulting-web-api-1`:

```text
CONSULTING_BRAIN_ROOT=/brain/consulting
CONSULTING_PYTHON=python3
# no CONSULTING_BRAIN_BACKEND
# no CONSULTING_BRAIN_WRITE_BACKEND
```

Tool availability inside API container:

```text
python3=/usr/local/bin/python3
psql=missing
docker=missing
psycopg=False
psycopg2=False
```

Network reachability from API container to PG18 sidecar:

```text
host.docker.internal:55418 = ConnectionRefused
172.24.0.2:5432 = timeout
consulting-web-pg18-rehearsal-pg18-1 = DNS failure
```

Interpretation: setting `CONSULTING_BRAIN_BACKEND=dual` in `docker-compose.prod.yml` now would not create useful PG18 read shadow. It would make `pg_backend.py` fail the shadow path inside API because it cannot reach/query PG18. SQLite results would still return, but mismatch logs would become noise.

### C. Web-turn ingest write-dual — BLOCKED, not enabled

`ConsultingWebIngestWorker` spawns `apps/api/scripts/ingest_web_dialogue.py` inside the API container. That Python path imports shared `store.py`; if `CONSULTING_BRAIN_WRITE_BACKEND=dual` were set in the API container today, the PG side of `pg_store.py` would need PG18 access and fail for the same reasons above.

Therefore API container write-dual is intentionally not enabled.

### D. PG-only cutover — NOT READY

Reasons:

1. Static writer audit still shows broad SQLite dependency:
   - `writer_files=63`
   - `sqlite_delete_safe=false`
2. Web API cannot currently query PG18 sidecar from inside the container.
3. Web-turn ingest cannot currently dual-write to PG18 from inside the container.
4. The read PG backend is lexical+graph shadow, not full semantic/vector parity for all production paths.
5. SQLite remains the only fully proven source-of-truth for every caller.

## Next required implementation unit for PG-only eligibility

1. Put PG18 sidecar on a network/API-reachable path or promote PG18 into an approved production service.
2. Add a container-safe PG client path:
   - either install `psql` and set `CONSULTING_PG_DSN`, or
   - better: add a Python `psycopg` implementation in `pg_backend.py` / `pg_store.py` and include it in the API image.
3. Then enable and test:
   - web API `CONSULTING_BRAIN_BACKEND=dual`
   - web-turn ingest `CONSULTING_BRAIN_WRITE_BACKEND=dual`
4. Run browser/API chat smoke with a marker turn:
   - assistant generation succeeds
   - web turn persists to SQLite
   - same marker appears in PG18 raw + `brain_rag`
   - mismatch logs stay empty
   - cleanup restores marker counts if smoke data is temporary
5. Only after 24–72h clean live observation or an equivalent replay harness over representative web traffic should `pg` mode be considered.

## Final judgment

- **PG18 mirror/backfill/parity:** ready.
- **Host cron dual-write observation:** enabled.
- **Web API dual-read/write:** not yet enabled; blocked by container PG access.
- **PG-only source-of-truth:** not ready.
- **SQLite archive/delete:** still forbidden.
