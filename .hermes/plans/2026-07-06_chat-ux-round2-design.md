# 채팅 UX 2차 고도화 — 설계서 (구현 전 / 실화면 진단 기반)

> 작성 2026-07-06 · **설계만** (구현 미착수) · 브라우저 실화면(127.0.0.1:5273 · QA계정)으로 8개 이슈 근본원인 확정
> 기존 1차(커밋 62d7bf1~cfe7080)에서 남은 안정성·가독성·캐시 문제를 해결한다.

## 진단 환경 (재현용)
- dev 5273 (→ /api proxy → prod API 8088), prod 8088 동시 가동 중 (5273 = 사용자 dev, **kill 금지**)
- QA 계정: `qa-uxtest@example.com` / 회원가입으로 생성됨. 워크스페이스 "QA 지구's Workspace" → 프로젝트 "창원시 컨설팅" → 채널 "예산 검토"
- 실측 도구: browser_vision(스크린샷), browser_console(computed style/DOM)

## 실측으로 확정한 근본 원인 (추정 아님)
| # | 증상 | 실측 근본원인 | 근거 |
|---|------|--------------|------|
| 1 | 채널 빠른 왕복 시 씹힘/안눌림 | active 채널 button `disabled` → 되돌아갈 때 클릭 불가 + `pendingTopicId`↔router 경합 + 윈도우가 로컬 state라 전환마다 리셋 | AppShell.tsx:468 `disabled={channelActive}` |
| 2 | 불러오는 게 의식됨 | IO rootMargin 320px 고정(뷰포트 무관), 스켈레톤이 "불러오는 중" 텍스트로 노출, 프리페치 없음 | VirtualMessageStream IO `rootMargin '320px 0px 120px'` |
| 3 | 근거 폼 애니 어색 + 취소 시 버튼 레이아웃 튐 | grid 아코디언과 "근거 추가" 버튼이 **상호 배타 렌더**(폼 열림=버튼 unmount) → 취소 시 버튼이 즉시 재삽입되며 높이 점프. `formInner`가 padding-top만 있고 진입 stagger 없음 | EvidencePanel.tsx `{!formOpen ? <button> : null}` |
| 4 | 채널 ⋯ 메뉴가 배경에 가려져 뒤로감 | **`.channelListInner { overflow: hidden }`**(접기 아코디언용)이 메뉴 popover(position:absolute)를 클리핑 → 잘린 영역 클릭이 채널행 onClick으로 흘러 채널 이동 | console: channelListInner overflow=hidden |
| 5 | 입력창이 채팅창과 배경 동일 | 컴포저 `.box` bg = `#f7f5f1` = 채팅 캔버스 `#f7f5f1` **완전 동일**, border는 10% 회색뿐 | console: composerBox rgb(247,245,241) == chatCanvasBg |
| 6 | 검색이 검색창 밑+우측 동시에 뜸, 클릭 시 레이아웃 시프트 | 헤더 드롭다운(`.searchResults` top5)과 우측 `SearchResultsPanel`(전체)이 **동시 렌더**. 클릭 시 `jumpAround`가 윈도우 교체→가상리스트 리마운트로 시프트 | ChatThread 헤더+ContextPanel 둘 다 검색결과 렌더 |
| 7 | 밑으로 버튼 동작 불안정 + 채팅 가독성 | `jumpToLatest`가 resetToLatest(비동기)→rAF scrollIntoView 경합, 검색 중 원치않는 스크롤. 가독성: 본문 15px/1.65는 무난하나 위계·여백·인용/표 스타일 미최적 | ChatThread jumpToLatest, ThreadView .text |
| 8 | 채널 재방문 시 처음부터 다시 로드 | **윈도우가 useState 로컬** → threadId 바뀌면 `setWindowState(undefined)` 후 재구성. TanStack 캐시는 API만 커버, 누적/스크롤/트림 상태는 소실 | useMessageWindow.ts:28-40 |

---

# 설계 (트랙별)

## G1 — 채널 전환 안정화 (#1) + 항상 최하단 (#8 보조)
**목표:** 아무리 빠르게 왕복해도 클릭이 씹히지 않고, active 채널도 다시 누를 수 있으며, 전환 후 항상 최하단.

**설계:**
1. **active 채널 button `disabled` 제거** → `aria-current`만 유지. 이미 활성인 채널 클릭은 `openChannel` 내부에서 `topicId===currentTopicId`면 "그래도 최하단으로 스크롤"만 수행(no-op navigate 회피). 이게 #1 "안 눌림"의 직접 원인.
2. **입력 경합 차단**: `openChannel`에 마지막 클릭 의도를 ref로 기록(`lastClickedTopicRef`). `startNav` 완료 후 실제 도착 topic이 마지막 클릭과 다르면 재-navigate(빠른 왕복 시 최종 클릭 승리).
3. **navigate 디바운스 아님, 최신 우선(latest-wins)**: `useTransition`은 유지하되 pendingTopicId를 "가장 마지막 클릭"으로 항상 덮어씀(이미 부분 구현, 경합 케이스만 보강).
4. **전환 후 최하단 보장**: 스레드 진입 시 `didInitialScroll` 리셋 + latest 윈도우면 항상 `scrollToIndex(last,'end')`. (현행 동작 검증 후 필요 시 강화)

**검증:** Slow 3G에서 A↔B 10회 왕복 → 마지막 클릭 채널이 열리고, active 재클릭도 반응, 열릴 때마다 최하단.

## G2 — 무의식 프리페칭 무한스크롤 (#2, 고급기법)
**목표:** 사용자가 "불러온다"는 걸 **전혀 인지하지 못하게**.

**설계 (다층):**
1. **동적 rootMargin = 뷰포트 배수**: 고정 320px → `rootMargin: '${vh*1.5}px 0px ${vh*0.8}px'`. 뷰포트 1.5배 남았을 때 미리 로드 → 사용자가 경계 도달 전 완료.
2. **속도 기반 프리페치(velocity-aware)**: 스크롤 속도(px/frame)를 rAF로 추적, 빠르면 rootMargin을 더 키움(관성 스크롤 대비). scroll-velocity 패턴.
3. **스켈레톤 억제**: 프리페치가 제때 끝나면 로딩 표식 자체를 안 보임. `isLoadingOlder`가 400ms(useDelayedFlag) 넘을 때만 미니 인디케이터. 정상 프리페치는 무음.
4. **앵커 무결성 유지**: 현행 IntersectionObserver 센티넬 + scrollToIndex 앵커 보정 유지(회귀 금지). `content-visibility` 유지.
5. **idle 프리페치(선택)**: `requestIdleCallback`으로 유휴 시 다음 older 페이지 1장 선반입(네트워크 여유 시). 과하면 D6 staleTime과 상충 — 옵션으로만.

**검증:** 500+ 메시지 스레드에서 보통 속도 스크롤 시 "불러오는 중" 텍스트 0회 노출(Performance 타임라인 + 육안). 빠른 플릭에도 빈 구간 없음.

## G3 — 근거 폼 애니메이션 + 레이아웃 안정 (#3)
**목표:** 열기/닫기 부드럽고, 취소 시 버튼 튐 0.

**설계:**
1. **"근거 추가" 버튼을 상시 마운트**로 변경 — 폼과 배타 렌더 폐지. 버튼은 항상 자리(높이 고정 슬롯)에 두고, 폼이 열리면 버튼을 `opacity/visibility`로 숨김(unmount 아님) → 취소 시 높이 점프 없음.
2. **폼 진입 stagger**: formInner 자식(input 3개+버튼행)에 `@starting-style` 또는 CSS transition-delay 계단(0/40/80ms) fade+rise. GSAP 불필요(모던 CSS).
3. **grid 아코디언 유지**(0fr→1fr)하되 `transform: translateY` 제거하고 opacity+grid-rows만(현재 translateY가 어색함의 원인 중 하나).
4. **reduced-motion**: 즉시 전환.

**검증:** 열기→취소 5회 반복, 버튼 위치 픽셀 고정(레이아웃 시프트 0), 진입 자연스러움 육안.

## G4 — 채널 메뉴 클리핑 해소 (#4)
**목표:** ⋯ 메뉴가 잘리지 않고, 눌러도 채널 이동 안 함.

**설계 (택1, 권장 A):**
- **A. Portal 렌더 + 고정 위치**: RowMenu의 `.pop`을 `document.body`에 portal, 트리거 rect 기준 `position:fixed`로 배치. overflow:hidden 조상 무관. z-index 계층 정리(팝오버 레이어 1000+).
- **B. overflow 완화**: `.channelListInner`의 hidden은 접기 애니메이션 전용이므로, **접힘 완료 후 `overflow:visible`로 전환**(transitionend). 단 애니 중 메뉴 열면 잘림 — A보다 취약.
- 공통: RowMenu 트리거/팝오버에 `e.stopPropagation()` 강화(이미 있으나 잘린 영역 클릭이 문제였음 → A로 근본 해결). 채널행 onClick은 `.chanMain` 버튼에만(행 전체 clickable 축소).

**검증:** 메뉴 열기→항목 다 보임(스크린샷), 항목/바깥 클릭 시 채널 이동 안 함, 좁은 사이드바에서도 화면 안에 위치.

## G5 — 컴포저 시각 분리 (#5)
**목표:** 입력창이 채팅 영역과 명확히 구분.

**설계:**
1. 컴포저 `.box` 배경을 `--surface-card(#fffdf8)`로 (캔버스 #f7f5f1보다 밝게) + **위로 뜨는 그림자**(`box-shadow: 0 -1px 0 border, 0 8px 24px -18px`) 또는 상단 hairline + 미묘한 elevation.
2. 컴포저 영역 전체를 감싸는 `.composer`에 상단 구분선(`border-top`) + 살짝 다른 배경으로 "입력 존" 확립.
3. 다크모드 대칭 확인(surface-card #1d1f22 vs canvas). focus-within accent 링 유지.
4. B1(단일 표면) 원칙 유지 — 내부는 투명, `.box`만 새 배경.

**검증:** 라이트/다크 스크린샷에서 입력창이 시각적으로 분리(대비 측정), 경계 명확.

## G6 — 검색 UX 단일화 + 시프트 제거 (#6, #7 검색부분)
**목표:** 검색 결과는 **한 곳만**(우측 패널), 클릭 시 레이아웃 안정.

**설계:**
1. **헤더 드롭다운(`.searchResults`) 폐지** → 검색 결과는 우측 "검색" 탭 하나로 통일(사용자 명시 선호). 헤더엔 입력창 + `◀ n/m ▶` 네비게이터 + 결과 수 뱃지만.
2. **결과 클릭 시 시프트 제거**: `jumpAround`가 윈도우를 통째 교체 → 가상리스트 리마운트가 시프트 원인. 대신 **타깃이 현재 윈도우 안이면 스크롤만**(교체 X), 밖일 때만 jumpAround. jumpAround도 스크롤 컨테이너 높이 고정 + 앵커 정렬로 시프트 최소화.
3. **검색 중 자동 스크롤 안정화**: 검색 실행 시 첫 결과로의 이동을 1회만, `behavior:auto`, atBottom 강제 해제. 검색 종료(쿼리 클리어) 시 원위치 복원 옵션.
4. 우측 패널 검색 탭: 헤더 sticky, 결과 행 클릭 시 포커스 인덱스만 갱신(현행 유지), hover/active 강조.

**검증:** 검색 시 헤더 아래 드롭다운 안 뜸(우측만), 결과 12개 클릭 연타 시 채팅 영역 점프/시프트 없음.

## G7 — 밑으로가기 안정화 (#7) + 채팅 가독성 고도화 (#7 핵심)
**목표:** FAB 100% 안정 + **컨설팅 가독성 최대화**.

**FAB 설계:**
1. `jumpToLatest`의 resetToLatest(async)↔scrollIntoView(rAF) 경합 제거: latest 윈도우면 즉시 `virtualizer.scrollToIndex(last,'end')`, around/hasNewer면 resetToLatest **await 후** 단일 rAF에서 스크롤. 이중 rAF 제거.
2. 검색 활성 중 FAB는 "검색 종료 후 최하단"으로 동작(검색 상태 먼저 clear).
3. atBottom 판정 히스테리시스(120px)로 깜빡임 방지.

**가독성 설계 (컨설팅=가독성 최우선):**
1. **본문 타이포**: 15px/1.7(현 1.65→1.7), 문단 간격 `margin-block`, 최대 폭 `max-width: 72ch`(장문 줄길이 제어 — 가독성 핵심). 좌측 정렬(사용자 선호).
2. **위계**: 발신자 이름/시간 메타 대비 조정, AI/사용자 구분을 배경이 아닌 **여백·아바타·정렬**로(버블 배경 남발 금지 = Slack 스타일).
3. **마크다운 리치 요소 강화**: 표(풀폭·좌측정렬·zebra), 인용(좌측 accent 바), 코드(가독 폰트/대비), 리스트 간격, 링크 밑줄 — 컨설팅 산출물 렌더 품질.
4. **긴 한국어 줄바꿈**: `word-break:keep-all` 유지 + 표/코드만 overflow 스크롤.
5. **밀도 옵션(선택)**: 편안/조밀 토글은 과설계 — 기본 "편안"만.

**검증:** 장문(표+코드+인용+리스트) 메시지 렌더 스크린샷 라이트/다크, 줄길이 72ch 확인, FAB 10회 연타 안정.

## G8 — 진짜 메시지 캐시 (#8)
**목표:** 채널 재방문 시 재로딩 없이 즉시 표시 + 바뀐 부분만 교체 + 항상 최하단.

**설계 (핵심 아키텍처 변경):**
1. **윈도우 상태를 TanStack Query 캐시로 승격**: `windowState`(누적 페이지·커서·트림·mode)를 로컬 useState → **per-thread 캐시 스토어**(QueryClient의 `setQueryData`로 `['message-window', threadId]` 보관, 또는 모듈 레벨 Map<threadId, MessageWindow>). threadId 전환 시 `undefined` 리셋 대신 **캐시 hit면 즉시 복원**.
2. **바뀐 부분만 교체(delta)**: 재방문 시 캐시 표시 + 백그라운드로 latest 1페이지 refetch → `mergeMessagePage`로 **새 메시지만 append**(기존 id는 dedupe로 유지). 전체 리로드 아님.
3. **항상 최하단 규칙**: 캐시가 남아있어도 채널 진입 시 스크롤은 **항상 최하단**(사용자 명시). 캐시=내용 보존, 스크롤 위치=매번 초기화(최하단). 단 "around(검색점프) 캐시"는 재방문 시 latest로 리셋(꼬임 방지).
4. **메모리 상한**: 캐시 Map은 LRU(최근 N개 스레드, 예: 8개)로 제한 — 무한 성장 방지. 각 윈도우는 이미 D4로 400개 상한.
5. **무효화**: 메시지 전송/삭제 시 해당 thread 캐시에 반영(현행 invalidate와 연결).

**트레이드오프:** 모듈 Map은 새로고침 시 소실(정상 — 세션 캐시). sessionStorage 영속화는 과설계라 보류(요구=세션 내 재방문).

**검증:** A(50+메시지 로드·위로 스크롤)→B→A 재방문 시 (a) API 재요청 0(네트워크 탭), (b) 내용 즉시 표시, (c) 스크롤 최하단, (d) 그새 온 새 메시지만 추가.

---

# 구현 순서 (의존성)
```
G4(메뉴 클리핑, 독립·저리스크) → G5(컴포저 배경, 독립)
→ G1(채널 전환) → G8(메시지 캐시)   ← G1·G8 함께: 캐시가 전환 안정성의 기반
→ G2(프리페치) → G7-FAB(밑으로가기)  ← 스크롤 계열 묶음
→ G6(검색 단일화)
→ G3(근거 폼 애니)
→ G7-가독성(타이포/마크다운 고도화)  ← 시각 마감
→ 전체 QA(실화면 8이슈 재현 테스트)
```

# 리스크 / 열린 결정
1. **G8 캐시 저장소**: 모듈 Map(단순) vs QueryClient setQueryData(devtools 가시성). → 권장 **모듈 LRU Map**(윈도우는 직렬화 부적합한 Map 포함).
2. **G8 "항상 최하단" vs "읽던 위치 복원"**: 사용자 명시 = **항상 최하단**. A7의 위치복원은 폐기(상충). 신규 구분선은 유지.
3. **G6 헤더 드롭다운 폐지**: 상위 5 미리보기를 완전 제거 → 우측만. (사용자 "정신없다" = 중복 제거 지지)
4. **G2 idle 프리페치**: 네트워크/배터리 고려해 기본 off, rootMargin 동적화만 필수.
5. **G7 max-width 72ch**: 넓은 화면에서 우측 여백 생김 — 컨설팅 가독성 우선이므로 채택 권장(사용자 확인 포인트).

# 변경 예정 파일 (설계 기준)
```
apps/web/src/shared/ui/menu/Menu.tsx (+ .module.css)          G4 (portal)
apps/web/src/widgets/app-shell/ui/AppShell.tsx (+ .module.css) G1, G4(행 clickable 축소)
apps/web/src/widgets/chat-thread/model/useMessageWindow.ts     G8 (캐시 승격)
apps/web/src/widgets/chat-thread/model/messageCache.ts (신규)  G8 (LRU Map)
apps/web/src/widgets/chat-thread/ui/VirtualMessageStream.tsx   G2, G7-FAB
apps/web/src/widgets/chat-thread/ui/ChatThread.tsx             G1, G6, G7-FAB
apps/web/src/widgets/thread-view/ui/ThreadView.module.css      G5, G6, G7(타이포)
apps/web/src/shared/ui/markdown/Markdown.module.css            G7 (표/인용/코드)
apps/web/src/widgets/evidence-panel/ui/EvidencePanel.tsx(+css) G3
apps/web/src/widgets/app-shell/ui/AppShell.tsx(ContextPanel)   G6 (검색 탭 유지, 헤더 드롭다운 제거는 ChatThread)
```

---

# 2차 추가 요구 (2026-07-06 추가 진단 — G9~G12)

실화면(`browser_console`) + 코드 + Hermes 공식 문서로 확정.

## G9 — 메시지 입력창 자동 확장 (#1 붙여넣기, #2 줄바꿈)
**실측 근본원인:** `<Textarea rows={1}>`에 auto-grow 로직이 **전혀 없음**. `.cwInputBare`는 `resize:none`만. 붙여넣기/줄바꿈 시 높이 고정 → 내부 스크롤만 발생, 확장 안 됨.

**설계:**
1. **auto-grow 훅** `useAutoGrowTextarea(ref, value, { maxRows })`:
   - `value` 변할 때마다 `el.style.height = 'auto'` → `el.style.height = min(scrollHeight, maxHeightPx) + 'px'`.
   - `maxRows`(예: 8줄) 초과 시 `overflow-y:auto`로 전환(그 전엔 hidden), 최대높이 도달 후에만 내부 스크롤.
   - 붙여넣기(`onPaste`)·IME 조합(`compositionend`)·프로그램적 setInput(슬래시 채우기)·창 리사이즈 모두 재계산. rAF로 배칭(리플로우 1회).
2. **CSS**: `.textarea`에 `min-height: 1lh; max-height: calc(8 * 1.5em); overflow-y: hidden; transition: none`(높이 트랜지션은 타이핑 지연 유발 → 없음). 최대높이는 토큰화.
3. **전송 후 리셋**: 전송 시 `height:auto`로 되돌림(1줄 복귀).
4. **접근성**: rows 고정 대신 aria 유지, 스크롤 시 포커스 유지.

**검증:** 5줄 텍스트 붙여넣기 → 5줄로 확장, 10줄 → 8줄+내부 스크롤, 전송 후 1줄 복귀. 슬래시 자동완성·IME 한글 조합에서도 정상.

## G10 — 헤더 타이틀을 채널·프로젝트명으로 (#3)
**실측 근본원인:** 헤더는 `ChatThread({title})` = `ThreadDetailResponse.title`. 스키마에 **채널명/프로젝트명 없음**. 토픽 title이 기본 "대화"라 "대화"만 표시됨. (`ThreadView.tsx`의 breadcrumb는 하드코딩 데모 — 실제 미사용.)

**설계 (2안, 권장 A):**
- **A. 백엔드 breadcrumb 확장(정공법)**: `ThreadDetailResponse`에 `projectName`·`channelName`·`topicName` 추가. `chat` 스토어에서 topic→channel→project join. 헤더는 `프로젝트 › 채널` crumb + 토픽명 title 렌더. 새로고침에도 안전(현행 threadDetail 쿼리 재사용).
- **B. 프론트 역참조(임시)**: `useWorkspaceTree`에서 `topicId`로 project/channel 역탐색. 스키마 변경 없음이나 트리 미로드 시 빈 표시 + O(n) 탐색.
- 권장 **A** — 계약 명확·리프레시 안전·성능 우위. 헤더 렌더: `창원시 컨설팅 › 예산 검토` (crumb, muted) + 그 아래 토픽 title. 토픽 title이 "대화"면 채널명을 title로 승격(중복 회피).

**검증:** 채널 진입 시 헤더에 "프로젝트 › 채널" + 토픽명. 새로고침 유지. 이름 변경 시 반영.

## G11 — 사용자 선택형 질문(clarify) UI — **현 시점 백엔드 미지원, 설계만 확보**
**핵심 조사 결과 (Hermes 공식):**
- 현재 웹앱 백엔드는 Hermes **Runs API**(`/v1/runs` + `/events` SSE)를 프록시. 노출 이벤트: `message.delta / tool.started|completed / reasoning.available / run.completed|failed|cancelled` — **선택형 질문(clarify) 이벤트 없음**.
- **Hermes GitHub Issue #2971** ("expose structured run events and resumable clarify/approval interactions")이 정확히 이 기능을 **미구현 enhancement 요청**으로 명시. 요청된 이벤트에 `interaction.requested / interaction.resolved / clarify`가 포함됨 → **아직 API로 제공 안 됨**.
- 결론: **지구(Hermes)가 clarify 도구로 만드는 "몇 개 선택지 제시 → 사용자 선택" 왕복을 Runs API가 구조화 이벤트로 노출하지 않음.** 현재로선 웹앱에서 네이티브 선택 UI를 띄울 API 훅이 없다.

**설계 (2트랙):**
### G11-a. 지금 가능한 것 — 마크다운 규약 기반 "약한" 선택 UI (백엔드 무변경)
- 에이전트가 답변 본문에 **구조화된 선택 블록**을 규약대로 출력하도록 프롬프트/스킬 유도:
  ```
  ::choices
  1. 옵션 A
  2. 옵션 B
  ::
  ```
  또는 기존 마크다운 순서목록 말미 특정 마커.
- 프론트 `StreamingMarkdown`/`Markdown`에 **choices 디렉티브 파서**를 추가 → 해당 블록을 클릭 가능한 **선택 칩/버튼**으로 렌더. 클릭 시 그 텍스트를 다음 메시지로 자동 전송(사용자가 타이핑한 것처럼).
- 한계: 에이전트 출력에 의존(보장 없음), 스트리밍 중 부분 파싱 주의. 진짜 "resumable interaction"은 아님(그냥 다음 turn 전송).

### G11-b. 정식 지원 — Hermes API가 clarify 이벤트를 노출할 때 (백엔드 확장 필요)
- 계약 확장: `ChatStreamEvent`에 `interaction`(type:'interaction', kind:'clarify'|'approval', prompt, options[], interactionId) 이벤트 추가.
- `hermes-runs-client.ts`가 업스트림 `interaction.requested`를 매핑(현재 미존재 이벤트 → Issue #2971 머지 후 가능).
- 재개(resume): `/v1/runs/:id/respond`류 엔드포인트로 사용자의 선택을 되돌려보내 run 재개. **현재 Hermes에 해당 엔드포인트 없음 → 대기.**
- UI: 스트림 중 `interaction` 수신 시 선택 카드(라디오/버튼) 렌더 → 선택 시 respond 호출 → run이 이어서 진행.

**권장:** G11-a(마크다운 규약)를 **지금 구현**해 "선택지 제시→클릭→자동 전송" 경험을 확보하고, G11-b는 **Hermes #2971 반영 시 정식 승격**하도록 계약 자리(placeholder)만 문서화. 사용자에게: 진짜 중단형 clarify 왕복은 상류(Hermes) 지원 대기 항목임을 명시.

**검증(G11-a):** 에이전트가 choices 블록 출력 → 칩으로 렌더, 클릭 시 해당 옵션이 새 사용자 메시지로 전송되어 대화 이어짐. 일반 목록은 칩으로 오인 렌더 안 함(마커 엄격).

## G12 — (참고) 위 항목들과 기존 G1~G8의 상호작용
- G9(auto-grow)는 G5(컴포저 배경 분리)와 같은 파일 → **함께 작업**(컴포저 리워크 1회).
- G10(헤더)은 G6(검색 헤더 정리)와 같은 `.head` → **함께 작업**.
- G11-a는 G7(마크다운 가독성 고도화)와 같은 Markdown 파이프라인 → **함께 작업**(파서 확장 지점 공유).

---

# 최종 구현 순서 (G1~G12 통합)
```
1. G4(메뉴 portal) · G5+G9(컴포저 배경+auto-grow, 1파일)          ← 독립·저리스크
2. G1(채널 전환) + G8(메시지 캐시)                                  ← 캐시 기반
3. G10(헤더 채널/프로젝트명, 백엔드 breadcrumb)                     ← 백엔드 계약 확장
4. G2(무의식 프리페치) + G7-FAB(밑으로가기)                          ← 스크롤 계열
5. G6(검색 단일화)
6. G3(근거 폼 애니)
7. G7-가독성 + G11-a(선택 칩, 마크다운 파이프라인 공유)              ← 시각/렌더 마감
8. 전체 QA(실화면 12이슈 재현) + G11-b는 Hermes #2971 대기 문서화
```

# 추가 열린 결정
6. **G10 방식**: 백엔드 breadcrumb 확장(A) vs 프론트 트리 역참조(B) → 권장 A. 승인 필요(백엔드 스키마 변경 = 승인 대상).
7. **G11 범위**: 지금은 G11-a(마크다운 규약 선택칩)만. 정식 clarify(G11-b)는 Hermes 상류 미지원 → **대기**. 이 분리를 수용하실지 확인.
8. **G9 maxRows**: 8줄 기본. 더 크게/작게 원하시면 조정.

