# D. AI Search / GraphRAG / Vector 연결성 감사 및 보강 설계

> **For Hermes:** 이 문서는 `consulting-web`이 기존 텔레그램 컨설팅 시스템의 대체·고도화판이라는 전제에서 작성한다. 따라서 `consulting-web`은 기존 `consulting` 자산과 “느슨히 참고”가 아니라 **무조건 연결**되어야 한다.

**Goal:** AI가 검색할 때 프로젝트·채널·대화·자료·근거가 단단히 연결되도록 현재 코드/DB/기존 컨설팅 GraphRAG 레이어를 실측 감사하고, A/B/C 설계를 고도화한다.

**Audit date:** 2026-07-06/07 실측.

---

## 0. 최종 결론

현재 상태만 보면 **consulting-web 자체는 GraphRAG/벡터 검색이 없다.** 그러나 기존 `consulting`에는 이미 강한 GraphRAG 레이어가 있다. 문제는 둘 사이의 **브릿지 부재**다.

따라서 정답은:

```text
consulting-web(Postgres) = 제품 UI / 워크스페이스·프로젝트·채널·스레드 / 권한 / 화면 transcript
consulting(db/consulting.db) = 컨설팅 지식 SoT / 검증자료 / 대화·파일 임베딩 / GraphRAG 검색 엔진
브릿지 = web 프로젝트·채널·토픽·스레드를 consulting topic slug에 자동 연결 + web 대화를 기존 GraphRAG에 인제스트 + 검색 결과를 chat prompt에 주입
```

즉 **web에 pgvector를 새로 붙이는 것보다 먼저 기존 consulting GraphRAG를 web의 검색 엔진으로 연결**해야 한다. pgvector/새 벡터 store는 나중에 미러·성능 최적화로만 검토한다.

---

## 1. 실측 증거

### 1.1 consulting-web 실측

`consulting-web-pg-1` 기준:

| 항목 | 실측 | 의미 |
|---|---:|---|
| workspaces / projects / channels / topics / threads | 9 / 7 / 13 / 16 / 16 | web 쪽 scope tree 존재 |
| chat_messages | 235 | web transcript 저장됨 |
| context_edges | 45 | 전부 `parent_of/system` |
| `related_to` / `references` / `shares_memory_with` | 0 | 상호참조 graph 미구현 |
| context_tags / scope_tags | 2 / 0 | 태그 vocabulary만 있고 scope tagging 없음 |
| topics.memory_topic_id | 16개 중 0개 | memory 배선 없음 |
| evidence_items / artifacts / files / document_extractions | 각 1 | evidence/document 레이어 초기 형태만 있음 |
| pg extensions | `plpgsql` only | `pgvector` 없음 |
| vector/embedding deps | 없음 | Node/Postgres 쪽 벡터 검색 구현 없음 |
| dead edges to deleted nodes | channel/topic from/to 각 1건 | tombstone 누락 결함 실존 |

검색 코드 측면:

- `ChatMessageStore.searchMessages(threadId)`는 thread 내부 JS 문자열 검색만 수행.
- `HermesRunsClient`는 Hermes `/v1/runs`로 message + `instructions`만 전달.
- `dialogue_memory_cli`, embedding, RRF, rerank, vector search 호출 없음.

### 1.2 Hermes state.db 실측 — web 대화는 저장되고 있음

Hermes `state.db`에는 `consulting-web` API 세션이 존재한다.

| prefix | sessions | messages | source |
|---|---:|---:|---|
| `consulting-thread:*` | 14 | 60 | `api_server` |
| `consulting-project:*` | 1 | 2 | `api_server` |

즉 web 대화는 Hermes 세션 DB에도 쌓인다. 그러나 아래처럼 기존 `consulting.db`에 바인딩되지 않는다.

### 1.3 기존 consulting GraphRAG 실측

`/home/jigoo/.hermes/workspace/consulting/db/consulting.db` 기준:

| 항목 | 전체 / 창원 topic | 의미 |
|---|---:|---|
| topics | 2 | `road-traffic-conditions-outlook`, `changwon-org-mgmt-diagnosis` |
| changwon dialogue_chunks | 97 / 97 embedded | 대화 임베딩 완비 |
| changwon dialogue_edges | 338 | 대화→claim/evidence/entity graph |
| changwon file_chunks | 602 / 602 embedded | 파일/문서 임베딩 완비 |
| changwon file_edges | 696 | 파일→claim/evidence/entity graph |
| total file_chunks | 1298 | 기존 자료 store가 더 큼 |
| bound sessions with `consulting-%` | 0 | web 세션은 미인제스트 |

기존 recall smoke test:

질문 `정원 인건비 조직진단` → `dialogue_memory_cli.py recall --topic changwon-org-mgmt-diagnosis`가 `CL-D5-01`, `CL-RP03`, `CL-D1-01` 등 검증 claim 파일 chunk를 상위로 반환했다.

**따라서 기존 GraphRAG는 작동한다. 문제는 web이 이 엔진을 안 쓰는 것이다.**

---

## 2. 핵심 구조 오해 바로잡기

### 2.1 “consulting topic”과 “consulting-web topic”은 같은 단어지만 레벨이 다르다

기존 `consulting.db.topics`의 topic은 **컨설팅 과업/프로젝트 단위**다.

예:

```text
changwon-org-mgmt-diagnosis = 창원시설공단 조직 및 경영 진단 연구용역 전체
```

반면 `consulting-web.topics`는:

```text
workspace → project → channel → topic → thread
```

중 `channel` 아래의 세부 대화 topic이다.

따라서 web topic 하나마다 consulting.db topic을 새로 만들면 안 된다. 기본 매핑은:

```text
consulting-web project  ──maps_to──>  consulting.db topic
consulting-web channel/topic/thread ──subscope──> same consulting.db topic + scope metadata
```

즉 **창원시 컨설팅 web project 전체가 기존 `changwon-org-mgmt-diagnosis` topic으로 연결**되어야 하고, web channel/topic은 그 내부 하위 scope로 기록되어야 한다.

### 2.2 C문서 기존안의 결함

기존 C문서는 `topics.memory_topic_id = consulting-topic:${webTopicId}`처럼 web topic마다 독립 memory topic을 만드는 방향이었다. 이것은 다음 문제가 있다.

- 기존 창원 GraphRAG(`changwon-org-mgmt-diagnosis`)와 분리됨
- web topic이 너무 세분화되어 파일/claim/evidence 지식과 못 만남
- 기존 텔레그램 컨설팅을 대체한다는 사용자 의도와 충돌

수정 방향:

```text
web project memory link = consulting topic slug/id
web topic memory id = consulting topic + web scope path
```

---

## 3. 결함 매트릭스

| ID | 결함 | 심각도 | 근거 | 수정 방향 |
|---|---|---:|---|---|
| D-01 | web이 기존 consulting GraphRAG를 호출하지 않음 | 높음 | 코드 검색 결과 호출 0 | `ConsultingGraphRagBridge` 추가 |
| D-02 | web 대화가 GraphRAG에 인제스트되지 않음 | 높음 | state.db web sessions 존재, consulting.db bound web sessions 0 | web transcript ingester 추가 |
| D-03 | `memory_topic_id`가 전부 null | 높음 | 16/16 null | project→consulting topic link로 재정의 |
| D-04 | `context_edges`가 parent_of뿐 | 높음 | 45/45 parent_of/system | A문서 related/references 활성화 |
| D-05 | scope_tags가 0이라 태그 기반 classifier가 작동 불가 | 중간 | scope_tags 0 | 태그 seed/extract task 선행 |
| D-06 | web 자체 벡터/pgvector 없음 | 중간 | pg extension/deps 없음 | 먼저 기존 SQLite vector 재사용, pgvector는 후순위 |
| D-07 | 삭제 노드 graph ghost | 높음 | dead edge 각 1건 | B tombstone/isLive 선행 |
| D-08 | evidence/artifact와 graph 연결 약함 | 중간 | evidence 1, artifact source link 0 | artifact/evidence→references edge 자동 생성 |
| D-09 | session scope가 project/thread 혼재 | 중간 | `consulting-project` 1, `consulting-thread` 14 | web thread/project → consulting topic link로 통일 |
| D-10 | 검색 결과가 prompt 끝단까지 안 감 | 높음 | `instructions`는 포맷 지침만 | recall context injection acceptance test |

---

## 4. 목표 아키텍처

```text
사용자 질문
  ↓
consulting-web API
  ↓ resolve thread → web project/channel/topic
  ↓ resolve web project → consulting topic slug (예: changwon-org-mgmt-diagnosis)
  ↓
ConsultingGraphRagBridge.recall(query, currentScope)
  ├─ current consulting topic: dialogue+file 3신호 검색
  │    semantic(Gemini) + lexical(FTS5) + graph(claim/evidence edges) + RRF/rerank
  ├─ A context_edges related scopes: 같은 WS 내 관련 project/channel/topic
  │    └─ 관련 scope의 consulting topic slug로 추가 recall, cross-project 감쇠
  └─ 결과를 source-tier/프로젝트 라벨/보관 라벨 붙여 prompt context로 구성
  ↓
Hermes run instructions
  ↓
응답
  ↓
web chat_messages 저장
  ↓
web transcript ingester → consulting.db dialogue_chunks/file graph와 같은 topic에 추가
```

---

## 5. 브릿지 데이터 모델

### 5.1 consulting-web Postgres: `consulting_topic_links`

web scope와 기존 consulting.db topic을 연결한다.

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
  scope_path text NOT NULL DEFAULT '', -- project/channel/topic/thread human path
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

정책:

- project-level link는 필수.
- channel/topic/thread는 기본적으로 project link를 상속.
- 특정 channel/topic이 별도 컨설팅 과업이면 override link 가능.
- archive/delete 시 link는 삭제하지 않고 `status='archived'`.

### 5.2 consulting.db SQLite: `dialogue_session_scopes` 또는 확장

기존 `dialogue_topic_sessions`는 `topic_id, session_id`만 가진다. web scope 경로를 보존하려면 별도 테이블을 추가한다.

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

기존 `dialogue_chunks.session_id`로 join하면 어떤 web channel/topic에서 온 대화인지 추적 가능하다.

---

## 6. 검색 경로 설계

### 6.1 `ConsultingGraphRagBridge`

NestJS에서 Python CLI를 얇게 호출한다. 초기엔 subprocess bridge가 가장 빠르고 안전하다.

```ts
interface RecallInput {
  consultingTopicSlug: string;
  query: string;
  currentScope: { workspaceId; projectId; channelId?; topicId?; threadId? };
  relatedScopes?: RelatedScope[];
}
```

동작:

1. 현재 project의 `consulting_topic_slug`로 recall 실행.
2. A의 `context_edges`로 related scopes 조회.
3. related scope가 다른 project면 confidence ×0.6, 라벨 `다른 프로젝트`.
4. related project의 consulting slug가 다르면 같은 query로 추가 recall(top 1~2).
5. 결과를 source-tier 순서로 정렬:
   - 검증완료/qualified file claim
   - 현재 topic dialogue
   - cross-project dialogue/file
   - raw/unverified
6. timeout 3~5초. 실패 시 empty context + 내부 로그. 사용자의 채팅 응답은 죽이지 않는다.

### 6.2 prompt 주입 형식

```text
[컨설팅 검색 기억 — 근거 우선, 참조용]
현재 프로젝트(창원시설공단 조직 및 경영 진단):
- 검증자료 / 조건부확인: CL-D5-01 …
- 대화기억: 지난 논의에서 …

다른 프로젝트 참고(약한 연결, 현재 사실로 단정 금지):
- <프로젝트명>/<채널명>: …

보관된 항목 참고:
- 보관됨 / <채널명>: …
```

불변식:

- cross-project는 반드시 `다른 프로젝트` 라벨.
- archived는 반드시 `보관됨` 라벨.
- raw/unverified는 수치 단정 금지 라벨.
- `memoryTopicId`, DB경로, CLI명은 사용자에게 노출하지 않음.

---

## 7. 인제스트 경로 설계

### 7.1 왜 Hermes state.db만 의존하면 안 되나

실측상 web 대화가 Hermes `state.db`에 `api_server` source로 쌓인다. 기존 `ingest.py --session-id`로 당장 끌어올 수는 있다. 하지만 제품 데이터의 SoT는 `consulting-web.chat_messages`다.

따라서 안정 설계는:

```text
MVP 긴급 브릿지: state.db session_id를 consulting.db에 bind + 기존 ingest.py 재사용
정식 브릿지: web Postgres chat_messages → consulting.db dialogue_chunks 직접 인제스트
```

### 7.2 정식 `web_chat_ingest.py`

기존 `dialogue_memory`의 함수들을 재사용한다.

입력:

- `--consulting-topic changwon-org-mgmt-diagnosis`
- `--thread-id <web thread uuid>` 또는 `--project-id <web project uuid>`
- Postgres read-only connection

처리:

1. `chat_messages`에서 thread/project scope 메시지 읽기.
2. noise filter, Q&A digest.
3. contextualize.
4. claim/evidence keyword edge extraction.
5. Gemini embedding.
6. `dialogue_chunks`에 `source='consulting-web'`, `session_id='consulting-web-thread:<threadId>'`로 insert.
7. `dialogue_session_scopes`에 scope_path 기록.

스트림 응답 path에서 직접 돌리지 말고 outbox/background worker로 실행한다.

---

## 8. 생성/삭제 라이프사이클

### 8.1 새 프로젝트 생성

web project는 컨설팅 과업에 해당하므로 다음 중 하나가 필요하다.

1. 기존 consulting topic 선택/연결: 예 `changwon-org-mgmt-diagnosis`
2. 새 consulting topic 자동 생성: project slug 기반

정책:

- 프로젝트 생성 UI에서 기본은 “기존 과업 선택 or 새 과업 생성”.
- 내부적으로 `consulting_topic_links` project-level row는 반드시 생성.
- 중복 slug는 fuzzy/confirm.

### 8.2 새 채널/토픽 생성

- 별도 consulting.db topic을 만들지 않는다.
- project의 consulting topic link를 상속한다.
- channel/topic은 `scope_path`와 `context_edges parent_of`로만 구분.
- GraphRAG 인제스트 시 source scope metadata로 남긴다.

### 8.3 프로젝트/채널 보관

- consulting.db 지식은 삭제하지 않는다.
- link status만 `archived`.
- retrieval은 기본 제외하거나 낮은 가중치 + `보관됨` 라벨로 포함.

---

## 9. A/B/C 문서 보강 사항

### A 보강

- 상단 Architecture의 “프로젝트 경계는 넘지 않음” 문구는 폐기.
- `scope_tags=0`이므로 A6 classifier 전에 **A0 태그 seed/extract**가 필요.
- `related_to`만으로 검색이 완성되지 않는다. A는 web scope graph이고, 실제 의미검색은 C/D의 `ConsultingGraphRagBridge`가 담당.

### B 보강

- 보관 상태는 GraphRAG retrieval label에도 반영해야 한다.
- archived link/chunk는 삭제하지 않고 label+weight로만 제어.

### C 보강

- C의 핵심은 “새 topic_memory store”가 아니라 **기존 consulting.db GraphRAG 브릿지**다.
- `topic_memory_states`는 보조 상태판일 뿐, 검색 엔진이 아니다.
- 임베딩/GraphRAG는 MVP 밖이 아니라 **MVP의 필수 검색 엔진**이다. 다만 새로 만들지 말고 기존 것을 연결한다.

---

## 10. 구현 우선순위

### P0 — 끊긴 브릿지 복구
1. `consulting_topic_links` 추가.
2. 창원 web project → `changwon-org-mgmt-diagnosis` 백필 연결.
3. `ConsultingGraphRagBridge.recall()` 추가.
4. chat prompt에 기존 GraphRAG recall 결과 주입.
5. web 대화 인제스트 MVP: state.db session bind 또는 direct Postgres ingester.

### P1 — graph scope 단단화
1. B tombstone/isLive.
2. A context_edges read/write.
3. scope tag seed/extract.
4. related scope 기반 cross-project recall.

### P2 — 제품화
1. “지구가 참고한 근거” UI.
2. 보관됨/다른프로젝트 라벨 표시.
3. 검색 품질 로그(recall_used, ignored).
4. pgvector 미러 검토(성능 필요할 때만).

---

## 11. Acceptance tests

- web 창원 project가 `changwon-org-mgmt-diagnosis`로 resolve된다.
- web chat 질문 “정원 인건비 조직진단” 시 prompt context에 `CL-D5-01` 또는 동급 claim recall이 포함된다.
- web stream 후 대화가 `consulting.db.dialogue_chunks`에 `source='consulting-web'`로 증가한다.
- cross-project recall은 `다른 프로젝트` 라벨 없이는 prompt에 들어가지 않는다.
- archived scope recall은 `보관됨` 라벨 없이는 prompt에 들어가지 않는다.
- GraphRAG bridge 실패 시 채팅 자체는 성공하고 내부 로그만 남는다.

---

## 12. 한 줄 판단

**현재 web은 껍데기/대화 UI는 생겼지만 기존 컨설팅 지능층과 아직 끊겨 있다.** 새 벡터 DB를 만들기보다, 이미 검증된 `consulting.db` GraphRAG를 web의 검색 엔진으로 붙이는 것이 가장 빠르고 정확한 고도화다.
