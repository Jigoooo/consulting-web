# consulting SQLite → PostgreSQL 전환 검토

> Last measured: 2026-07-09
> Scope: `/home/jigoo/.hermes/workspace/consulting/db/consulting.db`, `consulting-web` Postgres runtime.
> 상태: Phase 11 runtime cutover 반영. 활성 dialogue/file GraphRAG는 PG18/pgvector sidecar, SQLite는 rollback/fallback snapshot.

## 0. 결론

가능하며, 2026-07-09 기준 GraphRAG hot path는 PostgreSQL 18/pgvector sidecar로 전환됐다. 단, `consulting.db`는 단순 GraphRAG 캐시가 아니라 **컨설팅 OS 전체 DB**에 가깝기 때문에 즉시 `rm`은 금지하고 rollback/fallback snapshot으로 보관한다.

```text
1단계: GraphRAG hot path를 Postgres에 read-only mirror             완료
2단계: SQLite/PG recall 결과를 같은 eval로 비교                   완료
3단계: writer를 adapter/dual-write/pg-only 경계로 전환             완료(핵심 dialogue/file)
4단계: API/cron PG-only smoke                                      완료
5단계: SQLite를 archive/fallback으로 격하                          진행 중(24h 관찰 후 quarantine)
```

2026-07-09 실측:

```text
PG18 brain_raw:
  dialogue_chunks 170 / embedded 170
  dialogue_edges  483
  file_chunks     1,526 / embedded 1,526
  file_edges      1,949

SQLite fallback consulting.db:
  dialogue_chunks 160 / embedded 160
  dialogue_edges  444
  file_chunks     1,526 / embedded 1,526
  file_edges      1,949
```

2026-07-09 PG recall/reranker parity 재측정:

```text
eval: graphrag_eval_gate.py --rerank --no-fake-embeddings --top-k 2 --rerank-prune 4 --raw-weight 0.20
questions: 45
rerank_modes: [cross-encoder]
fake_embeddings: false
warning_count: 0
hit_rate/context_recall: 0.9333
context_precision: 0.3251
p95_latency_s: 3.5018

baseline(SQLite/original): context_precision 0.2881 / context_recall 0.8667
판정: PG hot path는 baseline parity를 회복했다. P6 실험 투입 전 목표(context_precision >= 0.45)는 별도 precision 개선 과제로 남긴다.
```

2026-07-09 P6 product baseline:

```text
command: pnpm --filter @consulting/api run test:p6-product-baseline
config: rw020-prune4-top1
repeat: 3 / required_repeats: 3
context_precision: 0.8310
context_recall: 0.9111
hit_rate: 0.9111
worst_p95_latency_s: 4.1768
trace/retrieval/eval ledger rows: 1/1/1
leakage_count: 0
decision: allowed=true

판정: 현재 product baseline은 통과했다. ColBERT/SPLADE/RAPTOR는 이 baseline 대비
개선을 증명해야 하는 read-only comparison lab으로 남긴다.
```

운영 판정:

```text
- consulting-web API env: CONSULTING_BRAIN_BACKEND=pg, CONSULTING_BRAIN_WRITE_BACKEND=pg
- web-turn ingest smoke: CONSULTING_DB=/tmp/... 상태에서 PG insert 성공 후 marker cleanup 완료
- weekly KPI cron: 기본 pg backend, 수동 cron last_status=ok
- consulting-dialogue-ingest / sync-changwon / public-health cron: 수동 run ok
- SQLite 물리삭제: 금지. final backup/checksum 후 24h 관찰 → quarantine rename → smoke → 14일 뒤 삭제 순서
```

현재 병목은 “Postgres 16이 너무 낮다”가 아니라:

```text
- product DB(`consulting-web-pg-1`)와 brain DB(`pg18-rehearsal`)가 분리되어 있음
- legacy Python 코드에는 아직 sqlite3/FTS/embedding 직접 의존이 많음
- 핵심 dialogue/file GraphRAG는 PG18로 전환됐지만, 넓은 consulting OS 파생 writer 전체가 사라진 것은 아님
- Korean lexical search 품질은 PG ranking 회귀평가를 계속 유지해야 함
```

Product DB의 Postgres 16.14 자체는 2026-07 기준 최신 minor이고 공식 지원도 2028-11까지 남아 있다. GraphRAG brain은 별도 PG18/pgvector sidecar로 운영한다.

---

## 1. 현재 SQLite 감사 결과

DB:

```text
path: /home/jigoo/.hermes/workspace/consulting/db/consulting.db
size: 99,954,688 bytes
sqlite_version: 3.45.1
page_count: 24,403
page_size: 4,096
```

객체 규모:

```text
user tables excluding FTS shadow: 212
all tables including FTS shadow: 230
indexes: 36
triggers: 6
FTS virtual tables:
  - chunks_fts
  - dialogue_chunks_fts
  - file_chunks_fts
  - rag_chunks_fts
FTS shadow tables: 18
```

핵심 GraphRAG 테이블 현재값:

```text
topics                         2
dialogue_chunks              128
dialogue_chunks_fts          128
dialogue_edges               372
file_chunks                1,298
file_chunks_fts            1,298
file_edges                 1,931
rag_chunks                 1,559
rag_chunks_fts                73
claims                       37
evidence_items               83
claim_evidence_links        137
source_locations            549
dialogue_session_scopes       1
dialogue_topic_sessions      16
dialogue_topic_telegram       1
dialogue_telegram_thread_bindings 0
```

가장 큰 테이블군:

```text
lineage_graph_nodes     1,951
kg_entities             1,949
file_edges              1,931
lineage_graph_edges     1,817
kg_relations            1,815
rag_chunks              1,559
file_chunks             1,298
acquisition_attempts      905
atomic_statements         662
statement_verification_events 662
source_locations          549
step_events               529
step_oracles              529
slice_eval_runs           397
dialogue_edges            372
```

PK 없는 테이블:

```text
chunks_fts                       FTS virtual
dialogue_chunks_fts              FTS virtual
file_chunks_fts                  FTS virtual
rag_chunks_fts                   FTS virtual
phase2deep_proxy_candidate_map   snapshot/latest table
phase2deep_user_export_latest    snapshot/latest table
phase2r_deep_discovered_sources_latest
phase2r_deep_priority1_summary_latest
phase2r_deep_verification_latest
road_traffic_phase2r_master_latest
```

해석:

```text
- DB 전체는 작다. 용량 100MB 미만이라 단순 저장용량 때문에 PG가 필요한 상태는 아님.
- 하지만 테이블 수와 writer 수가 많아 “전면 이식” 비용은 크다.
- 실제 성능 병목이 온다면 file/dialogue vector search, FTS, 동시 writer, web/API 통합 쪽이다.
```

---

## 2. Python 코드 의존성 감사

검색 기준: `*.py`에서 `sqlite3`, `sqlite3.connect`, FTS `MATCH/bm25`, embedding/BLOB, `PRAGMA`, `sqlite_master`, `?` placeholder 탐색.

```text
sqlite/fts 관련 Python 파일 수: 165
sqlite3.connect hit: 163
sqlite3 import hit: 75
FTS MATCH/bm25 hit: 10
embedding/BLOB 관련 hit: 88
PRAGMA hit: 17
sqlite_master hit: 46
qmark placeholder hit: 8,823
```

핵심 파일:

```text
consulting/scripts/dialogue_memory/store.py
  - SQLite DDL 생성
  - FTS5 virtual table 생성
  - FTS sync trigger 생성
  - embedding BLOB pack/unpack
  - topic/session/telegram binding writer

consulting/scripts/dialogue_memory/search.py
  - semantic + lexical + graph RRF
  - FTS5 MATCH + bm25
  - LIKE fallback
  - file/dialogue rank fusion
  - trust tier weight

consulting/scripts/dialogue_memory/vsearch.py
  - BLOB float32 embedding brute-force cosine
  - optional sqlite-vec ANN threshold

consulting/scripts/dialogue_memory_cli.py
  - web API가 호출하는 recall/stats/ingest entrypoint

consulting-web/apps/api/src/consulting/consulting-graphrag-bridge.service.ts
  - Node API에서 Python CLI를 execFile로 호출
  - `/brain/consulting/scripts/dialogue_memory_cli.py recall ... --rerank`
```

현재 vector routing:

```text
ANN_THRESHOLD: 50,000
sqlite-vec available: false
changwon dialogue vectors: 128
changwon file vectors: 602
routing: brute
```

해석:

```text
- 현재 규모에서는 brute-force cosine도 충분하다.
- PG 전환의 ROI는 현시점 성능보다 운영 통합/동시성/웹DB 통합/미래 scale 대비 쪽이다.
- qmark placeholder 8,823개 때문에 `sqlite3` → `psycopg` 단순 치환은 거의 불가능하다.
```

---

## 3. 현재 Postgres 감사 결과

운영 컨테이너:

```text
container: consulting-web-pg-1
compose image: postgres:16-alpine
server_version: 16.14
version: PostgreSQL 16.14 on x86_64-pc-linux-musl
volume: consulting-web_pg-data:/var/lib/postgresql/data
shared_preload_libraries: empty
```

설치된 extension:

```text
plpgsql 1.0
```

available but not installed:

```text
btree_gin 1.3
pg_trgm   1.6
uuid-ossp 1.1
```

중요: 현재 컨테이너에서 `vector` extension은 available 목록에 없다.

로컬/레지스트리 이미지 상태:

```text
현재 운영 compose: postgres:16-alpine

로컬 보유:
  postgres:16-alpine
  postgres:16
  postgres:17
  pgvector/pgvector:pg16
  pgvector/pgvector:pg15
  timescale/timescaledb:latest-pg16

Docker Hub / manifest 확인됨:
  postgres:18
  postgres:18-alpine
  postgres:18.4
  postgres:18.4-alpine
  pgvector/pgvector:pg18

PostgreSQL 19 상태:
  postgres:19 안정 태그 없음
  postgres:19beta1 manifest 확인됨
  PostgreSQL 19 Beta 1 released: 2026-06-04
  PostgreSQL 19 GA 예상: 2026-09/10 전후
  pgvector/pgvector:pg19 태그 없음
```

해석:

```text
- 현재 운영 PG는 일반 postgres:16-alpine이라 pgvector가 없다.
- “18 이미지가 없다”가 아니라 “현재 운영 이미지/로컬 compose가 아직 18/pgvector가 아니다”가 정확하다.
- GraphRAG embedding을 PG로 옮기려면 pgvector/pgvector:pg16 또는 pgvector/pgvector:pg18 계열 이미지가 필요하다.
- PG19는 현재 beta라 운영 기준 후보가 아니고, pgvector pg19 이미지도 아직 확인되지 않았다.
- 단순 `CREATE EXTENSION vector`는 현재 이미지에서 실패할 가능성이 높다.
```

---

## 4. Postgres 16이 낮은가?

공식 지원표 기준:

```text
PostgreSQL 19: Beta 1 released 2026-06-04, GA expected around 2026-09/10, not production baseline yet
PostgreSQL 18: current minor 18.4, supported until 2030-11-14
PostgreSQL 17: current minor 17.10, supported until 2029-11-08
PostgreSQL 16: current minor 16.14, supported until 2028-11-09
```

현재 운영은 `16.14`이므로:

```text
- 보안/지원 관점: 낮아서 위험한 버전은 아님.
- minor 관점: 최신 minor라 양호.
- major 관점: 18이 최신 stable, 19는 beta 상태라 운영 기준은 아직 18.
```

PostgreSQL 19 메모:

```text
- PostgreSQL 19 Beta 1은 2026-06-04 공개됨.
- 공식 문서도 beta 버전을 production에서 쓰지 말라고 명시한다.
- PostgreSQL 19의 흥미로운 점은 SQL/PGQ property graph, parallel autovacuum, REPACK, ON CONFLICT DO SELECT, graph query 계열이다.
- consulting GraphRAG 장기 방향에는 매력적이지만, 현재는 실험/dev stack 대상이지 운영 전환 대상은 아니다.
```

PostgreSQL 18 주요 이점 중 이 시스템과 관련 있는 것:

```text
- AIO subsystem: 순차 scan, bitmap heap scan, vacuum 등 I/O 효율 개선 가능
- pg_upgrade가 optimizer statistics 유지
- skip scan: multicolumn B-tree index 활용 경우 증가
- uuidv7() 내장
- 기본 initdb data checksums 변경
```

하지만 현재 데이터 규모에서는:

```text
consulting-web product DB: 수백 row 규모
consulting brain DB: 100MB 미만, 수천 row 규모
```

따라서 지금 당장 16→18이 사용자 체감 성능을 크게 바꿀 가능성은 낮다.

판단:

```text
긴급 업그레이드: 불필요
단기 안전안: pgvector/pgvector:pg16 dev stack으로 GraphRAG mirror/recall parity 먼저 검증
장기 권장안(현재): 새 GraphRAG PG store는 Postgres 18 + pgvector/pgvector:pg18 기준으로 설계
차기 검토안: PostgreSQL 19 GA + pgvector pg19 이미지가 나온 뒤 GraphRAG dev stack에서 재평가
운영 전환 조건: dump/restore rehearsal, extension 검증, row/hash parity, recall eval green, rollback plan
```

---

## 5. SQLite 기능 → Postgres 매핑

| SQLite 현재 | Postgres 후보 | 주의점 |
|---|---|---|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `GENERATED BY DEFAULT AS IDENTITY` / `BIGSERIAL` | 기존 id 보존 필요하면 identity override |
| `TEXT` JSON | `jsonb` | 기존 스크립트가 문자열 JSON을 기대하면 adapter 필요 |
| `REAL` epoch ts | `double precision` 또는 `timestamptz` | 기존 정렬/비교 호환성 우선이면 double 유지 |
| `BLOB` float32 embedding | `vector(3072)` 또는 `bytea` | pgvector 검색을 쓰려면 vector 변환 필요 |
| FTS5 trigram `MATCH` | `pg_trgm` GIN/GiST + `similarity` / `%` | Korean 2자/3자 검색 품질 회귀 가능 |
| FTS5 `bm25()` | `ts_rank_cd`, `similarity`, custom rank | 점수 스케일 달라 RRF regression 필요 |
| SQLite triggers for FTS sync | generated column + GIN index or trigger | 단순 tsvector는 한국어에 약함 |
| `?` placeholder | `%s` / SQLAlchemy bind | 직접 SQL이 많아 adapter 없이 치환 위험 |
| `INSERT OR IGNORE` | `ON CONFLICT DO NOTHING` | unique constraint 재정의 필요 |
| `INSERT OR REPLACE` | `ON CONFLICT DO UPDATE` | replace semantics 다름 |
| `sqlite_master` introspection | `information_schema` / `pg_catalog` | migration scripts 전면 수정 필요 |
| `PRAGMA foreign_keys` | always-on FK | 테스트/마이그레이션 코드 수정 필요 |

---

## 6. 권장 마이그레이션 단계

### Phase A — read-only mirror / 성능 실험

목표: 운영 writer는 SQLite 유지, PG에 GraphRAG hot path만 복제해서 recall 품질/성능 비교.

대상 테이블:

```text
topics
dialogue_chunks
dialogue_edges
file_chunks
file_edges
claims
evidence_items
claim_evidence_links
source_locations
rag_chunks
```

필수 작업:

```text
1. pgvector 지원 이미지로 별도 dev DB 준비
2. `CREATE EXTENSION vector`, `CREATE EXTENSION pg_trgm`
3. `consulting_brain` schema 생성
4. SQLite → PG export/import script 작성
5. BLOB float32 → vector(3072) 변환
6. FTS5 lexical query를 pg_trgm/ts_rank 기반으로 대체
7. 동일 eval fixture로 SQLite recall vs PG recall 비교
```

통과 기준:

```text
- row count parity 100%
- embedding dimension parity 3072
- top-k overlap 기준선 설정
- context_precision / recall 회귀 없음
- p95 latency 개선 또는 최소 동등
```

### Phase B — adapter 도입

목표: 호출부가 SQLite/PG를 몰라도 되는 `BrainStore` 경계 만들기.

```text
CONSULTING_DB          = sqlite path fallback
CONSULTING_DATABASE_URL = postgres DSN option
CONSULTING_BRAIN_BACKEND = sqlite | postgres | dual
```

주의:

```text
- 현재 Python 코드 165개 파일이 sqlite에 걸려 있으므로 전면 추상화는 과함.
- 우선 dialogue_memory hot path만 adapter화한다.
- 기존 CLI contract는 유지한다: `dialogue_memory_cli.py recall/stats/ingest`.
```

### Phase C — dual-write

목표: 신규 web/telegram dialogue ingest를 SQLite와 PG에 동시에 쓰고 parity check.

```text
write SQLite → write PG → compare count/hash → log parity
```

실패 정책:

```text
- 초기에는 PG 실패해도 SQLite 성공이면 운영 계속
- parity 실패는 alert/report
- 충분히 안정화 후 PG primary, SQLite fallback으로 역전
```

### Phase D — cut-over

목표: API recall을 PG primary로 전환.

```text
read path: PG primary, SQLite fallback
write path: PG primary, SQLite archive or disabled
```

전환 전 조건:

```text
- 최소 1~2주 dual-write parity OK
- real-embedding GraphRAG eval green
- web chat browser QA green
- export/verifier gate 영향 없음
- backup/restore runbook 존재
```

---

## 7. 위험도

| 위험 | 심각도 | 이유 | 대응 |
|---|---:|---|---|
| FTS 품질 회귀 | 높음 | SQLite FTS5 trigram + bm25와 PG lexical이 다름 | eval fixture로 top-k/precision 비교 |
| Korean 2자 term recall 회귀 | 높음 | 현재 LIKE fallback이 `정원`, `승진` 같은 2자어를 살림 | pg_trgm + fallback LIKE 유지 |
| embedding 변환 오류 | 높음 | BLOB little-endian float32 → vector(3072) | checksum/dim/assertion script |
| writer 누락 | 높음 | 165개 Python 파일이 sqlite 직접 접근 | hot path부터 adapter화 |
| id 보존 실패 | 중상 | edges가 chunk_id/claim_id 참조 | identity override/import order |
| `INSERT OR IGNORE` 의미 차이 | 중 | idempotency 핵심 | unique constraints + ON CONFLICT 명시 |
| 운영 컨테이너 volume migration | 중 | major upgrade/dump restore 필요 | backup + dry-run compose stack |
| pgvector 이미지 변경 | 중 | 현재 postgres:16-alpine에는 vector 없음 | dev stack에서 image 교체 검증 |

---

## 8. 즉시 추천안

현재 바로 하면 좋은 것:

```text
1. Postgres major upgrade는 보류
2. pgvector 도입용 dev compose 프로필 추가 검토
3. GraphRAG hot path mirror 스크립트부터 작성
4. SQLite vs PG recall parity eval을 먼저 만든다
5. 현 문서와 검토 문서를 pre-commit hook으로 갱신 누락 방지
```

현재 하지 말아야 할 것:

```text
1. 운영 DB를 바로 postgres:18로 교체
2. consulting.db 전체 212개 테이블을 한 번에 PG로 이식
3. Python 코드 전체의 sqlite3를 psycopg로 기계 치환
4. FTS5 MATCH/bm25를 검증 없이 tsvector로 대체
5. pgvector 없는 현재 postgres:16-alpine에서 vector 전환을 시도
```

---

## 9. 최종 판단

```text
SQLite → Postgres 전환: 가능
전면 즉시 전환: 비추천
가장 안전한 첫 단계: GraphRAG hot path read-only PG mirror + eval parity
Postgres 16 상태: 낮아서 위험한 상태 아님. 16.14 최신 minor + 2028년까지 지원.
진짜 선행조건: pgvector/pg_trgm 사용 가능한 이미지와 recall regression harness.
```

---

## 10. 2026-07-08 운영 스키마 후속 — judgment guard ledger

컨설팅 답변의 과잉단정/자료수집 실패/적용성 오류를 운영에서 추적하기 위해
`judgment_guard_runs` ledger를 추가했다. 적용 migration은
`0021_judgment_guard_runs.sql`이며, 운영 DB `consulting-web-pg-1`의
`_migrations`에서 `2026-07-08 14:41:14+00` 적용을 확인했다.

실측 반영 상태:

```text
table: public.judgment_guard_runs exists
api: consulting-web-api-1 healthy
web: http://127.0.0.1:8088 root_http=200
gateway: http://127.0.0.1:8642/v1/health status=ok
```

역할:

```text
- Source intake 실패, 최신 권위자료 요구, 적용성 맵, 반대신문, 사용자 재지적 패턴을 구조화 저장
- Verifier Gate가 일반 채팅은 경고, 보고/최종산출은 blocker 차단으로 해석
- GraphRAG prompt context에 런타임 현재시각 기반 판단 안전 계약을 주입
```

실질 ROI:

```text
단기 ROI:
  낮음 — 현재 규모에서는 SQLite brute-force도 충분.

중기 ROI:
  중간 — web/API와 brain DB 통합, 동시성, 운영 관측성, backup/restore 일원화.

장기 ROI:
  높음 — topic 수·file_chunks 수가 커지고 ANN/pgvector 검색이 필요해질 때.
```

---

## 11. 2026-07-10 artifact-version verification ledger

최종 PDF/DOCX 승인을 source-message telemetry가 아니라 실제 artifact bytes에 귀속하기 위해
`artifact_version_verifications` append-only run ledger를 추가했다. 적용 migration은
`0027_artifact_version_verification_ledger.sql`이다.

키와 제약:

```text
identity: workspace_id + project_id + artifact_id + artifact_version_id
content: SHA-256(exact UTF-8 content), lowercase hex 64 chars
payload: exactness + verdicts + gate + verifier + evidence_count
provenance: source_thread_id/source_message_id nullable
status: exact PASS만 passed, PASS_WITH_WARNINGS/BLOCKED는 blocked
ordering: sequence_no bigint identity (monotonic)
indexes: scope, artifact+version+sequence, version+content_hash+sequence
```

안전 판정:

```text
- artifact_version_id별 sequence_no 최신 run을 먼저 읽은 뒤 identity/hash를 비교한다.
- 최신 run이 tenant/hash mismatch, soft-delete, malformed, status↔gate 모순이면 과거 PASS를 탐색하지 않고 차단한다.
- DB CHECK도 passed=clean PASS, blocked=BLOCKED/PASS_WITH_WARNINGS 일관성을 강제한다.
- PASS + blockers/warnings 0건만 내보낸다.
- source message 삭제나 부재는 승인 의미를 바꾸지 않는다.
- 사용자·workspace·artifact 물리 삭제 cascade 외에는 application write path가 INSERT만 수행한다.
```

Pre-deploy 실측:

```text
isolated PostgreSQL migrations 0000..0027: PASS
real ledger insert/read tenant/hash/malformed/status regression: PASS
production table/readback: pending deploy
```
