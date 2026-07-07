# C. Existing Consulting GraphRAG Bridge & Topic Memory Wiring 설계

> **For Hermes:** `consulting-web`은 기존 텔레그램 컨설팅 시스템의 대체·고도화판이다. 따라서 기존 `/home/jigoo/.hermes/workspace/consulting/db/consulting.db` GraphRAG와 **무조건 연결**되어야 한다. 이 문서는 web 전용 새 memory store 설계가 아니라, 기존 컨설팅 지식층을 web에 붙이는 브릿지 설계다.

**Goal:** `consulting-web`의 프로젝트/채널/토픽/스레드를 기존 `consulting` GraphRAG topic에 연결하고, AI가 답변 전 기존 대화·파일·claim/evidence 임베딩 검색 결과를 라벨 붙여 prompt에 주입하게 한다. web 대화도 다시 기존 GraphRAG로 인제스트되어 텔레그램 시절 지식과 하나의 컨설팅 자산으로 이어져야 한다.

**Architecture:**

```text
consulting-web(Postgres)
  = 제품 UI / 권한 / workspace→project→channel→topic→thread / chat_messages

consulting(db/consulting.db)
  = 컨설팅 지식 SoT / topics / claims / evidence / rag_chunks
  = dialogue_chunks + file_chunks + FTS5 + Gemini embeddings + graph edges + RRF/rerank

Bridge
  = web project ↔ consulting topic slug mapping
  = web chat → consulting dialogue ingest
  = consulting GraphRAG recall → Hermes prompt context injection
```

**Tech Stack:** NestJS bridge service · existing Python `dialogue_memory_cli.py` / modules · Drizzle/Postgres link table · existing SQLite `consulting.db` GraphRAG · Vitest.

---

## 0. 현재 상태 (실측 2026-07-06/07)

**구현 업데이트 2026-07-07:** C1~C6 및 stream-trigger형 C7이 구현·배포·E2E 검증됨. 현재 web project는 기존 `consulting.db` GraphRAG recall을 prompt에 주입하고, 완료된 web 대화는 기존 `dialogue_chunks`에 `source='consulting-web'`로 적재된다. 원 설계의 durable outbox worker는 아직 별도 worker가 아니라 stream settle 시 direct best-effort spawn으로 구현되어 있으며, 내구성/retry 보강은 Phase 7 hardening 후보다.

### consulting-web

| 항목 | 현재 | 문제 |
|---|---|---|
| `context_edges` | 45건, 전부 `parent_of/system` | 관련/참조 graph 없음 |
| `scope_tags` | 0건 | 태그 기반 classifier 즉시 불가 |
| `topics.memory_topic_id` | 16/16 null | memory 배선 없음 |
| `chat_messages` | 235건 | web transcript는 있음 |
| vector/embedding | pgvector/deps/코드 없음 | web 자체 의미검색 없음 |
| Hermes sessions | `consulting-thread:*` 14개/60msg, `consulting-project:*` 1개/2msg | state.db에는 쌓이지만 consulting.db에 미바인딩 |

### existing consulting GraphRAG

| 항목 | `changwon-org-mgmt-diagnosis` 실측 |
|---|---:|
| dialogue_chunks | 97 / 97 embedded |
| dialogue_edges | 338 |
| file_chunks | 602 / 602 embedded |
| file_edges | 696 |
| web sessions bound | 0 |

`dialogue_memory_cli.py recall --topic changwon-org-mgmt-diagnosis --q "정원 인건비 조직진단"`는 `CL-D5-01`, `CL-RP03`, `CL-D1-01` 등 관련 claim을 상위 반환했다. 즉 기존 GraphRAG는 작동한다. web과 연결만 안 되어 있다.

---

## 0.5 확정 결정 (A/B/D와 일관)

| # | 결정 | C에서의 적용 |
|---|---|---|
| C-D1 | `consulting-web`은 기존 텔레그램 컨설팅의 대체판 | 기존 `consulting.db` GraphRAG를 1차 검색 엔진으로 연결 |
| C-D2 | web project = consulting 과업 단위 | web project가 기존/new `consulting.db.topics.slug`에 매핑 |
| C-D3 | web channel/topic/thread = 하위 scope | consulting.db topic을 새로 만들지 않고 scope metadata로 기록 |
| C-D4 | 새 벡터 DB보다 기존 GraphRAG 우선 | pgvector는 후순위 미러/성능 최적화, MVP 필수 아님 |
| C-D5 | cross-project 자동 참조 | A의 `context_edges`로 관련 project를 찾고, 관련 consulting topic recall 결과를 약하게 주입 |
| C-D6 | 삭제/보관은 지식 삭제 아님 | link/status만 archived, recall은 라벨+감쇠로 제어 |

---

## 1. 핵심 설계 선택 — 기존 consulting.db를 검색 SoT로 쓴다

### 하지 말아야 할 방향

```text
web topic마다 독립 memory_topic_id 생성
web Postgres에 별도 vector store 생성
기존 consulting.db와 나중에 연결
```

이 방향은 web과 기존 컨설팅 지식이 갈라져 “텔레그램 대체”가 아니라 “새 빈 앱”이 된다.

### 채택 방향

```text
web project → consulting topic slug mandatory link
web channel/topic/thread → same consulting topic의 하위 scope
web query → existing dialogue_memory recall
web response/transcript → existing dialogue_memory ingest
```

---

## 2. 레벨 매핑 — 이름 충돌 주의

`consulting.db.topics`의 topic은 “컨설팅 과업/프로젝트”다. 반면 `consulting-web.topics`는 channel 밑의 세부 대화 토픽이다.

```text
consulting.db topic
  changwon-org-mgmt-diagnosis
    ↑ maps_to
consulting-web project
  창원시 컨설팅
    ├─ channel: 자료수집
    │   ├─ web topic: 공공시설 기초자료
    │   └─ web topic: 회의·요청사항
    ├─ channel: 분석
    ├─ channel: 보고서
    └─ channel: 질의응답
```

따라서 기본 규칙:

- web project 하나가 consulting.db topic 하나에 연결된다.
- web channel/topic/thread는 그 topic 안의 source scope로 기록된다.
- 특정 web channel이 완전히 다른 컨설팅 과업이면 override link만 허용.

---

## 3. 데이터 모델

### 3.1 Postgres: `consulting_topic_links`

```sql
CREATE TABLE consulting_topic_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel_id uuid REFERENCES channels(id) ON DELETE CASCADE,
  web_topic_id uuid REFERENCES topics(id) ON DELETE CASCADE,
  thread_id uuid REFERENCES threads(id) ON DELETE CASCADE,
  link_level text NOT NULL, -- project | channel | topic | thread
  consulting_topic_slug text NOT NULL,
  consulting_topic_id integer,
  scope_path text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active', -- active | archived
  origin text NOT NULL DEFAULT 'system', -- system | manual | import
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX consulting_topic_links_project_unique
  ON consulting_topic_links(project_id)
  WHERE link_level='project' AND status='active';
CREATE INDEX consulting_topic_links_slug_idx ON consulting_topic_links(consulting_topic_slug);
```

백필:

- `창원시 컨설팅` project → `changwon-org-mgmt-diagnosis`
- 테스트/Docker projects는 별도 test slug 또는 unlinked로 둔다. AI 검색 주입은 link가 있는 project에서만 활성.

### 3.2 SQLite consulting.db: web scope provenance

기존 `dialogue_topic_sessions(topic_id, session_id)`만으로는 web channel/topic 경로가 안 남는다. 최소 보강:

```sql
CREATE TABLE IF NOT EXISTS dialogue_session_scopes (
  topic_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'consulting-web',
  workspace_id TEXT,
  project_id TEXT,
  channel_id TEXT,
  web_topic_id TEXT,
  thread_id TEXT,
  scope_path TEXT NOT NULL DEFAULT '',
  bound_at TEXT NOT NULL,
  PRIMARY KEY(topic_id, session_id)
);
```

`dialogue_chunks.session_id`와 join해 “이 기억이 어느 web 채널/토픽에서 왔는지”를 표시한다.

### 3.3 `topics.memory_topic_id` 재정의

기존 C안처럼 web topic별 `consulting-topic:${webTopicId}`로 만들지 않는다.

권장:

```text
topics.memory_topic_id = consulting:<consulting_topic_slug>#<web_channel_slug>/<web_topic_slug>
```

단, 실제 검색 엔진 resolve는 `consulting_topic_links`가 담당한다. `memory_topic_id`는 내부 추적/디버깅 보조값이다.

---

## 4. 검색 브릿지

### Task C1: `ConsultingTopicLink` schema + 백필

- **Files:** `packages/db-schema/src/schema/consulting-topic-link.ts` 또는 `context-graph.ts` 인접 · migration `0011_consulting_topic_links.sql`
- `창원시 컨설팅` project를 `changwon-org-mgmt-diagnosis`로 연결.
- link 없는 project에서는 GraphRAG recall을 비활성화하고 로그만 남김.
- **RED tests:** project link resolve, archived link 제외, channel/topic override.

### Task C2: `ConsultingTopicResolver`

- **Files:** `apps/api/src/consulting/consulting-topic-resolver.service.ts`
- 입력: `{workspaceId, projectId, channelId?, topicId?, threadId?}`
- 출력:
  ```ts
  {
    consultingTopicSlug: string;
    linkLevel: 'project'|'channel'|'topic'|'thread';
    scopePath: string;
    archived: boolean;
  }
  ```
- channel/topic/thread override가 있으면 가장 구체적인 link 우선, 없으면 project link 상속.

### Task C3: `ConsultingGraphRagBridge.recall()`

- **Files:** `apps/api/src/consulting/consulting-graphrag-bridge.service.ts`
- 초기 구현은 Python CLI subprocess:
  ```bash
  /home/jigoo/.hermes/workspace/consulting/.venv/bin/python3 \
    /home/jigoo/.hermes/workspace/consulting/scripts/dialogue_memory_cli.py \
    recall --topic <slug> --q <query> --top-k 5 --format json --no-rerank
  ```
- timeout 3~5초, 실패 시 empty. 채팅 전체 실패로 전파하지 않음.
- 결과에서 `kind`, `utility_tier`, `doc_title`, `raw_text`, `score`를 normalize.
- **RED tests:** CLI 실패 fallback, JSON parse 실패 fallback, 정상 hit normalize.

### Task C4: `MemoryContextBuilder`를 GraphRAG 중심으로 변경

- **Files:** `apps/api/src/chat/memory-context.builder.ts`
- 입력: 현재 scope + user query.
- 구성 순서:
  1. 현재 project의 consulting topic recall.
  2. A의 related scopes 조회.
  3. related scope가 같은 consulting slug면 중복 recall 대신 scope 라벨만 보강.
  4. related scope가 다른 consulting slug면 top 1~2만 추가 recall, confidence ×0.6.
  5. archived scope는 `보관됨` 라벨 + 하위 우선순위.
- prompt block 예:
  ```text
  [컨설팅 검색 기억 — 근거 우선, 참조용]
  현재 프로젝트:
  - 검증자료/조건부확인: CL-D5-01 ...
  - 대화기억: ...

  다른 프로젝트 참고(약한 연결, 현재 사실로 단정 금지):
  - <프로젝트>/<채널>: ...
  ```
- **RED tests:** `다른 프로젝트`, `보관됨`, `미검증 원문`, budget cut invariant.

### Task C5: Chat stream에 recall context 주입

- **Files:** `chat-stream.controller.ts`, `hermes-runs-client.ts`
- 현재 `instructions = CONSULTING_RESPONSE_FORMAT`만 보낸다. 변경:
  ```ts
  instructions = CONSULTING_RESPONSE_FORMAT + '\n\n' + memoryContext
  ```
- `CONSULTING_RESPONSE_FORMAT` 상수 prefix는 유지.
- **Acceptance:** “정원 인건비 조직진단” 질문 시 prompt context에 `CL-D5-01` 계열 recall hit 포함.

---

## 5. web 대화 인제스트

### 5.1 MVP 긴급 경로: Hermes state.db session bind

실측상 web 대화는 Hermes `state.db.messages`에 `source='api_server'`, `session_id='consulting-thread:*'` 또는 `consulting-project:*`로 저장된다. 기존 `ingest.py --session-id`는 explicit session이면 source 무관하게 messages를 가져온다.

따라서 빠른 MVP:

1. web stream 시작 시/종료 시 session id를 계산.
2. resolver로 consulting topic slug/id 확보.
3. `dialogue_topic_sessions`에 session id bind.
4. `dialogue_memory_cli.py ingest --topic <slug> --session-id <sessionId>`를 background/outbox로 실행.

단점: Hermes state.db 내부 구조에 의존한다.

### 5.2 정식 경로: Postgres chat_messages 직접 인제스트

제품 SoT는 `consulting-web.chat_messages`이므로 정식은 직접 ingester다.

**Task C6: `web_chat_ingest.py`**

- **Files:** `/home/jigoo/.hermes/workspace/consulting/scripts/dialogue_memory/web_ingest.py` 또는 web repo scripts.
- 입력:
  - `--consulting-topic changwon-org-mgmt-diagnosis`
  - `--thread-id <web thread uuid>` or `--project-id <web project uuid>`
  - Postgres connection env
- 처리:
  1. Postgres `chat_messages` + thread/topic/channel/project join.
  2. 기존 `ingest.py`의 noise/digest/contextualize/entity/embedding logic 재사용.
  3. `dialogue_chunks.source='consulting-web'`.
  4. `session_id='consulting-web-thread:<threadId>'`.
  5. `dialogue_session_scopes`에 web scope metadata 기록.
- 실행 시점: stream response 완료 후 outbox/background. 사용자 응답 path를 막지 않음.

### Task C7: outbox worker

- event: `ChatTurnCompleted`
- payload: `{workspaceId, projectId, channelId, topicId, threadId, userMessageId, assistantMessageId, runId}`
- worker가 resolver → web_ingest 호출.
- idempotency: message pair hash / content hash.

---

## 6. project/channel/topic lifecycle

### 새 project 생성

web project는 컨설팅 과업 단위이므로 `consulting_topic_links` project-level row가 반드시 필요하다.

정책:

- UI/API는 “기존 과업 연결” 또는 “새 과업 생성”을 요구.
- 기존 slug가 있으면 선택 연결.
- 새 project면 consulting.db `topics`에도 row 생성(또는 topic_registry) 후 link.
- 기존 창원 project는 `changwon-org-mgmt-diagnosis`로 백필.

### 새 channel/topic 생성

- consulting.db topic을 새로 만들지 않는다.
- project link를 상속.
- `scope_path`만 갱신.
- A의 `parent_of` edge와 tag inheritance는 유지.

### archive/delete

- consulting.db 지식 삭제 없음.
- link/status만 archived.
- retrieval은 기본 감쇠 + `보관됨` 라벨.

---

## 7. shares_memory_with 실제 동작

| edge | 효과 |
|---|---|
| `related_to` | GraphRAG recall 후보를 약하게 추가. session/store는 합치지 않음 |
| `references` | A가 B를 근거로 인용. recall 우선순위 상승 |
| `shares_memory_with` | 수동 고정. 두 web scope의 consulting recall을 항상 함께 주입 |

중요: `shares_memory_with`도 consulting.db topic을 새로 섞는 게 아니라, bridge query fan-out 정책이다.

---

## 8. 벡터/임베딩 정책

### MVP

- 새 pgvector 불필요.
- 기존 `consulting.db`의 Gemini embedding + FTS5 + graph + RRF를 그대로 사용.
- Node/NestJS는 검색 bridge만 가진다.

### 후순위

pgvector를 도입한다면:

- source of truth가 아니라 web UI용 mirror/cache.
- 기존 `consulting.db`와 동기화 검증 필요.
- embedding engine 혼합 금지: GBrain OpenAI 1536d, Gemini 3072d는 같은 vector column에 섞지 않는다.

---

## 9. 검증

```bash
# web → consulting topic link
select project_id, consulting_topic_slug, status
from consulting_topic_links
where status='active';

# existing GraphRAG health
cd /home/jigoo/.hermes/workspace/consulting
.venv/bin/python3 scripts/dialogue_memory_cli.py stats --topic changwon-org-mgmt-diagnosis

# bridge smoke
curl/chat test: "정원 인건비 조직진단"
# prompt context에 CL-D5-01 / CL-RP03 / CL-D1-01 계열 hit 포함 확인

# web ingest after stream
select source, count(*) from dialogue_chunks group by source;
-- source='consulting-web' 증가

# no web session gap
select count(*) from dialogue_topic_sessions where session_id like 'consulting-%';
-- MVP bind 후 > 0
```

Acceptance:

- 창원 web project가 `changwon-org-mgmt-diagnosis`로 resolve된다.
- chat prompt에 기존 consulting GraphRAG hit가 들어간다.
- web 대화가 consulting.db에 `source='consulting-web'`로 인제스트된다.
- cross-project recall은 `다른 프로젝트` 라벨 없이 들어가지 않는다.
- archived scope recall은 `보관됨` 라벨 없이 들어가지 않는다.
- bridge 장애가 사용자 응답을 죽이지 않는다.

---

## 10. 구현 순서

1. **C1~C3:** project→consulting topic link + resolver + recall bridge. ✅ 구현/검증 완료(2026-07-07)
2. **C4~C5:** MemoryContextBuilder + chat prompt injection. ✅ 구현/검증 완료(2026-07-07)
3. **C6~C7:** web chat ingest(outbox) → existing consulting.db. ✅ direct best-effort trigger 구현/실제 stream E2E 완료. durable outbox worker는 Phase 7 hardening 후보.
4. **B1~B4:** tombstone/isLive로 ghost recall 차단.
5. **A1~A6:** related scope graph 활성화 + cross-project recall fan-out.
6. **C shares_memory:** 수동 고정 memory fan-out.
7. UI: “지구가 참고한 근거/기억” 패널.

**중요:** 검색 품질 관점에서는 C1~C5가 A보다 먼저여도 된다. A는 cross-project scope discovery이고, C bridge는 현재 창원 project 안에서 즉시 기존 지식 검색을 살린다.
