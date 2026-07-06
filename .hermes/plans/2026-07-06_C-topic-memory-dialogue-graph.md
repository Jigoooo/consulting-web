# C. Topic Memory & Dialogue Graph Wiring 설계

> **For Hermes:** 구현 시 subagent-driven-development 스킬로 task 단위 실행. 이 문서는 설계/계획 전용, 실행 아님.

**Goal:** `topics.memory_topic_id`를 실제로 배선해 토픽별 대화 상태판·회상·메모리 공유를 만들고, A문서의 워크스페이스 지식그래프 결정(프로젝트 간 자동 연결)을 **라벨 있는 recall**로 구현한다. 사용자는 "지구가 프로젝트/채널을 넘나들며 기억한다"고 느끼되, 다른 프로젝트 사실이 현재 채널 사실처럼 섞이지 않게 한다.

**Architecture:** 원문 transcript는 이미 `chat_messages`에 thread 단위로 저장된다. C는 그 위에 (1) topic memory id, (2) topic state board, (3) turn digest/event log, (4) graph-aware recall context builder, (5) `shares_memory_with` 수동 고정 메모리 그룹을 얹는다. **중요:** Hermes `session_id`를 단순히 workspace-wide로 넓히지 않는다. workspace-wide opaque session은 프로젝트 간 사실을 라벨 없이 섞어 A문서 D3("다른 프로젝트" 라벨)와 충돌한다. 대신 topic/session은 좁게 유지하고, cross-project recall은 명시 컨텍스트 블록으로 주입한다.

**Tech Stack:** NestJS · Drizzle ORM · PostgreSQL · existing `chat_messages` · `topics.memory_topic_id` · `context_edges`(`related_to`, `shares_memory_with`) · Vitest.

---

## 0. 현재 상태 (실측/코드 확인 2026-07-06)

| 항목 | 현재 | 문제 |
|---|---|---|
| `topics.memory_topic_id` | 컬럼 존재, prod 15/15 null | 스키마만 있고 미배선 |
| transcript | `chat_messages` thread 단위 저장 | 원문은 있지만 topic/workspace recall layer 없음 |
| search | `ChatMessageStore.searchMessages(threadId)` thread 내부 JS 검색 | 다른 thread/topic/project 검색 불가 |
| Hermes run session | `consulting-project:<workspaceId>:<projectId>` | 프로젝트 안 채널은 섞이지만, A 결정인 workspace 그래프와 불일치. 또한 project-wide opaque memory는 라벨 없음 |
| response instructions | `CONSULTING_RESPONSE_FORMAT` 상수만 주입 | 대화 상태판/관련 프로젝트 기억 주입 없음 |
| memory sharing edge | `shares_memory_with` enum만 존재 | A7이 의존할 실제 동작 없음 |

---

## 0.5 확정 결정 (A/B와 일관)

| # | 결정 | C에서의 적용 |
|---|---|---|
| A-D1 | 경계=워크스페이스 | memory/recall은 같은 workspace 안에서 자동. cross-workspace는 자동 금지 |
| A-D2 | cross-project 자동 연결 | related edge를 통해 다른 프로젝트 기억도 후보로 recall |
| A-D3 | cross-project 약 + 라벨 | recall 블록에 **"다른 프로젝트"** 라벨, confidence 감쇠 반영 |
| A-D4 | 태그 2개↑ 자동연결 | C는 A가 만든 `related_to/classifier`를 읽어 recall 후보로 사용 |
| B-D3 | 보관하기만 노출 | archived topic/channel은 recall 가능하되 **"보관됨"** 라벨, 쓰기 금지 |
| B-D4 | 무기한 보관 | memory state/event도 만료·purge 없음 |

---

## 1. 핵심 설계 선택 — opaque session을 넓히지 말고, 라벨 있는 기억을 주입

### 하지 말아야 할 단순안

```ts
session_id = `consulting-workspace:${workspaceId}`
```

이렇게 하면 구현은 쉽지만, Hermes 내부 세션이 워크스페이스 모든 프로젝트 대화를 라벨 없이 섞는다. 그러면:
- 다른 프로젝트 근거가 현재 채널 사실처럼 말릴 수 있음
- A문서의 cross-project 감쇠/라벨 정책을 적용할 방법이 없음
- archived/보관됨 라벨도 누락됨

### 채택안

```text
원문 세션 continuity: topic 또는 memory group 단위로 좁게 유지
워크스페이스 지식그래프: context_edges + topic_memory_state를 읽어 명시 컨텍스트로 주입
```

| 레이어 | 범위 | 역할 |
|---|---|---|
| Hermes `session_id` | 기본 topic memory, L3 공유 시 memory group | 짧은 대화 연속성 |
| `topic_memory_state` | topic 1개 | 결론·가설·질문·자료공백·다음단계 상태판 |
| `topic_memory_events` | turn digest append-only | 어떤 대화에서 무엇이 변했는지 감사/회상 |
| A의 `context_edges` | workspace graph | 관련 topic/channel/project 찾기 |
| `related_memory_context.builder` | prompt injection | 라벨 있는 cross-topic/cross-project 기억 주입 |

---

## 2. 데이터 모델

### 2.1 `topics.memory_topic_id` 활성화

- 새 topic 생성 시 항상 채움: `consulting-topic:${topic.id}`
- 기존 null topic 백필: 같은 패턴으로 update
- contracts에는 계속 숨김. `packages/contracts/src/spaces.ts` 주석대로 `memoryTopicId`는 server-side internal field.

### 2.2 신규 테이블 — topic state board

```sql
CREATE TABLE topic_memory_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  memory_topic_id text NOT NULL,
  maturity text NOT NULL DEFAULT '탐색중',
  conclusion_summary text NOT NULL DEFAULT '',
  working_hypotheses jsonb NOT NULL DEFAULT '[]'::jsonb,
  open_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  decisions jsonb NOT NULL DEFAULT '[]'::jsonb,
  material_gaps jsonb NOT NULL DEFAULT '[]'::jsonb,
  next_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(topic_id),
  UNIQUE(memory_topic_id)
);
```

### 2.3 신규 테이블 — memory event/digest log

```sql
CREATE TABLE topic_memory_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  user_message_id uuid REFERENCES chat_messages(id) ON DELETE SET NULL,
  assistant_message_id uuid REFERENCES chat_messages(id) ON DELETE SET NULL,
  run_id text,
  event_type text NOT NULL, -- turn_digest | state_update | manual_note | recall_used
  digest text NOT NULL DEFAULT '',
  extracted jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX topic_memory_events_topic_idx ON topic_memory_events(topic_id, created_at DESC);
CREATE INDEX topic_memory_events_workspace_idx ON topic_memory_events(workspace_id, created_at DESC);
```

### 2.4 선택 테이블 — L3 pinned memory groups (`shares_memory_with`)

A7을 실제 동작시키려면 `shares_memory_with` 엣지 하나만으로는 부족하다. 수동으로 강하게 묶인 topic들은 같은 memory group으로 관리한다.

```sql
CREATE TABLE memory_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memory_group_members (
  group_id uuid NOT NULL REFERENCES memory_groups(id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  added_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(group_id, topic_id)
);
```

**정책:** L3 group은 자동 생성 금지. 사용자가 "이 두 토픽은 같이 기억해" 같은 명시 동작을 했을 때만.

---

## 3. Run session scope 정책

### 3.1 기본 session id

현재:
```ts
sessionId = `consulting-project:${workspaceId}:${projectId}`
```

변경:
```ts
sessionId = `consulting-topic:${workspaceId}:${memoryTopicId}`
```

이유:
- topic 내부 thread들은 같은 대화 맥락을 공유
- 프로젝트 전체를 opaque하게 섞지 않음
- cross-project 기억은 C의 명시 context builder가 라벨 붙여 주입

### 3.2 L3 memory group일 때

해당 topic이 `memory_group_members`에 속하면:
```ts
sessionId = `consulting-memory-group:${workspaceId}:${groupId}`
```

단, group은 수동 고정(`shares_memory_with`)일 때만. 자동 `related_to`는 session을 합치지 않는다.

### 3.3 migration compatibility

기존 project session memory는 Hermes 외부 세션에 남아 있을 수 있다. C 구현 후에는 새 session id로 전환되므로 초기 며칠간 "예전 project-wide 세션 기억"이 약해질 수 있다. 이를 보완하기 위해:
- 기존 `chat_messages` 기반으로 `topic_memory_events` 백필
- 첫 run부터 state board를 instructions에 주입

---

## 4. Prompt / context 주입 구조

`HermesRunsClient.startRun()`의 `instructions`는 현재 `CONSULTING_RESPONSE_FORMAT`만 보낸다. C에서는 프롬프트 캐시를 지키기 위해 **상수 prefix는 유지**하고, 동적 컨텍스트를 뒤에 붙인다.

```text
[상수] CONSULTING_RESPONSE_FORMAT

[동적] 현재 토픽 상태판
- 현재 결론: ...
- 미해결 질문: ...
- 다음 단계: ...

[동적] 연관 기억 — 참조용, 이 채널의 사실로 단정 금지
- 같은 프로젝트 / 채널명: ...
- 다른 프로젝트 / 프로젝트명 / 채널명: ... (다른 프로젝트)
- 보관됨 / 프로젝트명 / 채널명: ... (보관된 기억)
```

### 주입 예산

| 블록 | 기본 예산 |
|---|---:|
| 현재 topic state | 800자 |
| L3 memory group states | 1,200자 |
| A related edges 후보 | 3개 × 400자 |
| 최근 turn digest | 3개 × 250자 |

초과 시 우선순위:
1. 현재 topic state
2. L3 memory group
3. same-project related
4. cross-project related(confidence 감쇠 적용)
5. archived related

---

## 5. 구현 태스크 (bite-sized, TDD)

### Task C1: memory schema + 백필
- **Files:** Modify `packages/db-schema/src/schema/space.ts` if needed · Create `packages/db-schema/src/schema/topic-memory.ts` · Create `packages/db-schema/drizzle/0011_topic_memory.sql`
- `topic_memory_states`, `topic_memory_events`, optional `memory_groups`, `memory_group_members` 생성
- 기존 `topics.memory_topic_id is null` 백필: `consulting-topic:${topic.id}`
- topic별 state row 생성
- **RED tests:** prod-like seed에서 null memoryTopicId topic 생성 → migration/backfill 후 0개
- **검증 SQL:** `select count(*) from topics where memory_topic_id is null;` = 0

### Task C2: CreateTopicUseCase에 memoryTopicId 자동 등록
- **Files:** Modify `apps/api/src/spaces/create-topic.usecase.ts` · Test `apps/api/test/topic-memory.test.ts`
- topic insert 후 `memoryTopicId = consulting-topic:${topic.id}` 업데이트 또는 id를 먼저 생성해 insert에 포함
- 동시에 `topic_memory_states` 기본 row insert
- outbox `TopicMemoryCreated` 추가
- **RED tests:** topic 생성 → topics.memory_topic_id not null + topic_memory_states 1행

### Task C3: ChatStreamUseCase가 topic/channel/memory 정보를 반환
- **Files:** Modify `apps/api/src/chat/chat-stream.usecase.ts`, `chat-stream.controller.ts`
- `canReadThread()` 반환 확장:
  ```ts
  { workspaceId, projectId, channelId, topicId, memoryTopicId }
  ```
- parent status/deleted 필터는 B의 `isLive` 헬퍼 사용
- **RED tests:** soft/archived/deleted parent 필터, memoryTopicId 반환

### Task C4: HermesRunsClient session id 정책 변경
- **Files:** Modify `apps/api/src/chat/hermes-runs-client.ts` · Test `apps/api/test/hermes-session-scope.test.ts`
- scope 입력을 `{workspaceId, projectId, channelId, topicId, memoryTopicId, memoryGroupId?}`로 확장
- 기본 session id = `consulting-topic:${workspaceId}:${memoryTopicId}`
- group이 있으면 = `consulting-memory-group:${workspaceId}:${groupId}`
- **주의:** `CONSULTING_RESPONSE_FORMAT` 상수 prefix는 유지. dynamic instructions는 뒤에 append.
- **RED tests:** 기본 topic session, group session, fallback thread session

### Task C5: TopicMemoryStore + state board API
- **Files:** Create `apps/api/src/chat/topic-memory.store.ts` + controller endpoints if needed
- methods:
  - `getState(topicId)`
  - `upsertState(topicId, patch)`
  - `appendEvent({topicId, threadId, userMessageId, assistantMessageId, digest, extracted})`
  - `recentEvents(topicId, limit)`
- maturity enum: `탐색중 | 잠정 | 검증중 | 검증됨 | 확정`
- **RED tests:** invalid maturity reject, append event idempotency, get default state

### Task C6: MemoryContextBuilder — 현재 토픽 + 관련 기억 주입
- **Files:** Create `apps/api/src/chat/memory-context.builder.ts` + test
- inputs: current `{workspaceId, topicId, channelId, projectId}` + A의 `context-graph.reader`
- output: bounded Korean context string
- logic:
  - current topic state always included
  - `shares_memory_with` group states included strongly
  - `related_to` edges included weakly, confidence order
  - `cross_project=true` → "다른 프로젝트" 라벨
  - archived target → "보관됨" 라벨
  - cross-workspace target → excluded unless explicit D5 confirm path and never auto
- **RED tests:** same-project label 없음, cross-project label 있음, archived label 있음, deleted_soft 제외, token budget 컷

### Task C7: stream settle 후 turn digest/event 저장
- **Files:** Modify `apps/api/src/chat/chat-stream.controller.ts`, `ChatMessageStore` to return user message id or look it up
- 현재 user message 저장은 id를 반환하지 않는다. `saveUserMessage()`가 id를 반환하게 변경.
- assistant save 후 `TopicMemoryStore.appendEvent()` 호출:
  - digest v1 = deterministic excerpt: user 300자 + assistant 500자 + runId
  - extracted v1 = `{}` (LLM extraction은 C9에서)
- **RED tests:** stream complete → user/assistant rows + memory event 1행. error/cancelled은 event_type=`turn_digest_partial` 또는 skip 정책 명시.

### Task C8: related-context + memory-context 통합
- **Files:** Modify `HermesRunsClient.startRun()` signature or controller prebuild instructions
- `instructions = CONSULTING_RESPONSE_FORMAT + '\n\n' + memoryContext + '\n\n' + relatedContext`
- A5의 related context와 C6 memory context 중복 방지: **C6이 A reader를 호출해 하나의 memory context로 통합**하는 것을 권장. A5는 C6으로 흡수 가능.
- **RED tests:** instructions에 state board와 다른 프로젝트 라벨 포함

### Task C9: 상태판 자동 갱신 v2 (선택, C1~C8 이후)
- **Files:** `apps/api/src/chat/topic-memory-extractor.ts`
- LLM/heuristic extractor로 assistant response에서 decisions/open_questions/next_steps 후보 추출
- 안전정책: 자동 갱신은 `origin='bot'`, 사용자가 UI에서 수정 가능. 고객 제출용 사실로 바로 승격 금지.
- MVP에서는 append-only event만으로 시작하고, C9는 별도 PR 가능.

### Task C10: UI — "지구가 기억 중" 상태판
- **Files:** `apps/web/src/features/topic-memory/*`
- topic/channel 사이드 패널에 표시:
  - 현재 결론
  - 미해결 질문
  - 다음 단계
  - 최근 기억 이벤트
  - 관련 프로젝트 기억(다른 프로젝트 라벨)
- 비개발자 표현. `memoryTopicId`, DB, script명 노출 금지.
- **RED tests / QA:** 로딩, 빈 상태, archived 읽기전용, 다크/hover/간격

---

## 6. shares_memory_with (A7) 실제 동작

A7의 `shares_memory_with`는 C 없이는 의미가 없다. C에서 다음처럼 정의한다.

| edge | 효과 |
|---|---|
| `related_to` | 자동 발견/약한 recall. session은 합치지 않음 |
| `references` | A가 B를 출처로 인용. recall 때 유향 우선순위 |
| `shares_memory_with` | 수동 고정. 같은 memory group에 넣고, session_id도 group scope로 전환 가능 |

### UX
- 사용자가 "이 토픽은 저 토픽과 같이 기억해" 클릭
- 2단계 확인 모달: "두 토픽의 대화 기억을 강하게 공유합니다. 이후 답변에서 서로의 진행상태를 같은 묶음으로 참고합니다."
- 승인 시:
  1. `context_edges`에 `shares_memory_with/manual`
  2. `memory_groups` 생성/병합
  3. `memory_group_members` 추가
  4. audit `memory.share`

---

## 7. 검색/임베딩 고도화는 MVP 밖, 단 확장점 확보

MVP는 Postgres + digest/state만으로 충분하다. 처음부터 Gemini/GBrain embedding을 붙이면 범위가 커진다.

### MVP
- `topic_memory_state` + 최근 digest + graph edge 기반 recall
- 비용 0, 빠름, 구현 안정

### 고도화 G2 이후
- digest/event를 embedding하여 semantic recall
- 단, GBrain은 OpenAI 1536d, Gemini는 3072d라 한 store에 섞으면 안 됨(consulting-evidence reference의 핵심 함정)
- 선택지:
  1. Postgres/pgvector or sqlite-vec 자체 store (Gemini 가능)
  2. GBrain MCP write (OpenAI 차원 준수)
  3. 둘 다 하지 않고 state/digest만 유지

**권장:** C MVP 후, 실제 대화량이 늘어 검색 품질 문제가 보일 때 embedding 트랙을 별도 D문서로 설계.

---

## 8. 검증

```bash
# schema/backfill
select count(*) from topics where memory_topic_id is null; -- 0
select count(*) from topic_memory_states; -- topics 수와 동일

# session scope regression
pnpm --filter @consulting/api test hermes-session-scope topic-memory memory-context

# memory event creation
select topic_id, count(*) from topic_memory_events group by topic_id order by count desc;

# cross-project recall label invariant
# test에서 memoryContext 문자열에 "다른 프로젝트" 포함 확인
```

Acceptance:
- 새 topic 생성 시 memory state 자동 생성
- chat run instructions에 현재 topic state 포함
- cross-project related memory는 자동 포함되되 "다른 프로젝트" 라벨 필수
- archived memory는 "보관됨" 라벨, deleted_soft는 제외
- `shares_memory_with` 수동 고정 시 group session scope로 전환

---

## 9. 리스크 / 트레이드오프

- **workspace-wide session 유혹:** 구현은 쉬우나 라벨 없는 오염. 금지.
- **상태판 자동 추출 환각:** C9 전까지는 append-only digest 중심. 자동 추출은 bot-origin 후보로만, 사용자가 수정 가능해야 함.
- **prompt 길이 증가:** state/related/digest 예산을 엄격히 둔다. 관련 기억 3개 기본.
- **중복 컨텍스트:** A의 related-context와 C의 memory-context를 따로 만들면 중복. C6이 A reader를 호출해 통합하는 쪽 권장.
- **기존 project session 기억 약화:** session id 변경으로 초기엔 이전 opaque project memory가 덜 보일 수 있음. 백필 digest/state가 완충.

---

## 10. 의존관계 / 실행순서

1. **B1~B4 선행 권장:** live/deleted/archived 필터 인프라 필요
2. **C1~C5:** memory id + state/event store + session scope 변경
3. **A1~A6 또는 병행:** context_edges related graph 활성화
4. **C6~C8:** graph-aware memory context 주입(A reader 사용)
5. **A7+C shares_memory:** pinned memory group
6. **C9/C10:** 자동 상태판 추출 + UI

**중요:** A5 related context builder는 C6에서 흡수 가능하므로, 구현 시 중복 builder를 만들지 말고 `MemoryContextBuilder`를 단일 주입 지점으로 삼는다.
