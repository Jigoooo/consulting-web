# Chat Channel Selection and Virtualized Message List Implementation Plan

> **For Hermes:** 이 계획은 UI 1차 수정은 즉시 적용하고, 메시지 가상화는 API/스크롤 불변식부터 잠근 뒤 단계별로 구현한다.

**Goal:** 선택된 채널의 상태 표시/무반응 재클릭/고급 micro-motion을 완성하고, 긴 대화에서도 안정적인 채팅 가상화·양방향 로딩·검색 이동을 구현한다.

**Architecture:** 사용자에게는 `프로젝트 → 채널 → 바로 대화`만 보인다. 내부 topic/thread는 호환 계층으로 유지한다. 메시지 목록은 `전체 로드 + 전체 DOM 렌더`를 폐기하고, 서버 cursor API + 클라이언트 window cache + keyed virtualizer + scroll anchor state machine으로 전환한다.

**Tech Stack:** React 19, TanStack Router, TanStack Query, Drizzle/PostgreSQL, 후보 라이브러리 `@tanstack/react-virtual@3.14.5` 우선, `react-virtuoso@4.18.10` fallback, `@virtuoso.dev/message-list@1.17.1`은 상용 라이선스라 참고만.

---

## 0. 현재 상태 진단

| 영역 | 현재 구현 | 문제 | 파일 |
|---|---|---|---|
| 채널 선택 | 채널 클릭 시 첫 topic으로 이동 | 활성 채널 표시 없음, 같은 채널 재클릭도 navigate 시도 | `apps/web/src/widgets/app-shell/ui/AppShell.tsx` |
| 메시지 로딩 | `api.listMessages(threadId)`가 전체 메시지 반환 | 대화가 커지면 DB/네트워크/DOM 모두 선형 증가 | `packages/api-client/src/client.ts:149`, `apps/api/src/chat/chat-message.store.ts:55` |
| 메시지 렌더 | `persisted.map(...)` 전체 DOM 렌더 | 1만 건 이상에서 렌더/hover/minimap/markdown 비용 폭증 | `apps/web/src/widgets/chat-thread/ui/ChatThread.tsx:265` |
| 스크롤 | `history.data/live` 변경마다 bottomRef로 smooth scroll | 과거 읽는 중 새 메시지/히스토리 prepend 시 위치가 튐 | `ChatThread.tsx:85` |
| 검색 이동 | 현재는 minimap querySelector + scrollIntoView | 가상화 후 DOM에 없는 메시지로 이동 불가 | `ChatThread.tsx:214` |
| 입력창 배경 | box/canvas/bar가 미묘하게 다르게 보일 수 있음 | 흰색 surface 통일 필요 | `ThreadView.module.css` |

---

## 1. 조사 요약: 채팅 가상화의 안정 조건

| 출처 | 확인한 핵심 | 적용 판단 |
|---|---|---|
| TanStack Blog, “Chat UIs Are Lists Until They Aren't” (2026-05-25) | 채팅은 일반 리스트와 달리 end-anchored. older history는 prepend, 새 메시지는 append, streaming 중 마지막 item height가 계속 변함. `anchorTo: 'end'`, stable item key, `followOnAppend`, `scrollEndThreshold`, end-distance helper가 핵심 | 1순위. 앱이 이미 TanStack Query/Router라 기술 계열이 맞음. 단 실제 설치 후 API 존재 여부를 typecheck로 확인해야 함 |
| Stream Chat `VirtualizedMessageList` | 고트래픽/긴 채널은 visible DOM만 유지. `defaultItemHeight`, unread/new message notification, `hasMore`, `hasMoreNewer`, `loadMore`, `loadMoreNewer`, `highlightedMessageId` 제공 | 제품 수준 요구사항 체크리스트로 사용. 직접 도입은 Stream SDK 의존도가 커서 부적합 |
| Virtuoso Message List | human/chatbot용 message list, declarative scroll control, auto-scroll, custom components. `@virtuoso.dev/message-list`는 상용 라이선스 | 상용 패키지는 제외. OSS `react-virtuoso`는 fallback 후보 |
| CSS Scroll Anchoring Module Level 1 | DOM 변화로 viewport가 밀리는 문제를 anchor node + scroll offset 조정으로 보정. `overflow-anchor`로 opt-out 가능 | 브라우저 anchoring과 virtualizer anchoring이 충돌할 수 있으므로 scroll container에는 명시 정책 필요 |
| Discord 공개 엔지니어링 | 메시지 저장은 대규모 분산 저장/시간순 조회 최적화가 핵심. UI 세부는 공개 자료 부족 | 우리 규모에서는 Postgres `(thread_id, created_at, id)` cursor index로 충분 |
| Slack/Kakao/Discord UI 일반 패턴 | 내부 구현은 대부분 비공개. 공개적으로 확인 가능한 공통 UX는 windowed DOM, cursor page, unread/latest anchor, search→jump→주변 page hydration | “특정 회사가 이렇게 한다”가 아니라 검증 가능한 공통 방법론으로 채택 |

결론: `map → virtualizer` 단독 변경 금지. 반드시 `서버 cursor API + stable key + prepend anchor + append follow condition + search hydrate`를 같이 넣어야 한다.

---

## 2. 불변식

### 2.1 채널 선택 불변식
1. 활성 채널은 항상 시각적으로 표시된다.
2. 활성 채널을 다시 눌러도 API, router navigate, scroll reset이 발생하지 않는다.
3. 프로젝트/채널 추가는 Slack-style flat row를 유지하되 120~180ms micro-motion만 쓴다.
4. `prefers-reduced-motion: reduce`에서는 모든 장식 모션을 제거한다.

### 2.2 채팅 스크롤 불변식
1. 최신 메시지 근처에 있을 때만 새 메시지를 따라간다.
2. 사용자가 위로 올라가 읽는 중이면 새 메시지가 와도 viewport를 끌어내리지 않는다.
3. 과거 메시지를 prepend해도 현재 읽던 메시지는 같은 시각 위치에 남는다.
4. streaming assistant 메시지가 길어져도 최신에 붙어 있던 사용자는 bottom pinned 상태를 유지한다.
5. 검색 결과로 이동할 때 해당 메시지 주변 page를 먼저 hydrate한 뒤 scrollToIndex/scrollToKey를 호출한다.
6. 위/아래 sentinel은 `isFetching` + cursor null + 요청 방향 lock으로 무한 호출을 막는다.
7. message key는 index가 아니라 DB message id다.
8. 대화별 scroll state는 threadId별로 분리된다.

---

## 3. 구현 계획

### Task 1: 채널 선택 상태/재클릭 무반응/모션 1차 적용

**Objective:** 즉시 체감되는 UX 결함을 수정한다.

**Files:**
- Modify: `apps/web/src/widgets/app-shell/ui/AppShell.tsx`
- Modify: `apps/web/src/widgets/app-shell/ui/AppShell.module.css`
- Modify: `apps/web/src/widgets/thread-view/ui/ThreadView.module.css`

**Steps:**
1. `useLocation()`으로 현재 `/t/$topicId` 추출.
2. 채널의 첫 topic id와 현재 topic id를 비교해 `channelActive` 계산.
3. active 채널에 `aria-current="page"`, `.chanRowActive` 적용.
4. active 채널 버튼은 `disabled` 처리하고 `openChannel`에서도 topicId 같으면 early return.
5. `.chanRowActive::before` active rail 추가.
6. project/channel/add trigger에 160ms transform/opacity micro-motion 추가.
7. composer/box/textarea/bar 배경을 `var(--bg-canvas)`로 통일.
8. `pnpm typecheck && pnpm lint`.
9. 브라우저 QA: active 표시, 재클릭 후 URL/메시지 위치 변화 없음, 입력창 배경 통일 확인.

**Status:** 이 계획 작성 시점에 1차 패치 적용 및 typecheck/lint GREEN.

---

### Task 2: 메시지 pagination contract 추가

**Objective:** 전체 메시지 반환 API를 cursor 기반으로 확장한다. 기존 API는 호환 유지.

**Files:**
- Modify: `packages/contracts/src/spaces.ts`
- Modify: `packages/api-client/src/client.ts`
- Modify: `apps/api/src/chat/chat-stream.controller.ts`
- Modify: `apps/api/src/chat/chat-message.store.ts`
- Test: API contract/store test 추가 또는 기존 테스트 확장

**API 설계:**

```ts
ListMessagesPageRequest = {
  limit?: number;           // default 50, max 100
  before?: string;          // message id or cursor
  after?: string;           // message id or cursor
  around?: string;          // search/jump target message id
  direction?: 'older' | 'newer';
}

ListMessagesPageResponse = {
  messages: ChatMessage[];  // ascending createdAt,id
  hasOlder: boolean;
  hasNewer: boolean;
  olderCursor: string | null;
  newerCursor: string | null;
  anchorMessageId?: string;
}
```

**DB query invariant:**
- 정렬 기준은 `(created_at, id)` 복합키.
- 기존 index `chat_messages_thread_idx(thread_id, created_at)`는 id tie-break가 약하므로 가능하면 `(thread_id, created_at, id)` 보강 마이그레이션.
- `before`: 현재 window의 가장 오래된 메시지보다 이전 page.
- `after`: 현재 window의 가장 최신 메시지보다 이후 page.
- `around`: target message 포함 ±N page.

**Acceptance:**
- 최신 thread 진입 시 마지막 50개만 반환.
- 184건 텔레그램 thread에서 latest page < 전체 184 DOM.
- before/after/around가 중복 없이 ascending order 유지.

---

### Task 3: 클라이언트 message window store 설계

**Objective:** TanStack Query가 page cache를 관리하고, UI는 평탄화된 sorted window만 본다.

**Files:**
- Create: `apps/web/src/widgets/chat-thread/model/useMessageWindow.ts`
- Modify: `apps/web/src/widgets/chat-thread/ui/ChatThread.tsx`

**State:**
```ts
type MessageWindowState = {
  pages: MessagePage[];
  messagesById: Map<string, ChatMessage>;
  orderedIds: string[];
  hasOlder: boolean;
  hasNewer: boolean;
  olderCursor: string | null;
  newerCursor: string | null;
  loadingOlder: boolean;
  loadingNewer: boolean;
}
```

**Rules:**
- 중복 message id는 항상 dedupe.
- optimistic/live turns는 persisted window와 별도 layer로 둔다.
- streaming 완료 후 invalidate가 아니라 `append/replace by id`로 최소 변화.
- `live`와 persisted가 중복되면 persisted가 우선.

---

### Task 4: Virtualizer spike

**Objective:** 실제 라이브러리 API를 확인하고, 작은 실험 컴포넌트로 prepend/append/streaming을 검증한다.

**Files:**
- Create: `apps/web/src/widgets/chat-thread/ui/VirtualMessageStream.spike.tsx` 또는 test sandbox
- Possibly add dependency: `@tanstack/react-virtual@3.14.5`

**Decision:**
- 1순위: `@tanstack/react-virtual`.
- 설치 후 실제 `anchorTo: 'end'`, `followOnAppend`, `computeItemKey`, `scrollToIndex/scrollToOffset`, `measureElement` 타입 확인.
- 만약 현재 stable package에 blog API가 없거나 불안정하면 fallback: `react-virtuoso@4.18.10`의 `Virtuoso`/`MessageList` 패턴 사용.
- `@virtuoso.dev/message-list`는 상용 라이선스라 도입하지 않음.

**Spike tests:**
1. 1,000개 mock message render 시 DOM node 수가 visible+overscan만 유지.
2. older 50개 prepend 후 anchor message 위치 변화가 2px 이내.
3. bottom pinned 상태에서 append 시 bottom 유지.
4. not pinned 상태에서 append 시 scroll 불변.
5. 마지막 assistant message 높이 증가 시 pinned 유지.

---

### Task 5: ChatThread를 virtualized stream으로 교체

**Objective:** 실제 메시지 UI를 가상화 리스트로 전환한다.

**Files:**
- Create: `apps/web/src/widgets/chat-thread/ui/VirtualMessageStream.tsx`
- Modify: `apps/web/src/widgets/chat-thread/ui/ChatThread.tsx`
- Modify: `apps/web/src/widgets/thread-view/ui/ThreadView.module.css`

**Implementation:**
- `MessageRow`를 별도 컴포넌트로 추출.
- `computeItemKey = message.id`.
- dynamic height 측정 연결.
- top threshold 진입 시 `loadOlder()`.
- bottom threshold/검색 mode에서 `loadNewer()`.
- `isAtEnd`일 때만 live append follow.
- “최신으로 이동” 버튼 추가: not-at-end + newer message 존재 시 표시.

---

### Task 6: 검색 후 양방향 hydrate + jump

**Objective:** DOM에 없는 메시지를 검색 결과에서 바로 찾고 주변 문맥을 양방향 로딩한다.

**Files:**
- API search endpoint는 별도 task: `GET /chat/threads/:id/messages/search?q=`
- Client model: `jumpToMessage(messageId)`

**Flow:**
1. 검색 결과는 message id + snippet + createdAt 반환.
2. 클릭 시 `listMessages({ around: messageId, limit: 50 })` 호출.
3. window를 해당 around page로 교체 또는 별도 search window mode 진입.
4. virtualizer가 target key/index를 찾은 뒤 center align scroll.
5. highlight를 1.6초만 표시.
6. 사용자가 위/아래로 움직이면 older/newer cursor로 양방향 로딩.
7. “최신으로 돌아가기”를 누르면 latest window로 전환.

**Risk:** search window와 live latest window가 섞이면 꼬임. 해결: `mode: 'latest' | 'around'`를 명시하고 mode별 cursor를 분리.

---

### Task 7: 무한 불러오기 방지 장치

**Objective:** scroll threshold가 계속 트리거되어 같은 page를 반복 호출하는 사고 방지.

**Guards:**
- `loadingOlder/loadingNewer` mutex.
- `hasOlder/hasNewer` false면 절대 호출 금지.
- 최근 요청 cursor set 보관: 같은 cursor 1초 내 중복 차단.
- 응답 messages.length === 0이면 해당 방향 cursor를 null 처리.
- virtualizer range가 바뀌어도 threshold가 실제로 crossed될 때만 호출.
- error 후 retry는 명시 버튼 또는 1회 backoff만.

---

### Task 8: QA/성능 검증

**Commands:**
```bash
pnpm typecheck
pnpm lint
pnpm build
```

**Browser QA:**
1. `창원시 컨설팅 → 텔레그램` 클릭: active 표시 생김.
2. 같은 채널 재클릭: URL 변화 없음, message scroll 변화 없음, 네트워크 호출 없음.
3. 프로젝트 접기/펼치기: 부드럽지만 과한 그림자 없음.
4. 프로젝트 추가/채널 추가: inline form 등장 애니메이션, reduced-motion에서 꺼짐.
5. 메시지 입력창: box/top/bar/textarea 모두 같은 흰 surface.
6. 184건 thread에서 초기 DOM 메시지 row가 184개 미만인지 확인. 1,000건 seed 후 visible DOM만 유지.
7. 위로 스크롤: older page 로드 후 현재 읽던 메시지 위치 유지.
8. 아래로 스크롤: newer page 로드, latest 버튼 상태 정상.
9. 검색 결과 클릭: target 주변 hydrate 후 center 이동 및 highlight.
10. streaming 답변: pinned일 때만 따라감.

**Metrics:**
- Initial message request payload: latest 50 only.
- DOM row count: visible + overscan, 목표 30~80.
- Prepend anchor drift: 2px 이내.
- Search jump completion: 300ms~800ms 내 target visible, 네트워크 상황 따라 예외.

---

## 4. 구현 순서와 커밋 단위

1. `fix: mark active channel and unify composer surface`
2. `feat(api): add cursor-paged message contract`
3. `feat(web): add message window query model`
4. `spike(web): validate chat virtualizer anchoring`
5. `feat(web): virtualize chat message stream`
6. `feat(chat): add message search jump hydration`
7. `test: harden chat scroll pagination invariants`

---

## 5. 주요 리스크

| 리스크 | 왜 위험한가 | 방지책 |
|---|---|---|
| index key 사용 | prepend 시 모든 index가 밀려 anchor 복구 실패 | DB message id만 key 사용 |
| CSS reverse/scaleY hack | 접근성/텍스트 선택/복사 순서 깨짐 | 금지. 정상 DOM 순서 유지 |
| browser scroll anchoring과 virtualizer 충돌 | 두 시스템이 서로 scrollTop 보정 | scroll container 정책 명시, virtualizer가 주도 |
| streaming height 증가 | 마지막 메시지가 커지며 bottom에서 밀림 | pinned 상태일 때만 end anchor follow |
| 검색 window와 latest window 혼합 | cursor가 꼬여 중복/누락 | `mode` 분리 |
| top sentinel 반복 호출 | 같은 cursor 무한 fetch | cursor lock + loading mutex + empty response cutoff |
| Markdown dynamic height | measure 지연으로 점프 | measureElement/ResizeObserver, default estimate 조정 |
| Minimap 전체 map 비용 | 가상화해도 preview 배열이 전체면 비용 유지 | minimap도 현재 window 기반으로 축소 또는 서버 summary |

---

## 6. 현재 1차 적용 내역

- 활성 채널 표시 추가 예정/적용: `.chanRowActive`, `aria-current="page"`.
- 같은 채널 재클릭 early return + disabled.
- 프로젝트/채널/add row micro-motion.
- composer 배경 통일.
- typecheck/lint GREEN 확인.

---

## 7. 다음 실행 판단

바로 다음은 Task 2다. 즉, 가상화 라이브러리부터 붙이지 말고 먼저 API를 cursor 기반으로 바꿔야 한다. 현재 API가 전체 messages를 반환하므로 이 상태에서 virtualizer만 붙이면 네트워크/메모리 비용은 그대로이고 DOM만 줄어드는 반쪽짜리 개선이다.
