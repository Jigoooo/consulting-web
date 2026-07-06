# Consulting Web Premium UI/UX Redesign Plan

> 계획 전용 문서입니다. 이 문서는 구현하지 않고, 조사·판단·실행 계획만 정의합니다.

**Goal:** 로그인 화면과 앱 셸 전반을 고급감 있는 절제된 B2B SaaS 톤으로 재정의하고, 과한 검증/어색한 한글 줄바꿈/가려지는 알림 팝오버/즉시 로그아웃/불명확한 아이콘/기존 Radix Toast를 Sonner 기반 커스텀 토스트로 개선한다.

**Architecture:** `tokens.css`를 single source of truth로 재설계하고, Auth/AppShell/Dialog/Toast/Notification 컴포넌트가 해당 토큰을 소비하도록 순차 마이그레이션한다. 기능 변경은 최소화하되, UX 상태 모델(폼 검증, 로그아웃 확인, 알림 표시 방식)은 실제 사용자 흐름 기준으로 재정의한다.

**Tech Stack:** React, TanStack Router, CSS Modules, Radix Dialog, Sonner, Wanted Sans self-hosted, lucide/SVG Icon registry.

---

## 1. 근거 레퍼런스 요약

### 1.1 Visual / Design System

확인한 레퍼런스:
- Linear: dark-native, near-black + cool gray + restrained indigo, 510/590 weight 중심, 색은 기능에만 사용.
- Vercel: achromatic white canvas, `#171717` text, shadow-as-border, 400/500/600 weight, 색은 기능 맥락에만 사용.
- Superhuman: luxury productivity 톤, deep purple hero + warm cream CTA + charcoal ink, dramatic color gesture는 한 번만.
- WCAG 2.2 SC 1.4.3: 일반 텍스트 4.5:1, 큰 텍스트 3:1 이상 대비 필요. 얇은 폰트/안티앨리어싱 고려 시 기준보다 여유 있게 잡아야 함.
- Material Design token concept: color/typography/shape/elevation/motion을 토큰화하여 컴포넌트에 직접 hex를 흩뿌리지 않음.

현재 문제 판단:
- 로그인 왼쪽 패널이 지나치게 밝은 indigo/purple gradient라 “프리미엄 B2B 컨설팅”보다 “AI SaaS 템플릿” 느낌이 강함.
- 오른쪽 폼은 매우 무난하지만 왼쪽 색감이 강해서 전체 톤이 분리됨.
- `--accent #5e6ad2`, `--accent-hi #7170ff`, 강한 보라 그라디언트가 과사용됨.
- `font-weight: 780/750/700` 계열이 많아 타이포가 무겁고 고급감보다 힘 준 느낌이 남.

방향:
- “절제된 컨설팅 워크스페이스”: Vercel의 achromatic discipline + Linear의 precise dark rail + Superhuman의 한 번만 쓰는 deep muted purple gesture.
- 밝은 보라 그라디언트 제거. deep ink/navy/charcoal + warm off-white + muted slate/indigo로 재정의.
- 액센트는 saturation 낮춘 blue-violet 1개만: CTA/focus/active에만 사용.

---

## 2. 제안 디자인 토큰 시스템

대상 파일:
- Modify: `apps/web/src/styles/tokens.css`
- Audit: `apps/web/src/styles/global.css`
- Audit: `apps/web/src/shared/ui/shared-ui.css`
- Audit: CSS Modules 전체

### 2.1 Palette v2 제안

Light theme:
- `--bg-canvas: #f7f5f1` : 순백 대신 warm ivory canvas
- `--bg-sidebar: #f0eee8` : 사이드바는 한 단계 더 따뜻한 종이톤
- `--bg-rail: #111214` : rail은 Linear식 deep charcoal 유지
- `--bg-rail-2: #181a1d`
- `--surface-card: #fffdf8`
- `--surface-panel: #ebe8df`
- `--surface-hover: rgba(31, 33, 36, 0.055)`
- `--text-primary: #1f211f` : pure black 금지
- `--text-secondary: #62605a`
- `--text-muted: #918c82`
- `--border-whisper: rgba(31, 33, 36, 0.10)`
- `--border-hair: rgba(31, 33, 36, 0.06)`
- `--accent: #565f9f` : 기존보다 채도 낮춘 blue-violet
- `--accent-hi: #6a72b8`
- `--accent-soft: rgba(86, 95, 159, 0.11)`
- `--accent-glow: rgba(86, 95, 159, 0.20)`
- `--link: #3451a3`
- `--green: #287a46`
- `--amber: #a96613`
- `--red: #b43d2f`

Dark theme:
- `--bg-canvas: #141516`
- `--bg-sidebar: #191a1c`
- `--bg-rail: #0b0c0d`
- `--surface-card: #1d1f22`
- `--surface-panel: #222428`
- `--text-primary: #ebe7de`
- `--text-secondary: #b2aca2`
- `--text-muted: #7e786f`
- `--border-whisper: rgba(235, 231, 222, 0.11)`
- `--accent: #8a91d6`
- `--accent-hi: #a0a5e6`

### 2.2 Typography v2

원칙:
- Wanted Sans 유지(외부 폰트 금지, 현재 선호와 일치).
- 폰트 weight 범위를 줄임: 400 / 510 / 590 / 650까지만 기본 사용.
- 700+는 극소수 CTA 또는 로고만. 현재 780/750은 제거 후보.
- 한글 문장은 `word-break: keep-all`, `line-break: strict`, `overflow-wrap: break-word`를 기본 적용.
- display/headline은 너무 큰 음수 letter-spacing 금지: 한글은 -0.01em ~ -0.025em 선에서 제한.

추가 토큰:
- `--font-weight-regular: 400`
- `--font-weight-ui: 510`
- `--font-weight-strong: 590`
- `--font-weight-display: 650`
- `--leading-tight: 1.18`
- `--leading-body: 1.55`
- `--tracking-heading-ko: -0.018em`

### 2.3 Elevation / shape

원칙:
- Vercel식 shadow-as-border 도입: border와 shadow가 따로 노는 느낌 제거.
- radius는 8/12/16 중심으로 단순화.

토큰:
- `--radius-sm: 8px`
- `--radius-md: 12px`
- `--radius-lg: 16px`
- `--shadow-ring: 0 0 0 1px var(--border-whisper)`
- `--shadow-card: 0 0 0 1px rgba(31,33,36,.08), 0 2px 2px rgba(31,33,36,.035), 0 12px 28px -22px rgba(31,33,36,.35)`
- `--shadow-pop: 0 0 0 1px rgba(31,33,36,.10), 0 18px 55px -24px rgba(31,33,36,.45)`

---

## 3. 로그인 화면 개편 계획

대상 파일:
- Modify: `apps/web/src/features/auth-session/ui/Auth.module.css`
- Possibly modify text only: `apps/web/src/features/auth-session/ui/AuthKit.tsx`

현재 진단:
- 좌측 gradient가 너무 선명하고 밝음: `linear-gradient(150deg, var(--accent), var(--accent-hi), #4b53c4)`.
- headline `근거로 말하는 컨설팅, 한 워크스페이스에서.`가 1280px 화면에서 “워크스 / 페이스”로 분리되어 보임.
- `font-weight: 780`, 밝은 white text, aurora blob이 과하게 AI 템플릿 톤.

개편 방향:
- 왼쪽 패널: deep ink + 아주 낮은 채도의 radial glow로 변경.
  - 예: `linear-gradient(160deg, #17181b 0%, #202238 52%, #2c2b42 100%)`
  - glow는 `rgba(232, 224, 205, .10)` 수준으로 낮춤.
- 좌측 카피 컨테이너 폭 확장 또는 문구 수동 줄바꿈 제어.
  - headline max-width를 440~480px로 확대하거나, `한 워크스페이스에서` 앞에 줄바꿈을 의도적으로 넣되 단어 내부 분리는 금지.
- 버튼/입력 focus ring은 bright blue 대신 muted accent glow로 변경.
- 폼 영역 배경은 `#f7f5f1` + 아주 약한 radial glow. 현재 오른쪽 푸른 glow는 제거 또는 채도 50% 감소.
- CTA는 warm charcoal or muted accent 중 택1:
  - 로그인 primary: `#1f211f` 배경 + ivory text가 가장 프리미엄.
  - focus/link: muted indigo.

검증 기준:
- 로그인 스크린샷에서 보라 그라디언트 템플릿 느낌 제거.
- 주요 텍스트 대비 WCAG AA 이상.
- 1280x633, 1440x900, 390x844에서 한국어 단어 내부 줄바꿈 없음.

---

## 4. 폼 검증 UX 개선 계획

대상 파일:
- Modify: `apps/web/src/routes/login.tsx`
- Modify: `apps/web/src/routes/signup.tsx`
- Possibly modify: `apps/web/src/features/auth-session/ui/AuthKit.tsx`

근거:
- NN/g: inline validation은 좋지만 “입력이 완료되기 전에 검증하지 말 것”. 에러는 필드 옆에 두되, 사용자가 아직 입력할 의도가 명확하지 않은 빈 필드에 과하게 경고하지 않는다.
- Smashing Magazine: blur 기반 late validation은 흔하지만 사용자가 정말 입력을 끝냈는지 추정일 뿐이라 틀릴 수 있다.

현재 문제:
- 로그인/회원가입 모두 `onBlur={() => setTouched(...true)}`.
- 빈 이메일 입력 필드를 클릭했다가 외부 클릭만 해도 “이메일을 입력해주세요.”가 뜸.
- `canSubmit` 때문에 버튼은 이미 비활성화되어 있으므로 blur 빈값 에러는 중복 압박.

제안 상태 모델:
- `submitted: boolean` 추가.
- 필드별 `dirty` 또는 `value.length > 0` 기준 사용.
- 에러 노출 조건:
  - 필수값 비어있음: submit 시에만 표시.
  - 형식 오류(email format): 사용자가 값을 한 글자라도 입력했고 blur 또는 submit 이후 표시.
  - password length/strength: 회원가입에서는 입력 중 힌트/strength meter는 유지, “필수값 없음”은 submit 후만.
- 버튼 상태:
  - disabled는 유지 가능하되, 빈 상태에서는 조용히 비활성화.
  - submit 시 비어 있으면 첫 번째 오류 필드 focus.

예상 변경:
- `touched` → `visited`/`dirty`/`submitted` 모델로 변경.
- `onBlur`는 빈값 오류를 발생시키지 않게 조정.
- `Field`에 `hint` prop 추가 고려: 에러 전에는 “업무용 이메일을 입력하세요” 같은 차분한 안내 가능.

검증 기준:
- 이메일 필드 focus → 아무 입력 없이 외부 클릭: 에러 없음.
- 이메일에 `abc` 입력 후 blur: “올바른 이메일 형식…” 표시.
- 빈 상태에서 로그인 클릭: 필수값 에러 표시 + 첫 오류 focus.

---

## 5. 한국어 자연 줄바꿈 전수 개선 계획

대상 파일:
- Modify: `apps/web/src/styles/global.css` 또는 `apps/web/src/styles/tokens.css` adjacent global layer
- Modify: `apps/web/src/features/auth-session/ui/Auth.module.css`
- Modify: `apps/web/src/widgets/app-shell/ui/AppShell.module.css`
- Modify: `apps/web/src/widgets/evidence-panel/ui/EvidencePanel.module.css`
- Modify: `apps/web/src/shared/ui/markdown/Markdown.module.css`

근거:
- MDN `word-break`: `break-all`은 단어 중간에서도 끊기므로 한국어/영문 혼합 UI에 위험. `keep-all`은 CJK 텍스트에서 단어 중간 줄바꿈을 막는다.
- CSSWG 이슈: 한국어는 한글 음절 단위 자동 줄바꿈이 어색한 케이스가 많아 별도 제어 필요.
- 실제 발견: 로그인 패널 “한 워크스페이스에서.”가 “워크스 / 페이스”로 분리됨.

현재 코드 스캔 결과:
- `apps/web/src/widgets/app-shell/ui/AppShell.module.css:390` `word-break: break-all;` 초대 링크 URL용. 일반 텍스트에는 부적합. URL 전용이면 유지 가능하나 토큰화/클래스명 명확화 필요.
- `apps/web/src/widgets/evidence-panel/ui/EvidencePanel.module.css:58` `word-break: break-all;` URL/근거 텍스트인지 확인 후 URL 전용으로 좁혀야 함.
- `apps/web/src/shared/ui/markdown/Markdown.module.css:5` `word-break: break-word;` deprecated 성격. `overflow-wrap: break-word` 또는 URL/code 전용 처리로 분리 필요.
- `white-space: nowrap` 3곳은 badge/mini-map 등 레이아웃 의도 가능. overflow 여부 QA 필요.

전역 정책 제안:
```css
html:lang(ko), body {
  word-break: keep-all;
  line-break: strict;
}

p, li, h1, h2, h3, h4, h5, h6,
.cwKoreanText {
  word-break: keep-all;
  overflow-wrap: break-word;
}

.cwBreakLong,
.cwUrl,
code,
pre {
  word-break: normal;
  overflow-wrap: anywhere;
}
```

주의:
- 전역 `word-break: keep-all`만 걸면 긴 URL/토큰/초대링크가 overflow할 수 있음.
- URL/코드/토큰은 별도 `.cwBreakLong`로 분리해야 함.

검증 기준:
- 로그인 headline에서 “워크스페이스” 내부 분리 없음.
- 사이드바/컨텍스트/알림/마크다운/근거 패널 주요 한글 문장 단어 내부 분리 없음.
- 긴 초대링크와 URL은 overflow 없이 줄바꿈됨.

---

## 6. 로그아웃 확인 Dialog 계획

대상 파일:
- Modify: `apps/web/src/widgets/app-shell/ui/AppShell.tsx`
- Possibly modify: `apps/web/src/shared/ui/dialog/Dialog.tsx` / `Dialog.css`

현재 문제:
- Rail 로그아웃 아이콘 클릭 즉시 `logout()` 실행.
- 사용자가 실수로 눌러도 복구 여지 없음.
- 버튼이 `div`라 키보드 접근성과 semantic이 부족함.

계획:
- Rail의 산출물/테마/로그아웃을 모두 `IconButton` 또는 native `button`으로 통일.
- 로그아웃 클릭 시 Radix Dialog 표시.
- Dialog copy:
  - title: “로그아웃할까요?”
  - desc: “현재 작업 내용은 저장된 항목만 유지됩니다. 다시 로그인하면 이어서 볼 수 있어요.”
  - secondary: “취소”
  - destructive/primary: “로그아웃”
- Confirm 시에만 `logout()` + navigate.
- Escape/overlay click은 취소.

검증 기준:
- 로그아웃 클릭만으로 세션 종료되지 않음.
- Enter/Space/Escape 키보드 동작 정상.
- 스크린리더 label 존재.

---

## 7. Rail 아이콘 UX 개선 계획

대상 파일:
- Modify: `apps/web/src/widgets/app-shell/ui/AppShell.tsx`
- Modify: `apps/web/src/widgets/app-shell/ui/AppShell.module.css`

현재 문제:
- “로그아웃 위에 위에 버튼”은 코드상 `/artifacts` 산출물 버튼으로 추정됨.
- 아이콘만 있고 rail 하단에 `산출물`, `테마`, `로그아웃`이 tooltip title 의존이라 비전문 사용자에게 불명확.
- `div` 버튼 사용으로 semantic/action discoverability 낮음.

계획:
- rail 하단 액션 그룹을 명시적 구조로 분리: `RailAction` 컴포넌트 생성.
- 모든 아이콘 버튼에 `aria-label`, `title`, focus ring, active state 추가.
- 산출물 버튼 아이콘을 더 직관적인 `archive/file-stack` 계열로 검토(현재 registry 확인 필요).
- hover/focus 시 작은 floating label 또는 accessible tooltip 도입 검토.
- active route일 때 rail item과 동일한 active styling 적용.

검증 기준:
- 사용자가 버튼 목적을 title/tooltip/aria로 즉시 파악.
- 산출물/테마/로그아웃 모두 keyboard reachable.

---

## 8. 알림 리스트를 Modal/Sheet로 변경 계획

대상 파일:
- Modify: `apps/web/src/widgets/notification-center/ui/NotificationBell.tsx`
- Modify: `apps/web/src/widgets/notification-center/ui/NotificationBell.module.css`
- Reuse: `apps/web/src/shared/ui/dialog/Dialog.tsx`

현재 문제:
- 알림은 sidebar 헤더 안에서 absolute popover로 뜸.
- `.pop { position:absolute; right:0; width:320px; z-index:60 }`라 좌측/레이아웃 경계에 가려지거나 sidebar overflow/stacking context에 영향을 받기 쉬움.
- 사용자 말대로 modal로 전환하는 편이 안정적.

계획:
- 데스크톱: centered Dialog 또는 right Sheet 중 택1.
  - 추천: centered compact modal. 알림은 task interruption 성격이 있으므로 420~520px 중심 modal이 가장 안정적.
  - 모바일: 동일 modal full-width near-bottom 또는 sheet.
- `NotificationBell`은 open state 유지하되 popover DOM 제거, `DialogRoot open={open}` 사용.
- 알림 리스트 max-height는 `min(560px, calc(100vh - 180px))`.
- 브라우저 알림 토글은 modal footer로 이동.
- `모두 읽음`은 header 우측 텍스트 버튼 유지.
- 알림 item 클릭 시 modal 닫고 navigate.

검증 기준:
- sidebar/rail/context 어디에도 가려지지 않음.
- overlay z-index가 Dialog.css 기준 `900/901`로 안정.
- Escape/overlay close 정상.
- unread badge는 bell에 유지.

---

## 9. Sonner toast 마이그레이션 계획

대상 파일:
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Replace: `apps/web/src/shared/ui/toast/Toast.tsx`
- Replace or remove: `apps/web/src/shared/ui/toast/Toast.module.css`
- Audit call sites: `useToast()` 사용처 전체

현재 상태:
- `sonner` 미설치.
- 현재 Toast는 Radix Toast 직접 구현.
- 사용처는 `const toast = useToast(); toast('success', '...')` 패턴으로 잘 추상화되어 있음.

Sonner 공식 문서 확인 결과:
- `<Toaster />` + `toast()` 기본 구조.
- `toast.success/error/info/warning`, `toast.promise`, `toast.loading` 지원.
- `toast.custom`은 기본 기능 유지하면서 unstyled/custom JSX 렌더 가능.
- Styling 문서: 완전 커스텀은 `style prop`보다 “Headless / TailwindCSS” 방식 권장. `toastOptions.style`은 작은 변경용. `classNames`는 override에 `!important` 필요. `unstyled`도 가능하지만 커스텀 toast는 headless가 더 낫다고 명시.

계획:
- `sonner` 설치: `pnpm --filter @consulting/web add sonner`
- 기존 `useToast()` API는 유지하여 call site 변경 최소화.
- `ToastProvider` 내부에서 Sonner `<Toaster>`를 렌더.
- `push(kind, message)`는 `toast.custom((t) => <ConsultingToast id={t} kind={kind} message={message} />)` 형태로 매핑.
- `ConsultingToast`를 CSS Module로 완전 커스텀:
  - surface: `var(--surface-card)`
  - shadow: `var(--shadow-pop)`
  - icon: muted semantic circle, 과한 원색 금지
  - close button: 현재 디자인 시스템 Button/Icon 사용
- `style prop`/inline style 남발 금지.
- 기존 `Toast.module.css`는 `ConsultingToast.module.css`로 재정리하거나 같은 파일 유지.

검증 기준:
- 기존 `toast('success', '...')` 호출부 수정 최소.
- success/error/info/warning 표시 정상.
- close, auto dismiss, swipe/animation 정상.
- dark/light token 반영.

---

## 10. 기타 UI/UX 점검 및 고도화 항목

### 10.1 Inline style 제거
현재 발견:
- `AppShell.tsx` center layout inline style
- `InlineCreate` form/Input inline style
- invite role wrapper inline style
- topic Link `style={{ flex: 1 }}`

계획:
- CSS Module 클래스로 이동.
- 디자인 토큰 일관성 보장.

### 10.2 `window.confirm` 제거
현재 발견:
- `onDelete`에서 native confirm 사용.

계획:
- 삭제도 Radix Dialog로 교체.
- 로그아웃 Dialog와 동일한 ConfirmDialog primitive 도입 검토.

### 10.3 Button semantics
현재 발견:
- Rail 테마/로그아웃은 `div` 클릭.
- Workspace rail item도 `div` 클릭.

계획:
- 실제 action은 button으로 교체.
- `aria-pressed`/`aria-current` 적용 검토.

### 10.4 디자인 토큰 미정의 변수 정리
현재 발견:
- `NotificationBell.module.css`에서 `--border-subtle`, `--bg-surface` 사용. `tokens.css`에는 현재 해당 이름이 없음.

계획:
- 토큰 alias 추가 또는 CSS 수정.
- undefined var로 인한 fallback 부재 점검.

### 10.5 색상/아이콘 직접값 정리
현재 다수:
- `#fff`, `#141517`, `#0d0e0f`, `rgba(255,255,255,...)` 등 직접값.

계획:
- rail 전용 토큰 추가: `--rail-bg`, `--rail-surface`, `--rail-text`, `--rail-muted`.
- semantic color는 token-only로 통일.

---

## 11. 구현 순서 제안

### Task 1: Token v2 정의 및 CSS 변수 정리
Files:
- `apps/web/src/styles/tokens.css`
- `apps/web/src/styles/global.css`
- `apps/web/src/shared/ui/shared-ui.css`

Steps:
1. 새 palette/typography/elevation token 적용.
2. undefined token(`--border-subtle`, `--bg-surface`) alias 추가.
3. global Korean text wrapping baseline 추가.
4. `pnpm --filter @consulting/web typecheck`.
5. 로그인/앱셸 screenshot 비교.

### Task 2: Auth screen premium redesign
Files:
- `apps/web/src/features/auth-session/ui/Auth.module.css`
- `apps/web/src/features/auth-session/ui/AuthKit.tsx` if copy/layout needs manual line break

Steps:
1. 좌측 gradient를 deep muted hero로 교체.
2. headline width/line-break/keep-all 조정.
3. weights 780/750 제거.
4. input/button focus state를 token v2로 조정.
5. 1280/1440/mobile screenshot 검증.

### Task 3: Form validation state model 개선
Files:
- `apps/web/src/routes/login.tsx`
- `apps/web/src/routes/signup.tsx`
- Optional: `AuthKit.tsx`

Steps:
1. `submitted` state 추가.
2. 빈 필수값은 submit 이후만 표시.
3. 형식 오류는 dirty+blur 또는 submitted에서 표시.
4. submit 실패 시 첫 오류 focus.
5. Playwright/manual QA: focus→blur 빈값 no-error, submit empty shows error.

### Task 4: Korean wrapping audit and fixes
Files:
- `Auth.module.css`
- `AppShell.module.css`
- `EvidencePanel.module.css`
- `Markdown.module.css`
- possibly global utility classes

Steps:
1. 한글 문장 클래스는 keep-all.
2. URL/code/초대링크만 `.cwBreakLong`/`.cwUrl`로 anywhere 처리.
3. `word-break: break-all` 사용처를 URL 전용으로 축소.
4. screenshot 및 긴 URL overflow 검증.

### Task 5: ConfirmDialog primitive + logout dialog
Files:
- `shared/ui/dialog/Dialog.tsx`
- `shared/ui/dialog/Dialog.css`
- `widgets/app-shell/ui/AppShell.tsx`

Steps:
1. ConfirmDialog 또는 composable footer styles 추가.
2. logout 즉시 실행 제거.
3. confirm 시에만 logout+navigate.
4. keyboard/Escape/overlay QA.

### Task 6: Rail action clarity
Files:
- `AppShell.tsx`
- `AppShell.module.css`

Steps:
1. `RailAction` 컴포넌트 생성.
2. div click → button/Link semantics 정리.
3. 산출물/테마/로그아웃 tooltip/aria/title 통일.
4. active/focus styling 추가.

### Task 7: Notification modal migration
Files:
- `NotificationBell.tsx`
- `NotificationBell.module.css`
- Reuse Dialog primitives

Steps:
1. absolute popover 제거.
2. Dialog modal로 알림 리스트 렌더.
3. footer에 브라우저 알림 토글 배치.
4. navigate/mark-read 흐름 유지.
5. sidebar 가림 현상 재검증.

### Task 8: Sonner custom toast migration
Files:
- `apps/web/package.json`
- `pnpm-lock.yaml`
- `shared/ui/toast/Toast.tsx`
- `shared/ui/toast/Toast.module.css`

Steps:
1. `sonner` 설치.
2. `ToastProvider`를 Sonner 기반으로 교체.
3. 기존 `useToast()` API 유지.
4. `toast.custom`/headless JSX로 완전 커스텀 toast 적용.
5. 모든 toast call site 동작 확인.

### Task 9: UI debt cleanup pass
Files:
- `AppShell.tsx`, `AppShell.module.css`, 기타 inline style 사용처

Steps:
1. inline styles CSS Module 이동.
2. native confirm 제거.
3. token 직접값 정리.
4. typecheck/lint/build.
5. browser QA: login, signup, app shell, notification, logout, toast, dark/light.

---

## 12. 검증 명령 및 QA 시나리오

Commands:
- `pnpm --filter @consulting/web typecheck`
- `pnpm --filter @consulting/web lint`
- `pnpm --filter @consulting/web build`
- 가능하면 기존 전체 루트 검증도 수행: `pnpm typecheck && pnpm lint && pnpm build`

Browser QA:
1. `/login` 1280x633: 색감, headline 줄바꿈, focus state.
2. `/signup`: 빈 필드 blur 에러 미노출, submit 후 에러 표시.
3. 로그인 후 AppShell: rail action 의미 파악 가능 여부.
4. 알림 버튼: modal이 sidebar/rail에 가리지 않음.
5. 로그아웃: dialog 없이는 로그아웃 안 됨.
6. toast: success/error/info/warning 커스텀 디자인 표시.
7. dark mode: 대비/색감 유지.
8. 긴 초대링크/URL: overflow 없음.

---

## 13. 리스크 / 트레이드오프

- 전역 `word-break: keep-all`은 긴 한글 없는 문자열/URL overflow를 유발할 수 있음 → URL/code 전용 class 분리가 필수.
- palette 변경은 앱 전역 영향을 줌 → Auth부터 보고 AppShell로 확장하되 token alias를 유지해야 함.
- Sonner는 기본 스타일을 쓰면 현재 디자인과 섞임 → `toast.custom` headless 방식으로 가야 함.
- 알림 modal은 popover보다 interruptive함 → 알림은 사용자가 명시 클릭했을 때만 열리므로 허용 가능.
- 로그아웃 confirm은 NN/g에서 “sparingly” 권고지만, 세션 이탈은 destructive-ish navigation이라 적절함.

---

## 14. Open questions

1. 로그인 hero의 최종 톤은 A/B 중 어떤 쪽이 좋은가?
   - A: Deep charcoal/navy + muted indigo (Linear/Superhuman 혼합)
   - B: Warm ivory + charcoal CTA 중심 (Vercel/Superhuman 혼합, 더 절제)
   - 추천: A. 현재 좌측 split 구조를 유지하면서 가장 적은 구조 변경으로 고급감 확보.
2. 알림은 centered modal vs right sheet?
   - 추천: centered compact modal. sidebar 가림 문제를 가장 확실히 제거.
3. rail tooltip을 직접 구현할지, title만 개선할지?
   - 추천: 최소 구현은 title+aria+focus. 고도화는 Radix Tooltip 도입 검토.

---

## 15. 이번 조사에서 확정된 결론

- 색감 문제의 핵심은 “밝고 채도 높은 보라 그라디언트 과사용”이다. token v2에서 채도와 밝기를 낮추고, CTA/focus 외 색 사용을 제한해야 한다.
- 빈 input blur 에러는 과하다. 필수값 에러는 submit 이후, 형식 오류는 dirty 이후로 분리해야 한다.
- 한국어 줄바꿈은 전역 keep-all + URL/code 예외가 맞다.
- 알림 팝오버는 layout boundary에 취약하므로 modal 전환이 맞다.
- Sonner는 `style prop`보다 headless/custom JSX 방식이 공식적으로도 더 적합하다.
