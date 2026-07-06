# Consulting Web Roadmap

Last updated: 2026-07-05

## 현재 위치

Phase 1 기반 앱: ██████████ 100%
Phase 2 협업/증거/문서지능: ██████████ 100%
Phase 3 Cloudflare/외부 노출: ░░░░░░░░░░ 0%

## 이번 완료 묶음

- UI 현대화/FSD 패스
  - 텍스트·이모지 아이콘 금지 회귀 테스트 추가 및 GREEN
  - lucide-react 기반 shared icon registry 추가
  - shadcn 호환 `components.json`, shared UI primitives(Button/Input/Textarea/EmptyState 등), Tailwind v4 bridge 추가
  - 주요 `components/*` 구현 파일을 `widgets/features/shared`로 물리 이동하고 compatibility shim만 유지
  - Toast를 Radix Toast 기반으로 교체, Dialog/Sheet를 Radix Dialog 기반 shared UI로 추가
  - Wanted Sans self-host 적용 후 complete 1.29MB 단일 파일에서 unicode-range split 로딩으로 최적화
  - Windows/Mac fallback font stack 지정
  - dev proxy를 현재 prod stack nginx(`127.0.0.1:8088`) 기준으로 수정
  - signup→login→AppShell 브라우저 E2E, console error 0, emoji 0 확인

- React Compiler 공식 적용
  - `@vitejs/plugin-react` + `reactCompilerPreset` + `@rolldown/plugin-babel`
  - on/off 빌드 비교 스크립트 추가: `pnpm --filter @consulting/web profile:react-compiler`
  - 결과 파일: `reports/react-compiler-profile.json`
  - 현재 측정: compiler runtime 활성, gzip +2.1%

- 업로드 자동 문서 인덱싱
  - 첨부 업로드 직후 `document_extractions`에 추출 상태/본문 길이/품질점수 저장
  - indexed 문서는 같은 thread에 `file` evidence 후보 자동 생성

- HWP/HWPX 추출 rail
  - HWPX: zip XML 텍스트 추출 지원
  - HWP: `hwp5txt`가 있는 런타임에서 지원, 없으면 실패 사유 기록
  - 운영 helper: `scripts/extract-document-text.sh`

- Evidence 품질 점수화
  - evidence 응답에 `qualityScore`, `qualitySignals` 노출
  - attachment 목록에 extraction 상태/점수/경고 노출

- pnpm 11 전환
  - `packageManager: pnpm@11.10.0`
  - pnpm 11 설정을 `pnpm-workspace.yaml`로 이동
  - build-script allowlist와 supply-chain policy 통과 확인
  - `baseline-browser-mapping`은 최소 공개 후 경과시간 정책 때문에 `2.10.41`로 안정 고정

- 동시 signup 회귀 수정
  - unique violation wrapper/cause chain의 `23505`를 CONFLICT로 매핑
  - double-submit loser가 INTERNAL로 새지 않도록 보강

## 검증 게이트

- `pnpm install` with pnpm 11.10.0
- `pnpm --filter @consulting/db-schema drizzle:migrate`
- `pnpm test`
- `pnpm --filter @consulting/api test -- test/auth-integration.test.ts test/phase2-collab.test.ts`
- `pnpm typecheck`
- `pnpm build`
- `pnpm --filter @consulting/web profile:react-compiler`
- HWPX sample extraction smoke
- `docker compose --env-file .env.docker -f docker-compose.prod.yml config --quiet`
- `docker compose --env-file .env.docker -f docker-compose.prod.yml build api web`

## 다음 우선순위

1. React Compiler interaction profiling
   - 빌드 비용은 측정됨. 실제 UI interaction 기준 이득은 별도 브라우저 profiling 필요.

2. 구형 HWP 런타임 패키징 결정
   - 현재 API rail은 있으나 로컬에는 `hwp5txt` 없음.
   - Alpine runtime에 안정 패키징할지, 변환 서비스로 분리할지 결정 필요.

3. Phase 3 Cloudflare
   - 계정/도메인/tunnel token 준비 후 외부 노출 게이트 진행.

## 2026-07-06 완료 — 로그인 디테일 완성 + API 타임아웃 (Phase 1~6)
- api-client 15s 타임아웃 + TIMEOUT/NETWORK 에러코드 (무한 스피너 구조적 차단)
- favicon/브랜드 이모지 → 순수 SVG BrandMark, forbidden 테스트 public/ 확장
- 공통 Button loading/shine/focus-ring, Input invalid/shake, disabled=회색조
- 로그인/회원가입 split 레이아웃 재구축: 인라인 검증, 비밀번호 토글, 강도미터
- Google Fonts(Inter/JetBrains Mono) 제거 → Wanted Sans 셀프호스팅 + 시스템 mono
- E2E: 가입→AppShell 진입, 콘솔에러 0 검증 완료

## 2026-07-06 완료 — Service Worker 레이어 (배포안전 + Web Push + 오프라인)
근거: velog "왜 서비스 워커를 안 쓸까" + MDN Service Worker API 검토 → 5단계 전부 적용.
- ① nginx 캐시 정책 근본수정: index.html/sw.js/version.json = no-cache, /assets/ = immutable 1년.
  ★nginx add_header 상속 함정: location에서 add_header 쓰면 상위 보안헤더 전체 소실
  → nginx-security-headers.conf snippet으로 구조화(모든 location에 include). CSP에 worker-src 'self' 추가.
- ② vite:preloadError 세션당 1회 reload 안전망 (최후 보루, src/lib/sw.ts)
- ③ SW 본체 (public/sw.js + vite version-manifest 플러그인):
  version.json(빌드타임스탬프+에셋목록, 불일치비교→롤백 안전) 폴링(5분+visibilitychange),
  신버전 전체 프리캐시 후 NEW_VERSION postMessage → 라우트 이동 시점 자연 reload.
  /assets/ cache-first(전체 버킷 검색→배포후 구 청크 404 원천 차단), 버킷 최신 3개 유지.
  ★하드룰: /api/ (특히 SSE)는 respondWith 자체를 안 함. dev(5273)에선 SW 미등록.
- ④ Web Push: push_subscriptions 테이블(0007), VAPID env(미설정시 no-op 열화),
  /push/public-key·subscribe·unsubscribe, notifyWorkspace→sendToUsers 팬아웃(best-effort,
  404/410 dead endpoint 자동 프룬), 벨 드롭다운에 "브라우저 알림" 토글.
- ⑤ 오프라인: SW 셸 폴백(navigate 실패→캐시된 index.html) + OfflineBadge(online/offline 이벤트).
- ★함정 기록: public/ 파일 umask 600 → 컨테이너 nginx 403. Dockerfile에 chmod 644/755 정규화로 구조적 차단.
- 검증: typecheck/lint/test 전체 GREEN, 프로드 재배포, sw.js 200+no-cache, version.json 200,
  push subscribe→DB row→unsubscribe→0 실측, SW가 version.json+전체 에셋 프리캐시하는 로그 확인.

## 2026-07-06 완료 — 채팅 가상화/검색/Hermes 런타임 UI/슬래시/사이드바 모션
- 메시지 로딩을 전체 transcript fetch에서 cursor pagination으로 전환:
  latest/before/after/around contract, `(created_at, id)` cursor index, API 호환 유지.
- 클라이언트 message window store 추가:
  dedupe/chronological merge, older/newer hydrate, search around jump window replace.
- `@tanstack/react-virtual` 기반 채팅 가상화 적용:
  dynamic height, prepend anchor preservation, top/bottom auto-load guard, live streaming row 분리.
- 대화 검색:
  `/chat/threads/:threadId/messages/search` + api-client + header 검색 dropdown + 결과 클릭 center jump/highlight.
- Hermes slash palette:
  `/` 입력 시 Discord/Telegram식 명령 제안, ↑↓/Tab/Enter 지원.
  slash 전용 API는 현재 Hermes API Server에 없어서 기존 `/v1/runs`로 slash 문자열 전송.
- Hermes runtime status UI:
  model/runId, total/input/output token usage, context meter(한도 수신 시), elapsed, tool activity, reasoning.available 표시.
- 좌측 프로젝트 collapse motion:
  channel list unmount 대신 grid-row/opacity/chevron rotate 애니메이션, inert+aria-hidden, reduced-motion fallback.
- 검증: `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm --filter @consulting/web typecheck && build` GREEN.
