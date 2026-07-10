# consulting / consulting-web 전체 레이어 맵

> Last measured: 2026-07-11
> Scope: `/home/jigoo/.hermes/workspace/consulting` shared brain + `/home/jigoo/.hermes/workspace/consulting-web` web/API/product layer.
> 원칙: 이 문서는 기억이 아니라 코드/DB/컨테이너 실측값으로 갱신한다.

## 0. 결론

`consulting`은 공유 컨설팅 두뇌/근거 생산 코어이고, `consulting-web`은 그 두뇌를 웹 제품화한 UI/API/운영 레이어다. 2026-07-09 기준 활성 GraphRAG hot path는 PostgreSQL 18/pgvector sidecar(`brain_raw.*`)이고, `consulting.db` SQLite는 rollback/fallback 및 quarantine 후보로 격하됐다. `consulting-web-api` 컨테이너는 `/brain/consulting`으로 `consulting` repo를 bind mount하되, recall/write backend는 `CONSULTING_BRAIN_BACKEND=pg`, `CONSULTING_BRAIN_WRITE_BACKEND=pg`로 고정한다.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                         주인님 / 컨설턴트 / 내부 사용자                       │
└──────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ consulting-web: 웹 제품 레이어                                                │
│                                                                              │
│  React 19 + Vite 8 + TanStack Router/Query + Tailwind v4 + Radix + PDF UI      │
│  - 채팅 UI / 프로젝트·채널·토픽·스레드 / 근거 패널 / 파일·아티팩트 / 모델선택  │
│  - 접속: http://127.0.0.1:8088                                                │
└──────────────────────────────────────────────────────────────────────────────┘
                                      │ HTTP/SSE
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ consulting-web API: NestJS 11 + Drizzle + Postgres + Redis                    │
│                                                                              │
│  1) Auth / Workspace / Scope tree                                             │
│  2) Chat stream proxy → Hermes Runs                                           │
│  3) GraphRAG context builder → consulting brain recall                        │
│  4) Evidence-to-Decision / Exactness / Verifier Gate                          │
│  5) Outbox → completed web chat turn ingest                                   │
└──────────────────────────────────────────────────────────────────────────────┘
        │                         │                           │
        │ Drizzle SQL             │ Hermes API                │ Python subprocess
        ▼                         ▼                           ▼
┌──────────────────────┐   ┌──────────────────────────┐   ┌────────────────────────────┐
│ Product Postgres 16   │   │ Hermes Gateway            │   │ consulting shared brain     │
│ consulting-web-pg-1   │   │ 127.0.0.1:8642             │   │ PG18/pgvector brain_raw     │
│ scopes/chat/outbox    │   │ via socat proxy :38642     │   │ SQLite = fallback archive   │
└──────────────────────┘   └──────────────────────────┘   └────────────────────────────┘
        │                                                    ▲
        │ outbox event: ConsultingWebTurnCompleted           │
        └────────────────────────────────────────────────────┘
             completed web Q/A is embedded into PG brain_raw.dialogue_chunks
```

핵심 해석:

```text
consulting-web ≠ 새 두뇌
consulting-web = 기존 consulting 두뇌를 웹/API/검증/협업 제품으로 감싼 레이어
```

---

## 1. repo 규모 / 현재 상태

### 1.1 `consulting` repo — 공유 컨설팅 두뇌

```text
경로: /home/jigoo/.hermes/workspace/consulting
브랜치: master
상태: clean
최근 커밋:
  dfbfccd tune(dialogue-memory): lower raw recall weight for precision
  db6e425 feat(dialogue-memory): explicit fact-code rank guard + exact telegram binding
  2c032a9 docs: align consulting brain GraphRAG terminology
```

실측 규모:

```text
tracked files: 1,297
tracked bytes: 48,345,341
text lines:    346,880

주요 확장자:
  .md    584 files / 99,795 lines
  .csv   254 files / 20,207 lines
  .json  226 files / 118,445 lines
  .py    162 files / 38,875 lines
  .html   20 files / 20,808 lines
  .sql     9 files / 3,156 lines
```

역할:

```text
- 컨설팅 프로젝트별 원자료 / 산출물 / QA / 보고서 / 시스템 OS
- PostgreSQL 18/pgvector `brain_raw.*` active dialogue/file GraphRAG
- SQLite `consulting.db` fallback/quarantine candidate
- dialogue_memory backend adapter (`sqlite|dual|pg`)
- Gemini embedding wrapper
- pgvector + pg_trgm/lexical ranking, with SQLite FTS5 retained for rollback
- claim/evidence graph edges
- 평가/하드닝 스크립트
```

### 1.2 `consulting-web` repo — 웹 제품/운영 레이어

```text
경로: /home/jigoo/.hermes/workspace/consulting-web
브랜치: master
상태: dirty 파일 존재 가능성 있음. 저장/커밋 전 `git status --short` 재확인 필요.
최근 push된 커밋:
  3cf95fc chore(graphrag): support real-embedding eval tuning
  5e1233f feat(consulting): wire NLI verifier gate into artifact export + quality eval
  366ab7e fix(consulting): tolerate Hermes model listing failures
  cbbdf36 feat(consulting): add topic provisioning and verification gates
  b21e31b fix(web): stabilize chat tail and build chunks
```

실측 규모:

```text
tracked files: 523
tracked bytes: 5,427,618
text lines:    83,771

주요 확장자:
  .ts    230 files / 27,963 lines
  .tsx    56 files / 6,656 lines
  .json   38 files / 16,034 lines
  .md     29 files / 10,451 lines
  .css    23 files / 6,978 lines
  .sql    20 files / 1,056 lines
  .py      9 files / 1,864 lines
```

---

## 2. 운영 컨테이너 / 배포 레이어

현재 확인된 컨테이너 상태:

```text
consulting-web-web-1           Up        127.0.0.1:8088->80/tcp
consulting-web-api-1           Up        3000/tcp, healthy
consulting-web-hermes-proxy-1  Up        healthy
consulting-web-cloudflared-1   Up
consulting-web-redis-1         Up        6379/tcp, healthy
consulting-web-pg-1            Up        5432/tcp, healthy
```

compose 구조:

```text
docker-compose.prod.yml

┌──────────────────────────────────────────────────────────────┐
│ web                                                          │
│ - build: apps/web/Dockerfile                                 │
│ - port: 127.0.0.1:8088:80                                    │
│ - depends_on api healthy                                     │
└──────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│ api                                                          │
│ - build: apps/api/Dockerfile                                 │
│ - PORT=3000                                                  │
│ - DATABASE_URL=postgres://consulting:***@pg:5432/consulting  │
│ - REDIS_URL=redis://redis:6379                               │
│ - HERMES_API_BASE_URL=http://host.docker.internal:38642      │
│ - CONSULTING_BRAIN_ROOT=/brain/consulting                    │
│ - HERMES_ENV_FILE=/brain/hermes.env                          │
│ - CONSULTING_PYTHON=python3                                  │
│ - CONSULTING_WEB_INGEST_SCRIPT=/app/scripts/ingest_web...py  │
│                                                              │
│ volumes:                                                     │
│ - /home/jigoo/.hermes/workspace/consulting:/brain/consulting │
│ - /home/jigoo/.hermes/.env:/brain/hermes.env:ro              │
│ - /home/jigoo/.hermes/config.yaml:/brain/hermes.config.yaml  │
└──────────────────────────────────────────────────────────────┘
        │                   │                      │
        ▼                   ▼                      ▼
┌──────────────┐   ┌─────────────────┐   ┌──────────────────────┐
│ pg           │   │ redis           │   │ hermes-proxy          │
│ Postgres 16  │   │ Redis 7 AOF     │   │ socat host:38642       │
│ healthy      │   │ healthy         │   │ → 127.0.0.1:8642       │
└──────────────┘   └─────────────────┘   └──────────────────────┘
```

중요 포인트:

```text
- `consulting` repo는 `/brain/consulting`으로 bind mount된다.
- 따라서 shared brain library/CLI 변경은 대체로 API 컨테이너 재빌드 없이 반영된다.
- 단, `apps/api/scripts/ingest_web_dialogue.py`는 API 이미지 내부 `/app/scripts`에 복사되므로 이 파일을 바꾸면 API 이미지 재빌드/재생성이 필요하다.
- 완료선언 전에는 컨테이너 내부 env/import/CLI 실행과 web-turn ingest smoke로 확인한다.
- P1 (2026-07-10): web-turn ingest는 `S.topic_id()` 대신 `S.ensure_topic()`을 호출한다.
  신규 웹 프로젝트의 첫 턴이 shared brain에 topic 행(brain_raw.topics)을 idempotent하게
  자동 생성한다 — title은 scopePath 첫 세그먼트(프로젝트 표시명), status='active'.
  기존 topic(창원 등)은 절대 갱신하지 않는다(creation-only). 이전 동작은
  `unknown topic` SystemExit → 비창원 프로젝트 웹 턴이 뇌에 전혀 적재되지 않는 결함이었다.
```

---

## 3. 데이터 저장소 레이어

### 3.1 `consulting` shared brain — PG18 active, SQLite fallback

DB:

```text
active PG DSN: postgres://consulting:***@pg18-rehearsal:5432/consulting
active schema: brain_raw
fallback file: /home/jigoo/.hermes/workspace/consulting/db/consulting.db
fallback size: 99,954,688 bytes ≈ 95.3 MiB
```

현재 주요 테이블 카운트:

```text
PG18 brain_raw:
  topics:             2
  dialogue_chunks:  170 / embedded 170
  dialogue_edges:   483
  file_chunks:    1,526 / embedded 1,526
  file_edges:     1,949

SQLite fallback consulting.db:
  topics:                            2
  dialogue_chunks:                 160 / embedded 160
  dialogue_edges:                  444
  file_chunks:                   1,526 / embedded 1,526
  file_edges:                    1,949
  dialogue_topic_sessions:          18
  dialogue_topic_telegram:           1
  dialogue_telegram_thread_bindings: 6
```

topic별(PG18 brain_raw active):

```text
┌──────────────────────────────────┬──────────┬──────────────┬───────┬────────────┬──────────────┬────────────┐
│ topic                            │ dialogue │ dialogue_emb │ files │ files_emb  │ dlg_edges    │ file_edges │
├──────────────────────────────────┼──────────┼──────────────┼───────┼────────────┼──────────────┼────────────┤
│ road-traffic-conditions-outlook  │ 0        │ 0            │ 696   │ 696        │ 0            │ 1,235      │
│ changwon-org-mgmt-diagnosis      │ 170      │ 170          │ 830   │ 830        │ 483          │ 714        │
└──────────────────────────────────┴──────────┴──────────────┴───────┴────────────┴──────────────┴────────────┘
```

file utility tier:

```text
raw_document       1,132
final_usable         109
qualified_usable      57
```

해석:

```text
- PG18이 dialogue/file GraphRAG의 활성 정본이다.
- SQLite는 최신 dialogue write를 더 이상 대표하지 않으며 rollback/fallback snapshot이다.
- raw 원문이 많고 검증완료/조건부 자료는 소수이므로 recall에서 raw를 완전 제거하지 않고 낮은 가중치로 살려두는 설계는 유지한다.
```

2026-07-09 PG recall parity 재측정:

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
판정: PG hot path가 baseline parity를 회복했다. 다만 P6 aspirational gate(context_precision >= 0.45)는 별도 개선 대상이다.
```

2026-07-09 P6 product baseline 고정:

```text
command: pnpm --filter @consulting/api run test:p6-product-baseline
config: rw020-prune4-top1
repeat: 3 / required_repeats: 3
fake_embeddings: false
warning_count: 0
context_precision: 0.8310
context_recall: 0.9111
hit_rate: 0.9111
worst_p95_latency_s: 4.1768
trace_probe: trace_rows=1, retrieval_rows=1, eval_rows=1, leakage_count=0
decision: allowed=true

판정: P6 product path의 현재 baseline은 통과 상태다. ColBERT/SPLADE/RAPTOR는
이 baseline보다 좋아지는지 비교하는 별도 read-only lab으로만 재개한다.
```

### 3.2 `consulting-web` Postgres

DB 컨테이너:

```text
consulting-web-pg-1
Postgres 16
database: consulting
user: consulting
```

주요 row count:

```text
workspaces                    13
projects                      11
channels                      36
topics                        56
threads                       56
chat_messages                401
context_edges                167
context_tags                  12
scope_tags                    37
consulting_topic_links         6
claim_verification_verdicts    0
exactness_runs                 0
evidence_items                 2
artifact_versions              4
```

scope 상태:

```text
projects:
  active     10
  archived    1

channels:
  active       29
  archived      6
  deleted_soft  1

topics:
  active       46
  archived      9
  deleted_soft  1

threads:
  active       46
  archived      9
  deleted_soft  1
```

chat 상태:

```text
chat_messages:
  user       159
  assistant 242
  total     401

assistant finish_state:
  complete 236
  error      6
```

outbox 상태:

```text
outbox_events:
  published 152

by event_type:
  WorkspaceCreated             13
  ChannelCreated               36
  TopicCreated                 51
  ThreadCreated                51
  ConsultingWebTurnCompleted    1
```

---

## 4. 핵심 도메인 구조: scope tree + graph

`consulting-web`의 기본 구조:

```text
workspace
  └─ project
      └─ channel
          └─ topic
              └─ thread
                  └─ chat_messages
```

ASCII:

```text
┌──────────────┐
│ Workspace    │  tenant/confidentiality boundary
└──────┬───────┘
       │ 1:N
       ▼
┌──────────────┐
│ Project      │  예: 창원시 컨설팅, TEST, qa-...
└──────┬───────┘
       │ 1:N
       ▼
┌──────────────┐
│ Channel      │  예: 자료수집, 분석, 보고서, 검증 등
└──────┬───────┘
       │ 1:N
       ▼
┌──────────────┐
│ Topic        │  세부 논점/텔레그램 포럼 토픽 대응
└──────┬───────┘
       │ 1:N
       ▼
┌──────────────┐
│ Thread       │  실제 채팅방
└──────┬───────┘
       │ 1:N
       ▼
┌──────────────┐
│ ChatMessage  │  user/assistant + runId + finish_state
└──────────────┘
```

그 위에 `context_edges` 그래프가 얹힌다.

```text
                context_edges
┌──────────┐   related_to / references / shares_memory_with / ...   ┌──────────┐
│ Scope A  │◄──────────────────────────────────────────────────────►│ Scope B  │
└──────────┘                                                         └──────────┘
     │                                                                     │
     └─ workspace boundary enforced                                        └─ same/cross-project weight
```

현재 context edge 분포:

```text
parent_of  / system      138
related_to / classifier   29
```

classifier confidence:

```text
0.5000  12 edges
0.6667  14 edges
1.0000   3 edges
```

scope tags:

```text
project   2
channel  10
topic    25
```

tag 값:

```text
client:changwon                    17
domain:organization-diagnosis       9
phase:analysis                      3
phase:data-collection               3
phase:report                        3
source:telegram                     2
```

context graph 가중치:

```text
same_project   weight = 1.0
cross_project  weight = 0.6
classifier edge 생성 기준 = shared tags >= 2
traverse limit = 12
```

2026-07-08 프로젝트 온보딩/설정 레이어 변경:

```text
- 프로젝트 생성 wizard는 기본 컨설팅 템플릿 자동 적용을 UI에서 opt-out 가능하게 한다.
- 프로젝트 자체 profile은 `scope_profiles(scope_type='project')`에 저장하고, 생성 후 프로젝트 설정에서 재수정한다.
- 프로젝트↔프로젝트 수동 연결은 `context_edges`에 저장하되 같은 pair의 `related_to`/`shares_memory_with`가 동시에 live로 남지 않도록 서버에서 무방향 pair 단위로 정규화한다.
- 프로젝트 설정의 자료실 진입은 전체 자료실이 아니라 해당 project filter를 초기값으로 넘긴다.
```

---

## 5. `consulting_topic_links`: web scope ↔ shared brain 연결

`consulting-web`이 `consulting` SQLite topic을 찾는 테이블이다.

```text
consulting_topic_links
  id
  workspace_id
  project_id
  channel_id?
  web_topic_id?
  thread_id?
  link_level          project | channel | topic | thread
  consulting_topic_slug
  consulting_topic_id
  scope_path
  status              active | archived
  origin
  created_by_user_id?
  archived_at?
```

현재 링크 분포:

```text
link_level = project only
status = active

changwon-org-mgmt-diagnosis  2
qa-2                         1
qa-gate-p-1783473742116      1
qa-proj-0708-100517          1
test                         1

total = 6
```

링크 해석 우선순위:

```text
thread > topic > channel > project
```

현재는 전부 project-level이므로 대체로:

```text
web project 전체
  └─ shared consulting brain topic slug
```

형태로 붙어 있다.

---

## 6. GraphRAG 두뇌 레이어 상세

### 6.1 저장 구조

`consulting` SQLite 내부 GraphRAG는 대화와 문서를 분리한다.

```text
consulting.db
│
├─ topics
│
├─ dialogue_chunks
│   ├─ raw_text
│   ├─ context_text
│   ├─ entities JSON
│   ├─ embedding BLOB: Gemini 3072d
│   └─ source/session/ts
│
├─ dialogue_chunks_fts
│   └─ FTS5 trigram lexical index
│
├─ dialogue_edges
│   └─ chunk → claim/evidence/entity
│
├─ file_chunks
│   ├─ doc_title/source_path/chunk_index
│   ├─ text/context_text
│   ├─ utility_tier
│   ├─ embedding BLOB
│   └─ Gemini file vector space
│
├─ file_chunks_fts
│   └─ FTS5 trigram lexical index
│
└─ file_edges
    └─ chunk → claim/evidence/entity
```

대화와 문서 embedding model:

```text
dialogue embedding:
  model: gemini-embedding-001
  dim:   3072
  task:  RETRIEVAL_DOCUMENT / RETRIEVAL_QUERY

file/document embedding:
  model: gemini-embedding-2
  dim:   3072
  separate vector space

중요:
  dialogue vector와 file vector는 cosine 직접 비교하지 않음.
  각각 따로 검색한 뒤 RRF로 federated fusion.
```

embedding 입력 제한/분할:

```text
CONSULTING_MAX_EMBED_CHARS default = 2600
Gemini hard input limit 고려해서 chunk tail silent truncation 방지
```

### 6.2 retrieval 신호

검색 신호는 기본 3개 + 파일 3개 + 선택적 ToG-2다.

```text
대화 공간:
  1. semantic  = Gemini query embedding vs dialogue_chunks.embedding
  2. lexical   = FTS5 BM25/trigram + LIKE fallback
  3. graph     = dialogue_edges → claim/evidence/entity

문서 공간:
  4. file_semantic = Gemini file query embedding vs file_chunks.embedding
  5. file_lexical  = FTS5 BM25/trigram + LIKE fallback
  6. file_graph    = file_edges → claim/evidence/entity

고급:
  7. tog2_deep = advanced_graphrag_layers.search_tog2_deep, depth=2
```

ASCII:

```text
                         query
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
       semantic vec     lexical       graph walk
       Gemini 3072d     FTS5/BM25     edges→claims
              │            │            │
              └──────┬─────┴─────┬──────┘
                     ▼           ▼
              dialogue RRF     file RRF
                     │           │
                     └─────┬─────┘
                           ▼
                 cross-space rank RRF
                           │
                           ▼
                  trust-tier sort/group
                           │
                           ▼
                optional cross-encoder rerank
                           │
                           ▼
                         top-K
```

### 6.3 RRF / rank fusion

상수:

```text
RRF_K = 60
```

rank contribution:

```text
rrf = 1 / (60 + rank + 1)
```

예시:

```text
rank 1  ≈ 1 / 61 = 0.01639
rank 2  ≈ 1 / 62 = 0.01613
rank 10 ≈ 1 / 70 = 0.01429
```

의미:

```text
- cosine 점수와 BM25 점수를 직접 더하지 않음.
- 각 신호에서 몇 등인지 RRF로 합침.
- 스케일이 다른 semantic/lexical/graph를 안정적으로 섞기 위함.
```

### 6.4 trust tier / raw weight

운영 기본값:

```text
final_usable      weight = 1.00
qualified_usable  weight = 0.75
raw_document      weight = 0.20
unknown/raw       weight = 0.20
dialogue          trust group = 0, raw와 같은 unverified bucket
```

최근 튜닝:

```text
raw_weight: 0.30 → 0.20
```

실측 결과:

```text
real Gemini query embedding
fake_embeddings = false

baseline raw=0.30:
  context_precision = 0.2704
  recall/hit        = 0.8667
  p95 latency       = 5.564s

final raw=0.20:
  context_precision = 0.2881
  recall/hit        = 0.8667
  p95 latency       = 4.124s
```

해석:

```text
raw를 완전 배제하지 않고도 precision 개선.
raw=0.0도 수치는 같았지만 원문 완전 배제라 운영상 과격.
따라서 raw=0.20 채택.
```

### 6.5 rerank

`search.py` 기본은 env 기준으로 rerank OFF다.

```text
CONSULTING_RERANK default = 0
```

하지만 `consulting-web` bridge는 `--rerank`를 붙여서 호출한다.

```text
DIALOGUE_MEMORY_CLI recall ... --format json --rerank
```

rerank path:

```text
1. cross-encoder reranker
2. 실패 시 hermes -z LLM rerank fallback
3. 그래도 안 되면 RRF order
```

운영 기본 prune:

```text
CONSULTING_RERANK_PRUNE default in search.py = 16
```

eval script 기본 prune:

```text
graphrag_eval_gate.py:
  --rerank-prune 없으면 CONSULTING_RERANK_PRUNE=4로 setdefault
```

구분:

```text
운영 API recall:
  topK from builder = 8
  injected final hits = 5
  rerank prune = env 없으면 16

평가 게이트:
  package script test:graphrag = --rerank --top-k 2
  eval script default prune = 4
  fake embeddings default = true
  --no-fake-embeddings 주면 real Gemini query embedding
```

---

## 7. web 채팅 → GraphRAG → Hermes 답변 흐름

### 7.1 요청 흐름

```text
사용자 입력
  │
  ▼
POST /chat/stream
  │
  ├─ AccessTokenGuard
  ├─ requireThreadRead(userId, threadId)
  │   └─ thread → topic → channel → project
  │
  ├─ saveUserMessage()
  ├─ bindAttachmentsToMessage()
  │
  ├─ ConsultingMemoryContextBuilder.build(threadId, query)
  │   ├─ ConsultingTopicResolver.resolveThreadFanout()
  │   ├─ context_edges fanout
  │   ├─ bridge.recallMany(scopes, query, topK=8)
  │   ├─ diffusionWeightedScopes()
  │   ├─ EvidenceSufficiencyEvaluator.evaluate()
  │   ├─ Evidence-to-Decision lines
  │   └─ render GraphRAG context markdown
  │
  ├─ HermesRunsClient.startRun()
  │   ├─ session_id = stableSessionId(project, workspaceId, projectId)
  │   ├─ input = user message
  │   ├─ instructions = response format + GraphRAG memoryContext
  │   └─ POST /v1/runs
  │
  ├─ read /v1/runs/:runId/events
  │   ├─ message.delta → SSE delta
  │   ├─ tool.started/completed → SSE tool
  │   ├─ reasoning.available → SSE reasoning
  │   ├─ approval.request → SSE approval
  │   └─ run.completed → SSE done
  │
  └─ finally persist()
      ├─ saveAssistantMessage()
      ├─ saveRunEvidence(toolUses)
      ├─ EvidenceDecisionStore.recordCompletedAnswer()
      ├─ ConsultingWebIngestService.ingestCompletedTurn()
      └─ NotificationStore.notifyWorkspace()
```

ASCII:

```text
┌──────────────┐
│ Web Chat UI  │
└──────┬───────┘
       │ POST /chat/stream
       ▼
┌────────────────────────────┐
│ ChatStreamController        │
│ - save user msg             │
│ - build GraphRAG context    │
│ - proxy Hermes SSE          │
│ - persist assistant         │
└──────┬───────────────┬─────┘
       │               │
       │               ▼
       │      ┌────────────────────────┐
       │      │ ConsultingMemoryContext │
       │      │ Builder                 │
       │      └─────────┬──────────────┘
       │                ▼
       │      ┌────────────────────────┐
       │      │ consulting brain recall │
       │      │ Python CLI + SQLite     │
       │      └─────────┬──────────────┘
       │                │ memory context markdown
       ▼                ▼
┌─────────────────────────────────────┐
│ HermesRunsClient                     │
│ POST /v1/runs                        │
│ instructions = format + GraphRAG      │
│ session_id = project-scoped hash      │
└──────┬──────────────────────────────┘
       │ SSE
       ▼
┌──────────────┐
│ Web Browser  │
└──────────────┘
```

### 7.2 project-scoped Hermes memory

Hermes run session은 thread가 아니라 project 단위로 묶인다.

```text
session_id = stableSessionId('project', workspaceId, projectId)
```

의도:

```text
- 화면 transcript는 thread별.
- Hermes memory는 같은 project 안 채널/토픽 사이에서 공유.
- workspace/project 밖으로는 격리.
```

---

## 8. GraphRAG context builder 세부 가중치

### 8.1 기본 fanout

```text
현재 scope:
  relation = current
  weight   = 1.0

context graph related scope:
  same_project  weight = 1.0
  cross_project weight = 0.6
```

### 8.2 diffusionWeightedScopes

```text
diffuseGraph:
  mode = ppr
  iterations = 6

scope weight update:
  new_weight = scope.weight * (1 + diffusionScore) * dampening

dampening:
  cross_project = 0.85
  same/current  = 1.0
```

따라서 cross_project는 두 번 감쇠된다.

```text
context graph traverse: 0.6
diffusion dampening:    0.85

대략 기본 cross-project effective 시작값:
  0.6 * 0.85 = 0.51
  + PPR diffusionScore 보정
```

### 8.3 hit diffusion ranking

최종 hit 정렬 점수:

```text
base = rerankScore ?? fusedScore ?? score ?? 0

diffusionHitScore =
  base
  + scopeScore * 0.25
  + sameScopeBoost
  - crossPenalty
```

값:

```text
sameScopeBoost:
  current/same_project = +0.04

crossPenalty:
  cross_project = -0.03
```

즉 같은 프로젝트 hit는 살짝 밀어주고, 다른 프로젝트 hit는 라벨+감점한다.

### 8.4 최종 주입량

```text
bridge.recallMany topK = 8
builder final hits = slice(0, 5)
```

즉 Hermes prompt에 들어가는 실제 검색 hit는 최대 5개다.

---

## 9. Evidence Sufficiency / CRAG 판단

`EvidenceSufficiencyEvaluator`는 GraphRAG hit가 충분한지 판단한다.

```text
상태:
  sufficient
  ambiguous
  insufficient

액션:
  answer_with_citations
  answer_with_scope_label_or_ask
  refuse_or_request_evidence
```

판단 흐름:

```text
if hits.length == 0:
  insufficient / no_retrieved_context

query terms 추출:
  stop terms 제거
  suffix 제거
  최대 8개

if allMatches < min(2, queryTerms.length or 2):
  insufficient / low_overlap

if onlyCrossProject OR currentMatches=0 and allMatches>0:
  ambiguous / cross_project_only

if linkedClaims > 0 and strongSignals > 0:
  sufficient

else:
  ambiguous
```

signal strength:

```text
각 hit의 signal_breakdown에서:
  rank <= 3  → +2
  rank > 3   → +1
  rrf > 0    → +1
```

ASCII:

```text
GraphRAG hits
   │
   ├─ no hits? ───────────────► insufficient
   │
   ├─ query term overlap < 2? ─► insufficient
   │
   ├─ cross-project only? ─────► ambiguous
   │
   ├─ linked claim + signal? ──► sufficient
   │
   └─ otherwise ──────────────► ambiguous
```

---

## 10. Evidence-to-Decision 레이어

이 레이어는 검색된 근거 → claim 판단 → 검토 큐/점수카드를 만든다.

### 10.1 claim/evidence lattice

```text
ClaimInput:
  id
  text
  decisionImpact

EvidenceInput:
  id
  text
  qualityScore
  linkedClaimIds

ClaimVerdict:
  supports
  refutes
  mixed
  not_enough_info
```

로컬 NLI/heuristic 기준:

```text
supportScore >= 0.55                                  → supports
refuteScore >= 0.55 and refute >= support - 0.05       → refutes
support >= 0.55 and refute >= 0.55                    → mixed
else                                                  → not_enough_info
```

contradiction pairs:

```text
증가 ↔ 감소
늘 ↔ 줄
상승 ↔ 하락
확대 ↔ 축소
필요 ↔ 불필요
가능 ↔ 불가능
유지 ↔ 폐지
찬성 ↔ 반대
supports ↔ refutes
increase ↔ decrease
higher ↔ lower
yes ↔ no
```

### 10.2 decision scorecard

post-answer verification에서 대안은 2개다.

```text
answer_as_written       = 현재 답변 유지
collect_more_evidence   = 근거 보강 후 재작성
```

기준/가중치:

```text
support             weight = 0.65
contradiction_risk  weight = 0.35, lower_is_better
```

adjusted score:

```text
adjustedScore = directionalScore * normalizedWeight * (1 - uncertainty * 0.35)
```

requiredAction:

```text
if evidenceCoverage < 0.8 OR uncertainty > 0.45:
  collect_more_evidence
else:
  recommend
```

### 10.3 review queue priority

```text
priorityScore =
  decisionImpact * uncertainty * evidenceGap * deadlineWeight
```

deadlineWeight:

```text
no due date       = 1.00
due <= 24h        = 1.25
due <= 6h         = 1.50
overdue           = 1.80
```

### 10.4 W2-1 retrieval relevance feedback loop

`retrieval_hits`와 `evidence_items`는 다른 원장이므로 UI에서도 섞지 않는다. 근거 패널의
`근거검증` 탭이 최신 thread-scoped retrieval hit를 별도 조회하고, 사람이 한 번의 클릭으로
정탐/실패 사유를 기록한다.

```text
GET  /chat/threads/:threadId/retrieval-hits
POST /chat/threads/:threadId/retrieval-hits/:hitId/feedback
  → judged_relevant=true,  failure_type=NULL
  → judged_relevant=false, failure_type=<roadmap taxonomy>
```

불변식:

- API access check와 DB `workspace_id + thread_id + hit_id` 조건을 이중 적용한다.
- 부정 라벨은 `failure_type` 필수, 긍정 라벨은 `failure_type`을 반드시 NULL로 되돌린다.
- 이 라벨은 검색 정밀도 학습/eval 데이터이며 기존 GraphRAG recall 순위에는 즉시 개입하지 않는다.
- 라벨 50건 전에는 RRF/reranker weight를 변경하지 않는다.

---

## 11. Exactness Gate

정확한 수치/계산/법령/DB 관련 질의는 LLM 직감으로 답하지 않게 막는 레이어다.

trigger regex에 포함된 신호:

```text
계산, 산정, 비율, 증감률, 총액, 합계, 평균, 중위값, 가중치,
인건비, 승진, 정원, 기간, 근속,
row count, 카운트, 검산, DB, 테이블, 법령, 조항, 페이지, 원문
```

지원 check 종류:

```text
sum_equals_total
percentage_change
ratio_percent
```

상태:

```text
skipped
passed
blocked
```

중요 규칙:

```text
required = checks.length > 0 OR trigger regex match

if required and checks.length == 0:
  blocked
  summary = exactness_required_but_no_checks_supplied
```

즉 “가중치/row count/DB/법령” 같은 말이 있으면, 자동 계산 check가 없더라도 단정 금지 쪽으로 가는 구조다.

계산은 JS number가 아니라 bigint 기반 decimal 구현이다.

```text
parseDecimal:
  "2,668" → comma 제거
  bigint int + scale

percentage_change:
  (new-old)/old*100
  output scale 6 → trim max 4

ratio_percent:
  numerator/denominator*100
```

---

## 12. Verifier Gate 정책

`VerifierGatePolicyService`는 mode별로 block/warning을 다르게 적용한다.

mode:

```text
general_chat
analysis_draft
report_decision
final_export
```

decision:

```text
PASS
PASS_WITH_WARNINGS
BLOCKED
```

high impact threshold:

```text
HIGH_IMPACT_THRESHOLD = 0.8
```

block 구조:

```text
structuralBlocksEnabled =
  mode == report_decision OR mode == final_export

exactnessStatus == blocked:
  report_decision/final_export에서는 blocker

citationIssueCount > 0:
  report_decision/final_export에서는 blocker

verdict refutes/mixed:
  report_decision/final_export에서는 blocker

verdict not_enough_info:
  final_export AND highImpact일 때만 blocker
  그 외 warning
```

ASCII:

```text
Claim verdicts + Exactness + Citation issues
        │
        ▼
┌─────────────────────┐
│ VerifierGatePolicy   │
└─────────┬───────────┘
          │
          ├─ general_chat    → 대체로 warning 중심
          ├─ analysis_draft  → 대체로 warning 중심
          ├─ report_decision → exact/refute/citation block
          └─ final_export    → high-impact unsupported까지 block
```

---

## 13. Claim Verifier: NLI + 선택적 LLM strict JSON

현재 기본 NLI:

```text
providerId = local_nli
model      = term-overlap-contradiction-v1
```

LLM strict JSON verifier:

```text
providerId:
  VERIFIER_LLM_ENABLED=false → disabled_llm_json
  true                      → hermes_strict_json

session_id = cw-verifier-strict-json
timeout    = VERIFIER_LLM_TIMEOUT_MS
```

NLI confidence:

```text
overlap = matched claim terms / min(claimTerms.length, 6)
qualityBoost = evidence.qualityScore / 100 * 0.12
contradiction bonus = +0.2
confidence = clamp01(overlap + qualityBoost + bonus)
```

entailment 기준:

```text
contradiction? → contradiction
undecided?     → neutral
confidence >= 0.55 → entailment
else neutral
```

LLM strict JSON은 다음 schema만 허용한다.

```json
{
  "verdicts": [
    {
      "claim_id": "...",
      "verdict": "supports|refutes|mixed|not_enough_info",
      "confidence": 0.0,
      "evidence_id": "... or null",
      "rationale": "short reason"
    }
  ]
}
```

검증 포인트:

```text
- unknown claim_id 금지
- unknown evidence_id 금지
- JSON 외 prose/markdown 금지
```

---

## 14. 완성 답변 저장 후 재학습/재인덱싱 흐름

웹 채팅이 끝나면 assistant 답변이 다시 `consulting` 두뇌로 들어간다.

```text
assistant complete
  │
  ▼
ChatStreamController.persist()
  │
  ├─ saveAssistantMessage()
  ├─ saveRunEvidence()
  ├─ recordCompletedAnswer()
  └─ webIngest.ingestCompletedTurn()
       │
       ▼
ConsultingWebIngestService
  │
  └─ insert outbox_events:
       eventType = ConsultingWebTurnCompleted
       status    = pending
       idempotencyKey = consulting-web-ingest:{threadId}:{assistantMessageId}
```

outbox relay가 published 처리하면 Python ingest script가 호출되는 구조다.

Python ingest payload:

```text
consultingTopicSlug
consultingTopicId
sessionId = consulting-web-thread:{threadId}
workspaceId
projectId
channelId
topicId
threadId
scopePath
userText
assistantText
runId
assistantMessageId
timestamp
```

Python script:

```text
apps/api/scripts/ingest_web_dialogue.py
  ├─ resolve consulting topic
  ├─ write dialogue_session_scopes
  ├─ bind_session
  ├─ content_hash idempotency
  ├─ contextualize
  ├─ extract entities/edges
  ├─ Gemini embed
  ├─ insert dialogue_chunks
  ├─ insert dialogue_edges
  └─ checkpoint source='consulting-web'
```

embedding fail-open:

```text
if Gemini embedding fails:
  - chunk still stored
  - embed_dim = 0
  - embed_model = embedding_failed:...
  - FTS + graph recall remains available
  - later backfill_missing_embeddings can fill vector
```

현재 실제 outbox:

```text
ConsultingWebTurnCompleted published = 1
dialogue_session_scopes = 1
```

즉 웹→brain 재주입은 구조상 살아 있고, 실제 1건 처리 이력이 있다.

---

## 15. Telegram / 기존 consulting 대화 연결

`consulting` brain에는 기존 Telegram/주제 binding 테이블도 있다.

```text
dialogue_topic_sessions          16
dialogue_topic_telegram           1
dialogue_telegram_thread_bindings 0
```

의미:

```text
- consulting brain 쪽 broad Telegram topic binding은 legacy reference로 남아 있다.
- consulting-web의 `telegram_topic_links`가 web scope ↔ Telegram forum topic exact binding 정본이다.
- exact binding은 chat_id + thread_id + consulting_topic_slug + web topic memory_topic_id를 모두 맞춰 감사한다.
```

`telegram_topic_links` schema:

```text
workspace_id
project_id
channel_id
web_topic_id
thread_id
telegram_chat_id
telegram_thread_id
telegram_topic_name
consulting_topic_slug
memory_topic_id
profile_source
status
```

역할:

```text
Telegram forum topic
  ↔ consulting-web channel/topic/thread
  ↔ consulting brain topic slug
```

2026-07-10 live exact binding audit:

```text
package script: pnpm --filter @consulting/api run audit:telegram-web-bindings -- --project-id <projectId>
project: 창원시 컨설팅 / 01fba1a5-7b16-4267-93df-f9ca6cf0462f
registryCount: 5
activeBindingCount: 5
matchedKeys:
  -1004453868195:1
  -1004453868195:12
  -1004453868195:356
  -1004453868195:524
  -1004453868195:533
blockers: []
warnings: []
artifact: artifacts/topic-binding/telegram-web-binding-audit.json
```

따라서 창원 Telegram/web 토픽 binding은 현재 exact readback gate 기준 통과 상태다.

---

## 16. frontend 레이어

기술:

```text
React              ^19.2.7
React DOM          ^19.2.7
Vite               ^8.1.3
TypeScript         ^6.0.3
TanStack Router    ^1.170.17
TanStack Query     ^5.101.2
TanStack Virtual   ^3.14.5
Radix UI           dialog/select/slot/toast/tooltip
TailwindCSS        ^4.3.2
GSAP               ^3.15.0
Mermaid            ^11.16.0
KaTeX              ^0.17.0
PDF                pdfjs-dist ^6.1.200, react-pdf ^10.4.1
Markdown           react-markdown + remark-gfm/math + rehype-katex/raw/sanitize
Shiki              ^4.3.1
```

웹 UI 구조:

```text
┌──────────────────────────────────────────────────────────────┐
│ AppShell                                                     │
│  ├─ workspace/project/channel/topic tree                      │
│  ├─ route outlet                                              │
│  ├─ notification center                                       │
│  └─ model picker / auth session                               │
└──────────────────────────────────────────────────────────────┘
              │
              ├─ /th/:threadId
              │    ├─ ChatThread
              │    ├─ VirtualMessageStream
              │    ├─ Composer / attachments
              │    ├─ ConvoMinimap
              │    └─ right panel: evidence/search/file/artifact
              │
              ├─ /library
              │    └─ files / extractions / source browsing
              │
              ├─ /artifacts
              │    └─ report/doc/pdf artifact versions/export
              │
              └─ auth routes
                   ├─ login
                   └─ signup
```

---

## 17. backend/API 레이어

기술:

```text
NestJS               ^11.1.27
Drizzle ORM          ^0.45.2
pg                   ^8.22.0
BullMQ               ^5.79.2
ioredis              ^5.11.1
Pino / nestjs-pino
Zod                  ^4.4.3
Vitest               ^4.1.9
Supertest
```

주요 API 모듈:

```text
auth
spaces
chat
consulting
artifacts
notifications
files/evidence
```

큰 API 흐름:

```text
┌──────────────┐
│ Auth Guard   │
└──────┬───────┘
       ▼
┌──────────────┐
│ Space Access │ workspace/project membership
└──────┬───────┘
       ▼
┌──────────────┐
│ Chat API     │ messages/search/SSE/runtime/evidence
└──────┬───────┘
       ├─ HermesRunsClient
       ├─ ConsultingMemoryContextBuilder
       ├─ EvidenceStore
       ├─ EvidenceDecisionStore
       └─ ConsultingWebIngestService
```

---

## 18. 평가/품질 게이트

### 18.1 GraphRAG eval gate

스크립트:

```text
apps/api/scripts/graphrag_eval_gate.py
```

기본값:

```text
topic: changwon-org-mgmt-diagnosis
top_k: 5
timeout: 45s
rerank: false unless --rerank
require_cross_encoder: true when rerank
fake_embeddings: true by default
min_hit_rate: 0.60
max_p95_latency_s: 20.0
eval set minimum: 40 questions
```

질문 생성:

```text
claims table에서 claim_code/claim_text 읽음

각 claim당 3문항:
  {code}-code   = "{CL-...} 관련 핵심 판단과 근거"
  {code}-terms  = "{keywords} 이슈의 판단 근거"
  {code}-risk   = "{keywords} 관련 리스크와 의사결정 포인트"
```

metrics:

```text
hit_rate
context_recall
context_precision
citation_correctness
structured_relation_questions
mean_latency_s
p95_latency_s
```

package script:

```text
pnpm --filter @consulting/api test:graphrag
= python3 scripts/graphrag_eval_gate.py --rerank --top-k 2 --output ...
```

중요한 차이:

```text
CI/eval default:
  fake_embeddings = true
  rerank_prune = 4

실제 품질 측정:
  --no-fake-embeddings 필요
```

최근 실측 최종:

```text
real embedding / raw=0.20:
  precision 0.2881
  recall    0.8667
  p95       4.1242s
```

2026-07-10 human-authored global eval:

```text
package script: pnpm --filter @consulting/api run test:graphrag-human-global
fixture: apps/api/fixtures/eval/changwon_human_global_cases.json
questions: 6
human_global_questions: 6
fake_embeddings: false
rerank: cross-encoder
hit_rate: 1.0000
context_recall: 1.0000
context_precision: 0.2653
citation_correctness: 1.0000
p95_latency_s: 7.4871
warning_count: 0

판정: claim_code를 질문에 직접 노출하지 않는 수동 global case 6문항은 통과했다.
자동 claim-code fixture와 별개로, 사용자가 실제로 묻는 종합 질문형 regression gate다.
```

### 18.2 Artifact version-bound final export gate

공용 판정 경로:

```text
API preflight/export
  -> ArtifactVerificationService
  -> ArtifactVerificationDbLedger.latest(exact target)
  -> auditArtifactExportPreflight

CLI audit
  -> ArtifactVerificationDbLedger.latest(exact target)
  -> auditArtifactExportPreflight

script: apps/api/scripts/audit_artifact_export_preflight.ts
package script: pnpm --filter @consulting/api run audit:artifact-export-preflight -- --project-id <projectId>
```

불변식:

```text
- sourceMessageId/sourceThreadId는 provenance일 뿐 export 승인 키가 아니다.
- 승인은 workspaceId + projectId + artifactId + artifactVersionId + SHA-256(exact UTF-8 content) 조합에 귀속된다.
- 검증 결과는 append-only artifact_version_verifications 원장에 기록한다.
- artifactVersionId별 monotonic sequence 최신 verification을 먼저 확정한 뒤 identity/hash/deleted/status/gate를 검사한다. 조건 불일치 시 과거 PASS를 탐색하지 않는다.
- verification이 없거나 tenant/version/hash가 다르면 ARTIFACT_VERIFICATION_REQUIRED로 fail-closed한다.
- gate.decision이 정확히 PASS일 때만 export한다. PASS_WITH_WARNINGS와 BLOCKED는 모두 VERIFIER_GATE_BLOCKED다.
- exactness=skipped 단독은 verifier telemetry로 세지 않는다. claim verdict/judgment/실제 exactness 결과가 모두 없으면 missing_verifier_telemetry blocker다.
- POST /artifacts/:id/verify가 DB에서 읽은 현재 immutable version content 자체를 ClaimVerifierService + ExactnessGateService로 검증한다.
- 원본 없는 수동 artifact도 동일한 본문 검증을 통과해야 한다.
- hash·split·exactness보다 먼저 title 200자/content 200,000자 계약 상한을 O(1) 검사하며, 초과 입력은 413 `ARTIFACT_VERIFICATION_INPUT_TOO_LARGE`로 차단한다. 그 뒤 Markdown의 구조 heading과 구조 table cell allowlist를 제외한 1자 이상 본문 segment(표 cell·불릿·명사형·영문 포함), 그리고 generic system title이 아닌 사실형 artifact title을 모두 claim으로 검증한다. 최대 24 claim × claim당 2,000자, evidence 40건 × 2,000자로 제한해 최대 비교량을 24×40으로 고정하고, 초과·잘림·누락 verdict는 synthetic high-impact unsupported verdict로 fail-closed한다.
- 동일 artifactVersionId+contentHash+titleHash 동시 검증은 singleflight로 합치고, 프로세스당 서로 다른 검증은 최대 2건만 허용한다. 초과 요청은 503 ARTIFACT_VERIFIER_BUSY다.
- 원장 verifier는 `artifact_claim_coverage_v4:<titleSha256>:<provider>` 정책 identity를 포함한다. 다른 정책 또는 현재 title hash와 불일치하는 과거 PASS row는 latest verification으로 인정하지 않아 재검증을 강제한다.
- 자연어 백분율 자동 검산은 NFKC·Unicode 부호·default-ignorable 정규화 뒤 token 경계, percent suffix 경계, answer 전체 transition marker 소비, 절별 단일 pair/claim 결합을 모두 만족할 때만 수행한다. 모호성은 invalid_input으로 fail-closed한다.
- chat evidence 자동 저장은 canonical name이 정확히 web_search/web_extract인 tool.completed 결과만 허용한다. capture 시점뿐 아니라 saveRunEvidence 영속화 경계에서도 allowlist와 redaction을 다시 적용한다. JSON·malformed/닫히지 않은/backslash-escaped header는 auth/cookie label부터 줄 끝까지 fail-closed 제거하고, 확장 DB URI·JWT·AWS/Google signed URL의 raw/HTML-escaped query 전체·token prefix·email·완전/잘린 PEM secret을 redact한다. preview도 redaction 전에 유한 길이로 자른다.
- PDF/DOCX renderer는 위 preflight가 통과한 뒤에만 실행한다.
```

Schema/API:

```text
migration: packages/db-schema/drizzle/0027_artifact_version_verification_ledger.sql
table: artifact_version_verifications
API: POST /artifacts/:id/verify { versionNo? }
UI: ArtifactsSurface > 현재 버전 "본문 검증"
```

2026-07-10 live verification:

```text
isolated PostgreSQL 18: migrations 0000..0027 applied successfully
ledger integration: tenant/content/malformed-gate mismatch + legacy policy PASS invalidation fail-closed PASS
focused regressions: strict claim coverage/service 8개 + evidence redaction/persistence 12개 + exactness 27개 + export/policy 회귀 PASS
monorepo typecheck/lint/test/build + compose config PASS
production migration head: 0027_artifact_version_verification_ledger.sql (28 migrations)
production readiness: api/db/redis/bullmq/hermes 모두 ok
project evidence_items: 국가법령정보센터 제33조·제33조의2 원문 2건
기존 v3-policy PASS: v4 title-bound identity 불일치로 두 건 모두 ARTIFACT_VERIFICATION_REQUIRED 자동 무효화 확인
artifact aba9... v3: content/title hash 일치, sequence=7, status=passed, verifier=artifact_claim_coverage_v4:<titleSha256>:nli_local_nli_v1, evidence=2, verdict supports=2/2
artifact b4f0... v3: content/title hash 일치, sequence=8, status=passed, verifier=artifact_claim_coverage_v4:<titleSha256>:nli_local_nli_v1, evidence=2, verdict supports=3/3
API preflight: 두 target 모두 HTTP 200, canExport=true, reason=OK
CLI preflight: 두 target 모두 canExport=true, reason=OK; 의도적으로 미복구한 test artifact 1건 때문에 project summary 자체는 blocked
real export: v3 PDF 2건 %PDF- signature, DOCX 2건 ZIP integrity(각 16 entries) 확인
v3 SHA-256: aba9 PDF 04358e22...360d / DOCX bc56297d...45d9, b4f0 PDF d6b908b4...3022 / DOCX 7605a05f...56f8
판정: 과거 정책 PASS를 재사용하지 않고, 등록 법령 원문 기반 v3 두 건을 title-bound strict coverage로 재검증·내보내기까지 운영에서 통과했다.
```

### 18.3 NLI / hallucination / quality scripts

package scripts:

```text
test:nli             tsx scripts/nli_verifier_bench.ts
test:hallucination   tsx scripts/hallucination_reduction_eval.ts
test:quality         test:nli + test:hallucination + test:graphrag
test:ralph           python3 scripts/ralph_graphrag_hardening.py --iterations 3
```

---

## 19. 전체 레이어 ASCII — 상세 버전

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ L0. Human / Consulting Work                                                  │
│                                                                              │
│ - 주인님 / 컨설턴트                                                           │
│ - 웹 채팅, 파일 업로드, 근거 검토, 보고서/PPT/export                          │
│ - Telegram/Discord consulting topic 대화                                      │
└──────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ L1. Web UI Layer: @consulting/web                                             │
│                                                                              │
│ Tech: React 19, Vite 8, TypeScript 6, TanStack Router/Query/Virtual           │
│       Radix, Tailwind v4, pdfjs/react-pdf, Mermaid, KaTeX, Shiki              │
│                                                                              │
│ Functions:                                                                    │
│ - AppShell / scope tree                                                       │
│ - Thread chat / virtual stream / composer                                     │
│ - Evidence panel / file viewer / artifact viewer                              │
│ - Runtime model picker                                                        │
│ - Library / search / notifications                                           │
└──────────────────────────────────────────────────────────────────────────────┘
                                      │ HTTP + SSE
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ L2. API Layer: @consulting/api                                                │
│                                                                              │
│ Tech: NestJS 11, Drizzle ORM, pg, BullMQ, Redis, Zod, Pino, Vitest            │
│                                                                              │
│ Core services:                                                                │
│ - ChatStreamController                                                        │
│ - HermesRunsClient                                                            │
│ - ConsultingMemoryContextBuilder                                              │
│ - ConsultingTopicResolver                                                     │
│ - ContextGraphService                                                         │
│ - EvidenceDecisionStore                                                       │
│ - ClaimVerifierService                                                        │
│ - ExactnessGateService                                                        │
│ - VerifierGatePolicyService                                                   │
│ - ArtifactVerificationService / ArtifactVerificationDbLedger                  │
│ - ConsultingWebIngestService                                                  │
└──────────────────────────────────────────────────────────────────────────────┘
        │                              │                              │
        │ Drizzle                      │ Hermes API                   │ Python CLI
        ▼                              ▼                              ▼
┌──────────────────────┐   ┌────────────────────────────┐   ┌──────────────────────────┐
│ L3A. Product DB       │   │ L3B. Hermes Runtime         │   │ L3C. Shared Brain         │
│ Postgres 16           │   │ Hermes Gateway :8642        │   │ consulting repo           │
│ consulting-web-pg-1   │   │ socat proxy :38642          │   │ SQLite consulting.db      │
│                       │   │                             │   │ Gemini + FTS5 + GraphRAG │
│ - workspaces          │   │ - /v1/runs                  │   │                          │
│ - projects/channels   │   │ - /v1/runs/:id/events       │   │ - dialogue_chunks         │
│ - topics/threads      │   │ - /v1/models                │   │ - file_chunks             │
│ - chat_messages       │   │ - /v1/capabilities          │   │ - dialogue/file_edges     │
│ - context_edges       │   │ - approvals/tools           │   │ - FTS5 trigram            │
│ - evidence/claims     │   │                             │   │ - Gemini embeddings       │
│ - outbox              │   │                             │   │                          │
└──────────────────────┘   └────────────────────────────┘   └──────────────────────────┘
        │                                                             ▲
        │ outbox ConsultingWebTurnCompleted                           │
        └─────────────────────────────────────────────────────────────┘
```

---

## 20. Retrieval scoring ASCII — 핵심

```text
query = "창원 조직진단에서 정원/승진/재정 부담 근거 알려줘"

       ┌─────────────────────────────────────────────────────────┐
       │ 1. query terms / explicit code extraction                │
       │    - Korean suffix strip                                 │
       │    - stopwords 제거                                      │
       │    - CL-/EV-/RP code exact guard                          │
       └─────────────────────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────┼────────────────────────────┐
│                            │                            │
▼                            ▼                            ▼
SEMANTIC                     LEXICAL                      GRAPH
Gemini query vector          FTS5 BM25/trigram             edges to claims/evidence
dialogue/file separate       LIKE fallback                 exact code +1000 boost
│                            │                            │
└───────────────┬────────────┴──────────────┬─────────────┘
                ▼                           ▼
        dialogue RRF                  file/document RRF
        RRF_K=60                      RRF_K=60
                │                           │
                └──────────────┬────────────┘
                               ▼
                    cross-space rank RRF
                    dialogue_boost=1.0
                               │
                               ▼
                    trust governance
                    final_usable      group 2, weight 1.00
                    qualified_usable  group 1, weight 0.75
                    raw/unknown       group 0, weight 0.20
                    dialogue          group 0
                               │
                               ▼
                    optional cross-encoder rerank
                    prune=16 운영 / 4 eval
                               │
                               ▼
                    final top-k
                    API recallMany topK=8
                    prompt injection hits=5
```

---

## 21. 수치/가중치 모음표

### 21.1 GraphRAG

| 항목 | 값 |
|---|---:|
| dialogue embedding dim | 3072 |
| file embedding dim | 3072 |
| max embed chars | 2600 |
| RRF_K | 60 |
| search default pool | 30 |
| search CLI default top_k | 5 |
| web recallMany topK | 8 |
| prompt injected hits | 5 |
| dialogue_boost | 1.0 |
| final_usable weight | 1.0 |
| qualified_usable weight | 0.75 |
| raw_document weight | 0.20 |
| keyword overlap min | 4 |
| explicit code graph boost | 1000.0 |
| rerank prune 운영 기본 | 16 |
| rerank prune eval 기본 | 4 |
| consulting recall timeout | max(45s, env/default 60s) |

### 21.2 Context graph / fanout

| 항목 | 값 |
|---|---:|
| same_project graph weight | 1.0 |
| cross_project graph weight | 0.6 |
| classifier min shared tags | 2 |
| traverse limit | 12 |
| cross_project diffusion dampening | 0.85 |
| diffusion PPR iterations for scopes | 6 |
| hit score scopeScore multiplier | 0.25 |
| same-scope boost | +0.04 |
| cross-project penalty | -0.03 |
| graph diffusion default alpha | 0.15 |
| graph diffusion max iterations clamp | 50 |

### 21.3 Evidence / verifier

| 항목 | 값 |
|---|---:|
| support criterion weight | 0.65 |
| contradiction_risk criterion weight | 0.35 |
| uncertainty penalty multiplier | 0.35 |
| recommend evidenceCoverage threshold | 0.8 |
| recommend uncertainty threshold | 0.45 |
| support/refute threshold | 0.55 |
| high impact threshold | 0.8 |
| high-risk claim decisionImpact | 0.82 |
| normal claim decisionImpact | 0.62 |
| NLI qualityBoost max | 0.12 |
| linkedClaim boost | 0.2 |
| heuristic qualityBoost max | 0.15 |
| contradiction bonus | 0.2 / 0.25 계열 |
| review deadline overdue weight | 1.8 |
| review deadline <=6h weight | 1.5 |
| review deadline <=24h weight | 1.25 |
| no due date weight | 1.0 |

### 21.4 운영 DB 현재 수치

| 저장소 | 항목 | 값 |
|---|---|---:|
| consulting.db | topics | 2 |
| consulting.db | dialogue_chunks | 125 |
| consulting.db | file_chunks | 1,298 |
| consulting.db | dialogue_edges | 368 |
| consulting.db | file_edges | 1,931 |
| consulting-web PG | workspaces | 13 |
| consulting-web PG | projects | 11 |
| consulting-web PG | channels | 36 |
| consulting-web PG | topics | 56 |
| consulting-web PG | threads | 56 |
| consulting-web PG | chat_messages | 401 |
| consulting-web PG | context_edges | 167 |
| consulting-web PG | consulting_topic_links | 6 |
| consulting-web PG | evidence_items | 2 |
| consulting-web PG | artifact_versions | 4 |

---

## 22. 이미 실현된 것 / 아직 덜 찬 것

### 이미 실현된 것

```text
1. shared consulting brain과 web API 연결
   - /brain/consulting bind mount
   - Python CLI recall
   - web prompt에 GraphRAG context 주입

2. 대화/문서 하이브리드 GraphRAG
   - semantic + lexical + graph
   - dialogue/file separate vector space
   - RRF fusion
   - raw/verified tier governance

3. web chat persist + completed turn ingest
   - user/assistant message 저장
   - tool evidence capture
   - completed answer post-verification
   - outbox 기반 consulting brain 재주입

4. context graph 활성화
   - parent_of/system 138
   - related_to/classifier 29
   - cross-project dampening

5. exactness/verifier/export gate 설계
   - Exactness Gate
   - Local NLI
   - optional Hermes strict JSON verifier
   - final_export block policy

6. 운영 컨테이너
   - web/api/pg/redis/hermes-proxy/cloudflared 모두 up
   - api/pg/redis/hermes-proxy healthy
```

### 아직 덜 찬 것 / 주의할 것

```text
1. claim_verification_verdicts = 0
   - 구조는 있지만 현재 DB에는 누적 verdict가 아직 없음.

2. exactness_runs = 0
   - Exactness Gate 구조는 있지만 실제 누적 run은 아직 없음.

3. evidence_items = 2
   - web evidence DB는 아직 초기/소량.

4. ConsultingWebTurnCompleted = 1
   - web 완료 답변이 consulting brain으로 재주입된 실적은 1건.
   - 구조는 살아 있지만 대량 운용 전에는 outbox/relay 모니터링 필요.

5. dialogue_telegram_thread_bindings = 0
   - exact Telegram topic binding은 아직 brain DB 쪽에 없음.
   - broad legacy binding은 있으나, 주제별 안전 라우팅은 다음 작업 후보.

6. consulting-web working tree dirty 가능성
   - 운영/커밋 구조와 진행 중 UI 변경이 섞일 수 있으므로 새 커밋/배포 전 정리 필요.
```

---

## 23. 실질 이득 관점

### 이미 얻은 이득

```text
1. 지식 재사용
   웹 채팅이 기존 Telegram/문서 기반 consulting brain을 검색해서 답변에 활용 가능.

2. 근거 우선 답변
   raw 원문보다 final/qualified 자료를 우선 정렬.
   raw는 0.20으로 살려두되, 단정 근거로 과대평가하지 않음.

3. 프로젝트/범위 감쇠
   같은 프로젝트는 강하게, 다른 프로젝트는 0.6~0.51 계열로 감쇠하고 라벨 표시.

4. 수치/정확성 안전장치
   계산/DB/법령/가중치 같은 exact 요청은 blocked/warning 구조로 빠짐.

5. 최종 산출물 보호
   final_export에서는 exactness/citation/refute/high-impact unsupported를 block 가능.

6. 품질 측정 가능
   GraphRAG precision/recall/p95를 fake/real embedding으로 분리 측정 가능.

7. 제품 게이트 실사용화
   Trace Viewer redaction, Review Queue action, artifact export preflight/final gate가
   운영 배포·브라우저 QA·gateway smoke 기준으로 검증됨.
```

### 아직 구조로만 존재하고 실사용 데이터가 덜 찬 부분

```text
1. web evidence/verdict/exactness 데이터 축적
   테이블은 있지만 현재 row가 거의 없음.

2. post-answer verifier 실전 효과
   claim_verification_verdicts 0이라 hallucination reduction은 구조 검증 단계에 가까움.

3. web→brain feedback loop 규모
   완료 turn ingest 1건이라 장기 기억 루프의 실사용 효과는 아직 더 쌓여야 함.

4. Telegram exact topic bridge
   exact binding 0이라 Telegram topic별 정밀 분리는 다음 작업 후보.

5. P6 advanced labs 진입 조건
   `test:p6-product-baseline` 기준 현재 product baseline은 allowed=true다.
   ColBERT/SPLADE/RAPTOR/Leiden류는 제품 기본값이 아니라 baseline 대비 개선을 증명하는
   read-only comparison lab으로만 재개한다.
   2026-07-09 SPLADE-lite spike는 precision_delta=0.0000으로 HOLD; product path unchanged.
   2026-07-09 RAPTOR-lite spike는 global coverage_delta=-0.0333으로 HOLD; product path unchanged.
   재개 계획: `docs/plans/2026-07-09-colbert-splade-raptor-restart-plan.md`
```

---

## 24. 운영 해석

```text
consulting
  = 근거/문서/대화/claim/evidence/GraphRAG가 축적되는 컨설팅 두뇌

consulting-web
  = 그 두뇌를
    - 프로젝트/채널/토픽/스레드로 조직화하고
    - 웹 채팅 UX로 보여주고
    - Hermes Runtime에 prompt context로 주입하고
    - 답변 후 검증/근거/아티팩트/리뷰 큐를 붙이고
    - 완료 대화를 다시 두뇌로 되먹이는 제품 레이어
```

한 줄 압축:

```text
Telegram/문서에서 생긴 consulting brain
        ↓
consulting-web이 scope tree + graph + Hermes SSE + verifier로 제품화
        ↓
웹 답변이 다시 consulting brain에 들어가며 장기 기억화
```

현재 구조의 핵심 병목:

```text
- evidence/verdict/exactness row가 실제 운영에서 충분히 쌓이는가
- exact Telegram/web topic binding을 안전하게 채우는가
- context graph fanout이 과잉참조 없이 precision을 유지하는가
- final export gate를 실제 PDF/PPT 산출물 흐름에서 얼마나 강하게 켤 것인가
- P6 product baseline보다 ColBERT/SPLADE/RAPTOR가 실제로 precision/recall/latency에서 이기는가
```
