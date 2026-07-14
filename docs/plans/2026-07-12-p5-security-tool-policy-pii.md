# P5 security-tool — Tool Registry policy · PII redaction · immutable audit (read-only 코어)

작성일: 2026-07-12 · 상태: **순수 보안 코어 + legacy parity 실증 완료. runtime/gateway 변경 없음.**
근거 로드맵: §10.x(tool allowlist·prompt injection·PII·audit)

## 문제
- tool allowlist 판정이 runs-client fetch 안에 인라인(`enforceHermesToolPolicy`)이라 **단위테스트·재사용·감사 불가**.
- 기존 redact는 자격증명/시크릿 전용 — **개인 PII(주민번호·전화·카드)** 미커버.

## 구현
- `apps/api/src/security/tool-policy.ts` — 의존성 0, fail-closed.
  - `evaluateToolPolicy()`: allowlist 미포함 = deny. tenant grant 허용하되 **high-blast(mcp/messaging/admin/home_assistant/tts/x_search)는 grant여도 거부**.
  - `buildToolPolicyAudit()`: 결정별 불변 감사 레코드 + content-hash tamper-evidence(타임스탬프 제외 해시 → 동일결정 탐지).
- `apps/api/src/security/pii-redaction.ts` — 한국형 PII(rrn/phone/card/email) 탐지·마스킹. findings는 **길이만**(원문 미노출).
- 유닛테스트: tool-policy **10/10**, pii-redaction **9/9**.

## 검증
- **legacy parity**(`scripts/tool_policy_parity_check.ts`): 추출 코어 vs runs-client 인라인 로직 6케이스 verdict/blocked 완전 일치, **mismatch 0** → 재구현 아닌 충실한 추출 실증.
- PII findings에 원문 유출 0(테스트로 고정).
- API `typecheck`·`lint`(0)·`build` 그린.

## 방어 계층 정합
- tool-policy는 기존 `enforceHermesToolPolicy` fail-closed와 동일 판정 → 이중 방어(inline+testable core).
- PII redaction은 tenant audit log·eval fixture·모델 I/O 영속 표면에서 개인정보 제거용.

## 남은 배선 (후속, 선택)
- `enforceHermesToolPolicy`를 `evaluateToolPolicy`로 위임(중복 제거) + 감사 레코드 DB 영속(immutable log 테이블).
- MCP allowlist 승인 UX(operator 승인 시 tenant grant 발급, high-blast는 별도 승인 경로).
- PII redaction을 memory-write guard·eval fixture export에 결선.
