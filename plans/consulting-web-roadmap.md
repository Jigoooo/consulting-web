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
