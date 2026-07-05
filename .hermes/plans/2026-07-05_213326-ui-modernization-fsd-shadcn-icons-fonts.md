# Consulting Web UI Modernization Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task after 주인님 approval. This is planning only; do not implement during plan review.

**Goal:** consulting-web의 텍스트/이모지 아이콘을 전부 lucide-react 또는 프로젝트 소유 SVG로 대체하고, 버튼·입력·텍스트버튼·토스트·다이얼로그 등 공통 UI를 FSD `shared` 레이어로 정리하며, shadcn/ui 기반의 모던 Slack-like 업무용 인터페이스로 재정렬한다.

**Architecture:** 현재 `apps/web/src/components/*` 중심 구조를 `apps/web/src/shared/ui`, `shared/lib`, `shared/config`, `entities`, `features`, `widgets`, `pages/routes`로 점진 이동한다. shadcn/ui는 “소스 복사형 컴포넌트 레지스트리”로 도입하되, 기존 TanStack Router/Vite/React 19 구조와 CSS token 체계를 깨지 않도록 한 번에 갈아엎지 않고 shared UI primitives부터 흡수한다.

**Tech Stack:** React 19, Vite 8, TanStack Router/Query, TypeScript 6, CSS Modules + CSS variables, shadcn/ui, Tailwind CSS v4 bridge, lucide-react, Radix primitives, GSAP/CSS motion, self-hosted Korean UI font.

---

## 0. 현재 관찰 요약

- 로드맵 기준 Phase 1·2는 완료, 다음 Phase 3 전에 UI/UX 정리 삽입 가능.
- 현재 웹 패키지: `apps/web/package.json`
  - React 19.2, Vite 8.1, TanStack Router 1.170, GSAP 3.15 사용 중.
  - `lucide-react`, `tailwindcss`, shadcn 관련 패키지는 아직 없음.
- 텍스트/이모지 아이콘 발견 위치:
  - `apps/web/src/components/evidence/EvidencePanel.tsx`: `🧠 🌐 📁 🛠 📌`
  - `apps/web/src/components/ui/NotificationBell.tsx`: `🌍 📄 👋`
  - `apps/web/src/components/chat/ChatThread.tsx`: `📎`
  - `apps/web/src/routes/_app.artifacts.tsx`: `📄`
  - `apps/web/src/components/shell/AppShell.tsx`: `🌙 ☀️ 🖥 📄`
- 공통 UI가 각 화면에 중복 분산됨:
  - button/input/textarea/select가 route/component별 CSS class로 반복됨.
  - Toast는 존재하지만 shadcn/Sonner 또는 shared 표준 API로 통일되지 않음.
  - Dialog/Modal 역할을 하는 패널이 route 내부에 직접 구현됨.
- 공식 문서 확인:
  - shadcn Vite 문서: 기존 Vite 프로젝트는 Tailwind CSS 추가 후 `pnpm dlx shadcn@latest init`, 컴포넌트는 `pnpm dlx shadcn@latest add button` 방식. 모노레포는 `-c apps/web` 지정 가능.
  - lucide-react 문서: 개별 아이콘 import 방식, inline SVG, tree-shakable, TypeScript 지원.

---

## 1. 디자인 방향 결정

### 고정 방향

- Slack-like이지만 “클론”이 아니라 컨설팅 업무 도구 톤으로 해석한다.
- 핵심 인상:
  - 왼쪽: 짙은 사이드바, 워크스페이스/프로젝트 중심 탐색
  - 중앙: 대화·작업 흐름 중심
  - 오른쪽: 근거·산출물·알림 패널
  - 액션: 작은 radius, 또렷한 hover, 부드러운 spring/slide/fade
  - 카피: 장식적 문구 제거, 업무 수행에 필요한 문장만 유지

### 금지

- 이모지/텍스트 아이콘 신규 사용 금지.
- 파일·근거·테마 등 상태 표현에 `📄`, `📎`, `🌙` 같은 glyph 사용 금지.
- 컴포넌트별 독자 버튼 스타일 추가 금지.
- shadcn 기본 theme를 그대로 두고 “그럴듯한” 상태로 방치 금지.

---

## 2. 폰트 계획

### 1차 추천: Wanted Sans self-host

선정 이유:
- 한국어 UI에서 Pretendard와 같은 계열의 현대적 산세리프이지만 좀 더 브랜드 앱 느낌이 강함.
- Noonnu 기준 SIL Open Font License로 웹/앱 임베딩·상업 사용 가능 범위가 넓음. 단, 실제 적용 전 원 저작권자 라이선스 원문 재확인.
- Slack-like 업무용 SaaS 톤에 맞게 글자폭·숫자·한글 균형이 안정적.

대안:
- Toss Product Sans는 매우 현대적이나 라이선스/재배포 조건 확인 부담이 큼. 안전성이 낮으면 제외.
- SUIT는 UI 안정성이 높지만 Pretendard 대체 느낌이 강해 차별감은 Wanted Sans보다 약함.
- Paperlogy는 보고서/브랜딩에는 좋지만 dense dashboard UI 본문에는 개성이 과할 수 있음.

적용 방식:
- 웹폰트 파일을 앱에 포함:
  - `apps/web/src/shared/assets/fonts/wanted-sans/WantedSansVariable.woff2`
  - 필요한 경우 regular/medium/semibold 정적 woff2도 함께 보관.
- `apps/web/src/shared/config/fonts.css` 생성.
- `apps/web/src/styles/global.css`에서 import.
- font-family token:
  - `--font-sans: "Wanted Sans Variable", "Wanted Sans", "Apple SD Gothic Neo", "Malgun Gothic", "Segoe UI", system-ui, sans-serif;`
  - `--font-mono: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;`
- Windows/Mac 차이 방지:
  - `font-synthesis: none;`
  - `text-rendering: optimizeLegibility;`
  - `-webkit-font-smoothing: antialiased;`
  - Windows용 fallback에 `Malgun Gothic`, Mac용 fallback에 `Apple SD Gothic Neo` 명시.
  - `font-feature-settings: "tnum" 1`는 숫자 정렬이 필요한 meta/chip/table에만 제한 적용.

검증:
- Windows Chrome, macOS Safari/Chrome 기준 fallback 캡처 비교.
- 웹폰트 실패 상황을 강제로 만들어 fallback 깨짐 여부 확인.

---

## 3. FSD 목표 구조

최종 목표:

```txt
apps/web/src/
  app/
    providers/
      AppProviders.tsx
      QueryProvider.tsx
      ThemeProvider.tsx
      ToastProvider.tsx
    router/
      routeTree.gen.ts
    styles/
      global.css
      tokens.css
  pages/
    artifacts/
    auth/
    invite/
    topic/
    thread/
  widgets/
    app-shell/
    evidence-panel/
    chat-thread/
    notification-center/
    command-palette/
  features/
    auth-session/
    upload-attachment/
    create-evidence/
    export-artifact/
    theme-switcher/
  entities/
    workspace/
    topic/
    thread/
    evidence/
    artifact/
    notification/
  shared/
    ui/
      button/
      input/
      textarea/
      select/
      text-button/
      icon-button/
      toast/
      dialog/
      sheet/
      tooltip/
      badge/
      card/
      empty-state/
      spinner/
      skeleton/
    icons/
      Icon.tsx
      registry.ts
      custom/
    lib/
      cn.ts
      motion.ts
      a11y.ts
      format.ts
    config/
      fonts.css
      theme.ts
    assets/
      fonts/
```

점진 규칙:
- 1단계에서는 기존 route 파일 이동 최소화. 먼저 `shared/ui`, `shared/icons`, `shared/lib`를 만들고 import만 교체한다.
- 2단계에서 큰 화면 단위를 `widgets/*`로 이동한다.
- 3단계에서 비즈니스 행위를 `features/*`로 분리한다.
- route 파일은 얇게 유지: loader/guard + widget 조립만 담당.

---

## 4. Task Plan

### Task 1: UI inventory와 금지 아이콘 회귀 테스트 추가

**Objective:** 텍스트/이모지 아이콘과 중복 UI 패턴을 자동으로 잡는 안전망을 만든다.

**Files:**
- Create: `apps/web/src/shared/icons/forbidden-icons.test.ts`
- Create: `apps/web/src/shared/ui/ui-contract.test.ts`
- Modify: `apps/web/package.json`

**Steps:**
1. 금지 문자 regex 목록 작성: emoji ranges + known glyphs `📎📄🧠🌐📁🛠📌🌍👋🌙☀️🖥`.
2. `src/**/*.tsx`를 스캔해 JSX text node/string literal 내 금지 glyph가 있으면 fail.
3. 예외: 테스트 파일, SVG path data, 문서 문자열 없음.
4. 공통 UI import 규칙 테스트 추가: route/widget 내부에서 raw `<button>` 사용은 임시 허용하되 migration 완료 후 fail로 전환할 수 있게 TODO flag 사용.
5. 실행: `pnpm --filter @consulting/web test`.

**Expected:** 현재는 금지 아이콘 때문에 RED. 이 RED가 이후 migration 완료 기준이 된다.

---

### Task 2: shadcn/ui 최소 도입 + Tailwind v4 bridge

**Objective:** shadcn 컴포넌트를 도입하되 기존 CSS Modules/tokens와 충돌하지 않게 bridge를 만든다.

**Files:**
- Create: `apps/web/components.json`
- Create: `apps/web/src/shared/lib/cn.ts`
- Modify: `apps/web/package.json`
- Modify: `apps/web/vite.config.ts` if required by Tailwind plugin
- Modify: `apps/web/src/styles/global.css`
- Modify: `apps/web/src/styles/tokens.css`
- Possible create: `apps/web/src/index.css` only if shadcn CLI requires it; prefer existing `styles/global.css`.

**Dependencies:**
- `lucide-react`
- `class-variance-authority`
- `clsx`
- `tailwind-merge`
- `tailwindcss`
- `@tailwindcss/vite` if required by current Tailwind v4 setup
- Radix deps as components are added: `@radix-ui/react-dialog`, `@radix-ui/react-slot`, `@radix-ui/react-tooltip`, etc.

**Steps:**
1. Run docs-aligned init in dry-aware manner:
   - `pnpm dlx shadcn@latest init -c apps/web`
   - If CLI wants aliases, set:
     - components: `@/shared/ui`
     - utils: `@/shared/lib/utils` or `@/shared/lib/cn`
2. Add only foundational components first:
   - `button`, `input`, `textarea`, `select`, `dialog`, `sheet`, `tooltip`, `badge`, `card`, `separator`, `skeleton`, `sonner` or `toast`.
3. Ensure generated files land under `apps/web/src/shared/ui/*`, not `components/ui/*`.
4. Map shadcn CSS variables to existing tokens instead of introducing a second design system:
   - `--background` → current app background
   - `--foreground` → current text strong
   - `--muted`, `--muted-foreground`
   - `--primary`, `--primary-foreground`
   - `--border`, `--input`, `--ring`
5. Keep CSS Modules for feature layout; use shadcn for primitives and variants.

**Verification:**
- `pnpm install`
- `pnpm --filter @consulting/web typecheck`
- `pnpm --filter @consulting/web build`

---

### Task 3: shared icon system 구축

**Objective:** lucide와 커스텀 SVG를 한 경로로 쓰게 만들어 텍스트 아이콘 재발을 막는다.

**Files:**
- Create: `apps/web/src/shared/icons/Icon.tsx`
- Create: `apps/web/src/shared/icons/registry.ts`
- Create: `apps/web/src/shared/icons/custom/*.tsx` if lucide에 없는 아이콘이 필요할 때
- Modify: `apps/web/src/styles/tokens.css`

**Icon API:**

```tsx
<Icon name="paperclip" size="sm" tone="muted" ariaLabel="첨부" />
<Icon name="file-text" decorative />
```

**Initial registry mapping:**
- attachment/file upload: `Paperclip`, `Upload`, `FileText`
- document/artifact: `FileText`, `Files`, `Library`
- gbrain/source intelligence: `Brain`, `Database`, or custom brain SVG
- web source: `Globe`
- tool: `Wrench`
- manual pin: `Pin`
- assistant/system: `Bot`, `Sparkles`, or custom Jigoo globe SVG if needed
- member joined: `UserPlus`
- theme dark/light/system: `Moon`, `Sun`, `Monitor`
- notification: `Bell`
- command: `Command`
- close: `X`
- loading: `LoaderCircle`
- success/error/warning/info: `CheckCircle2`, `CircleAlert`, `TriangleAlert`, `Info`

**Rules:**
- 화면 파일은 lucide를 직접 import하지 않는다. 무조건 `shared/icons` registry를 통해 사용한다.
- 예외: 매우 특수한 one-off SVG는 `shared/icons/custom`에 넣고 registry에 등록.
- `aria-hidden`/`aria-label` 규칙을 Icon 컴포넌트에서 강제.

**Verification:**
- 금지 glyph 테스트 일부 GREEN.
- bundle 증가 확인: lucide는 개별 import라 큰 증가 없어야 함.

---

### Task 4: shared UI primitive 1차 교체

**Objective:** 버튼·텍스트 버튼·아이콘 버튼·input·textarea·select를 shared로 통일한다.

**Files:**
- Create/Modify:
  - `apps/web/src/shared/ui/button/Button.tsx`
  - `apps/web/src/shared/ui/button/IconButton.tsx`
  - `apps/web/src/shared/ui/button/TextButton.tsx`
  - `apps/web/src/shared/ui/input/Input.tsx`
  - `apps/web/src/shared/ui/textarea/Textarea.tsx`
  - `apps/web/src/shared/ui/select/Select.tsx`
  - `apps/web/src/shared/ui/field/Field.tsx`
- Modify call sites:
  - `apps/web/src/components/auth/AuthKit.tsx`
  - `apps/web/src/components/chat/ChatThread.tsx`
  - `apps/web/src/components/evidence/EvidencePanel.tsx`
  - `apps/web/src/routes/_app.artifacts.tsx`
  - `apps/web/src/routes/_app.t.$topicId.tsx`
  - `apps/web/src/components/thread/ThreadView.tsx`

**Button variants:**
- `primary`: 주요 CTA
- `secondary`: 보조 액션
- `ghost`: Slack-like hover surface
- `destructive`: 삭제/위험
- `outline`: form secondary
- `link`: text button

**Sizes:**
- `xs`, `sm`, `md`, `lg`, `icon-sm`, `icon-md`

**Motion:**
- hover: `transform: translateY(-1px)` + shadow token
- active: `translateY(0)` + subtle scale
- focus: visible ring using `--ring`
- reduced motion: transform off

**Verification:**
- `typecheck`, `build`
- UI smoke: login/signup/chat/artifacts/evidence 화면에서 버튼·폼 깨짐 없음.

---

### Task 5: Toast/Dialog/Sheet 공통화

**Objective:** 알림과 팝업 UX를 shadcn/Radix 기반으로 통일한다.

**Files:**
- Create/Modify:
  - `apps/web/src/shared/ui/toast/ToastProvider.tsx`
  - `apps/web/src/shared/ui/toast/useToast.ts`
  - `apps/web/src/shared/ui/dialog/Dialog.tsx`
  - `apps/web/src/shared/ui/sheet/Sheet.tsx`
  - `apps/web/src/shared/ui/empty-state/EmptyState.tsx`
- Modify:
  - `apps/web/src/main.tsx` or `apps/web/src/app/providers/AppProviders.tsx`
  - `apps/web/src/components/ui/Toast.tsx` -> migrate/delete after compatibility shim
  - `apps/web/src/routes/_app.artifacts.tsx`
  - `apps/web/src/components/evidence/EvidencePanel.tsx`
  - `apps/web/src/components/ui/CommandPalette.tsx`

**Toast policy:**
- success: 완료 사실만, 1줄
- error: 원인 + 사용자가 할 다음 행동, 1줄
- info: 상태 변화, 1줄
- warning: 위험/누락, 1줄
- 장황한 toast 금지. 상세는 dialog/sheet에 표시.

**Dialog policy:**
- form creation/editing은 Dialog 또는 Sheet로 이동.
- 삭제/위험은 AlertDialog로 분리.
- Command palette는 Dialog 기반으로 접근성 강화.

**Motion:**
- Toast: slide-in + fade, 180ms
- Dialog: overlay fade + content scale/translate, 160ms
- Sheet: side slide, 200ms
- 모든 motion은 `shared/lib/motion.ts` duration/easing token 사용.

**Verification:**
- 키보드 ESC/Tab/focus trap 확인.
- `prefers-reduced-motion`에서 motion 감소 확인.

---

### Task 6: FSD 1차 이동 - components를 widgets/features/entities로 분해

**Objective:** UI primitives와 비즈니스 화면을 분리해 유지보수 가능한 구조를 만든다.

**Move map:**
- `components/shell/AppShell.tsx` → `widgets/app-shell/ui/AppShell.tsx`
- `components/chat/ChatThread.tsx` → `widgets/chat-thread/ui/ChatThread.tsx`
- `components/evidence/EvidencePanel.tsx` → `widgets/evidence-panel/ui/EvidencePanel.tsx`
- `components/ui/NotificationBell.tsx` → `widgets/notification-center/ui/NotificationBell.tsx`
- `components/ui/CommandPalette.tsx` → `features/command-palette/ui/CommandPalette.tsx`
- `components/auth/AuthKit.tsx` → `features/auth-session/ui/AuthKit.tsx`
- `components/thread/ThreadView.tsx` → `pages/thread/ui/ThreadView.tsx` or widget if reused
- `components/chat/Markdown.tsx` → `shared/ui/markdown/Markdown.tsx`
- format helpers currently inline → `shared/lib/format.ts`

**Rules:**
- `shared`는 business entity를 import하지 않는다.
- `entities`는 `shared`만 import 가능.
- `features`는 `entities/shared` 가능.
- `widgets`는 `features/entities/shared` 가능.
- `routes/pages`는 widgets/features 조립 가능.

**Verification:**
- path alias import cycle check. 가능하면 `eslint-plugin-boundaries` 또는 간단한 스크립트로 layer import rule 추가.
- `pnpm --filter @consulting/web lint`.

---

### Task 7: 이모지/텍스트 아이콘 전면 제거

**Objective:** Task 1의 금지 아이콘 테스트를 완전히 GREEN으로 만든다.

**Target replacements:**
- `EvidencePanel.tsx`
  - `sourceIcon` string map 제거.
  - source type -> `IconName` map으로 변경.
- `NotificationBell.tsx`
  - notification type -> Icon registry map.
- `ChatThread.tsx`
  - file chip과 upload button의 `📎` 제거.
  - pending 상태는 `LoaderCircle` 또는 spinner 사용.
- `_app.artifacts.tsx`
  - empty state `📄` 제거, `EmptyState icon="file-text"` 사용.
- `AppShell.tsx`
  - theme glyph 제거, `ThemeSwitcher` feature + `Sun/Moon/Monitor` icon.
  - artifact nav glyph 제거.

**Verification:**
- `pnpm --filter @consulting/web test -- forbidden-icons`
- `grep`/search로 emoji residual 0 확인.

---

### Task 8: Slack-like visual token pass

**Objective:** shadcn 기본값이 아니라 consulting-web 자체 테마로 정리한다.

**Files:**
- Modify: `apps/web/src/styles/tokens.css`
- Modify: `apps/web/src/styles/global.css`
- Modify: layout CSS modules under widgets/pages

**Token groups:**
- surface:
  - `--surface-app`, `--surface-sidebar`, `--surface-panel`, `--surface-card`, `--surface-hover`
- text:
  - `--text-strong`, `--text-default`, `--text-muted`, `--text-faint`
- border:
  - `--border-subtle`, `--border-strong`, `--ring`
- semantic:
  - `--success`, `--warning`, `--danger`, `--info`
- motion:
  - `--ease-standard`, `--ease-emphasized`, `--dur-fast`, `--dur-base`, `--dur-slow`
- radius/shadow:
  - `--radius-sm/md/lg/xl`, `--shadow-popover`, `--shadow-panel`

**Slack-like details:**
- Sidebar는 더 깊은 neutral/navy graphite.
- Active nav는 pill + left accent 또는 glowless highlight.
- Main area는 dense but breathable 8px grid.
- Cards는 과한 gradient 금지, subtle border + hover surface.
- Critical CTA만 accent color 사용.

**Verification:**
- light/dark/system theme 전환.
- 1280px, 1440px, 1920px width smoke.

---

### Task 9: 카피 간결화

**Objective:** “쓸데없는 말”을 줄여 업무 앱 톤으로 바꾼다.

**Files:**
- Modify likely:
  - `apps/web/src/components/auth/AuthKit.tsx`
  - `apps/web/src/components/shell/AppShell.tsx`
  - `apps/web/src/components/chat/ChatThread.tsx`
  - `apps/web/src/components/evidence/EvidencePanel.tsx`
  - `apps/web/src/routes/_app.artifacts.tsx`
  - `apps/web/src/routes/login.tsx`
  - `apps/web/src/routes/signup.tsx`
  - `apps/web/src/routes/invite.$token.tsx`

**Copy rules:**
- Button: 동사 1개 중심. 예: `등록하기` → `등록`, `파일을 내려받았어요` → `다운로드 완료`.
- Empty state: 1문장 + 1 CTA만.
- Error: “문제가 발생했어요” 단독 금지. 원인 또는 다음 행동 포함.
- Toast: 20자 안팎 우선.
- Placeholder: 설명문 대신 예시형.

**Verification:**
- UX copy audit file 생성: `apps/web/src/shared/config/copy-guidelines.md` 또는 plan note.
- 모든 toast/dialog/empty state 문구 1차 리뷰.

---

### Task 10: 브라우저 실검증 + 성능/번들 확인

**Objective:** Node 빌드가 아니라 실제 브라우저에서 UI가 작동함을 확인한다.

**Commands:**
- `pnpm install`
- `pnpm --filter @consulting/web test`
- `pnpm --filter @consulting/web lint`
- `pnpm --filter @consulting/web typecheck`
- `pnpm --filter @consulting/web build`
- API 변경 없으면 backend rebuild 불필요. 단 실행 중 prod/dev stack 확인은 필요.
- web dev server background start 후 브라우저 확인.

**Browser checks:**
- `/login`: font, button/input, error state.
- `/signup`: form spacing, loading state.
- `/`: AppShell, sidebar, command palette, notification.
- topic/thread route: chat input/upload/evidence panel.
- `/artifacts`: empty state, create dialog/sheet, export buttons.
- dark/light/system theme.
- reduced motion.

**Bundle check:**
- lucide tree-shaking 확인.
- Tailwind/shadcn 도입 후 CSS/JS gzip 증가량 기록.
- 증가가 크면 unused component 제거.

---

## 5. 커밋 단위 제안

1. `test(web): add ui icon and primitive migration guards`
2. `chore(web): initialize shadcn primitives and lucide icon system`
3. `feat(web): add shared ui primitives and motion tokens`
4. `refactor(web): migrate controls and dialogs to shared ui`
5. `refactor(web): remove text icons across consulting web`
6. `refactor(web): align frontend layers with fsd structure`
7. `style(web): apply slack-like theme and self-hosted font`
8. `copy(web): simplify product copy and toast messages`
9. `test(web): verify browser ui modernization gates`

---

## 6. 위험과 대응

- shadcn + Tailwind가 기존 CSS Modules와 충돌할 수 있음
  - 대응: primitives만 shadcn/Tailwind, layout은 CSS Modules 유지. CSS variables를 단일 source로 연결.
- FSD 이동 중 import path가 대량 변경됨
  - 대응: 먼저 shared UI 생성 후 call site 교체, 그 다음 폴더 이동. 이동과 디자인 변경을 한 커밋에 섞지 않음.
- 폰트 라이선스/용량 문제
  - 대응: Wanted Sans 원본 라이선스 재확인 후 woff2 subset/variable 적용. 폰트 실패 fallback 검증.
- lucide 아이콘이 모든 의미를 커버하지 못함
  - 대응: custom SVG는 `shared/icons/custom`에만 허용하고 registry를 거치게 함.
- 카피 축약이 정보 부족으로 이어질 수 있음
  - 대응: 화면 텍스트는 짧게, 상세는 tooltip/dialog/help text로 분리.

---

## 7. 승인 후 첫 실행 순서

1. Task 1로 RED 안전망부터 만든다.
2. shadcn/lucide/font 라이선스·패키지 도입 범위를 확정한다.
3. `shared/ui`와 `shared/icons`를 먼저 구축한다.
4. 가장 많이 보이는 `AppShell`, `ChatThread`, `EvidencePanel`, `Artifacts` 순서로 교체한다.
5. FSD 폴더 이동은 UI가 GREEN인 뒤 별도 패스로 수행한다.
6. 마지막에 실제 브라우저 렌더와 gzip 변화를 보고한다.

---

## 8. Open Questions

1. shadcn 도입을 위해 Tailwind v4를 추가하는 방향으로 진행해도 되는가?
   - 추천: Yes. 단 layout은 CSS Modules 유지, shadcn primitives에만 Tailwind 사용.
2. 기본 폰트는 Wanted Sans로 진행할까?
   - 추천: Yes. 적용 전 라이선스 원문 확인 + self-host.
3. FSD 이동 범위는 이번 패스에서 완전 이동할까, shared/ui 우선 후 2차 이동할까?
   - 추천: shared/ui + icons + 주요 widgets까지만 1차, features/entities 완전 분해는 2차.

---

## 9. Definition of Done

- 텍스트/이모지 아이콘 0개.
- lucide/custom SVG icon registry만 사용.
- Button/Input/Textarea/Select/TextButton/IconButton/Toast/Dialog/Sheet가 `shared/ui`에서 제공됨.
- 주요 화면이 shared primitives를 사용함.
- shadcn 기반 컴포넌트가 `shared/ui`에 정착됨.
- Wanted Sans 또는 승인된 대체 폰트가 self-host로 적용됨.
- Windows/Mac fallback 지정 완료.
- Toast/Dialog/interaction animation이 동일 motion token 사용.
- 카피가 간결화됨.
- `pnpm --filter @consulting/web test/lint/typecheck/build` GREEN.
- 실제 브라우저에서 login/signup/app/artifacts/thread route 렌더 확인.
