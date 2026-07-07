# Consulting Web UI/UX·애니메이션 안정화 수정 계획

- 작성일: 2026-07-07 20:32 KST
- 범위: **계획 수립만**. 구현/코드 수정은 하지 않음.
- 대상 repo: `/home/jigoo/.hermes/workspace/consulting-web`
- 확인 URL: `http://127.0.0.1:5273`
- 브라우저 QA 계정: `UIQA 20260707` 테스트 세션 사용. 비밀번호는 기록하지 않음.

## 0. 브라우저 QA와 코드 매핑 근거

### 직접 확인한 화면 현상

1. 우측 근거 패널
   - `근거 추가` → `취소` → `프로젝트 전체` 전환 플로우에서 우측 패널 내부가 여러 height/opacity 전환을 동시에 수행한다.
   - 빈 상태/폼/추가 버튼/범위 전환이 같은 세로 영역에서 재배치되어 정신없이 보인다.
2. 자료실/산출물/보관함 네비게이션
   - 좌측의 `산출물 보관함`, `자료실`, `보관함`이 모두 보관/자료 의미를 섞어 쓰며 초심자에게 구분이 약하다.
   - `자료실`은 중앙 채팅 대신 별도 페이지로 열리지만 현재 채널로 돌아가는 명시 버튼이 없다.
   - `산출물 보관함`은 중앙 채팅을 대체하고, 현재 채널 복귀 경로가 약하다.
3. 인라인 생성 입력
   - `프로젝트 추가` 입력을 열어둔 상태에서 채널/프로젝트/모델 시트로 이동해도 입력이 남아 있다. 브라우저 QA에서 재현됨.
4. 모델 변경 시트
   - 상단 셀렉트박스와 아래 모델 카드 목록이 같은 일을 중복 수행한다.
   - API 기준 현재 모델 route는 3개만 반환됨: `anthropic/claude-opus-4-8`, `openai-codex/gpt-5.5`, `anthropic/claude-sonnet-5`.
   - 선택 행은 선/연한 배경 정도라 빠르게 보면 선택 상태가 약하다.
5. 검색/우측 패널
   - 우측 패널이 접힌 상태에서 검색해도 부모 `AppShell`이 자동으로 펼쳐지지 않는다.
   - 검색 종료는 입력값 삭제에 의존한다. 별도 `검색 취소` UX가 없다.
6. 채팅 초기 로딩/전환
   - 현재 스켈레톤은 `history.isLoading`이 300ms 이상일 때만 표시되고, 최소 표시 시간이 없다.
   - 스켈레톤과 실제 메시지가 같은 안정된 슬롯에서 교체되지 않아 채널 전환 시 가상 리스트/스크롤 보정과 함께 레이아웃 쉬프팅이 보일 수 있다.
7. 대화 미니맵
   - 미니맵 점 클릭은 DOM에 존재하는 `[data-turn]`만 `scrollIntoView` 한다. 가상 리스트에서 아직 렌더되지 않았거나 로드되지 않은 메시지는 이동하지 않을 수 있다.
8. 텍스트/배지 대비
   - 자료실/근거/검색/마크다운 코드 배지가 서로 다른 토큰 조합을 쓰며 일부는 배경과 글자 대비가 낮아질 수 있다. 특히 `itemType`, `srcType`, `searchRowKind`, inline `code` 계열은 명시 대비 규칙이 필요하다.

### 주요 관련 파일

- 앱 프레임/좌측 네비/우측 패널: `apps/web/src/widgets/app-shell/ui/AppShell.tsx`, `AppShell.module.css`
- 채팅/검색/모델/미니맵: `apps/web/src/widgets/chat-thread/ui/ChatThread.tsx`, `VirtualMessageStream.tsx`, `ConvoMinimap.tsx`, `ModelPickerSheet.tsx`
- 메시지 윈도우/검색 상태: `apps/web/src/widgets/chat-thread/model/useMessageWindow.ts`, `searchStore.ts`
- 근거 패널: `apps/web/src/widgets/evidence-panel/ui/EvidencePanel.tsx`, `EvidencePanel.module.css`, `SearchResultsPanel.tsx`
- 자료실/산출물: `apps/web/src/routes/_app.library.tsx`, `_app.artifacts.tsx`, `apps/web/src/components/library/Library.module.css`
- 파일 뷰어/다이얼로그 애니메이션: `apps/web/src/widgets/file-viewer/ui/FileViewer.tsx`, `FileViewer.module.css`, `apps/web/src/shared/ui/dialog/Dialog.css`
- 스켈레톤 delay hook: `apps/web/src/shared/lib/useDelayedFlag.ts`
- 마크다운/코드 대비: `apps/web/src/shared/ui/markdown/Markdown.module.css`, `CodeBlock.module.css`
- 디자인 토큰: `apps/web/src/styles/tokens.css`
- 모델 목록 API 병합: `apps/api/src/chat/hermes-runs-client.ts`

## 1. 우선순위별 수정 목표

### P0 — 즉시 체감되는 불편 제거

1. 보이지 않는 텍스트/배지 대비 보정
2. 인라인 생성 입력 자동 닫힘
3. 모델 변경 시트 중복 셀렉트 제거
4. 검색 시 우측 패널 자동 열림 + 검색 취소 추가
5. 채팅 초기 로딩 스켈레톤 안정화

### P1 — 모션/레이아웃 안정화

1. 근거 추가/취소/범위 전환 애니메이션 정리
2. 우측 패널 접힘/펼침에 따른 채팅 lane 이동 최소화
3. 자료실/파일 뷰어 닫기 애니메이션을 우측 drawer 방향으로 일관화
4. 채널 이동 시 가상 리스트 첫 렌더/스크롤 보정 중 화면 흔들림 제거

### P2 — 네비게이션 의미/복귀 동선 개선

1. `산출물 보관함`/`자료실`/`보관함` 명칭 재정의
2. 자료실·산출물에서 “이전 채널로 돌아가기” 제공
3. 산출물/자료실 진입 후 현재 채널 맥락 보존

### P3 — 긴 대화 UX 보정

1. 미니맵을 가상 리스트/미로드 메시지에도 동작하게 개선
2. 검색 선택/미선택 행 디자인 차이를 명확히 함
3. 긴 채팅방 이동 시 placeholder/scroll restoration을 통합

## 2. 상세 구현 계획

### 2.1 텍스트/배지 대비 시스템화

#### 문제
- `Library.module.css`의 `.itemType`, `EvidencePanel.module.css`의 `.srcType`, `.searchRowKind`, `Markdown.module.css`의 inline `.md code`가 각자 배경/글자색을 정한다.
- 라이트/다크/강조 배경 위에서 일부 조합은 사용자가 말한 “텍스트라고 감싸진 부분이 배경과 같아 안 보임” 현상으로 이어질 수 있다.

#### 수정
1. `tokens.css`에 badge/code 전용 토큰 추가
   - `--badge-bg`, `--badge-fg`, `--badge-border`
   - `--badge-accent-bg`, `--badge-accent-fg`, `--badge-accent-border`
   - `--inline-code-bg`, `--inline-code-fg`, `--inline-code-border`
2. 아래 CSS를 토큰 기반으로 통일
   - `Library.module.css` `.itemType`, `.itemChannel`, `.itemDate`
   - `EvidencePanel.module.css` `.srcType`, `.searchRowKind`, `.verdictBadge`, `.detailMeta span`
   - `Markdown.module.css` `.md code`
   - `CodeBlock.module.css`의 language label/action 버튼
3. 최소 대비 기준
   - 일반 텍스트/배지: 4.5:1 이상
   - 보조 메타: 3:1 이상, hover/focus 시 4.5:1에 가까워지게 보정
4. QA용 fixture 메시지 추가 없이, 브라우저에서 마크다운 inline code/자료실 item/evidence badge를 직접 확인한다.

#### 완료 기준
- 라이트/다크에서 `텍스트`, `파일`, `직접 첨부`, `초성`, `자모`, inline code pill이 배경과 분리되어 보인다.
- 기존 “회색 박스 과다” 느낌은 줄이고, 글자 대비는 높인다.

### 2.2 근거 패널 애니메이션 안정화

#### 문제
- `EvidencePanel.tsx`는 `formOpen`, `scope`, `mode`, `selectedId`가 독립적으로 움직인다.
- `EvidencePanel.module.css`는 `.formShell`과 `.addBtnShell`이 동시에 `grid-template-rows`로 접히고 펼쳐지며, `.formShellOpen .formInner > *`가 stagger animation을 수행한다.
- 취소 직후 범위 전환/빈 상태/로딩 표시가 겹치면 높이와 opacity가 연쇄적으로 바뀐다.

#### 수정
1. 상태 전환 정책
   - `scope` 변경 시 `setFormOpen(false)`, `setSelectedId(null)` 실행.
   - `mode` 변경 시에도 폼/상세를 닫는다.
   - `threadId`/`projectId` 변경 시 폼 필드와 선택 상세를 초기화한다.
2. 레이아웃 슬롯 고정
   - `sources` 본문 영역에 `min-height`를 둔 `sourceBody` 래퍼 추가.
   - Empty/loading/list/form/detail이 같은 안정된 슬롯에서 교체되게 함.
3. 폼 애니메이션 단순화
   - `addBtnShell`과 `formShell`의 동시 grid accordion 제거.
   - 열 때만 짧은 fade/height, 닫을 때는 opacity 100~140ms + 높이 즉시/짧게 정리.
   - 필드 stagger는 제거하거나 최초 open에만 1회 적용.
4. 프로젝트 전체 첫 진입 깜박임 보정
   - `useProjectEvidence`를 projectId가 있으면 우측 패널 open 시 prefetch한다.
   - scope 전환 중 빈 상태를 즉시 보여주지 않고, stale/placeholder 또는 reserved skeleton을 최소 350ms 표시.

#### 완료 기준
- `근거 추가 → 취소 → 프로젝트 전체 → 이 채널` 반복 시 패널 높이가 왕복 점프하지 않는다.
- 빠른 클릭에도 폼 잔상/빈 상태 플래시가 없다.

### 2.3 우측 패널/채팅 lane 모션 정리

#### 문제
- `AppShell.module.css` `.app`은 `grid-template-columns`를 260ms 전환한다.
- `.appContextCollapsed`는 `--chat-lane-offset`을 바꾸고, `ThreadView.module.css`의 `.msg`, `.stickyDate`, `.dateDivider`가 `transform 260ms`로 이동한다.
- 우측 패널을 접거나 검색으로 열 때 채팅 lane 전체가 움직여 “왔다갔다” 느낌을 만든다.

#### 수정
1. 우측 패널 open/close 정책
   - 패널 폭 변화는 shell grid에서 한 번만 처리하고, 메시지 개별 row transform transition은 제거한다.
   - `--chat-lane-offset` 기반 개별 메시지 이동은 정적 계산만 유지하거나 완전히 제거한다.
2. 검색/근거/멤버 탭 높이 안정화
   - `ContextPanel` 내부 `ctxTabs`, `ctxSection`에 고정 상단 구조와 scroll body를 분리한다.
   - 탭 전환 시 header/toggle button 높이가 바뀌지 않게 한다.
3. route 전환 중 transition lock
   - 채널 이동 직후 2 animation frame 동안 `.app[data-route-transitioning]`로 context/grid/row transition을 끈다.
   - 채팅 메시지 스켈레톤이 준비된 뒤 실제 메시지를 보여준다.

#### 완료 기준
- 우측 패널 열기/닫기, 검색 결과 열기, 근거 범위 전환 시 중앙 채팅 폭/배경이 불필요하게 깜박이지 않는다.

### 2.4 채팅 초기 로딩 스켈레톤 + 최소 표시 시간

#### 문제
- `useDelayedFlag(active, delayMs)`는 delay만 있고 `minVisibleMs`가 없다.
- `ChatThread.tsx`는 `showHistorySkeleton`을 메시지 스트림 안쪽 상단에 삽입한다.
- `VirtualMessageStream`은 threadId 변경 시 `scrollTop=0` → 메시지 로드 후 bottom pinning을 수행한다. 이 사이에 긴 대화는 흔들려 보일 수 있다.

#### 수정
1. `useDelayedFlag` 확장 또는 새 hook 추가
   - `useStableLoading(active, { delayMs, minVisibleMs })`
   - delay 이후 표시되면 최소 450~600ms 유지.
   - active가 빨리 끝나도 이미 표시된 skeleton은 최소 시간 뒤 자연스럽게 사라짐.
2. Chat skeleton 전용 컴포넌트
   - `ChatThreadSkeleton` 추가: avatar + message block 4~6개, 실제 lane width와 같은 wrapper 사용.
   - stream 내부 prepend가 아니라 absolute/slot 방식으로 `VirtualMessageStream`과 같은 영역을 차지하게 함.
3. 초기 렌더 게이트
   - `useMessageWindow`에 `isInitialLoading`, `isHydratingThread`를 명확히 노출.
   - `VirtualMessageStream`이 첫 `scrollToIndex(..., end)`를 마치기 전에는 opacity 0 또는 skeleton 유지.
   - 완료 후 opacity fade-in 120ms. 높이는 이미 예약되어 있어 layout shift 없음.
4. cached thread 재방문
   - `cachedLatest(threadId)`가 있으면 skeleton 없이 즉시 표시.
   - 네트워크 revalidate는 background로 처리하고 scroll을 재설정하지 않음.

#### 완료 기준
- 채팅방 전환 시 skeleton이 최소 시간 동안 안정적으로 보이고, 실제 메시지 등장 때 위아래 흔들림이 없다.
- 긴 채팅방에서도 첫 프레임에 이전 대화/빈 상태가 보이지 않는다.

### 2.5 모델 변경 UX 정리

#### 문제
- `ModelPickerSheet.tsx`가 같은 모델 목록을 `Select`와 card list로 중복 제공한다.
- `onSelect`는 즉시 localStorage에 반영되지만 하단 `적용`은 닫기 역할만 한다.
- 모델 API는 현재 3개 route만 반환한다.

#### 수정
1. 셀렉트박스 제거
   - 모델 선택은 카드 3개로만 수행.
   - 카드 클릭 즉시 선택 + 시트 닫기 또는 “선택 후 적용” 둘 중 하나로 일관화.
   - 추천안: 카드 클릭 즉시 선택하고 toast로 “다음 메시지부터 적용” 표시, 하단 버튼은 `닫기`만 유지.
2. 모델 라벨 정리
   - `claude-opus-4-8 · anthropic` → `Opus 4.8`
   - `openai-codex/gpt-5.5` → `GPT-5.5`
   - `claude-sonnet-5` → `Sonnet 5`
   - 세부 route/provider는 접힌 `고급 정보` 또는 작은 보조 텍스트로 이동.
3. 선택 상태 강화
   - 선택 카드에 왼쪽 accent rail + check icon + `현재 사용 중` badge.
   - hover와 selected 배경을 다르게 분리.
4. 모델 수 문제
   - 현재 3개만 보이는 것은 `HermesRunsClient.listModels()`가 `/v1/models`와 `HERMES_CONFIG_PATH`의 `model/fallback_providers`를 병합한 결과다.
   - 더 많은 모델을 노출하려면 Hermes config route를 추가해야 하며, UI는 “관리자가 허용한 모델만 표시” 문구를 추가한다.

#### 완료 기준
- 상단 중복 셀렉트가 사라지고, 3개 카드 중 하나를 누르는 동작만 남는다.
- `적용` 버튼 의미 혼란이 없다.

### 2.6 좌측 네비 명칭/복귀 동선 개선

#### 문제
- `AppShell.tsx`의 세 항목이 `산출물 보관함`/`자료실`/`보관함`으로 되어 있다.
- `AppShell.module.css`의 Slack-style pass에서 `.workspaceTool small { display: none; }`라 보조 설명이 숨겨져 있다.
- `LibraryPage`에는 채팅으로 돌아가는 버튼이 없고, `ArtifactsPage`의 back button은 `/`로 이동해 채널 복귀가 아니다.

#### 수정
1. 명칭 변경안
   - `산출물 보관함` → `산출물` 또는 `보고서·문서`
   - `자료실` → `근거·자료실`
   - `보관함` → `숨긴 항목` 또는 `보관된 채널`
2. 보조 설명 복원
   - 항상 작은 설명을 노출하거나, sidebar 폭이 좁을 때만 tooltip로 제공.
   - 첫 사용자 기준으로 “무엇을 누르면 무엇이 열리는지” 1초 안에 이해되게 한다.
3. 현재 채널 복귀
   - `lastThreadRouteStore` 추가: `/th/:threadId` 진입 때 마지막 채널 route를 저장.
   - `/library`, `/artifacts` 진입 시 `from` search 또는 store를 사용해 `← QA 채널로 돌아가기` 버튼 표시.
   - `ArtifactsPage`의 현재 `워크스페이스로 돌아가기`는 `이전 채널로 돌아가기`로 교체하되, fallback은 `/` 유지.
4. 중앙 채널 보존
   - 산출물/자료실을 “채팅을 완전히 잃는 이동”처럼 보이지 않게 breadcrumb에 `QA 프로젝트 / QA 채널 / 자료실` 표시.

#### 완료 기준
- 자료실·산출물에서 한 번의 클릭으로 방금 보던 채널로 복귀한다.
- 좌측 세 항목의 의미가 겹치지 않는다.

### 2.7 인라인 생성 입력 자동 닫힘

#### 문제
- `InlineCreate`가 자체 local state로 `open/name`을 갖고 외부 route/선택 변화에 반응하지 않는다.
- 브라우저 QA에서 `프로젝트 추가` 입력이 채널 이동/모델 시트 위에서도 남는 것을 확인했다.

#### 수정
1. Sidebar에 `createDismissEpoch` 상태 추가
   - route pathname 변경, workspace 변경, archive dialog/model sheet/openChannel/project toggle/자료실/산출물 링크 클릭 시 epoch 증가.
2. `InlineCreate`에 `dismissEpoch` prop 추가
   - `useEffect(() => cancel(), [dismissEpoch])`
3. 열린 인라인 폼은 한 개만 허용
   - `activeCreateKey`를 Sidebar가 소유하고, project/channel create가 동시에 열리지 않게 한다.
4. busy 중 정책
   - submit 중이면 닫지 않거나 disabled 상태 유지. navigation이 발생하면 입력값은 폐기하고 toast는 띄우지 않는다.

#### 완료 기준
- 프로젝트/채널 추가 입력을 열어둔 채 다른 채널/자료실/산출물/모델 시트를 열면 입력이 자동 닫힌다.

### 2.8 미니맵 점 이동 보정

#### 문제
- `ConvoMinimap`은 `entries`의 key를 받아 `streamRef.current?.querySelector([data-turn])?.scrollIntoView()`만 한다.
- `VirtualMessageStream`은 TanStack virtualizer를 사용하므로 offscreen row는 DOM에 없다.
- 아직 로드하지 않은 메시지는 entries에 없거나, 있어도 DOM query 방식으로 이동할 수 없다.

#### 수정
1. entries를 messageId 중심으로 변경
   - `MinimapEntry`에 `messageId`, `loaded`, `index`, `role`, `preview` 포함.
2. loaded message 이동
   - DOM query 대신 `virtualizer.scrollToIndex(index, { align: 'center' })` 경로를 사용.
3. unloaded message 이동
   - 서버 anchor endpoint가 있으면 `GET /messages?around=<messageId>`를 호출.
   - 없다면 우선 `hasOlder/hasNewer` 상태에 따라 해당 점을 disabled + tooltip `이전 대화 불러오는 중/먼저 불러오기`로 표시.
   - 장기안: `GET /threads/:id/message-anchors` 추가해 긴 대화의 질문 anchor 목록을 별도로 가져오고, 클릭 시 `focusMessage(messageId)` 사용.
4. 시각 개선
   - 미니맵 rail에 현재 viewport 구간 indicator 추가.
   - unloaded dot은 hollow style로 표시해 “클릭 가능하지만 로드 필요” 상태를 구분한다.

#### 완료 기준
- 긴 대화에서 미니맵 점 클릭이 loaded/offscreen/unloaded 상황별로 예측 가능하게 동작한다.

### 2.9 검색 UX 개선

#### 문제
- 검색 결과가 생겨도 `ContextPanel` 내부 탭만 search로 바뀌고, 부모 `contextCollapsed`가 자동으로 열리지 않는다.
- 검색 취소 버튼이 없고, 입력값 삭제가 검색 종료 트리거다.
- 선택 행과 미선택 행이 앞 선 외에는 거의 동일하다.
- 검색 결과 패널이 사라질 때 높이 변화로 레이아웃 쉬프팅이 난다.

#### 수정
1. 검색 시 우측 패널 자동 열림
   - `AppShell`에서 `useSearchState()`를 구독한다.
   - `search.open && search.query`가 true면 `setContextCollapsed(false)`.
2. 검색 취소 액션
   - 검색 input 오른쪽에 `X` 버튼 추가.
   - Escape는 blur가 아니라 검색 취소로 동작: `searchStore.reset(threadId)`, `setSearchQuery('')`, 필요 시 `jumpToLatest()`.
   - 우측 검색 패널에도 `검색 닫기` 버튼 추가.
3. 검색 패널 레이아웃 안정화
   - `ContextPanel` 검색 section에 `min-height`와 fade-out exit class 부여.
   - 닫힐 때 context panel 자체 폭/토글 높이는 유지하고 body만 fade.
4. 검색 결과 행 디자인
   - `.searchRowOn`: 배경, border, check/current marker, text weight, `현재 위치` badge 추가.
   - `.searchRow:hover`와 `.searchRowOn` 스타일 분리.
   - 파일/근거 hit도 message hit과 같은 focus 상태를 가질 수 있게 `focusedTargetId` 확장.
5. 검색 결과 count 보정
   - 현재 header count는 대화 결과 `results.length` 중심이다. 파일/근거 포함 총 결과와 현재 focus 범위를 분리 표기.

#### 완료 기준
- 우측 패널이 닫힌 상태에서 검색하면 자동으로 검색 탭이 열린다.
- `X`/Escape/검색 닫기로 검색 상태가 사라지고, 채팅은 자연스럽게 원래 맥락으로 돌아간다.

### 2.10 자료실/파일 뷰어 overlay 닫힘 애니메이션

#### 문제
- `FileViewer`는 fixed drawer지만 close 시 컴포넌트가 즉시 unmount된다.
- 공용 `Dialog.css`의 중앙 dialog는 close 때 `scale(0.98)`로 중앙에 모이는 느낌을 줄 수 있다.
- 사용자는 자료 닫기 때 overlay가 가운데로 모이며 사라지는 애니메이션을 어색하게 느꼈다.

#### 수정
1. FileViewer에 closing state 추가
   - `onRequestClose` → `closing=true` → 160ms 후 실제 `onClose`.
   - `.panelClosing { transform: translateX(24px); opacity: 0; }`
   - `.scrimClosing { opacity: 0; }`
2. overlay 닫힘 방향 통일
   - 자료/파일/모델처럼 우측에서 열린 것은 우측으로 닫힌다.
   - 중앙 modal은 확인/보관함 같은 실제 modal에만 사용한다.
3. Dialog close scale 조정
   - `cwDialogOut`의 scale을 제거하거나 `translateY(6px)+opacity`만 사용.
   - Sheet close animation도 `data-state='closed'` 추가해 방향성 유지.

#### 완료 기준
- 자료 뷰어 닫기 시 중앙으로 빨려 들어가는 느낌이 없다.

## 3. 구현 순서

1. **기반 유틸/토큰 먼저**
   - `useStableLoading` 추가
   - badge/code token 추가
   - transition lock class 설계
2. **P0 UX 즉시 개선**
   - 인라인 생성 자동 닫힘
   - 모델 시트 셀렉트 제거
   - 검색 자동 패널 열림/취소 버튼
   - 텍스트 대비 보정
3. **채팅 전환 안정화**
   - Chat skeleton slot 도입
   - VirtualMessageStream 최초 pin 이후 표시
   - 메시지 개별 transform transition 제거/완화
4. **근거 패널/자료실/파일 뷰어 motion 정리**
   - EvidencePanel form/scope transition 정리
   - FileViewer close animation 도입
   - Dialog close scale 제거
5. **네비 명칭/복귀 동선**
   - 좌측 네비 copy 변경
   - last thread route 저장 및 복귀 버튼
6. **미니맵 장기 보정**
   - loaded offscreen은 virtualizer index 이동
   - unloaded는 endpoint 추가 여부 결정 후 구현

## 4. 검증 계획

### 정적 검증

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test` 또는 관련 package test
- 변경 파일 중심으로 CSS class 미사용/타입 오류 확인

### 브라우저 QA 시나리오

1. 근거 패널
   - `근거 추가` 열기 → 취소 → 프로젝트 전체 → 이 채널 5회 반복
   - 폼이 열려 있는 상태에서 탭 `근거검증/결정표/검토큐` 이동
   - 우측 패널 접기/열기와 함께 반복
2. 채팅방 이동
   - 빈 채널 ↔ 긴 채팅 채널 ↔ 자료실 ↔ 산출물 왕복
   - 첫 진입 skeleton 최소 표시/실제 메시지 전환/scroll bottom 확인
3. 모델 시트
   - 세 카드 선택, 기본값 복귀, 새 메시지 모델 chip 반영 확인
   - 셀렉트박스가 없는지 확인
4. 좌측 네비
   - 자료실/산출물 진입 후 `이전 채널로 돌아가기`
   - 프로젝트/채널 추가 입력이 다른 네비 동작에서 자동 닫히는지 확인
5. 검색
   - 우측 패널 닫힌 상태에서 검색 → 자동 열림
   - 검색 결과 선택/미선택 시각 차이
   - X/Escape/검색 닫기 → 레이아웃 shift 없이 복귀
6. 미니맵
   - loaded offscreen 점 이동
   - unloaded/미로드 점 상태 표시 또는 around fetch 이동
7. 대비
   - 라이트/다크에서 inline code, 자료 타입 chip, 근거 source chip, 검색 kind chip 확인

### 성공 기준

- 사용자가 제시한 8개 항목이 모두 재현 불가 또는 의도된 UX로 교정된다.
- 레이아웃 shift가 눈에 띄지 않고, motion은 100~180ms 범위의 단일 방향 전환으로 정리된다.
- “보관함/자료실/산출물”의 의미와 복귀 경로가 초심자에게 분명해진다.
- 구현 후 브라우저 콘솔 오류 0건을 확인한다.

## 5. 리스크와 보류 판단

- 모델 3개 문제는 UI 버그가 아니라 현재 Hermes config/API 노출 범위일 수 있다. 더 많은 모델을 추가하려면 별도 config 변경 승인이 필요하다.
- 미니맵의 unloaded 점 완전 지원은 서버 anchor endpoint가 없으면 프론트만으로는 한계가 있다. 1차는 loaded/offscreen virtualizer 이동, 2차는 anchor endpoint로 나눈다.
- 좌측 네비 명칭은 UX copy 결정이므로 구현 전 최종 후보를 주인님에게 확인하면 좋다. 추천 기본값은 `산출물`, `근거·자료실`, `숨긴 항목`.

## 6. 예상 산출물

- 수정 PR/커밋 단위는 다음처럼 나누는 것을 권장
  1. `ui: stabilize loading/search/model picker interactions`
  2. `ui: polish evidence panel and drawer motion`
  3. `ui: clarify library/artifact/archive navigation`
  4. `ui: fix minimap navigation for virtualized threads`
- 각 커밋은 브라우저 QA 체크리스트와 함께 검증한다.
