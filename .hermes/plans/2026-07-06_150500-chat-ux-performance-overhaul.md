# Consulting-Web 채팅 UX·성능 종합 개선 계획 (12개 항목 + 발견 이슈)

> **For Hermes:** subagent-driven-development 또는 순차 직접 구현. 트랙 단위 커밋.
> 작성: 2026-07-06 · 계획만 수립(구현 미착수) · 사용자 12개 지시 + 전수조사 발견분 통합

**Goal:** 채팅 화면의 상호작용 정확성(스크롤 복귀·채널 전환·상태 표시), 시각 완성도(컴포저·우측패널·다크모드), 인증 지속성, 그리고 앱 전체 렌더링 성능을 구조적으로(재발 불가) 끌어올린다.

**Architecture:** ① 상호작용은 IntersectionObserver·React 19 동시성(useDeferredValue/startTransition/useOptimistic 패턴)으로, ② 시각은 "단일 표면(single-surface) + 토큰만 사용" 원칙으로, ③ 성능은 [렌더 빈도 절감 → 렌더 비용 절감 → 페인트 비용 절감 → 메모리 상한] 4층으로 접근.

**Tech Stack:** React 19.2(+React Compiler), TanStack Query v5/Router/Virtual, GSAP 3.15, Vite 8(rolldown), CSS Modules + tokens.css, NestJS+Drizzle(pg)

---

## 0. 현재 컨텍스트 / 전수조사 발견 목록

사용자 지적 12개 외에 코드 정독으로 발견한 문제(계획에 모두 포함):

| # | 발견 | 위치 | 영향 |
|---|------|------|------|
| F1 | **스트리밍 중 강제 스크롤 yank**: `useEffect(...bottomRef.scrollIntoView..., [live])`가 델타마다 실행 → 과거 메시지 읽는 중 바닥으로 끌려감 | `ChatThread.tsx:137-139` | 항목1의 숨은 원인 |
| F2 | **SSE 델타마다 setState**: `delta` 이벤트당 `patchTurn` → 초당 수십 회 전체 리렌더 | `ChatThread.tsx:207-210` | 스트리밍 성능 핵심 병목 |
| F3 | **1초 타이머가 스레드 전체 리렌더**: `nowTs` interval이 ChatThread 루트 state | `ChatThread.tsx:155-159` | busy 동안 가상리스트 포함 매초 리렌더 |
| F4 | **refresh 실패 시 무조건 로그아웃**: `tryRefresh` catch가 네트워크 오류도 `authStore.clear()` → 순간 오프라인=세션 사망 | `api.ts:65-80` | 항목8의 실제 근본 원인 후보 |
| F5 | **backdrop-filter: blur(8px) 다수**: `.head`, `.scrollProbe`, `.historyMoreBtn` → 스크롤 프레임마다 고비용 리페인트 | `ThreadView.module.css:9,341` | 스크롤 성능 + 항목9와 동일 지점 |
| F6 | **헤더 배경 하드코딩**: `.head { background: rgba(255,255,255,0.75) }` — 다크 무시 | `ThreadView.module.css:10` | 항목9 근본 원인 |
| F7 | **컴포저 이중 표면**: `Textarea`(=`cwInput` 자체 border/배경) + `.box` border + `.boxTop/.bar` 각자 배경. CSS import 순서에 의존해 `s.textarea`의 `border:none`이 이기는 구조(취약) | `Input.tsx:11-13`, `ThreadView.module.css:584-617` | 항목3·10 근본 원인 |
| F8 | **테마 전환 시 부분 트랜지션**: `cwInput`은 background transition 있고 `.box/.bar`는 없음 → 안쪽만 늦게 바뀌는 깜빡임. 새로 넣은 전역 버튼 transition도 동일 기여 | `shared-ui.css:94`, `global.css` | 항목10 근본 원인 |
| F9 | **미니맵 파생 O(n) 매 렌더**: `minimapEntries`가 useMemo 없이 매 렌더 재계산(F2·F3와 곱해짐) | `ChatThread.tsx:379-390` | 성능 |
| F10 | **메시지 윈도우 무한 성장**: `mergeMessagePage`가 페이지를 누적만 함 — 수천 개 로드 시 메모리·정렬 비용 무한 | `messageWindow.ts:45-84` | 항목11 메모리 상한 |
| F11 | **다크모드 스켈레톤 색 하드코딩**: AppShell `.skel`의 `#efeeeb` (잔존 클래스) | `AppShell.module.css:403` | 다크 이슈·데드코드 정리 |
| F12 | **runId 노출**: `visibleRunId`가 `run_4ec0d5ea…` 형태로 일반 사용자에게 노출 | `VirtualMessageStream.tsx:41-44` | 항목5 |
| F13 | **검색 드롭다운 라이트 고정 색**: `.searchResults`의 `color-mix(..., white)` | `ThreadView.module.css:95` | 다크 대비 점검 대상 |
| F14 | **expiresInSec 미저장**: 로그인/refresh 응답의 `expiresInSec`(900s)를 클라이언트가 버림 → 선제 refresh 불가 | `api.ts` PersistedAuth | 항목8 |

이미 확보된 것(재작업 금지): cursor pagination + `chat_messages_thread_cursor_idx` 인덱스, IntersectionObserver 센티넬 무한스크롤, keepPreviousData 채널 하이라이트, 공통 Skeleton+useDelayedFlag(300ms), 전역 버튼 모션 안전망, React Compiler, 서비스워커 프리캐시, Wanted Sans 셀프호스팅.

리서치 근거:
- `content-visibility`/`contain` — web.dev 7x 렌더 개선 사례, MDN
- 스트리밍 마크다운 블록 메모이제이션 — Vercel AI SDK cookbook / streamdown 패턴
- Scroll-to-bottom FAB — Slack/Discord/ChatGPT 공통 패턴(새 메시지 카운트 pill)
- React 19 `useDeferredValue`/`startTransition`/`useOptimistic` 공식 권장 패턴

---

# Track A — 채팅 상호작용 정확성 (항목 1·2·5·6·F1·F2·F3)

## Task A1: isAtBottom 추적 + 스트리밍 강제 스크롤 제거 (F1)

**Objective:** "바닥 근처일 때만 따라간다" 불변식 확립 — 이후 모든 스크롤 UX의 기반.

**Files:**
- Modify: `apps/web/src/widgets/chat-thread/ui/VirtualMessageStream.tsx`
- Modify: `apps/web/src/widgets/chat-thread/ui/ChatThread.tsx:137-139`

**Steps:**
1. VirtualMessageStream의 기존 bottom 센티넬 IO에서 `isAtBottom`(state) 산출 — `rootMargin '0px 0px 120px 0px'` 기준 교차 여부. `onAtBottomChange?: (v:boolean)=>void` prop으로 상향 전달.
2. ChatThread의 `useEffect([live])` scrollIntoView를 **`isAtBottom`일 때만** 실행으로 변경. behavior는 스트리밍 중 `'auto'`(smooth가 델타마다 큐잉되면 밀림).
3. 스레드 전환 시 isAtBottom=true로 리셋.

**Verify:** 위로 스크롤한 상태에서 메시지 전송 → 화면이 안 끌려감. 바닥에서 전송 → 따라감.

## Task A2: Scroll-to-bottom FAB + 새 메시지 pill (항목 1)

**Objective:** 위로 스크롤/검색 점프 상태에서 한 번에 최신으로 복귀.

**Files:**
- Create: `apps/web/src/widgets/chat-thread/ui/JumpToLatest.tsx` (+ CSS는 ThreadView.module.css)
- Modify: `ChatThread.tsx`, `VirtualMessageStream.tsx`, `model/useMessageWindow.ts`

**동작 명세 (엣지 케이스 전수):**
| 상황 | 버튼 | 클릭 동작 |
|------|------|-----------|
| 단순 위로 스크롤 (`!isAtBottom && !hasNewer`) | ⌄ 만 표시 | `virtualizer.scrollToIndex(last, end)` |
| 검색 점프 후 (`mode==='around'`, `hasNewer===true`) | ⌄ 표시 | **윈도우 탈출**: `resetToLatest()` — latest 페이지 재요청→윈도우 교체→바닥 고정 (아래 스크롤로 페이지 다 내리는 것보다 O(1)) |
| 위로 스크롤 중 새 메시지 도착(live 추가/done) | ⌄ + `새 메시지 N` pill | 위와 동일 + pill 카운트 리셋 |
| 스트리밍 진행 중 + 위로 스크롤 | ⌄ + pill(‘응답 작성 중’) | 클릭 시 바닥 이동 후 A1의 follow 재개 |
| 스레드 전환 | 버튼/카운트 리셋 | — |
| `Escape` 키(컴포저 포커스 아님·검색창 닫힘 상태) | — | 바닥 이동(디스코드 패턴) |
| reduced-motion | 등장 애니 생략 | scroll behavior 'auto' |

**Steps:**
1. `useMessageWindow`에 `resetToLatest()` 추가: `qc.invalidateQueries(latest)` 후 `mergeMessagePage(undefined, freshPage, 'latest')`로 윈도우 교체(누적 아님), `isJumping` 재활용.
2. `unseenCount` state: `!isAtBottom`일 때 done/새 live 발생 시 +1, 바닥 도달 시 0.
3. FAB: stream 우하단 absolute, `@starting-style` 진입 애니(Track D5의 모던 CSS), `aria-label="최신 메시지로 이동"`, lucide `arrow-down` 아이콘.
4. 오버레이 z-index는 컴포저(z 50대)보다 아래·메시지 위. 미니맵(우측 레일)과 겹치지 않게 `right: 46px` 계열로 배치.

**Verify:** 표 7행 각각 브라우저 QA. 특히 검색 점프→FAB 클릭→"최신 50개 윈도우로 교체 + hasOlder=true" 확인.

## Task A3: 채널 전환 optimistic 하이라이트 + startTransition (항목 2)

**Objective:** 클릭 즉시 선택 표시(0 딜레이), 로딩은 명시적 표시로 분리.

**근본 원인:** keepPreviousData로 **이전** 채널 하이라이트가 새 threadDetail 도착까지 유지됨 → "전환이 늦는" 체감. 버튼 자체 딜레이가 아니라 파생 상태 지연.

**Files:**
- Modify: `apps/web/src/widgets/app-shell/ui/AppShell.tsx` (Sidebar)
- Modify: `apps/web/src/widgets/app-shell/ui/AppShell.module.css`

**Steps:**
1. Sidebar에 `const [pendingChannelId, setPendingChannelId] = useState<string|null>(null)` + `const [isNavPending, startNav] = useTransition()`.
2. `openChannel`: 클릭 즉시 `setPendingChannelId(c.id)` (optimistic) → `startNav(async () => { ...기존 navigate... })`.
3. active 판정: `pendingChannelId === c.id || (pendingChannelId === null && channelActive)`. threadDetail이 새 topicId로 확정되면(effect) `setPendingChannelId(null)` — 서버 확정으로 수렴.
4. 로딩 UX: 클릭된 행 우측에 `isNavPending && pendingChannelId===c.id`일 때 14px 인라인 스피너(`Icon loader cwSpin`) 표시. 300ms 미만이면 안 보이도록 `useDelayedFlag(isNavPending, 150)` 게이팅(전환은 150ms 기준).
5. 실패 시(catch) pendingChannelId 롤백 + 기존 toast 유지.

**Verify:** 채널 클릭 즉시 하이라이트 이동(네트워크 스로틀 Slow 3G에서도), 이전 채널 하이라이트 잔류 없음, 스피너는 느릴 때만.

## Task A4: SSE 델타 rAF 배칭 (F2)

**Objective:** 스트리밍 리렌더를 초당 수십 회 → 프레임당 1회로.

**Files:** Modify: `ChatThread.tsx` send() 루프

**Steps:**
1. `const deltaBuf = useRef(''); const rafId = useRef(0);`
2. `delta` 이벤트: `deltaBuf.current += event.text;` 후 `rafId.current ||= requestAnimationFrame(flush)`. `flush`: `acc += deltaBuf.current; deltaBuf='' ; rafId=0; patchTurn(...)`.
3. `done`/`error`/abort 경로에서 잔여 버퍼 강제 flush(누락 방지).
4. `setActiveTool(null)`도 flush 안으로 이동.

**Verify:** 긴 응답 스트리밍 중 React DevTools Profiler로 commit 횟수 비교(≈frame rate 이하). 최종 텍스트 무손실(done 후 acc === 서버 저장본).

## Task A5: RunStatus 분리 — 1초 타이머 격리 (F3) + 상세 popover (항목 5·6)

**Objective:** ① 타이머 리렌더를 상태바 컴포넌트 안에 가둠 ② 요약 pill + 클릭 시 풀 디테일 popover ③ runId 원문은 일반 뷰에서 제거.

**Files:**
- Create: `apps/web/src/widgets/chat-thread/ui/RunStatusBar.tsx`
- Modify: `ChatThread.tsx` (runStatus 관련 JSX/타이머/포맷터 이동), `VirtualMessageStream.tsx:41-44` (visibleRunId), `ThreadView.module.css`

**Steps:**
1. `RunStatusBar({ status: RunStatusUi })` 신설: `nowTs` interval을 **이 컴포넌트 내부로 이동** → 매초 리렌더가 상태바에 국한. fmt* 유틸 동반 이동.
2. **요약 pill(기본)**: `● 모델명 · 67% · 1m 24s` 3요소만. mono 폰트 유지.
3. **상세 popover(클릭)**: Radix 없이 `@starting-style` CSS 등장 —
   - 모델 전체 이름 / 상태(running·done·error)
   - 토큰: 입력·출력·합계 · context limit · % 게이지(큰 바)
   - reasoning: on/off + `reasoningText` 마지막 2줄 프리뷰
   - 경과·시작 시각
   - 실행 ID: **"기술 정보" 접힘 섹션 안에만** 표기(복사 버튼) — 일반 사용자 기본 화면에서 제거
4. **메시지 메타의 runId 제거(항목 5)**: `visibleRunId` 삭제. 대신 assistant 메타에 모델명 뱃지(예: `claude-fable-5`)를 title 속성과 함께 표시하거나 아무것도 안 보임. `telegram-sync:` 는 기존대로 숨김.
   - 서버가 message에 model을 안 주면: 뱃지 생략, runId는 hover title로만 (`title={message.runId}`) — 화면 텍스트 노출 금지.
5. done 후에도 마지막 run 통계 pill 유지(현행 동작 보존), 새 send 시 교체.

**Verify:** busy 중 Profiler에서 ChatThread 루트 커밋이 매초 발생하지 않음. popover에 모든 필드. 채팅 어디에도 `run_` 문자열 미노출(`document.body.innerText.includes('run_')===false` 콘솔 체크).

---

# Track B — 시각 완성도 (항목 3·4·7·9·10·F5·F6·F7·F11·F13)

## Task B1: 컴포저 단일 표면화 — 이중 border 제거 (항목 3, F7)

**Objective:** 표면(배경+테두리)은 `.box` 하나만. 내부는 전부 투명. import 순서 의존 제거.

**Files:**
- Modify: `apps/web/src/shared/ui/input/Input.tsx`
- Modify: `ChatThread.tsx:544`, `ThreadView.module.css:584-617`

**Steps:**
1. `Textarea`/`Input`에 `unstyled?: boolean` prop 추가: true면 `cwInput` 클래스를 **아예 안 붙임**(`cn(unstyled ? 'cwInputBare' : 'cwInput cwTextarea', ...)`). `cwInputBare`는 `border:0; outline:0; background:transparent; font:inherit; resize:none;`만 정의(shared-ui.css).
   - 이유: 지금은 `s.textarea`가 cwInput을 "덮어쓰기"로 이기는 구조 → CSS 순서 바뀌면 재발. 클래스를 안 붙이는 게 구조적 해결.
2. ChatThread 컴포저: `<Textarea unstyled className={s.textarea} ...>`.
3. `.boxTop`/`.bar`/`.textarea`의 `background: var(--bg-canvas)` 전부 제거(투명) — 배경은 `.box` 단독. radius 상속 이슈 제거.
4. `.box` focus-within 유지(accent ring). 검증: 라이트/다크에서 테두리 1겹만.

## Task B2: 테마 전환 트랜지션 일시 차단 (항목 10, F8)

**Objective:** 테마 스위치 순간 모든 요소가 **동시에** 색 전환 — 부분 깜빡임 구조적 제거.

**Files:**
- Modify: `apps/web/src/lib/themeStore.ts:18-21`
- Modify: `apps/web/src/styles/global.css`

**Steps:**
1. global.css에:
```css
html[data-theme-switching] *,
html[data-theme-switching] *::before,
html[data-theme-switching] *::after {
  transition: none !important;
}
```
2. themeStore `apply()`:
```ts
const root = document.documentElement;
root.setAttribute('data-theme-switching', '');
if (next === 'dark') root.setAttribute('data-theme', 'dark');
else root.removeAttribute('data-theme');
// 2 프레임 뒤 해제(스타일 재계산 완료 보장)
requestAnimationFrame(() => requestAnimationFrame(() => root.removeAttribute('data-theme-switching')));
```
3. B1의 단일 표면화와 합쳐져 컴포저 깜빡임 소멸. (이 기법은 VSCode/Linear 등이 쓰는 표준 패턴)

**Verify:** 다크↔라이트 연타 — 컴포저·버튼·사이드바 어디에도 시차 색전환 없음.

## Task B3: 채팅 헤더 다크 대응 + backdrop-filter 대체 (항목 9, F5, F6)

**Objective:** 헤더/프로브가 토큰 기반으로 다크 완벽 대응 + 스크롤 페인트 비용 제거.

**Files:** Modify: `ThreadView.module.css:1-11, 332-342, 317-326`

**Steps:**
1. `.head`: `background: rgba(255,255,255,0.75)` + `backdrop-filter: blur(8px)` 제거 →
   `background: color-mix(in srgb, var(--bg-canvas) 92%, transparent);` (반투명 유지하되 blur 없음). 제목/텍스트는 이미 토큰이므로 배경만 문제.
   - 완전 불투명 `var(--bg-canvas)`도 후보 — 시각 확인 후 결정(불투명이 스크롤 성능 최상).
2. `.scrollProbe`, `.historyMoreBtn`, `.runStatus`, `.threadSearch`의 `backdrop-filter` 제거, `color-mix` 불투명도 96%로 상향해 가독성 보전.
3. `.searchResults`의 `color-mix(..., white)`(F13) → `color-mix(in srgb, var(--bg-surface) 96%, var(--text-primary) 0%)` 대신 그냥 `var(--surface-card)` + `box-shadow: var(--shadow-pop)`.
4. 다크 스크린샷 확인: 헤더·검색·상태 pill·프로브.

## Task B4: 우측 컨텍스트 패널 재설계 (항목 4)

**Objective:** Slack 스타일 플랫 완성도 — 스킬 라운드4 룰(카드 금지·간격 리듬·타이포 위계) 적용.

**Files:**
- Modify: `AppShell.tsx` ContextPanel (486-610), `AppShell.module.css` (.context~.roleSeg 구역)
- Modify: `EvidencePanel.tsx`, `EvidencePanel.module.css`

**설계 명세:**
1. **탭바**: 현행 border 박스 탭 → 하단 2px 인디케이터 방식(텍스트 탭 + 활성 밑줄 슬라이드, `--tab-index` transform). 상단 고정(sticky).
2. **섹션 리듬 통일**: 섹션 패딩 16px→`14px 16px`, 섹션 타이틀은 11px/650/upper 유지하되 `margin-bottom: 10px`, 섹션 사이 `border-bottom: 1px solid var(--border-hair)` 유지(플랫).
3. **멤버 행**: 아바타 28px 원형 → 요철 없이 `display:grid; grid-template-columns: 28px 1fr auto; gap:10px; padding:7px 4px; border-radius:8px; hover: var(--surface-hover)`. 역할은 우측 정렬 11.5px muted 뱃지(배경 없는 텍스트). 본인 행에 `나` 표시.
4. **초대 구역**: segmented control 유지, 버튼 풀폭, 생성된 링크는 `cwBreakLong` + 복사 아이콘 버튼(우측)이 있는 1행 박스로 정리. 안내문은 12px 2줄 제한.
5. **근거 카드**: 카드 border 제거 → 플랫 행(아이콘 24px + 출처타입 뱃지 + ref 1줄 + 발췌 2줄 clamp). hover 배경만. glow 링크(E-4)는 좌측 2px accent 레일로 교체(box-shadow glow보다 절제).
6. **빈 상태**: EmptyState 공통 컴포넌트 재사용(현재 근거 패널은 자체 `.empty` div) — 아이콘+타이틀+설명 위계.
7. **로딩**: `useDelayedFlag` + `SkeletonLines` 적용(현재 "불러오는 중…" 텍스트).
8. 패널 폭/스크롤: `overflow-y:auto; scrollbar-gutter: stable` 부여.

**Verify:** 라이트/다크 스크린샷 비교, 멤버 6명+ 시 정렬, 근거 hover-glow 링크 동작 유지.

## Task B5: 근거 추가 폼 등장 애니메이션 (항목 7)

**Objective:** 버튼→폼 전환에 자연스러운 expand+fade.

**Files:** Modify: `EvidencePanel.tsx:91-125`, `EvidencePanel.module.css`

**Steps:**
1. 폼 컨테이너를 상시 마운트 grid 아코디언으로: `.formShell { display:grid; grid-template-rows: 0fr; opacity:0; transform: translateY(-4px); transition: grid-template-rows 200ms var(--ease-out), opacity 160ms, transform 200ms; } .formShellOpen { grid-template-rows: 1fr; opacity:1; transform:none; }` + inner `min-height:0; overflow:hidden` (사이드바 아코디언과 동일 기법 재사용 — 검증된 패턴).
2. 닫힌 상태 `inert` + `aria-hidden` (기존 채널리스트와 동일).
3. 열릴 때 첫 Input `autoFocus`는 transition 종료 후(`onTransitionEnd`)로 지연 — 포커스 스크롤 튐 방지.
4. "근거 추가" 버튼 ↔ 폼 상호 페이드(버튼은 폼 열림 시 숨김).
5. `prefers-reduced-motion`: transition 없음(전역 룰이 이미 커버).
6. (진보적 향상) `interpolate-size: allow-keywords` 지원 브라우저에선 grid 핵 없이 height auto 전환 가능 — `@supports` 분기 주석만 남김(구현은 grid 방식 단일).

## Task B6: 다크 스켈레톤/잔존 클래스 정리 (F11)

**Files:** Modify: `AppShell.module.css` (.skel, #efeeeb), `ThreadView.module.css` (.skelMsg)

**Steps:** 사용처 없는 `.skel`/`.skelMsg` 규칙 삭제(이미 공통 Skeleton으로 대체됨). shimmer 하드코딩 `#efeeeb` 제거로 다크 잔재 소멸. `grep -rn 'skel' apps/web/src` 0건(Skeleton.css 제외) 확인.

---

# Track C — 인증 지속성 (항목 8, F4, F14)

## Task C1: refresh 실패 분류 — 네트워크 오류는 로그아웃 금지 (F4)

**Objective:** "나가기 버튼 전까지는 refresh 토큰(30일)으로 세션 유지" 보장.

**Files:** Modify: `apps/web/src/lib/api.ts:65-80`, `packages/api-client/src/http-core.ts`(에러 타입 노출 확인)

**Steps:**
1. `tryRefresh` catch 분기: 응답이 **401/403**(세션 무효 확정)일 때만 `authStore.clear()`. 네트워크 오류/5xx/timeout이면 세션 유지 + `false` 반환(호출측은 이번 요청만 실패 처리).
2. api-client가 상태코드 있는 에러를 던지는지 확인(`ApiError.status` 형태) — 없으면 http-core에 status 필드 보강.
3. 5xx/네트워크 실패 시 1회 지수 백오프 재시도(1s) 후 포기(세션은 유지).

**Verify:** DevTools offline 토글 → API 호출 실패해도 로그인 유지, online 복귀 후 정상. 서버에서 세션 row 삭제 → 401 → 로그인 화면(정상 만료 경로).

## Task C2: 선제(proactive) refresh 스케줄 (F14)

**Objective:** access 만료(15분)를 기다렸다 401 나고 갱신하는 대신, 만료 60초 전 미리 갱신 — SSE 스트림 중간 401 위험 제거.

**Files:** Modify: `apps/web/src/lib/api.ts` (PersistedAuth에 `accessExpiresAt: number` 추가), 로그인/refresh 저장 경로(`AuthKit.tsx`의 setSession 호출부 확인)

**Steps:**
1. `PersistedAuth`에 `accessExpiresAt`(epoch ms) 추가: `Date.now() + session.tokens.expiresInSec*1000`. 기존 저장분(필드 없음)은 마이그레이션: 로드 시 없으면 즉시 1회 refresh.
2. `scheduleRefresh()`: `setTimeout(tryRefresh, accessExpiresAt - Date.now() - 60_000)` — setSession/clear 때 재설정, visibilitychange 시 남은 시간 재계산(백그라운드 탭 타이머 스로틀 대응).
3. 로그아웃 버튼(`authStore.clear`)만 세션 종료 경로 — 서버 `/auth/logout`(refresh 무효화) 호출이 있으면 함께, 없으면 클라이언트 clear만(현행 유지, 계획 외).

**Verify:** accessExpiresAt를 과거로 조작 → 60초 내 자동 refresh 발생(네트워크 탭), 로그인 유지. 15분 방치 후 첫 클릭에 401 없이 동작.

---

# Track D — 성능 종합 (항목 11·12, F9, F10)

## Task D1: 렌더 빈도 — useDeferredValue/Transition 전면 적용 (항목 12)

**적용 지도 (검토 결과 적합 지점 전부):**

| 지점 | 훅 | 이유 |
|------|-----|------|
| 채널 전환 | `useTransition` (A3에서 구현) | 네비게이션 중 이전 화면 응답성 |
| 워크스페이스 전환 (`RailItem onClick`) | `startTransition(() => wsStore.set(id))` | 트리 전체 교체가 무거움 |
| 대화 검색어 → 결과 렌더 | `useDeferredValue(searchQuery)` + 결과 리스트 `opacity .6` (`isStale` 시) | 타이핑 즉시성 |
| 슬래시 팔레트 필터 | `useDeferredValue(slashQuery)` | 입력 지연 방지(목록 7개라 경미하지만 무비용) |
| 미니맵 파생 (F9) | `useMemo` + `useDeferredValue(persisted)` | O(n) 파생을 저우선으로 |
| 검색 점프(`jumpToSearchHit`) | 기존 isJumping 유지(이미 async UX 있음) | 변경 불필요 — 문서화만 |
| 테마 토글 | 적용 안 함 (DOM attr 직접 조작, React 외부) | B2로 해결 |

**Files:** `ChatThread.tsx`, `AppShell.tsx`
**Verify:** 각 지점 input lag 체감 + Profiler에서 deferred 커밋 분리 확인.

## Task D2: 렌더 비용 — 스트리밍 마크다운 블록 메모이제이션 (항목 11)

**Objective:** 스트리밍 중 매 프레임 문서 전체 재파싱 → 마지막 블록만 재파싱.

**Files:**
- Create: `apps/web/src/shared/ui/markdown/StreamingMarkdown.tsx`
- Modify: `VirtualMessageStream.tsx` LiveRow (streaming일 때만 교체)
- deps: `marked` 추가(lexer만 사용, ~10KB) — 승인 대상

**Steps (Vercel AI SDK cookbook 패턴):**
1. `marked.lexer(text)`로 블록 경계 분리 → `blocks: string[]`.
2. `MemoBlock = memo(({content}) => <Markdown text={content}/>, (a,b)=>a.content===b.content)`.
3. 마지막 블록만 내용이 변하므로 이전 블록들은 memo hit — 파싱·재조정 비용이 O(전체)→O(마지막 블록).
4. **persisted 메시지는 기존 `Markdown`(memo) 유지** — 이미 text 불변으로 파싱 1회. 스트리밍(LiveRow)만 StreamingMarkdown.
5. A4(rAF 배칭)와 곱연산 효과.

**Verify:** 3000자+ 응답 스트리밍 중 Performance 패널 scripting 시간 전후 비교(기대: 절반 이하). 완료 후 최종 렌더 결과가 기존 Markdown과 동일(스냅샷 비교).

## Task D3: 페인트 비용 — 모던 CSS containment (항목 11 "CSS 가상화 성능")

**Files:** `ThreadView.module.css`, `EvidencePanel.module.css`, `Markdown.module.css`, `global.css`

**Steps:**
1. `.virtualItem { contain: layout paint style; }` — 행 내부 변화(hover 액션 등)가 바깥 레이아웃 무효화 안 함. (size containment은 금지 — measureElement가 높이 측정해야 함.)
2. `.stream { overflow-anchor: none; scrollbar-gutter: stable; }` — 브라우저 네이티브 앵커링이 virtualizer 앵커 보정과 싸우는 것 차단 + 스크롤바 등장 시 레이아웃 시프트 제거.
3. **비가상화 리스트에 `content-visibility: auto`** (web.dev 7x 사례의 올바른 적용처):
   - 근거 카드: `.card { content-visibility: auto; contain-intrinsic-size: auto 96px; }`
   - 아티팩트 목록 행, 알림 목록 행 동일 적용.
   - 가상화된 `.virtualItem`에는 **적용 금지**(virtualizer와 이중 관리 충돌).
4. 마크다운 대형 블록: `.md pre { content-visibility: auto; contain-intrinsic-size: auto 200px; }` — 접힌 화면 밖 코드블록 렌더 스킵.
5. `.msgActions` opacity 전환은 GPU 무해(현행 유지). `will-change` 신규 부여 금지(메모리 비용) — GSAP가 tween 중 자동 관리.

**Verify:** 200+ 근거/긴 코드블록 스레드에서 rendering 타임라인 비교. 스크롤 중 Layout Shift 0.

## Task D4: 메모리 상한 — 메시지 윈도우 트리밍 (F10)

**Objective:** 무한 스크롤을 아무리 해도 in-memory 메시지 ≤ 400개.

**Files:** `messageWindow.ts`, `messageWindow.test.ts`

**Steps (TDD):**
1. RED: `mergeMessagePage` 결과가 `MAX_WINDOW(400)` 초과 시 — direction 'older'면 **newest 쪽**을 잘라 `hasNewer=true`+`newerCursor` 재설정, 'newer'/'latest'면 **oldest 쪽**을 잘라 `hasOlder=true`+`olderCursor` 재설정 — 하는 테스트 작성.
2. GREEN: orderedIds slice + 커서 경계 재계산 구현. anchorMessageId가 잘리는 쪽에 있으면 유지 예외(검색 점프 보호).
3. 가상화 쪽은 무변경(count만 줄어듦). A2의 FAB가 hasNewer 경로를 이미 처리하므로 UX 정합.

**Verify:** vitest GREEN. 브라우저에서 위로 500개 로드 → heap snapshot에서 메시지 배열 400 유지, 아래로 복귀 시 재hydrate 정상.

## Task D5: GSAP·마이크로 애니메이션 최적화 (항목 11)

**Files:** `lib/motion.ts`, `ThinkingRibbon.tsx`, `CommandPalette.tsx`, `AuthKit.tsx`, `Menu.tsx`, `global.css`

**Steps:**
1. GSAP 전역 설정 모듈(`motion.ts`): `gsap.config({ force3D: true }); gsap.ticker.lagSmoothing(500, 33);` + `prefersReducedMotion()`이면 `gsap.globalTimeline.timeScale(1000)` 패턴 대신 각 트윈에서 duration 0 처리 헬퍼 `motionDur(sec)` 제공.
2. 각 GSAP 사용처 감사: transform/opacity 외 속성(width/height/top 등 레이아웃 속성) 트위닝 발견 시 transform 등가로 교체. `gsap.context()` cleanup 여부 확인.
3. 신규 등장 애니메이션(검색 드롭다운·슬래시 메뉴·상세 popover·FAB)은 GSAP 대신 **모던 CSS**: `@starting-style` + `transition-behavior: allow-discrete` (display:none↔flex 전환 애니) — JS 0바이트.
```css
.popEnter { transition: opacity 160ms var(--ease-out), transform 200ms var(--ease-out), display 200ms allow-discrete; @starting-style { opacity: 0; transform: translateY(-4px) scale(0.98); } }
```
4. `@keyframes` 유지분(shimmer/pulse/spin)은 opacity/transform만인지 확인(현행 OK).

## Task D6: 쿼리·번들 미세 조정 (항목 11)

**Files:** `useMessageWindow.ts`, `lib/spaces.ts`, `vite.config.ts`(필요시)

**Steps:**
1. `messageWindowKeys.latest` 쿼리: `staleTime: 30_000` (탭 복귀마다 refetch로 윈도우 리셋되는 것 방지 — 현재 refetchOnWindowFocus 기본 true로 latest 페이지 재병합 발생 가능), `gcTime` 기본 유지.
2. `useWorkspaceTree`/`useThreads`: `staleTime: 10_000` + `placeholderData: keepPreviousData`(트리 전환 깜빡임 예방 — A3 보조).
3. 번들: `dist` 분석 결과 markdown 154KB/gsap 69KB는 라우트 자동 분할로 이미 격리. 추가 액션: `lucide-react` named import 확인(전량 트리셰이킹 여부) — `grep "from 'lucide-react'"` 후 barrel import면 개별 경로로. **과최적화 금지(YAGNI)** — 측정 후 154KB 청크가 FCP에 영향일 때만 lazy 검토.
4. `chat_messages` 인덱스·SSE·SW 프리캐시는 이미 최적 — 무변경 문서화.

**Verify:** Lighthouse(로그인 화면+앱 셸) 성능 점수 전후, 번들 사이즈 diff.

---

# Track E — React Compiler 정합 정리 (사용자 추가지시)

**Objective:** React Compiler가 자동 메모이제이션하므로 수동 `useMemo`/`useCallback`을 전부 제거하고, 컴파일러가 못 잡는 지점만 **다른 방식**으로 최적화. 총 19개 사용처(7파일) 감사.

**원칙:** React Compiler(babel-plugin-react-compiler v1)가 컴포넌트·커스텀훅 내 모든 파생값·함수를 deps 분석 기반으로 안정화한다. 따라서 수동 memo는 (a) 순수 성능용이면 제거, (b) 컴파일러가 bail-out하는 구조면 구조를 바꿔 제거, (c) ref 안정성이 **정확성**에 필요하면 `useRef`로 대체(memo 아님).

**감사 결과 (전 케이스 순수 성능 → 제거 대상):**

| 파일 | 사용 | 조치 |
|------|------|------|
| `ChatThread.tsx` | `slashItems` useMemo, `liveRows`(VirtualStream), `minimapEntries`(미메모) | useMemo 제거. minimapEntries는 F9대로 파생 유지(컴파일러가 안정화) |
| `VirtualMessageStream.tsx` | `requestOlder`/`requestNewer` useCallback, `liveRows` useMemo | **ref 기반 리팩터**(E1) — IO 효과가 컴파일러에 의존하지 않게. liveRows useMemo 제거 |
| `useMessageWindow.ts` | `loadOlder`/`loadNewer`/`jumpAround` useCallback | 제거(컴파일러가 훅 반환 콜백 안정화). 단 소비처 effect deps 회귀 QA |
| `ConvoMinimap.tsx` | `userEntries` useMemo | 제거 |
| `CommandPalette.tsx` | `items`/`filtered` useMemo | 제거(단 filtered는 Track F 한글매처로 교체됨) |
| `Toast.tsx` | `push` useCallback (context value) | 제거 — 컴파일러가 context value 안정화. 소비처 재렌더 회귀 Profiler 확인 |
| `push.ts` | `toggle` useCallback | 제거 |

## Task E1: VirtualMessageStream IO 콜백 ref화 (컴파일러 독립)

**Objective:** 무한스크롤 IO 효과의 정확성이 컴파일러 memo에 의존하지 않도록 구조 변경.

**Steps:**
1. `requestOlder`/`requestNewer` useCallback 삭제 → 로직을 IO effect **내부 인라인** 함수로 이동.
2. effect가 참조하는 모든 가변값(guards, load fns, allowAutoLoad)은 이미 ref이므로 effect deps는 `[scrollRef]`(불변)만.
3. 결과: 컴파일러가 이 컴포넌트를 bail-out해도 IO 재구독 없음. anchor 보정 로직도 ref 기반 확인.

## Task E2: 나머지 수동 memo 일괄 제거 + 검증

**Steps:**
1. 위 표대로 useMemo/useCallback 제거(useRef·useEffect·useState는 유지).
2. eslint `react-hooks` (v6, react-compiler 룰 포함) 통과 확인 — 불필요 memo 경고 0.
3. React DevTools Profiler로 3지점 회귀 확인: (a) Toast 다발 시 소비처 과다 리렌더 없음, (b) 채널 트리 재렌더, (c) 스트리밍 중 커밋 빈도.
4. **다른 방식 최적화(사용자 "다른 방식으로")**: 제거로 드러나는 진짜 병목은 memo가 아니라 *리렌더 유발원*이므로 Track A4(rAF 배칭)·A5(타이머 격리)·D(containment)가 실질 최적화를 담당. E는 코드 단순화 + 컴파일러 신뢰가 목적.

**Verify:** typecheck+build+test GREEN, Profiler 3지점 회귀 없음.

---

# Track F — 검색 UX 전면 보강 + 한글 스마트 검색 (사용자 추가지시)

**Objective:** ① 결과가 많을 때 "한 곳으로 점프"만 하던 UX를 **전체 결과 목록 + 전 버블 하이라이트 + 결과 네비게이터**로 교체. ② 초성/합성(부분자모)/띄어쓰기무시 한글 검색을 트랜스크립트 검색·⌘K 팔레트 양쪽에 적용.

**아키텍처 결정:** 한글 매처는 **순수 TS 유틸**로 `packages/contracts`에 두어 web·api 양쪽이 동일 로직 공유(스키마 변경 없음, 외부 의존 0). 트랜스크립트 검색은 서버 store가 스레드 메시지(경계 있음)를 로드해 JS 매처로 필터 — pg 확장/초성 컬럼 불필요.

## Task F1: 한글 스마트 매처 유틸 (공유)

**Files:** Create `packages/contracts/src/hangul-search.ts` + export in `packages/contracts/src/index.ts`; Test `packages/contracts/src/hangul-search.test.ts`

**명세 (TDD):**
```ts
// 유니코드 한글 음절 0xAC00~0xD7A3, 초성 19 / 중성 21 / 종성 28
export function decomposeJamo(s: string): string   // 음절→자모열, 그외 그대로
export function chosung(s: string): string          // 각 음절의 초성만
export function normalizeSearch(s: string): string  // lowercase + 모든 공백 제거
export function isChosungQuery(q: string): boolean   // 질의가 전부 초성자모(ㄱ~ㅎ)인가
export function hangulMatch(text: string, query: string): boolean
  // 아래 OR:
  //  (1) normalizeSearch(text).includes(normalizeSearch(query))   ← 띄어쓰기무시 부분일치
  //  (2) isChosungQuery면 chosung(text)에 대해 질의 초성 subsequence
  //  (3) decomposeJamo(text)에 대해 decomposeJamo(query) subsequence ← 합성/부분자모
export function highlightRanges(text: string, query: string): [number,number][]
  // (1) 경로로 매칭될 때만 원문 인덱스 범위 반환(초성/자모는 범위 없음 → 버블레벨 강조로 폴백)
```
**RED 테스트 케이스:** `hangulMatch('창원시 예산서','ㅊㅇㅅ')===true`, `('창원시 예산서','창원 예산')===true`, `('창원시','차')===true`(합성), `('Hello World','hw')===true`(영문초성 유사), `('예산서','상')===false`.

## Task F2: 서버 트랜스크립트 검색을 한글매처로 교체

**Files:** Modify `apps/api/src/chat/chat-message.store.ts` `searchMessages`, `apps/api/src/chat/chat-stream.controller.ts`(변경 없음), `packages/contracts` 재빌드

**Steps:**
1. `searchMessages(threadId, q, limit)`: 기존 `ILIKE '%q%'` → 스레드 메시지 로드(`selectBase().where(visibleThread).orderBy(desc createdAt).limit(2000)`) 후 `hangulMatch(content, q)` 필터 → 상위 limit. (스레드 메시지 경계 있음; 2000 상한 가드.)
2. 스니펫: `highlightRanges` 있으면 그 위치 기준, 없으면(초성/자모) 첫 매칭 어절 기준 발췌.
3. 응답 contract에 `matchKind: 'text'|'chosung'|'jamo'`와 선택적 `ranges` 추가(SearchMessagesResponse 스키마 확장, optional).

## Task F3: 검색 결과 UX — 우측 패널 결과 + 전 버블 하이라이트 + 네비게이터

**Files:** Modify `ChatThread.tsx`(검색상태 상향), `VirtualMessageStream.tsx`(하이라이트셋), `AppShell.tsx` ContextPanel(검색 탭), `ThreadView.module.css`; Create `apps/web/src/widgets/chat-thread/model/searchStore.ts`(스레드-검색 상태 공유 store, threadCtx 패턴)

**UX 명세:**
1. **결과 목록(우측 패널 "검색" 탭)**: 검색 실행 시 ContextPanel에 검색 탭 자동 활성 + 전체 결과(스니펫·역할·시각) 리스트. 각 항목 클릭 → 해당 버블로 점프+포커스. 헤더 드롭다운은 **빠른 미리보기(상위 5)**로 축소, "우측에서 전체 보기" 링크.
2. **전 버블 하이라이트**: 검색 활성 동안 현재 윈도우에 로드된 매칭 메시지 전부 `mark` 배경. `highlightRanges`가 있으면 해당 문자 범위에 `<mark>`, 없으면(초성/자모) 버블 좌측 accent 레일 + 옅은 배경.
3. **결과 네비게이터**: 헤더에 `◀ 3 / 12 ▶` (Ctrl+F 스타일). 다음/이전 = 결과 배열 순회 → 해당 메시지 `jumpAround` 후 강조. 현재 포커스 결과는 강조 강함(다른 매칭은 약함).
4. **엣지**: 결과가 현재 윈도우 밖이면 `jumpAround(id)`로 윈도우 이동(F10 트리밍과 정합) 후 강조. 검색어 지우면 하이라이트·네비 초기화. 스레드 전환 시 검색상태 리셋.
5. **하이라이트 지속**: 기존 1.8s 펄스는 "현재 포커스 결과"에만, 나머지 매칭은 검색 활성 동안 지속.

## Task F4: ⌘K 커맨드 팔레트 한글 매처 적용

**Files:** Modify `CommandPalette.tsx`

**Steps:** 기존 영문 subsequence `match()`를 `hangulMatch()`로 교체(초성/공백무시/합성 자동). `filtered` useMemo는 E대로 제거.

**Verify(F 전체):** contracts 테스트 GREEN, 브라우저에서 `ㅊㅇ`→창원 채널·메시지 매칭, `창원 예산`(공백)→`창원예산서` 매칭, 결과 12개 시 우측 패널 목록+네비게이터+전 버블 mark, 다크모드 mark 대비 확인.

---

# Track A 확장 — 채팅 불러오기 UX 보강 (사용자 "더 많이 잘")

기존 A1~A5에 더해:

## Task A6: 로딩 상태 3종 시각 분리 + 상단 "이전 대화" 로드 표시 강화

**Files:** `VirtualMessageStream.tsx`, `ThreadView.module.css`

**Steps:**
1. **초기 로드**: SkeletonMessage(완료됨) 유지.
2. **상단 older 로딩**: 현재 텍스트 프로브 → 상단 고정 미니 스피너 바 + `SkeletonMessage` 1개를 리스트 최상단에 얹어 "이어붙는 중" 시각화(레이아웃 점프 방지: 앵커 보정과 함께).
3. **하단 newer 로딩**(검색 점프 상태): 동일 패턴 하단.
4. **끝 도달**: "대화의 시작이에요"/"최신입니다" 종결 표식(hasOlder=false / hasNewer=false).
5. **네트워크 지연**: older 로드가 400ms 초과 시에만 스피너(useDelayedFlag) — 빠르면 무표시.
6. **에러**: older/newer 로드 실패 시 "다시 시도" 인라인 버튼(현재 무처리) — `useMessageWindow`에 로드 에러 state 추가.

## Task A7: 읽던 위치 보존(스레드 재진입) + 신규 메시지 구분선

**Files:** `useMessageWindow.ts`, `VirtualMessageStream.tsx`, `searchStore.ts`

**Steps:**
1. **마지막 읽음 위치**: 스레드별 마지막 본 messageId를 sessionStorage에 저장, 재진입 시 그 위치로 복원(옵션: 바닥이 기본, 안 읽은 게 있으면 첫 안읽음으로).
2. **신규 메시지 구분선**: 위로 스크롤 중 도착한 새 메시지 앞에 "여기까지 읽음 ─── 새 메시지" 디바이더(Slack 패턴). A2의 unseenCount와 연동.
3. **엣지**: 스트리밍 자기 메시지는 구분선 대상 아님(내가 보낸 것).

# 구현 순서 (의존성 기준)

```
1. B1 → B2 → B3   (표면 정리 먼저 — 이후 시각 작업의 기반, 항목 3·9·10 즉효)
2. A1 → A4 → A5   (스크롤 불변식 → 배칭 → 상태바 분리; A2가 A1에 의존)
3. A2 → A3        (FAB, 채널 전환)
4. C1 → C2        (인증 — 독립 트랙, 언제든 병행 가능)
5. B4 → B5 → B6   (우측 패널 재설계)
6. D1 → D2 → D3 → D4 → D5 → D6 (성능 — A4/A5 완료 후 측정 기반으로)
```

커밋 단위: Task당 1커밋(`feat:`/`fix:`/`perf:`), 트랙 완료마다 `pnpm typecheck && pnpm -C apps/web build && pnpm -C apps/web test` 게이트.

# 검증 시나리오 (최종 QA 체크리스트)

- [ ] 위로 스크롤 반복 → 과거 페이지 연속 로드(회귀 확인) + FAB 표시/동작 7케이스
- [ ] 스트리밍 중 위로 스크롤 → yank 없음, pill 카운트, FAB 복귀
- [ ] 검색 점프 → FAB → latest 윈도우 교체
- [ ] 채널 연타 전환 → 하이라이트 즉시 이동·스피너는 느릴 때만
- [ ] 컴포저: 라이트/다크 각 1겹 테두리, 테마 연타 시 깜빡임 0
- [ ] 다크 헤더/검색/프로브/우측패널 대비 정상(스크린샷)
- [ ] 근거 폼 열기/닫기 애니 + reduced-motion 시 즉시 전환
- [ ] `run_` 문자열 화면 미노출 + 상태 pill 클릭 → 상세 popover 전체 필드
- [ ] offline 토글 후 복귀 → 로그인 유지 / 15분 방치 → 무단절 갱신
- [ ] 3000자 스트리밍 Profiler: commit/frame ≤ 1.2, scripting 시간 ≥40% 감소
- [ ] 500+ 메시지 로드 heap: 윈도우 ≤400 유지
- [ ] vitest 전체 GREEN(신규: messageWindow 트리밍 테스트 포함)

# 리스크 / 트레이드오프 / 열린 질문

1. **`marked` 의존성 추가(D2)** — 신규 dep 승인 필요. 대안: 자체 블록 스플리터(빈 줄 기준)로 0-dep 구현 가능하나 코드펜스 경계 처리 필요. → 기본안 marked, 승인 없으면 자체 스플리터.
2. **윈도우 트리밍(D4)과 검색 점프 상호작용** — anchor 보호 로직 테스트 필수. 실패 시 MAX를 600으로 완화.
3. **`.head` 반투명 vs 불투명** — 불투명이 성능 최상이나 시각 결정 필요(구현 시 스크린샷 2안 비교 제시).
4. **`@starting-style`** — Chrome 117+/Safari 17.5+. 구형 브라우저는 애니 없이 즉시 표시(기능 무손실, 진보적 향상).
5. **선제 refresh(C2)** — 다중 탭 동시 refresh 회전 충돌 가능: refreshInFlight 단일화가 탭 내에서만 유효. localStorage `storage` 이벤트로 타 탭 세션 동기화 추가(계획 포함, 소규모).
6. **런 상세 popover의 reasoningText** — 서버가 reasoning 본문을 어디까지 주는지에 따라 프리뷰 축소 가능(현행 이벤트 기반, 없으면 'on' 표시만).
7. **프로드 배포** — 전 트랙 완료 후 일괄 재빌드/배포는 별도 승인.

# 변경 파일 총목록 (예상)

```
apps/web/src/widgets/chat-thread/ui/VirtualMessageStream.tsx   (A1,A2,A5)
apps/web/src/widgets/chat-thread/ui/ChatThread.tsx             (A1,A2,A4,A5,D1)
apps/web/src/widgets/chat-thread/ui/JumpToLatest.tsx           (A2, 신규)
apps/web/src/widgets/chat-thread/ui/RunStatusBar.tsx           (A5, 신규)
apps/web/src/widgets/chat-thread/model/useMessageWindow.ts     (A2,D6)
apps/web/src/widgets/chat-thread/model/messageWindow.ts        (D4)
apps/web/src/widgets/chat-thread/model/messageWindow.test.ts   (D4)
apps/web/src/widgets/thread-view/ui/ThreadView.module.css      (A2,A5,B1,B3,B6,D3)
apps/web/src/widgets/app-shell/ui/AppShell.tsx                 (A3,B4,D1)
apps/web/src/widgets/app-shell/ui/AppShell.module.css          (A3,B4,B6)
apps/web/src/widgets/evidence-panel/ui/EvidencePanel.tsx       (B4,B5)
apps/web/src/widgets/evidence-panel/ui/EvidencePanel.module.css(B4,B5,D3)
apps/web/src/shared/ui/input/Input.tsx                         (B1)
apps/web/src/shared/ui/shared-ui.css                           (B1)
apps/web/src/shared/ui/markdown/StreamingMarkdown.tsx          (D2, 신규)
apps/web/src/shared/ui/markdown/Markdown.module.css            (D3)
apps/web/src/lib/themeStore.ts                                 (B2)
apps/web/src/lib/api.ts                                        (C1,C2)
apps/web/src/lib/spaces.ts                                     (D6)
apps/web/src/lib/motion.ts → shared/lib/motion.ts 정합 확인     (D5)
apps/web/src/styles/global.css                                 (B2,D3,D5)
packages/api-client/src/http-core.ts                           (C1, status 노출 확인)
apps/web/package.json                                          (D2 marked — 승인 시)
```
