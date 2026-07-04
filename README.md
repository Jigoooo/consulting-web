# Consulting Web

컨설팅 업무 운영 웹앱. 설계·결정은 아래 문서가 단일 원천이다.

- 상위 계획: `~/.hermes/plans/consulting-webapp-plan.md`
- 백엔드 상세 설계: `~/.hermes/plans/consulting-web-backend-design.md`
- 결정 잠금(ADR): `~/.hermes/plans/consulting-web-adr/` (ADR-0001~0021)
- Phase 0 구현계획: `~/.hermes/plans/consulting-web-phase0-plan.md`
- Phase 1 구현계획: `~/.hermes/plans/consulting-web-phase1-plan.md`

## 스택

- 모노레포: pnpm workspace + turbo
- API: NestJS (CommonJS, TypeScript strict)
- DB: PostgreSQL (전용 포트 5434) + Drizzle ORM
- Queue/cache: Redis (전용 포트 6380; 6379는 Honcho) + BullMQ
- 계약: Zod (packages/contracts)
- 테스트: Vitest + 실 DB/Redis 통합

## 구조

```
apps/api            NestJS 백엔드 (config/infra/health/permissions/auth/organization/spaces/chat/queues)
packages/shared     Result 타입, 스코프 어휘, 위험등급 (ADR-0002/0004)
packages/contracts  Zod API 계약 (health/auth/invitation/chat/spaces) — strict response/event + secret 미노출 강제
packages/db-schema  Drizzle 스키마 (23 tables) + 마이그레이션 러너
tooling/*           공용 tsconfig, eslint(boundary) 설정
```

## 로컬 실행 (Phase 0)

```bash
# 1) 시크릿 준비 (한 번만)
cp .env.example .env.local
# .env.local 의 CONSULTING_POSTGRES_PASSWORD / JWT_* / HERMES_API_KEY 를 실제 값으로 채움
#   (openssl rand -hex 로 강한 랜덤 생성 권장; 이 파일은 gitignore)

# 2) 인프라 기동 (전용 PG 5434 + Redis 6380)
set -a; . ./.env.local; set +a
docker compose -f docker-compose.local.yml up -d

# 3) 의존성 + 라이브러리 빌드
pnpm install
pnpm --filter @consulting/shared --filter @consulting/contracts --filter @consulting/db-schema build

# 4) DB 마이그레이션 적용
pnpm --filter @consulting/db-schema drizzle:generate   # 스키마 변경 시에만
pnpm --filter @consulting/db-schema drizzle:migrate

# 5) 게이트 검증
pnpm -r typecheck
pnpm -r test          # 53 tests (실 DB/Redis 통합 포함)

# 6) API 부팅 + health
pnpm --filter @consulting/api build
node apps/api/dist/main.js          # env 필요: set -a; . ./.env.local; set +a
curl -s localhost:3000/health/ready
```

## Phase 0 Foundation Gate — 완료 기준 (달성)

- [x] pnpm typecheck / test / (lint 설정) 그린
- [x] packages/contracts = API 계약 단일 원천, strict response shape + secret 미노출 테스트
- [x] config 검증 실패 시 부팅 차단 (Zod env)
- [x] workspace-first 스키마 (모든 주요 테이블 workspace_id)
- [x] Redis/BullMQ health 분리 표시
- [x] permission engine: role/상속/deny 우선/explain — 9 유닛 테스트
- [x] context graph: 직접 생성 시 태그/edge 자동 상속 — 통합 테스트
- [x] outbox: 트랜잭션 내 기록 + relay + idempotency + workspace_id NOT NULL + relay index
- [x] audit: 주요 변경 기록
- [x] invitation share-link preview/accept → membership (email optional, 재사용/만료 차단)
- [x] 개인 workspace 자동 생성
- [x] Hermes key 브라우저/계약 미노출
- [x] Foundation Gate E2E + negative security 테스트

## Phase 1-B/C/D/G + Thread API + Hermes SSE Proxy — 부분 완료

- [x] `POST /auth/signup` — signup use-case를 strict bootstrap 응답으로 노출
- [x] `POST /auth/login` — password verify → public user + JWT access/refresh envelope 반환, refresh token hash는 sessions에만 저장
- [x] `POST /invitations` — owner/admin 공유링크 초대 생성(raw token은 생성 시 1회만 반환, tokenHash 미노출)
- [x] `POST /invitations/preview` — 초대 landing용 비소모성 preview(token/tokenHash 미노출)
- [x] `POST /invitations/accept` — Bearer access token 필수, body userId 금지, 인증 사용자 기준 token 수락 → membership 생성
- [x] HTTP contract adapter: Zod strict parse, domain error→HTTP status 매핑, response contract violation fail-fast
- [x] `POST /chat/stream` — Bearer access token 필수, thread workspace membership 검증, 권한 없는 사용자 403, 실제 Hermes API Server(`/v1/runs`+`/v1/runs/{id}/events`)로 proxy하여 strict SSE(start/delta/done/error)로 변환 (Hermes key/JWT secret 미노출, 서버측만 호출)
- [x] `POST /spaces/projects|channels|topics|threads` — Bearer access token 필수, workspace membership 검증, Project→Channel→Topic→Thread 생성 후 stream 연결 가능

## 보안 원칙 (요약)

- Hermes api_server는 백엔드만 접근 (브라우저 노출 금지, ADR-0007)
- secret 은 .env.local + 환경변수만 (DB 평문 저장 금지, ADR-0014)
- 접근권은 membership/invitation 으로만 발생 (ADR-0009)
- 봇 invoke ≠ capability (ADR-0004)

Hermes SSE proxy 연결이 완료됐다. 다음 백엔드 우선순위는 초대 landing/API 클라이언트 준비다. UI + apps/web는 후속 승인 범위이며 Slack-like 디자인 리서치 후 착수한다.

### Hermes API Server 연동 (운영 메모)

- `/chat/stream`은 서버측에서만 Hermes를 호출한다: `HERMES_API_BASE_URL`(예 `http://127.0.0.1:8642`) + `HERMES_API_KEY`.
- Hermes gateway 쪽은 `~/.hermes/.env`에 `API_SERVER_ENABLED=true` / `API_SERVER_KEY`(웹앱 `HERMES_API_KEY`와 동일) / `API_SERVER_HOST` / `API_SERVER_PORT` 필요. 변경 후 `hermes gateway restart`.
- 실제 E2E smoke 확인: signup→login→project/channel/topic/thread 생성→`/chat/stream`에서 실제 `run_*` id로 start/delta/done 수신, secret 미노출.
