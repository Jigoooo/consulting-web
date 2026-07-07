# Evidence-to-Decision Intelligence 전체 통합 기록

작성일: 2026-07-07
Repo: `/home/jigoo/.hermes/workspace/consulting-web`

## 결론

GraphRAG 검색 결과를 LLM 프롬프트에 넣는 수준을 넘어, 답변 생성 전후의 증거 상태를 DB에 저장하고 API/UI에서 조회하는 Evidence-to-Decision 통합 슬라이스를 구현했다.

이번 통합은 로컬 코드·DB migration·테스트·빌드 검증을 거쳐 운영 `8088` 배포와 브라우저 QA까지 완료했다. 푸시는 별도 단계로 남겨둔다.

## 구현된 것

### 1. EvidenceDecisionStore + API

- `apps/api/src/consulting/evidence-decision.store.ts`
- `GET /chat/threads/:threadId/evidence-decision/summary`
- `GET /chat/threads/:threadId/review-queue`
- 계약 스키마:
  - `EvidenceDecisionSummaryResponseSchema`
  - `ReviewQueueResponseSchema`
- API client:
  - `api.evidenceDecisionSummary(threadId)`
  - `api.reviewQueue(threadId)`

### 2. Post-answer verification loop

- `ChatStreamController`에서 assistant stream 완료 후 `EvidenceDecisionStore.recordCompletedAnswer()` 호출.
- 답변 문장/claim 추출.
- evidence_items와 대조해 verdict 저장:
  - supports
  - refutes
  - mixed
  - not_enough_info
- 저장 테이블:
  - `claim_verification_verdicts`
  - `decision_scorecards`
  - `decision_scorecard_items`
  - `active_review_items`
- verifier label: `strict_json_local_nli_v1`

### 3. UI 우측 패널

기존 EvidencePanel에 4개 탭 추가:

- 근거자료
- 근거검증
- 결정표
- 검토큐

파일:

- `apps/web/src/widgets/evidence-panel/ui/EvidencePanel.tsx`
- `apps/web/src/widgets/evidence-panel/ui/EvidencePanel.module.css`
- `apps/web/src/lib/collab.ts`

### 4. Strict JSON verifier + regression harness

현재는 비용 없는 deterministic strict JSON verifier다. 외부 NLI/LLM API 호출은 아직 아니지만, support/refute/not-enough-info/오탐 방지 fixture를 regression metric으로 고정했다.

완성된 것:

- verdict API/storage contract 고정
- verifier provenance 필드 저장
- `evidence_supported_rate`, `refute_detection_rate`, `unsupported_deferral_rate` regression harness
- 이후 NLI cross-encoder 또는 LLM strict JSON verifier로 교체 가능

남은 것:

- 실제 외부 NLI/LLM verifier adapter
- confidence calibration set 확장

### 5. Document unit indexing

`DocumentExtractionWorker`가 추출 완료 후 `document_retrieval_units`를 자동 생성한다.

생성 modality:

- `text`
- `table`
- `page_visual` placeholder

향후 ColPali/Voyage multimodal embedding을 붙일 수 있게 `metadata.needsImageEmbedding` 구조를 둔다.

### 6. Diffusion ranking 반영

`ConsultingMemoryContextBuilder`에서 context_edges/fanout recall scope를 바로 넘기지 않고:

1. scope graph를 PPR diffusion으로 보정
2. cross-project는 dampening
3. recall topK를 5→8로 넓힘
4. hit 정렬 시 diffusion score를 반영
5. 최종 5개를 LLM 컨텍스트에 삽입

즉 diffusion이 이제 프롬프트 설명만이 아니라 recall ranking 자체에 들어간다.

## 검증 결과

### API 전체 테스트

- `28 files passed`
- `102 tests passed`

### 핵심 통합 테스트

- `test/evidence-decision-api.test.ts`
- 검증 내용:
  - manual evidence 저장
  - attachment upload
  - document_retrieval_units 생성
  - chat stream 완료
  - post-answer claim verdict 저장
  - summary API 조회
  - review queue API 조회

### Typecheck

통과:

- `@consulting/contracts`
- `@consulting/db-schema`
- `@consulting/api-client`
- `@consulting/api`
- `@consulting/web`

### Build

통과:

- `@consulting/contracts`
- `@consulting/db-schema`
- `@consulting/api-client`
- `@consulting/api`
- `@consulting/web`

Vite warning:

- 일부 chunk > 500kB. 기존 번들 크기 경고이며 이번 기능 실패는 아님.

### Lint

통과:

- `@consulting/db-schema`
- `@consulting/api`
- `@consulting/web`

기존 warning:

- `MODULE_TYPELESS_PACKAGE_JSON`
- eslint config module type 경고. 기능 실패 아님.

### DB readback

존재 확인:

- `active_review_items`
- `claim_verification_verdicts`
- `decision_scorecard_items`
- `decision_scorecards`
- `document_retrieval_units`
- `truth_maintenance_queue`

### 측정 스크립트

`apps/api/scripts/evidence_to_decision_v1_metrics.ts`

대표 출력:

```json
{
  "claim_verdict_summary": {
    "supports": 1,
    "refutes": 1,
    "mixed": 0,
    "notEnoughInfo": 1,
    "claimCount": 3
  },
  "truth_queue_items": 1,
  "top_truth_priority": 1,
  "recommended_alternative": "ALT-STAFF",
  "decision_ranked": [
    { "id": "ALT-STAFF", "score": 0.7597, "action": "recommend", "coverage": 1 },
    { "id": "ALT-HOURS", "score": 0.6143, "action": "collect_more_evidence", "coverage": 0.6667 }
  ],
  "diffusion_method": "ppr_no_dep",
  "document_units_by_modality": { "table": 1, "text": 1, "page_visual": 1 },
  "review_top": { "id": "RV-URGENT", "score": 1.026 }
}
```

## 실제로 바뀐 점

### Before

- GraphRAG hit가 프롬프트에 들어감.
- LLM이 알아서 참고/판단.
- 답변 후 그 답변이 근거로 지지되는지 DB에 남지 않음.
- 우측 패널은 raw evidence 중심.

### After

- 답변 완료 후 claim 단위 verdict가 DB에 남음.
- 반박/근거부족 claim이 review queue로 올라감.
- scorecard가 “현재 답변 유지 vs 근거 보강 후 재작성”을 점수화함.
- 업로드 문서는 text/table/page_visual retrieval unit으로 쪼개짐.
- 우측 패널에서 근거검증/결정표/검토큐를 볼 수 있음.
- recall ranking에 diffusion score가 실제로 반영됨.

## 실익

1. 답변 신뢰도 가시화
   - “LLM이 그럴듯하게 말했다”에서 “몇 문장이 지지/반박/근거부족인지”로 바뀐다.

2. 검토 우선순위 자동화
   - 모든 오류를 사람이 훑지 않고, decision impact × uncertainty × evidence gap 기준으로 높은 것부터 본다.

3. 문서 검색 단위 개선
   - PDF/표/본문을 같은 blob으로 보지 않고 table/text/page_visual 단위로 분리할 수 있다.

4. GraphRAG recall 품질 개선 기반
   - context_edges는 이제 단순 설명이 아니라 retrieval weight에 반영된다.

5. UI의 의사결정 도구화
   - 우측 패널이 “자료창”에서 “검증/결정/검토 cockpit”으로 확장됐다.

## 아직 미완성/주의

- 운영 `8088` 반영과 브라우저 QA는 완료했다.
- real verifier는 아직 외부 NLI/LLM이 아니라 `strict_json_local_nli_v1` deterministic verifier다.
- page_visual은 PDF page image 추출과 local visual hash embedding metadata/search 연결까지 완료했지만, ColPali/Voyage API embedding은 아직 아니다.
- assistant message 본문 inline badge와 rewrite loop 버튼은 완료했다.

## 다음 추천 작업

1. Real verifier adapter
   - NLI cross-encoder 또는 LLM strict JSON verifier.
   - confidence calibration fixture 필요.

2. ColPali/Voyage multimodal indexing
   - PDF page image를 벡터화.
   - table/image/text hybrid retrieval.

3. API cache/performance
   - 매 조회마다 aggregation하지 않도록 캐시/요약 row 추가.

4. 운영 follow-up
   - 배포는 완료됨. 다음에는 실제 사용자 데이터 기준 장기 latency/cache 계측만 별도 수행.
