# P4 product-workflow — batch verification 리뷰 우선순위 (read-only 코어)

작성일: 2026-07-12 · 제품결선 갱신: 2026-07-14 · 상태: **Human Review API·원장·Web worklist·W3 shadow 결선 완료. 운영 적용은 HOLD.**
근거 로드맵: §4.x(Evidence/Review/Trace) · W2 게이트(preflight/red-team)

## 문제
기존 `auditArtifactExportPreflight`는 산출물별 export 가능 여부를 판정하지만,
**"사람이 무엇을 먼저 검토해야 하는가"**를 정렬·태깅하는 human-review 층이 없었다.
P4는 그 batch human-review 우선순위 백엔드를 채운다.

## 구현
- `apps/api/src/artifacts/batch-review-plan.ts` — 의존성 0, 결정론.
  - `classifyReviewRow()`: 산출물 1건을 critical/high/medium/clear로 분류 + 코드 태그(원문 없음).
    - critical: red-team BLOCKED 또는 verifier gate 차단 (하드 스톱)
    - high: 검증/구조 필요, gate blocker
    - medium: export 가능하나 gate/red-team 경고 (사람이 확인)
    - clear: 정상, 사람 검토 불필요
  - `buildBatchReviewPlan()`: 우선순위→제목 안정 정렬 + 버킷 카운트 + needsHumanReview 집계.
  - `reviewPlanFromAudit()`: 기존 `ArtifactExportPreflightAuditResult`를 재검증 없이 리뷰 플랜으로 매핑.
- 유닛+통합테스트 `test/batch-review-plan.test.ts` **12/12 통과**.

## 검증 (실 audit 출력 사용)
- 실제 `auditArtifactExportPreflight`에 구조미비+정상 2건을 넣고 `reviewPlanFromAudit`로 흘려:
  - 구조미비 산출물이 정상보다 상위(**high**, `structure_required`)로 정렬
  - 정상은 **clear**, needsHumanReview=1 — mock 아닌 실 게이트 출력과 계약 정합 실증.
- API `typecheck`·`lint`(0)·`build` 그린.

## W3 shadow 연결점
- red-team BLOCKED / gate 차단 산출물을 리뷰 큐 최상단으로 escalate → W3 shadow 그래프의 would_block 판정과 방어 논리 일치(defense-in-depth).

## 제품결선 갱신 (2026-07-14)
- `GET /artifacts/projects/:projectId/review-plan?offset=N`
  - 페이지당 최대 500건, `nextOffset` 기반으로 전체 후보 접근.
  - summary는 `returned_page` 범위임을 contract와 Web에 명시.
- `GET /artifacts/workspaces/:workspaceId?projectId=...&offset=N`
  - 기존 strict `{ artifacts }` shape를 유지하면서 DB query를 페이지당 최대 500건으로 제한.
  - Web은 방문 offset stack으로 가변 page size에서도 이전 페이지를 정확히 복원.
- `POST /artifacts/:id/versions/:versionNo/review-decision`
  - 서버 transition matrix가 hard blocker 승인, stale content hash, foreign tuple, terminal reject 이후 변경을 차단.
- `0056_artifact_review_decision_integrity.sql`
  - exact workspace/project/artifact/version tuple guard.
  - version별 advisory lock + sequence/hash chain.
  - reject terminal, UPDATE/DELETE/TRUNCATE 금지, FK `RESTRICT`.
  - legacy NULL actor는 `legacy_unknown`으로 보존하고, 신규 event는 실제 user actor만 허용.
  - 기존 exact tenant tuple을 hash backfill 전에 전수 검증.
  - SHA-256: `78b3f888e21baacb48738cd8d52970f805128ed9a6f4a61b4e0587a810a6b348`.
- W3 shadow
  - 32개 global admission cap, 동일 full-input fingerprint singleflight, A→B→A 포함 latest-wins pending 1개.
  - 5초 deadline은 caller만 degraded시키고 abort를 요청하며, 실제 operation이 settle하기 전에는 slot 회수·pending 시작을 금지해 stale checkpoint write와 cap 초과를 막음.
  - terminal checkpoint 뒤 parity write 실패는 다음 호출에서 재시도하고, `parityKey` partial unique index+conflict no-op으로 재시작·다중 replica 중복을 방지.
  - final hard blocker는 human checkpoint를 통과하지 않으며, 이미 paused인 checkpoint도 승인 대신 terminal block으로 수렴.
  - completed-state parity mismatch는 error span으로 영속 기록.

## Rolling contract
- 기존 artifact route는 query가 없으면 strict v1 request/response를 유지한다.
- v2 opt-in:
  - 구조 필드: `includeStructure=1`
  - final review eligibility: `includeReview=1`
- capability probe는 legacy `GET /artifacts/:id`와 충돌하지 않는 top-level `GET /artifact-contract`를 사용한다.
- 구 API에서 capability가 404이면 새 Web은 읽기만 유지하고 구조화 create/add-version은 409로 fail-closed한다. 구조 필드를 조용히 버리지 않는다.
- 구 Web이 새 API를 호출할 때 v1 preflight shape는 유지하되, 새 final blocker는 `VERIFIER_GATE_BLOCKED`로 보수적으로 투영한다.

## 운영 적용 순서
1. **사전 확인**
   - `_migrations` 0055 checksum 일치.
   - `artifact_review_decisions.decided_by_user_id IS NULL` 건수를 기록하고, 적용 후 동일 건수가 `actor_kind=legacy_unknown`으로 보존되는지 확인.
   - 기존 exact tuple mismatch가 있으면 0056은 전체 rollback되므로 사전 정정 없이 강행 금지.
   - DB snapshot과 현재 API/Web image digest 기록.
2. **Migration 0056**
   - advisory-locked migration runner로 단일 transaction 적용.
   - `_migrations` checksum을 위 SHA-256과 대조.
   - trigger 4개, hash verifier 함수, FK `RESTRICT`, legacy actor 보존 건수와 신규 actor 강제 readback.
3. **API 먼저 교체**
   - health GREEN.
   - 인증된 `GET /api/artifact-contract`가 `{ "version": 2 }` 반환.
   - query 없는 detail/preflight/create가 v1 contract를 유지하는지 smoke test.
4. **Web 교체**
   - capability true 전까지 편집 잠금 문구 확인.
   - review worklist 500건 pagination, version-bound note, blocked/invalid/rejected action visibility를 브라우저에서 확인.
5. **최종 readback**
   - 승인→반려 transition, 반려 뒤 승인 거부, chain verifier `valid=true`.
   - PDF/DOCX는 final eligibility true인 exact version에서만 활성화.

## Rollback
- Web 이상: Web image만 직전 digest로 복귀한다. API v1 default contract가 구 Web을 계속 지원한다.
- API 이상: API를 직전 digest로 복귀하되 0056 DB는 forward 상태로 유지한다. migration 파일을 역수정하거나 checksum을 되돌리지 않는다.
- 0056 적용 실패: runner transaction rollback을 확인하고 column/trigger 잔존 0건을 readback한 뒤 원인을 수정한다.
- 운영 적용·rollback은 별도 승인 전 실행하지 않는다.
