# Bidirectional Scroll Flicker + UI Surface Polish Implementation Plan

> **For Hermes:** 구현은 아직 금지. 이 문서는 `subagent-driven-development` 또는 직접 구현 전에 따라야 할 실행 계획이며, 제품 소스 수정 없이 저장된 계획서다.

**Goal:** consulting-web 채팅의 양방향 무한 스크롤 깜박임을 프레임 단위로 계량해 줄이고, 스켈레톤·모션·테이블/빈상태·폰트·컬러/대비·모달/포털 표면을 비침습적으로 정리한다.

**Architecture:** 현재 채팅은 `@tanstack/react-virtual`의 end-anchor 구조를 이미 사용한다. 따라서 대수술이 아니라, 긴 대화 fixture + rAF 프레임 추적으로 실제 깜박임을 먼저 계량한 뒤 tail-lock release, loading affordance, surface token을 최소 조정한다.

**Tech Stack:** React 19.2, Vite, CSS Modules, Radix Dialog/Select, `@tanstack/react-virtual@3.14.5`, TanStack Query/Router, shared CSS tokens.

---

## 0. 범위와 금지선

- 이 계획 단계에서는 제품 소스 파일을 수정하지 않는다.
- 허용된 산출물은 이 `.hermes/plans/*.md` 문서뿐이다.
- 긴 대화 fixture 생성, DB seed, 운영 DB mutation은 **명시 승인 후** 진행한다.
- 기존 repo에는 이미 다수의 변경분이 있으므로 구현 시 `git status --short`로 소유 변경과 기존 변경을 분리한다.
- 시크릿/비밀번호는 문서에 기록하지 않는다.

---

## 1. 확인한 현재 상태

### 1.1 코드 근거

- `apps/web/src/widgets/chat-thread/ui/VirtualMessageStream.tsx`
  - stable key: `getItemKey`가 message id 기반.
  - virtualizer 옵션: `anchorTo: 'end'`, `followOnAppend: 'auto'`, `scrollEndThreshold: 48`, `overscan: 12` 확인.
  - tail settling / tail lock 계열 로직과 `scrollToEnd({ behavior: 'auto' })` 보정 존재.
  - 따라서 문제는 “end-anchor 미적용”이 아니라, dynamic height 측정/정착 타이밍/표시 타이밍의 잔여 flicker 가능성이 높다.
- `apps/web/src/widgets/chat-thread/model/useMessageWindow.ts`
  - older/newer window 로딩 상태와 메시지 병합이 스크롤 안정성과 직접 연결된다.
- `apps/web/src/shared/lib/useDelayedFlag.ts`, `apps/web/src/shared/ui/skeleton/*`
  - delayed skeleton은 있으나, minimum visible duration 정책까지 일관되게 검증해야 한다.
- `apps/web/src/widgets/app-shell/ui/AppShell.tsx`
  - 멤버 탭은 workspace 멤버를 보여주지만 채팅 우측 패널에 있어 채널 멤버로 오해 가능.
- `apps/web/src/components/artifacts/*`, `apps/web/src/components/library/*`
  - 산출물/자료실은 모달 surface로 전환되어 대화 흐름 유지 측면은 좋다.
- `apps/web/src/styles/tokens.css`, `apps/web/src/styles/global.css`
  - motion, font, muted/placeholder contrast, z-layer token을 한 곳에서 정리할 여지가 있다.

### 1.2 브라우저 QA 근거

- `docker-ui@example.com` 계정으로 dev UI 로그인 성공.
- 저장된 thread `94d3fc3c-6a23-4a6c-992a-1a4b17d505fa`는 현재 DB상 메시지 2개뿐이라 양방향 스크롤 재현용으로 부적합.
- 메시지 277개 thread `f11d2db7-0081-4e39-87d6-5bc80d8e4094`는 `김지우's Workspace` 소속이고, 현재 로그인한 Docker UI 워크스페이스에서는 접근 불가/빈 상태로 보임.
- 따라서 긴 대화에서의 실제 flicker frame proof는 아직 미수행이며, 구현 승인 전 QA fixture 또는 접근 가능한 계정/스레드 확보가 필요하다.
- 산출물 모달:
  - overlay `backdrop-filter: none`, dim 배경, z-index 900/901 확인.
  - blur 왜곡 문제는 현재 보이지 않음.
  - 빈 상태/좌우 패널 밀도 차이와 muted text 대비가 약함.
- 자료실 모달:
  - 검색+필터가 정돈되어 있으나, 빈 상태에서 구조가 과하게 넓고 정보 위계가 약함.
- 우측 멤버 탭:
  - workspace 멤버인데 `멤버` 단독 라벨이라 채널 멤버로 오해 가능.
- 근거 추가 폼:
  - 큰 layout jump는 관찰되지 않았지만, 탭 바로 아래 입력칸이 붙고 경계가 옅어 “흰 빈 영역”처럼 보이는 구간이 있음.

---

## 2. 외부/내부 레퍼런스에서 채택할 규칙

| 영역 | 채택 규칙 | 근거 |
|---|---|---|
| 양방향 채팅 스크롤 | stable id key + `anchorTo:'end'` + `followOnAppend` 유지. index key/manual delta loop를 기본값으로 삼지 않는다. | TanStack Virtual Chat docs |
| prepend 안정성 | 최종 snapshot이 아니라 rAF frame trace로 old/mid/tail frame 노출을 계량한다. | 내부 reference `chat-tail-return-raf-proof`, `virtualized-chat-tail-lock-flicker` |
| skeleton | 1초 미만 quick load에는 skeleton flash를 피하고, 필요한 skeleton은 실제 구조를 닮게 한다. frame-only skeleton은 피한다. | NN/g Skeleton Screens |
| motion | enter는 더 부드럽게, exit/collapse는 짧게. token화하고 `prefers-reduced-motion`을 지킨다. | Material 3 motion easing/duration |
| Radix portal | Dialog/Select/Popover는 body portal 레이어 순서를 명시적으로 토큰화한다. | Radix Dialog/Select docs + known z-index issue |
| 폰트 | 한글 UI는 Pretendard Variable 우선 검토. fallback은 시스템 UI로 유지한다. | Pretendard README |
| placeholder/대비 | placeholder도 정보 텍스트면 충분한 contrast를 가져야 한다. | WCAG 2.2 / placeholder contrast 자료 |

---

## 3. 10개 커버리지 매트릭스

| # | 요청/파생 이슈 | 대상 파일 | 계획 | 완료 기준 |
|---:|---|---|---|---|
| 1 | 양방향 스크롤 깜박임 계량 | `VirtualMessageStream.tsx` + browser QA | 긴 thread에서 rAF sampler로 visible old/mid/near-bottom frame 수집 | bad visible frame = 0 |
| 2 | older prepend 안정화 | `VirtualMessageStream.tsx`, `useMessageWindow.ts` | stable key 유지, top sentinel/wheel fallback, load 중 중복 보정 방지 | older page 로드 후 첫 visible message가 의도치 않게 바뀌지 않음 |
| 3 | tail return/tail lock 정착 | `VirtualMessageStream.tsx`, `ChatThread.tsx` | thread key remount/settling/quiet-period release를 검증 후 최소 조정 | final `nearBottom=true`, 중간 old frame 0 |
| 4 | skeleton flash 감소 | `useDelayedFlag.ts`, `Skeleton.tsx/css`, 호출부 | delay + minVisibleMs 정책 도입 또는 현 정책 강화 | 빠른 로드는 skeleton 미노출, 느린 로드는 1-frame flash 없음 |
| 5 | motion token 정리 | `tokens.css`, CSS Modules | M3 기반 enter/exit/standard easing token으로 중복 cubic-bezier 정리 | reduced-motion 포함, console/layout jump 없음 |
| 6 | 산출물 모달 표면/빈상태 | `ArtifactsSurface.tsx/css`, Dialog CSS | 좌우 패널 밀도·빈상태 contrast·선택 전 안내 개선 | 모달에서 빈상태가 흐릿하거나 과하게 넓어 보이지 않음 |
| 7 | 자료실 필터/테이블/빈상태 | `LibrarySurface.tsx/css` | 빈 상태일 때 필터 과밀 완화, table header/empty state 대비 개선 | empty/table 상태 모두 시각 위계 명확 |
| 8 | Dialog/Select portal z-index | `Dialog.css`, `Select.module.css`, `tokens.css` | `--z-overlay`, `--z-dialog`, `--z-popover` 토큰화 | Dialog 내부 Select가 overlay 뒤/아래로 숨지 않음 |
| 9 | Pretendard/Korean typography | `global.css`, `tokens.css` | `Pretendard Variable` 우선 + 한글 keep-all/URL 예외 점검 | 한글 단어 쪼개짐 없음, 긴 URL overflow 없음 |
| 10 | 컬러/placeholder 대비 | `tokens.css`, shared input/table CSS | muted/placeholder/text-secondary contrast 재측정 후 token 조정 | placeholder·empty text가 배경 위에서 읽힘 |

---

## 4. 구현 승인 후 작업 순서

### Phase 0 — 안전 준비

1. `git status --short`로 기존 변경분 확인.
2. 긴 대화 QA fixture 확보 방법 결정:
   - 옵션 A: 접근 가능한 기존 긴 스레드 계정으로 로그인.
   - 옵션 B: Docker UI 워크스페이스에 긴 QA thread seed 생성. 단, DB mutation이므로 승인 필요.
3. fixture thread id, message count, workspace id를 기록하되 비밀번호/토큰은 기록하지 않음.

### Phase 1 — 스크롤 프레임 증거부터 만들기

1. 브라우저에서 tail 상태 진입.
2. rAF sampler로 5~7초간 다음 값을 수집:
   - `scrollTop`, `scrollHeight`, `clientHeight`, `distanceFromEnd`
   - visible first/last `data-message-id`
   - `isTailSettling` 또는 canvas hidden 상태
   - old/mid/tail marker visible 여부
3. 재현 플로우:
   - tail initial load
   - 위로 스크롤해 older load
   - 아래로 복귀
   - 검색/점프 후 채널 왕복
   - 우측 패널 접기/열기 중 scroll 유지
   - 근거 폼 열기/닫기 중 scroll 유지
4. pass/fail 카운터 정의:
   - `visibleOldCount === 0`
   - `visibleMidCount === 0`
   - `visibleNearButNotBottomCount === 0`
   - final `nearBottom === true`

### Phase 2 — 스크롤 로직 최소 조정

1. `VirtualMessageStream.tsx`
   - 현재 `anchorTo:'end'`, stable key는 유지.
   - fixed frame loop 추가 금지.
   - tail settling release 조건을 “한 번 bottom 감지”가 아니라 quiet period + final clamp 기준으로 검토.
   - older load 중 programmatic auto-load suppression 범위를 검토.
   - `useAnimationFrameWithResizeObserver`는 실험 후 trace 개선이 있을 때만 적용.
2. `useMessageWindow.ts`
   - older/newer merge 중 중복 id, stale cursor, loading flag race를 확인.
3. `ChatThread.tsx`
   - thread/channel 전환 시 virtualizer state leak이 없도록 key/remount 조건을 확인.

### Phase 3 — loading/skeleton 안정화

1. `useDelayedFlag.ts`
   - 필요하면 `minVisibleMs` 옵션을 추가한다.
   - 기존 API를 깨지 않도록 기본값은 현재 동작 유지.
2. `Skeleton.tsx/css`
   - 채팅 skeleton은 실제 message lane 높이/간격과 맞춘다.
   - shimmer 속도는 느리고 안정적으로, reduced-motion에서는 정지.
3. 호출부
   - 빠른 prefetch는 loading text/skeleton을 띄우지 않는다.
   - 느린 load는 최소 표시시간으로 1-frame flash를 방지한다.

### Phase 4 — 모션/z-layer/token 정리

1. `tokens.css`
   - 예시 token:
     - `--ease-standard: cubic-bezier(0.2, 0, 0, 1)`
     - `--ease-enter: cubic-bezier(0.05, 0.7, 0.1, 1)`
     - `--ease-exit: cubic-bezier(0.3, 0, 0.8, 0.15)`
     - `--dur-enter: 220ms`, `--dur-exit: 140ms`, `--dur-panel: 240ms`
     - `--z-overlay: 900`, `--z-dialog: 901`, `--z-popover: 930`, `--z-toast: 1000`
2. CSS Modules
   - `transition: all` 제거, property-specific transition으로 제한.
   - right panel/grid transition과 row transform이 동시에 흔들리지 않게 조정.

### Phase 5 — 산출물/자료실/근거/멤버 표면 개선

1. `ArtifactsSurface.tsx/css`
   - 빈 상태 문구 대비 강화.
   - 좌측 list와 우측 detail의 배경/경계선 균형 조정.
2. `LibrarySurface.tsx/css`
   - 빈 상태일 때 필터가 과하게 시선을 끌지 않게 정리.
   - table header와 empty state 스타일을 같은 token 계열로 통일.
3. `EvidencePanel.tsx/css`
   - 근거 추가 폼은 탭 아래 바로 붙지 않게 section container/spacing 부여.
   - 입력칸 경계/placeholder 대비 강화.
4. `AppShell.tsx`
   - `멤버` 라벨을 `워크스페이스 멤버` 또는 보조 설명으로 명확화.
   - “링크를 받은 사람은 이 워크스페이스에 참여” 문구는 유지하되 더 위에 scope를 명시.

### Phase 6 — 폰트/컬러/대비

1. `global.css`, `tokens.css`
   - `Pretendard Variable`, `Pretendard`, system UI fallback 순서 검토.
   - 한글 본문에는 `word-break: keep-all`, URL/code에는 overflow 예외 유지.
2. shared input/table CSS
   - placeholder와 muted text contrast를 배경별로 점검.
   - empty text가 `surface-panel` 위에서 흐릿하지 않게 조정.

---

## 5. 검증 명령

구현 후 최소 검증:

```bash
pnpm --filter @consulting/web typecheck
pnpm --filter @consulting/web lint
pnpm --filter @consulting/web test
pnpm --filter @consulting/web build
```

공유 contract/API/client를 건드렸다면 추가:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

브라우저 QA:

1. 긴 thread tail 진입 → rAF trace pass.
2. 위로 스크롤 older load → visible anchor 유지.
3. 아래로 복귀 → final nearBottom true.
4. 검색/점프 후 채널 왕복 → old/mid frame 0.
5. 산출물 모달 open/close → URL 유지, Select layer 정상.
6. 자료실 모달 empty/table 상태 → 대비/위계 확인.
7. 근거 추가 폼 open/cancel 5회 → height bounce 없음.
8. 멤버 탭 → workspace scope 오해 없음.
9. reduced-motion emulation → animation/transition 과잉 없음.
10. console error 0.

---

## 6. 위험과 열린 질문

- **가장 큰 blocker:** 현재 접근 가능한 Docker UI 워크스페이스에는 긴 thread가 없다. 긴 스크롤 QA를 하려면 접근 가능한 계정/fixture가 필요하다.
- fixture seed는 DB mutation이므로 별도 승인 필요.
- `directDomUpdates`는 현재 row transform 구조와 충돌 가능성이 있어 이번 범위에서는 기본적으로 제외한다.
- `useAnimationFrameWithResizeObserver`는 개선 가능성이 있지만, 실제 trace 없이 켜면 side effect가 있을 수 있다.
- 폰트 CDN 추가는 네트워크/성능 이슈가 있으므로 가능하면 self-host 또는 기존 asset 정책 확인 후 진행한다.

---

## 7. 완료 판정

이 작업은 단순히 “스크롤이 대체로 괜찮아 보임”이 아니라 다음을 만족해야 완료다.

- 긴 thread rAF trace에서 bad visible frame 0.
- 빠른 로딩에서 skeleton flash 0.
- 느린 로딩에서 skeleton 최소 표시시간 준수.
- 산출물/자료실/Dialog/Select/근거/멤버 패널의 시각 QA 통과.
- 타입체크/린트/테스트/빌드 통과.
- 소스 변경은 승인된 파일에 한정되고 기존 repo 변경분과 섞이지 않음.
