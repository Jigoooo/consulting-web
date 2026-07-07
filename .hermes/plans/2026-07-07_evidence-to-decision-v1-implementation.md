# Evidence-to-Decision Intelligence v1 구현 기록

작성일: 2026-07-07
Repo: `/home/jigoo/.hermes/workspace/consulting-web`

## 결론

GraphRAG를 더 키우기 전에, 검색 결과를 LLM 프롬프트 앞에서 **검증·보류·의사결정·검토우선순위**로 바꾸는 v1 수직조각을 구현했다.

이번 v1은 로컬 코드+스키마+로컬 DB migration+테스트 검증에서 시작했고, 후속 작업으로 운영 `8088` 배포와 브라우저 QA까지 완료했다. 푸시는 별도 단계로 남겨둔다.

## 이번에 구현한 것

### 1. Claim Verification Lattice

파일:
- `apps/api/src/consulting/evidence-to-decision.service.ts`
- `apps/api/test/evidence-to-decision.service.test.ts`
- `packages/db-schema/src/schema/evidence-decision.ts`
- `packages/db-schema/drizzle/0014_evidence_to_decision_intelligence.sql`

기능:
- claim × evidence를 `supports | refutes | mixed | not_enough_info`로 분류.
- FEVER식 `SUPPORTS / REFUTES / NOT ENOUGH INFO`의 v1 휴리스틱 버전.
- evidence quality, linked claim, term overlap, contradiction pair를 반영.

### 2. Truth Maintenance Queue

기능:
- 변경된 evidence가 어떤 claim/artifact를 stale하게 만드는지 산출.
- `priorityScore = decisionImpact + artifactBoost` 기반으로 recheck 우선순위 제공.
- DB 테이블: `truth_maintenance_queue`.

### 3. Decision Question / Alternatives / Criteria Scorecard

기능:
- 대안·기준·가중치·불확실성·evidence coverage를 합산해 scorecard 생성.
- `lower_is_better` criterion 지원.
- evidence 부족/불확실성 높음이면 `collect_more_evidence`로 보류.
- DB 테이블: `decision_scorecards`, `decision_scorecard_items`.

### 4. PPR / heat-kernel graph diffusion

기능:
- no-dep `ppr_no_dep`, `heat_kernel_no_dep` 구현.
- cross-project edge는 0.6 dampening.
- Leiden/igraph 전에 small graph에서 쓸 수 있는 수학 기반 확산 레이어.

### 5. PDF/table multimodal retrieval pilot

기능:
- 기존 `document_extractions` 텍스트에서 retrieval unit을 생성.
- modality: `table`, `text`, `page_visual`.
- `page_visual`은 ColPali류 이미지 embedding을 붙일 자리로 placeholder 처리.
- DB 테이블: `document_retrieval_units`.

### 6. Active Learning Review Queue

기능:
- `priority = decisionImpact × uncertainty × evidenceGap × deadlineWeight`.
- 사람이 검토할 항목을 “결정에 미치는 영향” 기준으로 정렬.
- DB 테이블: `active_review_items`.

### 7. LLM 프롬프트 실제 연결

파일:
- `apps/api/src/consulting/consulting-memory-context.builder.ts`
- `apps/api/test/consulting-memory-context.builder.test.ts`

흐름:

```text
사용자 질문
→ ConsultingTopicResolver fanout
→ shared consulting brain GraphRAG recall
→ CRAG evidence sufficiency
→ Evidence-to-Decision v1 요약
→ Hermes/LLM 프롬프트 컨텍스트에 주입
→ LLM은 이 지시를 읽고 답변/보류/라벨링 수행
```

추가된 프롬프트 섹션:

```text
### Evidence-to-Decision v1
- claim_verdicts: supports=..., refutes=..., not_enough_info=...
- graph_diffusion: ppr_no_dep; cross_project diffusion 적용; top=...
- document_units: table=..., text=..., page_visual=...
- active_review_top: ...
- LLM 사용 지시: claim_verdicts가 refutes/not_enough_info이면 단정 금지; cross_project diffusion 항목은 참조 라벨을 붙이고 현재 범위 사실처럼 말하지 않는다.
```

## 측정 결과

명령:

```bash
pnpm --filter @consulting/api exec tsx scripts/evidence_to_decision_v1_metrics.ts
```

출력 요약:

```json
{
  "claim_verdict_summary": { "supports": 1, "refutes": 1, "notEnoughInfo": 1, "claimCount": 3 },
  "truth_queue_items": 1,
  "top_truth_priority": 1,
  "recommended_alternative": "ALT-STAFF",
  "decision_ranked": [
    { "id": "ALT-STAFF", "score": 0.7597, "action": "recommend", "coverage": 1 },
    { "id": "ALT-HOURS", "score": 0.6143, "action": "collect_more_evidence", "coverage": 0.6667 }
  ],
  "diffusion_method": "ppr_no_dep",
  "diffusion_top3": [
    { "id": "thread:current", "score": 0.4684 },
    { "id": "topic:budget", "score": 0.3656 },
    { "id": "project:benchmark", "score": 0.1375 }
  ],
  "document_units_by_modality": { "table": 1, "text": 1, "page_visual": 1 },
  "review_top": { "id": "RV-URGENT", "score": 1.026 }
}
```

## 검증 결과

GREEN:

```bash
pnpm --filter @consulting/api exec vitest run \
  test/evidence-to-decision.service.test.ts \
  test/consulting-memory-context.builder.test.ts \
  test/evidence-sufficiency-evaluator.test.ts \
  test/citation-post-check.service.test.ts \
  --reporter=dot
# 4 files / 14 tests passed

pnpm --filter @consulting/db-schema typecheck
pnpm --filter @consulting/api typecheck
# pass

pnpm --filter @consulting/db-schema build
pnpm --filter @consulting/api build
# pass

pnpm --filter @consulting/db-schema lint
pnpm --filter @consulting/api lint
# pass, only pre-existing MODULE_TYPELESS_PACKAGE_JSON warning

pnpm --filter @consulting/api test -- --reporter=dot
# 27 files / 101 tests passed
```

Local DB migration readback:

```text
active_review_items
claim_verification_verdicts
decision_scorecard_items
decision_scorecards
document_retrieval_units
truth_maintenance_queue
```

## 이번 구현으로 얻은 실익

1. **LLM이 그냥 검색 hit를 읽는 구조에서, 검증된 판단상태를 읽는 구조로 이동했다.**
   - `claim_verdicts`, `CRAG`, `cross_project diffusion`이 프롬프트에 명시됨.

2. **답변/보류 판단이 코드로 측정된다.**
   - `supports/refutes/notEnoughInfo`, evidence coverage, uncertainty, review priority가 수치화됨.

3. **보고서 stale 문제를 다룰 DB substrate가 생겼다.**
   - 변경 evidence → affected claims/artifacts queue.

4. **Leiden 이전의 no-dep 수학 레이어가 생겼다.**
   - PPR/heat-kernel로 관련 scope 확산을 실험 가능.

5. **PDF/table 멀티모달 검색으로 갈 연결점이 생겼다.**
   - 텍스트/table/page_visual retrieval unit 분리.

6. **사람 검토 시간을 어디에 쓸지 계산할 수 있다.**
   - decisionImpact × uncertainty × evidenceGap × deadlineWeight.

## 아직 부족한 점 / 다음 구현 순서

### P0 — 실제 저장/조회 API

현재 v1은 service + schema + prompt integration이다. 다음은 산출물을 실제 DB에 persist/read하는 API가 필요하다.

1. `EvidenceDecisionStore`
   - verdicts 저장
   - scorecards 저장
   - document units 저장
   - review queue 저장/상태변경

2. API routes
   - `GET /threads/:id/evidence-decision/summary`
   - `POST /threads/:id/decision-scorecards`
   - `GET /threads/:id/review-queue`
   - `PATCH /review-items/:id/status`

3. UI panel
   - 채팅 우측패널에 `근거검증 / 결정표 / 검토큐` 탭.

### P0 — post-answer verification loop

현재는 pre-answer prompt context 중심이다. 다음은 LLM 답변이 생성된 뒤:

```text
assistant answer
→ sentence/claim extraction
→ citation post-check
→ claim verdict persist
→ unsupported sentence badge / rewrite request
```

을 붙여야 한다.

### P1 — 외부 NLI / verifier model

현재 claim lattice는 `strict_json_local_nli_v1` deterministic verifier와 regression fixture까지 갖췄다. 외부 모델을 붙일 경우 다음 중 하나를 붙인다.

- local NLI cross-encoder
- LLM verifier with strict JSON
- hybrid: heuristic prefilter → NLI/LLM only on risky claims

### P1 — ColPali/Voyage document unit indexing

현재 `document_retrieval_units`는 생성 substrate다. 다음은:

- extraction worker가 업로드 후 unit 생성
- table chunk 검색
- page image/ColPali embedding 파일 경로/스토어 연결

### P1 — graph diffusion as recall ranking input

현재 diffusion은 prompt summary다. 다음은 GraphRAG fanout/ranking에 직접 반영한다.

```text
context_edges → PPR score → recallScopes weight → bridge.recallMany ranking
```

### P1 — active learning feedback loop

- review item resolve 결과를 label로 저장.
- verifier/scorecard threshold 보정.
- 반복적으로 사람이 본 항목에서 라벨링 함수 개선.

### P2 — causal/VOI/MCDA 고도화

- causal DAG / SCM
- Value of Information
- AHP/TOPSIS/PROMETHEE
- Dempster-Shafer evidence combination

## 주의

- 운영 `8088` 배포와 브라우저 QA는 완료. 푸시는 아직 안 함.
- local/prod DB에는 migration `0014`, `0015` 적용됨.
- `.hermes/plans/2026-07-07_beyond-rag-methods-research.md`는 연구 메모로 untracked 상태.
