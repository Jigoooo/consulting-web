# ReportGenerationWorkflow — LangGraph.js shadow 스파이크 설계 (read-only, 승인 전 설계 전용)

작성일: 2026-07-12 · 상태: **설계만. 코드/설치/마이그레이션 미실행.**
근거 로드맵: `docs/plans/2026-07-10-roadmap-gap-audit-and-methodology-plan.md` §5 (LangGraph 판정) · §5.2 (경계 고정)

> 이 문서는 `@langchain/langgraph` 설치 승인이 떨어지는 즉시 turnkey 구현이 되도록,
> **기존 검증된 서비스에 노드를 매핑**한 실행 설계다. 새 검증 로직은 만들지 않는다(§5.2 scope-creep 금지선).

---

## 0. 왜 지금 리포트 루프만인가 (요약)
- 손익분기: 발행 게이트 6개(claim coverage · exactness · citation · freshness · red-team · 사람 승인) → LangGraph 이득 구간.
- 채팅 경로 접촉 금지: state 직렬화가 P95 직격(GraphRAG chunk 동반). 순수 함수가 더 쌈.
- 내구성: content-hash export gate가 이미 애플리케이션 층 멱등성 확보 → Temporal급 불필요.

## 1. 대상 그래프 (단 1개)
`ReportGenerationWorkflow`: `draft → verify → repair → re-verify → publish` + human interrupt.
채팅/스트리밍 경로 **접촉 금지**.

```
        ┌──────────┐
        │  draft   │  (기존 artifact_versions HEAD를 입력으로 참조만)
        └────┬─────┘
             ▼
        ┌──────────┐   verify 실패(gate BLOCKED/warning) ┌──────────┐
        │  verify  │ ───────────────────────────────────▶│  repair  │
        └────┬─────┘                                      └────┬─────┘
             │ PASS                                            │ (사람/LLM 수정 → 새 버전)
             ▼                                                 │
     ┌───────────────┐   interrupt()                           │
     │ human-approve │◀────────────────────────────────────────┘
     └──────┬────────┘   Command(resume)
            │ 승인
            ▼
        ┌──────────┐
        │ publish  │  (shadow: 판정만, 실제 발행 side-effect 없음)
        └──────────┘
```

## 2. 노드 → 기존 서비스 매핑 (신규 로직 0)
| 노드 | 호출 대상(기존 코드) | 비고 |
|---|---|---|
| draft | `artifact.store.ts` HEAD version 조회 | 원문 미탑재, 참조만 |
| verify | `ArtifactVerificationService.verify()` (`apps/api/src/artifacts/artifact-verification.service.ts:125`) | `ExactnessGateService` + `ClaimVerifierService` + `VerifierGatePolicyService.evaluate({mode:'final_export'})` 이미 결합됨 |
| repair | 없음(사람/LLM 편집→새 `artifact_versions` row) | 그래프는 재진입만 담당 |
| re-verify | verify와 동일 노드 재실행 | contentHash 갱신분 재검증 |
| human-approve | LangGraph `interrupt()` / `Command(resume)` | 승인 대기 상태를 checkpointer에 보존 |
| publish(shadow) | `ArtifactRedTeamService`(warning) + 판정 기록만 | **발행 side-effect 없음**. 기존 `artifact_export.service.ts`는 미접촉 |

## 3. Pointer State Pattern (Checkpoint Bloat 차단 — §5.2 필수)
state에 넣는 것: **참조와 판정 결과만**.
```ts
interface ReportWorkflowState {
  workspaceId: string; projectId: string;
  artifactId: string; artifactVersionId: string;
  contentHash: string;            // 원문 대신 해시
  verdict: 'PASS' | 'PASS_WITH_WARNINGS' | 'BLOCKED' | null;
  gateBlockers: string[];         // 메시지 코드만(원문 금지)
  redTeamVerdict: 'PASS' | 'PASS_WITH_WARNINGS' | 'BLOCKED' | null;
  attempt: number;
  shadowDecision: 'would_publish' | 'would_block' | null;
}
```
금지: retrieved chunk 원문, evidence 본문, claim 전문 → PG TOAST write-amplification 원인.

## 4. Checkpointer (PG 스키마 분리)
- 기존 `consulting_rbac` DB 재사용하되 **별도 스키마**(예: `langgraph_checkpoints`)로 격리.
- langchain-core 버전 churn을 앱 스키마와 분리해 blast radius 차단.
- 마이그레이션은 additive-only, 기존 경로 무변경(설치 승인 후 W1 원칙과 동일하게 negative test 동반).

## 5. 관측성 연속성 (성공 기준 b)
- 노드 전이마다 기존 `trace_spans` 테이블에 span 1개 append(`spanKind='workflow_node'`, `name=<node>`).
- 기존 Trace Viewer가 그대로 렌더 → 새 UI 불필요. eval scope 정책(`traceEvalScope.ts`)과 정합.

## 6. 성공 기준 (§5.2, 측정 가능하게 고정)
| # | 기준 | 검증 방법 |
|---|---|---|
| a | human-wait 중 프로세스 kill→재기동 시 checkpoint 재개 | 승인 대기에서 API kill → 재기동 후 `Command(resume)`로 이어짐 |
| b | 노드 전이가 trace_spans에 연속 기록 | run 1건의 span 체인 SQL readback |
| c | 동일 입력 재실행 시 결정 재현 | 같은 contentHash 2회 → shadowDecision 동일 |
| d | shadow 판정이 기존 경로와 불일치 0 | 기존 `preflight` canExport vs 그래프 shadowDecision 대조 N건 |

### 6.1 실측 결과 (2026-07-12, 승인 후 구현·검증)
`@langchain/langgraph@1.4.7` + `@langchain/langgraph-checkpoint-postgres@1.0.4` 설치.
- 결정 코어(`report-workflow.core.ts`): 순수 함수 유닛테스트 **10/10 통과**(`test/report-workflow-core.test.ts`).
- 그래프(`report-workflow.graph.ts`): 실 Postgres 체크포인터(격리 스키마 `langgraph_checkpoints_spike`) 대상 스파이크(`scripts/report_workflow_shadow_spike.ts`) **4/4 기준 통과**:
  - (a) `criterion_a_durable_resume=true` — human_approve 대기에서 그래프 객체 폐기(kill 모사)→동일 체크포인터로 재빌드→`Command(resume:true)` 시 draft/verify 재실행 없이 완료(`nodesAfterResume=[human_approve, publish]`).
  - (b) `criterion_b_trace_continuity=true` — span sink에 노드 체인 연속 기록(`draft→verify` before kill).
  - (c) `criterion_c_determinism=true` — 동일 입력 재실행 시 `decision===detDecision` (`would_publish`).
  - (d) `criterion_d_parity=true` — would_publish는 preflight canExport일 때만.
- 격리 스키마는 실행 종료 시 `DROP SCHEMA CASCADE`로 잔여 0 확인.
- API `typecheck`/`lint`/`build` 그린, Web 회귀 무영향.
- **경계 준수 확인**: `artifact-export.service.ts`(실제 PDF/DOCX) 및 채팅/SSE 경로 미접촉. 그래프는 기존 `preflightVersion` 계약만 호출.

### 6.2 남은 프로덕션 배선 (후속)
- span sink → 실제 `trace_spans` insert 어댑터(현재는 인메모리 sink로 (b) 실증).
- shadow 러너를 발행 경로에 병행 결선(발행 권한 없이 판정 로그만) 후 N건 실데이터 parity 집계.

## 7. 금지선 (scope creep = 최대 리스크)
- GraphRAG / rerank / NLI 캐스케이드 / Exactness Gate를 노드로 **재구현 금지**. 그래프는 발행 오케스트레이션 전용.
- `artifact-export.service.ts`(실제 PDF/DOCX 생성) **미접촉** — shadow는 판정만.
- 채팅/SSE/스트리밍 경로 **미접촉**.
- Temporal/Inngest/Restate 도입 안 함. 트리거(승인 며칠 대기 + 배포 중 run 생존, 또는 발행 exactly-once 계약요건) 도달 시에만 LangGraph를 **감싸는 내구층**으로 재검토.

## 8. 구현 순서 (설치 승인 후)
1. `@langchain/langgraph` + `@langchain/langgraph-checkpoint-postgres` 설치(격리 패키지 경계).
2. `langgraph_checkpoints` 스키마 additive migration + cross-workspace negative test.
3. `ReportWorkflowState` + 노드 6개(기존 서비스 호출 어댑터만).
4. shadow 러너: 기존 preflight와 병행 실행 → 판정 대조 로그.
5. 성공 기준 a~d 실측 → 결과를 이 문서 §6에 readback.

## 9. 롤백/폐기 안전성
- shadow 전용이라 발행 side-effect 없음 → 언제든 러너 비활성화로 무해 폐기.
- checkpointer 스키마는 앱 스키마와 분리되어 drop 시 앱 무영향.
- 의존성 실패 시 폴백: XState(durable resume 없음 → human-wait 재개는 수동 재큐로 격하, 1순위 아님).
