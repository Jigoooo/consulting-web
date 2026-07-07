# Chat Runtime·Evidence·Library UI Debug/Fix Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task. Follow systematic-debugging + TDD: reproduce first, write RED tests, then fix.

**Goal:** 모델/명령어 정확도, 근거·첨부·검색·자료실·채팅 UI 문제를 실제 화면 증거 기반으로 고치고, 컨설팅 웹앱 톤에 맞는 신뢰형 UX로 고도화한다.

**Architecture:** 증상별 즉흥 패치가 아니라 `contracts → api-client → API → web UI → browser QA` 순서로 고친다. 데이터가 실제로 있는 상태와 없는 상태를 분리하고, 파일첨부/근거/기억/검색을 각각 별도 도메인으로 명확히 노출한다.

**Tech Stack:** pnpm monorepo, React 19 + TanStack Router/Query/Virtual, NestJS + Drizzle + Postgres, Vitest, Hermes Runs API proxy.

---

## 0. 현재 확인한 사실

- 대상 repo: `/home/jigoo/.hermes/workspace/consulting-web` (`master`). 현재 이미 많은 수정/미추적 파일이 있으므로 구현 전 `git status --short`를 재확인하고, 기존 변경을 덮어쓰지 않는다.
- 주요 관련 파일:
  - Runtime/model/commands: `apps/web/src/widgets/chat-thread/ui/ChatThread.tsx`, `ModelPickerSheet.tsx`, `apps/api/src/chat/hermes-runs-client.ts`, `packages/contracts/src/chat.ts`
  - 근거 패널: `apps/web/src/widgets/evidence-panel/ui/EvidencePanel.tsx`, `EvidencePanel.module.css`, `apps/api/src/chat/evidence.store.ts`
  - 보관함: `apps/web/src/widgets/app-shell/ui/AppShell.tsx`, `apps/web/src/lib/spaces.ts`, `apps/api/src/spaces/*`
  - 파일첨부/자료실: `apps/web/src/lib/collab.ts`, `ChatThread.tsx`, `VirtualMessageStream.tsx`, `apps/api/src/chat/attachments.controller.ts`, `packages/db-schema/src/schema/collab.ts`, `apps/web/src/routes/_app.library.tsx`
  - 검색: `apps/web/src/widgets/evidence-panel/ui/SearchResultsPanel.tsx`, `apps/web/src/widgets/chat-thread/model/searchStore.ts`, `apps/api/src/chat/chat-message.store.ts`
  - 날짜 chip/채팅 가독성: `VirtualMessageStream.tsx`, `ThreadView.module.css`, `apps/web/src/shared/lib/formatDate.ts`
  - 산출물 버튼: `apps/web/src/routes/_app.artifacts.tsx`, `apps/web/src/components/artifacts/Artifacts.module.css`
  - 우측 패널/초대: `AppShell.tsx`, `AppShell.module.css`
- 현재 코드상 관찰:
  - 모델 picker는 `/v1/models`의 `id/root`를 거의 그대로 표시한다. provider/model 분해가 없고 UI 문구도 “Hermes 모델 route”/“Hermes 기본”이라 사용자에게 “Hermes Agent”처럼 보일 수 있다.
  - slash 명령은 `HERMES_SLASH_COMMANDS` 하드코딩이고 `/help`는 실제 배열과 불일치할 수 있다. 파라미터 추천이 없다.
  - 근거 scope toggle은 프로젝트 근거 query가 `scope === 'project'`가 된 뒤 처음 시작된다. 첫 전환 때 빈/로딩/레이아웃 깜박임 가능성이 있다.
  - 보관함은 `isError`와 empty state가 분리되어 있지만, API/contract/network 실패인지 “0건”인지 사용자가 구분하기 어렵다.
  - 파일첨부는 `onPickFile()`에서 즉시 thread attachment로 업로드만 하고, `chat_messages`와 연결하지 않는다. schema에도 `file_attachments.message_id`가 없다.
  - 근거 row는 상세 보기 없이 ref/excerpt/url 일부만 노출한다.
  - 검색 결과는 대화만 지원한다. 우측 검색 리스트는 단일 flat list이고 파일/근거 탭이 없다.
  - 검색 종료 UX는 input 삭제 또는 `JumpToLatest()`의 부작용에 의존한다.
  - 기억(GraphRAG/프로젝트 메모리)은 backend에서 prompt context로 들어가지만 사용자가 볼 수 있는 실제 연결 상태 UI가 없다.
  - AppShell의 우측 context panel은 모든 route에서 항상 차지한다. 자료실/산출물 화면과 파일 뷰어가 좁아질 수 있다.

---

## 1. 우선순위 / 작업 축

| P | 축 | 포함 이슈 | 이유 |
|---|---|---|---|
| P0 | 실제 재현·스크린샷 기준선 | 전체, 특히 채팅 가독성/자료실 | 주인님이 “렌더링된 걸 스크린샷으로 확인” 요구 |
| P1 | 모델·명령어 정확도 | 1번 | 잘못된 provider/model 표시는 신뢰 직접 손상 |
| P1 | 첨부≠근거, 첨부=메시지 | 파일첨부 1, 근거상세 2 | 현재 도메인 경계가 사용자 기대와 다름 |
| P1 | 검색 이동/종료/파일검색 | 검색 6~8 | 일상 사용성 핵심, 현재 상태 전환이 헷갈림 |
| P2 | 근거 scope flicker·보관함 empty/error | 근거탭 2, 보관함 3 | 데이터 없음과 장애를 분리해야 함 |
| P2 | 우측 패널/자료실 레이아웃 | 10 | 화면 낭비/좁아짐 직접 해결 |
| P2 | 기억 표시 UI | 9 | “실제로 연결됨” 신뢰 표시 |
| P3 | 날짜 chip/채팅 리스트/산출물 버튼 톤 | 3~5 | polish지만 화면 인상이 크게 달라짐 |

---

## 2. Phase A — 재현·증거 수집 먼저

### Task A1: 브라우저 QA 기준선 캡처

**Objective:** 수정 전 화면/콘솔/네트워크 증거를 남긴다.

**Files:**
- Evidence output only: `.hermes/qa/2026-07-07-chat-ui-baseline/`

**Steps:**
1. 현재 dev/prod URL 확인: 우선 `http://127.0.0.1:5273` dev, prod는 `http://127.0.0.1:8088`.
2. 앱이 떠 있지 않으면 user-owned dev server 원칙을 지켜 기존 프로세스 확인 후 새 서버는 별도 포트로 띄운다.
3. 다음 화면을 1440×1000, 1280×900 두 폭으로 캡처:
   - 채팅 thread: 기본, 검색 중, search result 선택 후, 파일첨부 후, 긴 대화 스크롤 중 날짜 chip
   - 근거 패널: 이 채널 → 프로젝트 전체 첫 전환
   - 보관함: 0건, API 실패/mock 실패
   - 자료실: 파일 viewer open, AppShell 우측 context 노출 상태
   - 산출물: 새 산출물/새 버전 버튼 hover
4. 콘솔 오류와 network 실패를 함께 저장한다.

**Commands:**
```bash
/home/jigoo/agent-tools/hermes-cli-tools/bin/hermes-playwright screenshot http://127.0.0.1:5273 --output .hermes/qa/2026-07-07-chat-ui-baseline/home-1440.png --width 1440 --height 1000
```
상호작용은 browser tool 또는 Playwright script로 보완한다.

**Exit criteria:** 수정 전/후 비교 가능한 스크린샷이 최소 8장 있다.

### Task A2: API shape 실측

**Objective:** 모델 목록/보관함/자료실/search 응답 shape를 추측하지 않고 확인한다.

**Commands:**
```bash
pnpm --filter @consulting/api test -- hermes-graphrag-instructions.test.ts
# 필요 시 mocked test 추가 전 현재 실패/성공 확인
```

**Probe targets:**
- `GET /chat/runtime/models`
- `GET /chat/runtime/capabilities`
- `GET /spaces/workspaces/:workspaceId/archive`
- `GET /library/workspaces/:workspaceId/sources`
- `GET /chat/threads/:threadId/messages/search?q=`

**Exit criteria:** 각 API의 정상/빈값/실패 상태가 구분되어 기록된다.

---

## 3. Phase B — 모델 변경/명령어 정확도

### Task B1: Runtime model contract 확장 테스트(RED)

**Objective:** provider/model을 “Hermes Agent”가 아니라 실제 provider/model로 표시할 수 있게 계약을 먼저 고정한다.

**Files:**
- Modify test: `packages/contracts/test/chat-contract.test.ts`
- Modify: `packages/contracts/src/chat.ts`

**Test cases:**
- `ChatRuntimeModelSchema` accepts `{ id, label, provider, modelName, route }`.
- `label`은 UI 표시용이고 `id/route`는 실제 request body `model`로 전달된다.
- 기존 `{ id, label, root }` shape도 호환된다.

**Expected RED:** `provider/modelName/route` unknown key로 fail.

### Task B2: HermesRunsClient 모델 정규화(RED→GREEN)

**Objective:** `/v1/models` upstream shape가 달라도 UI에는 `gpt-5.5 · openai-codex`처럼 표시한다.

**Files:**
- Modify: `apps/api/src/chat/hermes-runs-client.ts`
- Modify test: `apps/api/test/hermes-graphrag-instructions.test.ts` 또는 새 `apps/api/test/hermes-runtime-models.test.ts`

**Normalization rules:**
1. upstream item에 `provider`/`model`이 있으면 최우선 사용.
2. `id`가 `provider:model` 또는 `provider/model`이면 분해.
3. `root`가 `provider/model`이고 `id`가 alias면 `modelName=id`, `provider`는 root에서 추출.
4. `id` 또는 `label`이 `Hermes Agent`/`Hermes`처럼 agent brand이면 모델명으로 쓰지 않고 `defaultModel`/capabilities/status에서 보강한다.
5. request body에는 반드시 `route`/`id`를 보낸다. 사람이 보는 label과 전송 파라미터를 분리한다.

**Verification:**
```bash
pnpm --filter @consulting/api test -- hermes-runtime-models.test.ts
pnpm --filter @consulting/contracts test
```

### Task B3: ModelPickerSheet UI 문구 교정

**Objective:** 사용자가 “Hermes Agent”가 아니라 “gpt-5.5 / openai-codex”를 보게 한다.

**Files:**
- Modify: `apps/web/src/widgets/chat-thread/ui/ModelPickerSheet.tsx`
- Modify: `apps/web/src/widgets/chat-thread/ui/ChatThread.tsx`

**UI copy:**
- title: `모델 변경`
- description: `다음 답변에 사용할 모델을 고릅니다. provider 설정/비밀키는 브라우저에 노출하지 않습니다.`
- hero: `현재 모델: gpt-5.5 · openai-codex`
- small: `전송 파라미터: <route>`
- fallback: `기본 모델` 대신 실제 default label. 실제값이 없을 때만 `기본값 확인 중`.

### Task B4: Slash command registry로 “정확한 파라미터 추천” 구현

**Objective:** `/help`, slash palette, command 실행 로직이 같은 source of truth를 쓰게 한다.

**Files:**
- Create: `apps/web/src/widgets/chat-thread/model/runtimeCommands.ts`
- Modify: `apps/web/src/widgets/chat-thread/ui/ChatThread.tsx`

**Registry example:**
```ts
export const RUNTIME_COMMANDS = [
  { command: '/model', args: '[모델 route]', supported: true, hint: '/model 또는 /model gpt-5.5' },
  { command: '/status', args: '', supported: true, hint: '현재 run 상태' },
  { command: '/usage', args: '', supported: true, hint: '마지막 run 사용량' },
  { command: '/stop', args: '', supported: true, hint: '진행 중인 run 중단' },
  { command: '/help', args: '[명령어]', supported: true, hint: '명령 도움말' },
  { command: '/commands', args: '', supported: true, hint: '웹 지원 명령 목록' },
] as const;
```

**Rules:**
- 웹에서 실제 동작하지 않는 `/config`, `/tools`, `/cron` 등은 추천하지 않는다. 필요하면 “TUI 전용” 섹션에 설명만 둔다.
- `/model <route>`가 들어오면 route exact match일 때 즉시 선택, 아니면 sheet를 열고 검색어를 채운다.
- `/help /model`은 파라미터와 예시를 toast가 아니라 command panel/inline help로 보여준다.

**Tests:**
- Create: `apps/web/src/widgets/chat-thread/model/runtimeCommands.test.ts`
- Verify command parse: `/model gpt-5.5`, `/usage`, unknown command.

---

## 4. Phase C — 근거 scope flicker, 근거 상세, 보관함

### Task C1: 근거 scope 전환 깜박임 재현 테스트/시각 기준

**Objective:** “이 채널 ↔ 프로젝트 전체” 첫 전환에서 빈 상태가 잠깐 보이는지 확인한다.

**Files:**
- Modify: `apps/web/src/widgets/evidence-panel/ui/EvidencePanel.tsx`
- Modify: `apps/web/src/lib/collab.ts`

**Fix design:**
- `useProjectEvidence(projectId, enabled)`에 `placeholderData: keepPreviousData` 또는 prefetch 적용.
- `scope` 변경 시 즉시 빈 state를 렌더하지 말고, `isFetching && !data`일 때만 skeleton.
- tab content area에 `min-height`를 줘 높이 jump 방지.
- scope 버튼 `onMouseEnter/onFocus`에서 project evidence prefetch.

**Acceptance:** 첫 전환에서 row area가 “빈 근거”로 깜박이지 않고, 로딩 affordance 또는 이전 content 유지.

### Task C2: 근거 상세 sheet/expand 구현

**Objective:** 근거 row를 눌렀을 때 상세 내용/출처/연결 메시지를 볼 수 있게 한다.

**Files:**
- Modify: `apps/web/src/widgets/evidence-panel/ui/EvidencePanel.tsx`
- Modify: `apps/web/src/widgets/evidence-panel/ui/EvidencePanel.module.css`
- Optional contract/API if needed: `packages/contracts/src/collab.ts`, `apps/api/src/chat/evidence.store.ts`

**UI:**
- row는 `<button>`로 변경.
- detail sheet fields: `sourceType`, `ref`, full `excerpt`, `url`, `createdAt`, `messageId`, `runId`.
- actions: `출처 열기`, `관련 답변으로 이동`, `복사`.
- sourceType=file이면 attachment/file viewer 연결은 Phase D의 attachment linkage 이후 추가.

### Task C3: 보관함 empty/error 분리

**Objective:** “내용이 없음”은 에러처럼 보이지 않게, 실제 fetch 실패만 error로 표시한다.

**Files:**
- Modify: `apps/web/src/widgets/app-shell/ui/AppShell.tsx`
- Modify: `apps/web/src/widgets/app-shell/ui/AppShell.module.css`
- Verify: `apps/api/src/spaces/spaces.controller.ts`, `space-read.service.ts`, `packages/contracts/src/spaces.ts`

**Behavior:**
- 0건: neutral empty `보관한 항목이 아직 없어요` + 작은 설명.
- 실패: `보관함을 불러오지 못했어요` + `다시 시도` 버튼 + console/network detail은 개발자만.
- dialog 열 때 query refetch, 닫을 때 state 유지.
- `archiveOpen` 첫 open 전에 `selected` 없는 경우 버튼 disabled reason 표시.

**Tests:**
- API: archived list with 0 rows returns `{ items: [] }` 200.
- UI logic: error state only when query `isError`.

---

## 5. Phase D — 파일첨부를 “메시지”로 만들고 근거와 분리

### Task D1: DB/contract RED — attachment ↔ chat message linkage

**Objective:** 첨부가 thread 자료가 아니라 특정 사용자 메시지에 붙을 수 있게 한다.

**Files:**
- Modify: `packages/db-schema/src/schema/collab.ts`
- New migration: `packages/db-schema/drizzle/0011_attachment_message_link.sql`
- Modify: `packages/contracts/src/collab.ts`, `packages/contracts/src/spaces.ts`, `packages/contracts/src/chat.ts`
- Modify tests: `packages/contracts/test/*`

**Schema option:**
- Preferred minimal: add nullable `message_id uuid references chat_messages(id) on delete set null` to `file_attachments`.
- Add index: `(thread_id, message_id, created_at)`.

**Contract changes:**
- `ChatMessageSchema.attachments?: AttachmentSummary[]` or `attachmentIds?: string[]` + `attachmentCount`.
- `ChatStreamRequestSchema.attachmentIds?: uuid[]`.
- `UploadAttachmentResponseSchema` returns `AttachmentSummary` or enough summary for draft chip.

### Task D2: API RED — send with attachment IDs persists message bubble linkage

**Objective:** 파일 선택 후 전송하면 user message row와 attachment가 함께 보인다.

**Files:**
- Modify: `apps/api/src/chat/chat-stream.controller.ts`
- Modify: `apps/api/src/chat/chat-message.store.ts`
- Modify: `apps/api/src/chat/attachments.controller.ts`
- Modify: `apps/api/src/chat/document-extraction.service.ts`
- New test: `apps/api/test/attachment-message-link.test.ts`

**Flow:**
1. User uploads file: attachment row `message_id = null`.
2. User sends message with `attachmentIds`.
3. API validates: same `threadId`, same workspace, uploader can write, attachment not deleted, `message_id is null` or belongs to same draft.
4. API persists user `chat_messages` row.
5. API updates attachments `message_id = userMessage.id`.
6. Hermes prompt includes concise file summaries/extracted text only for attached files, with size/token caps.
7. Attachment does **not** become `evidence_items` unless user explicitly chooses “근거로 등록”.

**RED expectation:** current schema cannot link attachment to message.

### Task D3: Web composer draft attachments

**Objective:** 파일 선택 즉시 “근거”가 아니라 전송 대기 attachment chip으로 보인다.

**Files:**
- Modify: `apps/web/src/widgets/chat-thread/ui/ChatThread.tsx`
- Modify: `apps/web/src/widgets/thread-view/ui/ThreadView.module.css`
- Modify: `apps/web/src/lib/collab.ts`
- Modify: `apps/web/src/widgets/chat-thread/ui/VirtualMessageStream.tsx`

**UI behavior:**
- File pick → upload → draft chip in composer: filename, size, status, remove button.
- Send enabled when `input.trim()` OR draftAttachments length > 0.
- Empty text + file → message content fallback: `파일 첨부: <fileName>`.
- User bubble renders file cards inline under text.
- Thread-level file strip may remain as “이 대화의 업로드 문서” but visually separate from composer draft.

**Acceptance:** 파일만 보냈을 때 채팅 stream에 사용자 메시지 bubble이 생기고, 근거 패널에는 자동 추가되지 않는다.

---

## 6. Phase E — 검색 UX: 종료, 이동, 파일 탭

### Task E1: 검색 상태 전환 모델 정리

**Objective:** input 삭제 외에도 명시적 종료가 가능하게 한다.

**Files:**
- Modify: `apps/web/src/widgets/chat-thread/model/searchStore.ts`
- Modify: `apps/web/src/widgets/chat-thread/ui/ChatThread.tsx`
- Modify: `apps/web/src/widgets/thread-view/ui/ThreadView.module.css`

**Behavior:**
- 검색 input 안에 `X 검색 종료` 버튼.
- `Esc`: 첫 번째 Esc는 검색 종료 + highlight 제거, 두 번째 Esc는 blur.
- `JumpToLatest`: 검색 종료와 최신 이동을 분리한다. 버튼 label이 `검색 종료`인지 `최신으로`인지 현재 mode에 따라 명확해야 한다.
- 검색 중이라는 mode chip: `검색 중 · n개 결과 · 종료`.

### Task E2: “밑으로 가기” 이상 동작 재현/수정

**Hypotheses:**
1. search-around window에서 `JumpToLatest()`가 검색 state를 먼저 clear하고 `resetToLatest()`까지 해서 사용자가 “되돌아감”처럼 느낀다.
2. bottom sentinel의 `hasNewer` auto-load가 search jump 후 즉시 발동한다.
3. `targetMessageId`와 `history.mode === 'around'`가 동시에 남아 재센터링한다.

**Files:**
- Modify: `apps/web/src/widgets/chat-thread/ui/ChatThread.tsx`
- Modify: `apps/web/src/widgets/chat-thread/model/useMessageWindow.ts`
- Modify tests: `apps/web/src/widgets/chat-thread/model/messageWindow.test.ts`

**Fix design:**
- `exitSearch({ keepPosition: true })`와 `jumpToLatest()`를 별도 함수로 분리.
- 검색 결과 이동 후 아래 버튼은 `최신 대화로 이동`으로 표시하고, 누르면 검색 종료 여부를 작은 inline confirm/secondary action으로 분리하거나 한 번에 하되 label을 명시.
- search mode에서는 bottom auto-load를 사용자가 명시적으로 누를 때까지 억제.

### Task E3: 우측 검색 결과 탭 — 대화/파일/근거

**Objective:** 검색 결과가 구분되고, 파일도 검색된다.

**Backend option:**
- Minimal: extend library API with `threadId` filter and reuse document extraction ILIKE.
- Better: new endpoint `GET /chat/threads/:threadId/search?q=` returning:
```ts
{
  messages: MessageSearchHit[];
  files: AttachmentSearchHit[];
  evidence: EvidenceSearchHit[];
}
```

**Files:**
- Modify contracts: `packages/contracts/src/spaces.ts` or new `packages/contracts/src/search.ts`
- Modify API: `apps/api/src/chat/chat-stream.controller.ts`, `chat-message.store.ts`, `apps/api/src/library/library.store.ts`
- Modify web: `apps/web/src/widgets/evidence-panel/ui/SearchResultsPanel.tsx`, `EvidencePanel.module.css`

**UI:**
- Tabs: `대화`, `파일`, `근거`.
- Each row has visible separator/card surface, title, snippet, source meta, date.
- Selected row uses left rail + soft background, not only tight outline.
- File row opens `FileViewer`; evidence row opens Evidence detail; message row jumps to message.

---

## 7. Phase F — 기억 표시 UI (실제 동작 기반)

### Task F1: Backend emits memory context status event

**Objective:** 실제 GraphRAG/프로젝트 기억이 연결됐을 때만 UI가 표시되게 한다.

**Files:**
- Modify: `packages/contracts/src/chat.ts`
- Modify: `apps/api/src/chat/chat-stream.controller.ts`
- Modify: `apps/api/src/consulting/consulting-memory-context.builder.ts`
- Modify: `apps/api/test/consulting-memory-context.builder.test.ts`

**Contract:**
```ts
{ type: 'memory', runId, status: 'loading' | 'connected' | 'empty' | 'error', sourceCount?: number, summary?: string }
```

**Rules:**
- 내부 path/DB/table명 노출 금지.
- `memoryContext.build()` 결과가 실제로 비어 있으면 `empty`.
- 실패하면 답변은 계속하되 `기억 연결 실패`를 작게 표시.

### Task F2: Web memory indicator

**Files:**
- Modify: `apps/web/src/widgets/chat-thread/ui/ChatThread.tsx`
- Modify: `apps/web/src/widgets/chat-thread/ui/RunStatusBar.tsx`
- Modify: `apps/web/src/widgets/thread-view/ui/ThreadView.module.css`

**UI:**
- Composer 위 또는 header status: `기억 연결 중…` → `프로젝트 기억 5개 연결됨`.
- 클릭 시 popover: `기존 대화`, `업로드 문서`, `근거` 등 source category count만 표시.
- 답변 bubble 주변에 “이 답변은 프로젝트 기억을 참고함” 작은 badge.

**Acceptance:** 실제 memory event 없으면 표시하지 않는다.

---

## 8. Phase G — 날짜 chip, 채팅 가독성, 산출물 버튼 톤

### Task G1: 날짜 범위 chip formatter TDD

**Objective:** 상단 sticky date chip이 현재 viewport 범위에 맞게 표시된다.

**Files:**
- Modify: `apps/web/src/shared/lib/formatDate.ts`
- Modify test: `apps/web/src/shared/lib/formatDate.test.ts`
- Modify: `apps/web/src/widgets/chat-thread/ui/VirtualMessageStream.tsx`

**Formatter behavior:**
- 오늘: `오늘 · 7월 7일`
- 어제: `어제 · 7월 6일`
- 같은 해 과거: `7월 1일`
- 다른 해: `2025년 12월 31일`
- viewport first/last가 같은 날짜: 단일 label.
- 다른 날짜 범위: `7월 1일–7월 7일`, 다른 해면 `2025년 12월 31일–2026년 1월 2일`.
- divider는 더 명확하게 `2026년 7월 7일 화요일` 같은 full label 사용 검토.

**Implementation:** `virtualItems[0]`와 `virtualItems.at(-1)`의 createdAt을 모두 읽어 range label을 만든다.

### Task G2: 채팅 리스트/메시지 가독성 스크린샷 기반 조정

**Objective:** 실제 렌더링에서 폰트, 자간, 배경 대비, 줄간격을 조정한다.

**Files:**
- Modify: `apps/web/src/widgets/thread-view/ui/ThreadView.module.css`
- Check: `apps/web/src/shared/config/fonts.css`, `apps/web/src/styles/tokens.css`

**Initial design direction:**
- Message body: Wanted Sans 유지, body text `14.5px~15px`, line-height `1.62`, letter-spacing `-0.01em` 이하.
- Meta/time은 더 작고 흐리게, 메시지 본문 대비 우선.
- Background는 canvas/panel/card 3단만 사용. 불필요한 nested surface 줄이기.
- Assistant/user bubble은 “카드 박스”보다 flat row + hover action 방식 유지하되 row 구분선/spacing을 정돈.
- Search focused message는 타이트한 outline 대신 `soft bg + left rail + short pulse`.

**Verification:** before/after screenshot side-by-side.

### Task G3: 산출물 버튼 tone 정리

**Objective:** “새 산출물/새 버전/PDF/DOCX/취소” 버튼 hover에서 글자가 안 보이는 문제를 제거한다.

**Files:**
- Modify: `apps/web/src/components/artifacts/Artifacts.module.css`
- Optional shared component migration: `apps/web/src/shared/ui/button/Button.tsx`

**Rules:**
- `.newBtn`이 `Button variant="primary"`를 override하며 `color: var(--accent); background: var(--accent-soft)`로 충돌한다. shared `Button` variant를 믿거나 artifact-specific `secondaryAccent` class로 명확히 분리.
- hover state에 `color`를 반드시 지정한다.
- 컨설팅 톤: 과한 glow 대신 `border-color + subtle surface`.

---

## 9. Phase H — 우측 패널, 자료실 레이아웃, 초대 패널 숨김

### Task H1: AppShell context panel collapse state

**Objective:** 우측 context panel을 항상 띄우지 않고 필요할 때 열 수 있게 한다.

**Files:**
- Modify: `apps/web/src/widgets/app-shell/ui/AppShell.tsx`
- Modify: `apps/web/src/widgets/app-shell/ui/AppShell.module.css`

**Behavior:**
- AppShell state: `contextOpen`, persisted in localStorage.
- active thread route(`/th/`)에서는 default open 가능, library/artifacts에서는 default collapsed.
- Header/right rail에 `패널 열기/닫기` button.
- CSS grid: context closed이면 `grid-template-columns: rail sidebar minmax(...) 0`, context panel `width:0; overflow:hidden; border:0`.
- `@media (max-width: 1120px)`에서는 drawer sheet로 열기.

### Task H2: 멤버/초대 패널 분리

**Objective:** 초대 panel은 계속 보이지 않고 버튼으로 열리게 한다.

**Files:**
- Modify: `AppShell.tsx`, `AppShell.module.css`

**UI:**
- Members tab: member list + `초대 링크 만들기` button.
- Click → small accordion/sheet with role segmented control + generate button.
- Invite link 생성 후에만 link panel 표시.

### Task H3: 자료실 FileViewer 레이아웃

**Objective:** 자료실을 열었을 때 우측 레이아웃 부족/스크롤 내려감 해소.

**Files:**
- Modify: `apps/web/src/routes/_app.library.tsx`
- Modify: `apps/web/src/components/library/Library.module.css`
- Modify: `AppShell.tsx` route-aware context close.

**Design:**
- Library page 자체는 `list + detail` 2-pane로 충분한 폭 확보.
- FileViewer는 center 내부 overlay/sheet 또는 detail pane로 열되, AppShell context는 닫힘.
- 1280px에서는 list가 360px 이하로 줄지 않고, viewer는 horizontal overflow 없이 표시.

---

## 10. Phase I — 검증 게이트

### Narrow tests

```bash
pnpm --filter @consulting/contracts test
pnpm --filter @consulting/api test -- hermes-runtime-models.test.ts
pnpm --filter @consulting/api test -- attachment-message-link.test.ts
pnpm --filter @consulting/api test -- phase2-collab.test.ts
pnpm --filter @consulting/web test -- src/shared/lib/formatDate.test.ts
pnpm --filter @consulting/web test -- src/widgets/chat-thread/model/messageWindow.test.ts
pnpm --filter @consulting/web test -- src/widgets/chat-thread/model/runtimeCommands.test.ts
```

### Type/build gates

```bash
pnpm --filter @consulting/contracts build
pnpm --filter @consulting/api typecheck
pnpm --filter @consulting/web typecheck
pnpm typecheck
```

### Browser QA gates

Must verify with screenshots:
1. Model picker shows `gpt-5.5 · openai-codex` or true provider/model, not `Hermes Agent`.
2. `/model`, `/help /model`, `/status`, `/usage`, `/stop` give correct parameter guidance.
3. Evidence scope first switch has no empty flicker.
4. Archive empty state is neutral; forced API failure is visually distinct and has retry.
5. File-only send creates a user message bubble with file card; evidence panel unchanged.
6. Evidence row opens detail and can jump/open/copy.
7. Search panel tabs show 대화/파일/근거; row separation and selected state are visible.
8. Search exit works via X/Esc; “최신으로” button no longer feels like bouncing back.
9. Memory indicator appears only when backend emits real memory status.
10. 자료실 at 1280/1440 width: no cramped right panel; invite panel hidden until opened.
11. Chat readability before/after screenshot improves font/spacing/background.
12. Artifact buttons hover maintain contrast.

---

## 11. Risks / 주의점

- **Dirty repo:** 현재 repo에 기존 작업이 많다. 구현 전 `git diff --name-only`로 충돌 파일을 확인하고, unrelated 변경은 건드리지 않는다.
- **Contracts first:** contracts 변경 후 `api-client` build/typecheck를 반드시 통과해야 web 비교식/타입이 깨지지 않는다.
- **첨부 migration:** `file_attachments.message_id` 추가는 기존 첨부에 null을 허용해야 한다. 기존 자료실 목록이 깨지면 안 된다.
- **실제 기억 표시:** memory UI는 fake badge 금지. backend event 없으면 표시하지 않는다.
- **검색 auto-load:** search-around mode에서 sentinel 자동 로딩을 잘못 건드리면 가상 스크롤 품질이 퇴보한다. `messageWindow.test.ts`를 먼저 보강한다.
- **UI polish는 스크린샷 검증:** CSS 감으로 끝내지 말고 최소 2개 viewport에서 비교한다.

---

## 12. 실행 순서 추천

1. Phase A 기준선 캡처/실측.
2. Phase B 모델·명령어 정확도.
3. Phase D 첨부=메시지 linkage.
4. Phase E 검색 state/files tabs.
5. Phase C 근거/보관함 안정화.
6. Phase F 기억 indicator.
7. Phase H 레이아웃 collapse.
8. Phase G visual polish.
9. Phase I 전체 gate + after screenshot report.

이 순서가 좋은 이유: 도메인/contract를 먼저 고쳐야 UI polish가 재작업되지 않는다.
