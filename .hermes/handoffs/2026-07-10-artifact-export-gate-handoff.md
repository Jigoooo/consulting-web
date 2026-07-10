# Handoff — artifactVersionId + contentHash final-export ledger

Updated: 2026-07-10 KST
Repo: `/home/jigoo/.hermes/workspace/consulting-web`
Branch: `pg18-consulting-migration`
Baseline HEAD: `ba618c2`

## 결론

최종 PDF/DOCX 승인은 더 이상 `sourceMessageId` telemetry에 귀속되지 않는다. 현재 artifact version의 exact UTF-8 content SHA-256과 tenant/artifact identity가 모두 일치하고, 현재 policy-version 원장의 최신 gate가 **이슈 없는 `PASS`**일 때만 내보낸다. 운영 migration/deploy, 취약한 과거 v2 PASS 자동 무효화, 실제 보고서 2건의 strict v3 재검증·내보내기까지 완료했다.

## 확정 불변식

1. 승인 키는 `(workspaceId, projectId, artifactId, artifactVersionId, sha256(content))`다.
2. `sourceThreadId`/`sourceMessageId`는 provenance일 뿐 승인 키가 아니다.
3. 원본 없는 수동 artifact도 `POST /artifacts/:id/verify`로 현재 version content 자체를 검증해야 한다.
4. 검증 결과는 `artifact_version_verifications`에 append-only run으로 저장한다.
5. `artifactVersionId`별 최신 run은 monotonic `sequence_no`로 먼저 확정한다. 그 뒤 identity/hash/deleted/status/gate를 검사해 mismatch·손상·원장 없음은 fail-closed한다.
6. `PASS_WITH_WARNINGS`, `BLOCKED`, 또는 `PASS`인데 blocker/warning이 남은 손상 gate는 모두 `VERIFIER_GATE_BLOCKED`다.
7. `exactness=skipped` 단독은 telemetry가 아니다. claim verdict/judgment/실제 exactness 결과가 모두 없으면 `missing_verifier_telemetry` blocker다.
8. qualitative pay-progression prose는 ClaimVerifier 대상이다. 실제 계산 의도가 있는 요청만 Decimal Exactness Gate를 요구한다.
9. API와 CLI는 `ArtifactVerificationDbLedger.latest()` + `auditArtifactExportPreflight()`를 공유한다.
10. hash/split 전에 title 200자/content 200,000자 계약 상한을 O(1) 검사한다. 초과 입력은 413으로 차단한다. 이후 Markdown의 구조 heading/구조 table cell allowlist를 제외한 1자 이상 segment와 사실형 artifact title을 모두 검증한다. table은 cell별로 분리하며 최대 24 claim × 2,000자, evidence 40건 × 2,000자다. overflow·truncation·verdict 누락은 synthetic blocker다.
11. 동일 version+contentHash+titleHash 검증은 singleflight이고, 서로 다른 동시 검증은 프로세스당 2건으로 제한한다.
12. 원장 `verifier`는 `artifact_claim_coverage_v4:<titleSha256>:<provider>` identity를 가져야 한다. 정책 또는 title hash가 다른 과거 PASS는 재검증 대상으로 차단한다.
13. chat evidence 자동 저장은 공개 `web_search`/`web_extract`의 `tool.completed` 결과만 대상으로 한다. capture와 saveRunEvidence 영속화 경계 양쪽에서 allowlist/redaction을 적용하며, 닫히지 않은/backslash-escaped auth/cookie는 줄 끝까지 제거하고 확장 DB URI, JWT, raw/HTML-escaped AWS/Google signed URL query 전체까지 제거한다.

## 주요 구현 파일

- `packages/db-schema/drizzle/0027_artifact_version_verification_ledger.sql`
- `packages/db-schema/src/schema/collab.ts`
- `apps/api/src/artifacts/artifact-verification.service.ts`
- `apps/api/src/artifacts/artifact-verification-db-ledger.ts`
- `apps/api/src/artifacts/artifact-export-preflight-audit.ts`
- `apps/api/src/artifacts/artifacts.controller.ts`
- `apps/api/scripts/audit_artifact_export_preflight.ts`
- `apps/api/src/chat/evidence.store.ts`
- `apps/api/src/chat/chat-stream.controller.ts`
- `packages/contracts/src/collab.ts`
- `packages/api-client/src/client.ts`
- `apps/web/src/lib/collab.ts`
- `apps/web/src/components/artifacts/ArtifactsSurface.tsx`
- `docs/consulting-layer-map.md` §18.2

## 검증된 회귀

- 원본 없는 미검증 v1 차단
- blocked v1 뒤 원본 없는 v2 추가 우회 차단
- 같은 sourceMessageId라도 본문 변경 시 hash mismatch 차단
- workspace/project/artifact/version identity 불일치 차단
- legacy source-message verdict 101건이 있어도 artifact 판정에 영향 없음
- `PASS_WITH_WARNINGS` 차단
- `PASS` + blocker/warning 손상 gate 차단
- claim 0건 + exactness skipped 차단
- qualitative `근속승진 평균 이식` 문장을 fake Decimal check로 차단하지 않음
- monotonic 최신 run이 tenant/hash mismatch·soft-delete여도 과거 PASS를 되살리지 않음
- DB와 application 양쪽에서 status↔gate 모순 차단
- strict API 응답은 계약 필드만 직렬화
- 답변에 pair가 없으면 질문 단일 pair↔답변 단일 percent만 비교하고, 답변에 pair가 있으면 절별 정확히 1 pair↔1 percent·안전 connector만 허용하며 나머지는 fail-closed
- `%`/`퍼센트`/`프로`/Unicode 부호·default-ignorable, 다중·중첩 pair, scientific suffix, percent token 경계, 전역 transition marker 소비를 포함한 exactness 회귀 27개 통과
- canonical 이름이 정확히 web_search/web_extract인 completed 결과만 독립 evidence 행으로 저장하고, 영속화 경계에서 allowlist/redaction을 재적용
- private-source 결과·started 인자는 미저장하고 plain text/중첩·malformed·backslash-escaped JSON secret·email·완전/잘린 PEM private key는 redact
- 수치/비수치 Markdown 표·compact `|A|9|`·명사형·영문 bullet·사실형 artifact title도 claim으로 포함
- 24개/2,000자 초과와 verifier verdict 누락은 high-impact unsupported로 차단
- 동일 version+contentHash+titleHash singleflight, 세 번째 서로 다른 동시 검증은 503 차단
- Basic/Bearer/Proxy-Authorization, Cookie/Set-Cookie, session/credential/private_key, 확장 DB URI, short JWT, AWS/Google signed URL을 redact
- 정책 또는 title hash가 다른 legacy PASS latest row는 null 처리

## 실측 검증

- 격리 PostgreSQL에서 migrations `0000..0027` 적용: 성공
- 실제 ledger insert/read + tenant/hash/malformed/status/legacy-policy integration: 통과
- focused artifact coverage/service 8개, evidence redaction/persistence 12개, exactness 27개: 통과
- contracts → api-client → API → web typecheck: 통과
- 최종 monorepo `typecheck/lint/test/build` + prod compose config: exit 0.
- 운영 migration head `0027` 적용, API/web live image ID 일치, readiness `api/db/redis/bullmq/hermes=ok`.
- 기존 v3-policy PASS 두 건: v4 배포 직후 API에서 `ARTIFACT_VERIFICATION_REQUIRED` 확인.
- 대상 artifact 2건 v3: DB content/title hash 일치, `artifact_claim_coverage_v4:<titleSha256>:...` identity 일치, gate `PASS`, evidence 2건, verdict 전부 `supports`(2/2, 3/3).
- API/CLI v3 target preflight 모두 `OK`; PDF 2건 `%PDF-`, DOCX 2건 ZIP(각 16 entries) 검증.

## 운영 콘텐츠 상태

대상 project: `01fba1a5-7b16-4267-93df-f9ca6cf0462f` (`창원시 컨설팅`)

- artifact head: 3개
- 실질 복구 대상: 2개
  - `aba9b242-05fe-4010-8ca4-5821f5de07fa`
  - `b4f0ec9c-d41e-441a-b16f-f0ca2a38b54e`
- cross-project test artifact `dded2140-a07a-44a4-9852-0e6fed89bee0`: 복구/재생성하지 않는다.
- 대상 thread `evidence_items`: 국가법령정보센터 원문 2건

과거 정책으로 승인된 row를 재사용하지 않고, DB에 등록된 공식 법령 excerpt와 동일한 본문만 두 artifact의 v3로 저장·title-bound 검증했다. 두 v3 모두 실제 PDF/DOCX export가 가능하다.

## 남은 작업

- 코드·운영 작업 없음.
- push는 요청이 없어 수행하지 않음.

## 안전 가드

- `.env.docker` 내용·JWT/API key를 출력하지 않는다.
- 운영 DB에 raw PASS row를 수기로 만들지 않는다.
- cross-project test artifact를 되살리지 않는다.
- migration/deploy 후 source와 container dist를 모두 검증한다.
- 산출물 2개가 실제 exportable이 되기 전에는 “콘텐츠 복구 완료”라고 보고하지 않는다.
