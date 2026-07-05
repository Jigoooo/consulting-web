# 로그인/공통 UI 디테일 완성 + API 연결 전수 점검 계획

> **For Hermes:** 로그인 화면부터 순서대로 실행. 각 태스크 완료 시 5273(사용자 서버)으로 육안 확인 가능.

**Goal:** 로그인/회원가입 화면을 프로덕션 수준 디테일로 재구축하고, 파비콘·버튼 인터랙션·전환 애니메이션 등 공통 품질을 끌어올리며, API 연결의 "끝까지 도는" 문제류를 구조적으로 제거한다.

**Architecture:** shared/ui 레이어를 강화(버튼 로딩상태, 폼 검증 훅, 페이지 전환)한 뒤 auth 화면이 이를 소비. API 클라이언트에 타임아웃 불변식 추가로 무한 스피너 자체를 불가능하게 만든다.

**Tech Stack:** 기존 스택 유지 (GSAP, Radix, CVA, TanStack Router, Vite).

---

## 조사 결과 — 발견된 문제 전체 목록

### A. 사용자가 지적한 것
| # | 문제 | 원인 (실측) |
|---|---|---|
| A1 | 빈 아이디/비번에도 로그인 버튼 눌림 | `login.tsx` — disabled 조건 없음, 클라이언트 검증 없음 |
| A2 | 로그인 로딩 애니메이션 빈약 | `SubmitButton` 스피너만 있고 버튼 텍스트/상태 전환 없음 |
| A3 | 로그인 버튼 누르면 끝까지 도는 문제 | **2중 원인**: (1) api-client `http-core.ts`에 요청 타임아웃 자체가 없음 → 백엔드 무응답이면 영원히 pending. (2) 사용자 5273 서버는 vite.config 수정 **이전**에 시작됨 → proxy가 여전히 죽은 `127.0.0.1:3000`을 가리킴 → 모든 /api 요청이 hang. **5273 재시작 필요(승인 대기)** |
| A4 | 웹 아이콘이 이모지 지구 | `public/favicon.svg` 내부가 `<text>🌍</text>` — 금지 텍스트 아이콘 잔존 (forbidden-icons 테스트가 public/을 스캔 안 함) |
| A5 | 로그인 페이지 평범함 | 단일 카드 + 블롭 2개뿐. 좌우 분할·브랜드 패널 없음 |
| A6 | 로그인↔회원가입 링크 간격 답답 | `.foot` margin-top 18px, 시각 분리(구분선 등) 없음 |
| A7 | 버튼 hover 효과 부족 | translateY(-1px)만 있고 그라디언트 시프트/글로우/press 스케일 없음 |

### B. 조사로 추가 발견한 것 (말 안 해도 잡아야 할 것)
| # | 문제 | 위치 |
|---|---|---|
| B1 | **Google Fonts Inter가 여전히 로드됨** — Wanted Sans self-host와 충돌, 외부 네트워크 의존, FOUT 원인 | `index.html:21-26` |
| B2 | 로그인 실패 시 네트워크 오류와 자격증명 오류가 같은 메시지로 뭉개짐 | `friendlyError` fallback |
| B3 | 이메일 형식 클라이언트 검증 없음 (서버 VALIDATION 에러에만 의존) | login/signup 공통 |
| B4 | 로그인→앱 진입 시 페이지 전환 애니메이션 없음 (뚝 끊김) | 라우트 레벨 |
| B5 | 비밀번호 보기/숨기기 토글 없음 | `Field` 컴포넌트 |
| B6 | signup 비밀번호 강도 표시 없음 (10자 규칙이 제출 시에만 드러남) | signup.tsx |
| B7 | 로딩 중 필드가 편집 가능 (제출 중 값 변경 가능) | Field에 disabled 전달 안 됨 |
| B8 | Enter 연타 시 중복 제출 가능성 (loading 가드가 유일한 방어) | onSubmit |
| B9 | forbidden-icons 테스트가 `public/` 폴더 미스캔 → favicon 이모지 미검출 | `forbidden-icons.test.ts` |
| B10 | 다크모드에서 auth 카드가 `background:#fff` 하드코딩 → 다크 깨짐 | `Auth.module.css:39` |

### C. API 연결 전수 점검 대상
- `/auth/login`, `/auth/signup`, `/auth/refresh` — 타임아웃·에러 분기
- `streamChat` SSE — AbortSignal 있음(OK), 타임아웃 정책만 확인
- 401→refresh 단일비행 — 구현 확인됨(OK)
- Vite dev proxy — 8088로 수정 완료, **사용자 5273 재시작만 남음**

---

## 실행 계획

### Phase 1 — 무한 스피너 구조적 제거 (A3, B2)
1. `packages/api-client/src/http-core.ts`에 기본 타임아웃(15s) + `AbortSignal.timeout` 추가. 타임아웃 시 `ApiClientError(code:'TIMEOUT')`.
2. `friendlyError`에 TIMEOUT/네트워크 오류 분기 추가: "서버 응답이 없습니다. 잠시 후 다시 시도해주세요."
3. api-client 테스트 추가 (타임아웃 발동 검증).
4. 검증: `pnpm --filter @consulting/api-client test`

### Phase 2 — favicon/브랜드 아이콘 교체 (A4, B9)
1. `public/favicon.svg`를 이모지 없는 순수 SVG 마크로 교체 (그라디언트 라운드 사각형 + 기하학 글로브/오빗 라인 — lucide `globe` 계열 path 활용).
2. `AuthShell` 브랜드 아이콘도 동일 마크 사용 (bot 아이콘 → 브랜드 SVG).
3. `forbidden-icons.test.ts` 스캔 범위에 `public/` 추가 → RED 확인 → 교체 후 GREEN.
4. 검증: 테스트 + 브라우저 탭 아이콘 육안.

### Phase 3 — 공통 인터랙션 강화 (A7, 공통)
1. `shared-ui.css` 버튼 개선:
   - hover: 그라디언트 밝기 + 글로우 확산 + translateY(-1px)
   - active: scale(0.98) press 느낌
   - focus-visible: ring
   - `--primary` 버튼에 shine sweep(subtle) 옵션
2. `Button`에 `loading` prop 추가 — 스피너 교체 + 자동 disabled + 텍스트 유지(레이아웃 시프트 없음).
3. `Input`에 `invalid` prop + shake 애니메이션 토큰.
4. 페이지 전환: `__root.tsx`에 라우트 전환 fade/slide(GSAP or CSS) 추가. reduced-motion 존중.
5. 검증: typecheck + 5273 육안.

### Phase 4 — 로그인/회원가입 화면 재구축 (A1, A2, A5, A6, B3~B8, B10)
1. `AuthShell` 재설계: 좌측 브랜드 패널(그라디언트 + 오빗 애니메이션 + 카피) / 우측 폼. 모바일에서 단일 컬럼. 다크모드 대응(`var(--surface-card)`).
2. 폼 검증 훅 `useAuthForm`: 이메일 정규식, 비밀번호 최소 길이, touched 상태 → 필드별 인라인 에러.
3. 로그인 버튼: 유효할 때만 활성. loading 중 필드 disabled + 중복 제출 차단.
4. 비밀번호 보기 토글 (lucide eye/eye-off).
5. signup 비밀번호 강도 미터 (10자 규칙 실시간 표시).
6. footer 간격/구분선 재설계 (A6).
7. 성공 시 카드 exit 애니메이션 → 라우트 이동.
8. 검증: 브라우저 E2E (빈 폼 → 버튼 비활성 / 잘못된 자격 → 에러 / 정상 → 전환 애니메이션 + AppShell).

### Phase 5 — Google Fonts 제거 (B1)
1. `index.html`에서 Inter/JetBrains Mono `<link>` 제거.
2. mono가 필요한 곳 확인 (`font-family.*mono` 검색) → 시스템 mono 스택으로 대체.
3. 검증: build + 렌더 확인.

### Phase 6 — 최종 검증 + 커밋 분리
1. test / lint / typecheck / build 전체 GREEN.
2. 브라우저 E2E 재실행 (로그인 실패/성공 시나리오).
3. 커밋: ① api-client 타임아웃 ② favicon/브랜드 ③ 공통 인터랙션 ④ auth 화면 ⑤ 폰트 정리.

---

## 사용자 확인 필요 (승인 대기)
- **5273 재시작**: 현재 5273은 proxy가 죽은 3000을 보고 있어 로그인이 hang됨. vite.config는 이미 8088로 수정됨 → **주인님이 5273을 재시작해야 로그인이 실제로 동작**. (제가 kill하지 않음 — skill 준수)

## 리스크
- AuthShell 재설계는 invite.$token.tsx도 사용 → 회귀 확인 필요.
- api-client 타임아웃은 SSE 스트림에는 적용 제외 (스트림은 장시간 연결이 정상).
