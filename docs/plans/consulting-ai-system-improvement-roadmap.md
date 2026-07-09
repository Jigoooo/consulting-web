# 컨설턴트용 AI 업무시스템 고도화 개선안

> 작성일: 2026-07-08
> 기준 문서: `consulting-layer-map.md`
> 목표: 현재 `consulting` shared brain + `consulting-web` 구조를 기준으로, 실제 운영에서 신뢰 가능한 컨설팅 AI 업무 OS로 고도화하기 위한 개선사항과 추가 가능한 고급 기술/알고리즘/수학/과학적 방법을 정리한다.

---

## 0. 한 줄 결론

현재 구조는 이미 단순 챗봇이 아니라 **Hermes Gateway + 웹 제품 레이어 + shared consulting brain + GraphRAG + NLI/Exactness/Judgment Guard + PG18 runtime path + feedback ingest**까지 고려된 꽤 좋은 구조다.

다만 지금 가장 큰 병목은 “기술 부족”보다 아래 7개다.

```text
1. PG18 문서상 상태와 live API runtime(`pg/pg`) 사이 불일치가 있음
2. 검증/근거/정확성/Judgment Guard 데이터가 실제 운영 DB에 거의 쌓이지 않음
3. RAG recall은 괜찮지만 precision이 낮음
4. scope binding이 project-level 중심이라 topic/thread 정밀도가 부족함
5. completed turn ingest와 memory write loop가 아직 실사용 정책/데이터 부족
6. LLM run-level observability / eval dashboard가 약함
7. tool/MCP 권한, prompt injection, PII, tenant isolation 같은 운영 보안 레이어가 더 필요함
```

가장 좋은 고도화 순서는 다음이다.

```text
R0. PG18 runtime truth reconciliation: live `pg/pg`를 승인/문서화/커밋할지, `dual`로 rollback할지 정리
P0. 검증 데이터 축적 / claim ledger / evidence ledger / judgment guard row activation
P1. RAG precision 개선 / rerank / retrieval failure dataset
P2. topic/thread scope binding 정밀화 / memory write policy
P3. observability + eval CI/CD + hallucination regression
P4. Evidence/Review/Trace 업무 UI + guided project setup QA hardening
P5. advanced retrieval / GraphRAG / causal analytics / artifact intelligence
P6. MCP/tool registry + security hardening + 제품화
```

## 0.1 2026-07-08 23:54 현재상태 갱신 — 최근 커밋/런타임 반영

최근 커밋과 live runtime을 재측정한 결과, 기존 계획의 현재상태와 우선순위를 아래처럼 수정한다.

```text
recent committed delta:
  5c8b9df feat: add consulting judgment guard
  acce5a7 feat(spaces): add guided project setup
  86ced82 / 32c6924 chat table copy UX
  6ce50c4 cached channel switching / scroll stability

live runtime delta:
  consulting-web-api-1 env:
    CONSULTING_BRAIN_BACKEND=pg
    CONSULTING_BRAIN_WRITE_BACKEND=pg
    CONSULTING_PG_DSN_DRIVER=psycopg
  PG18 sidecar:
    consulting-web-pg18-rehearsal-pg18-1 healthy
```

해석:

```text
1. web/API path는 PG18 runtime 사용까지 전진했다.
2. 그러나 Phase9 문서/워크로그는 PG-only live flip 보류를 말한다.
3. shared consulting brain 전체에는 아직 SQLite writer/reader 표면이 남아 있다.
4. 따라서 “완전 PG-only source-of-truth 완료”가 아니라 “web/API runtime PG path active, 전체 cutover 검증/문서 정합성 미완”으로 기록한다.
5. Judgment Guard와 guided project setup은 신규 계획 항목에서 제외하고, 운영 row activation / QA hardening으로 재분류한다.
```

최우선 수정:

```text
새 기능보다 먼저 R0 PG18 runtime truth reconciliation을 수행한다.
문서·git diff·live container env가 같은 상태를 말하게 만든 뒤 P0 검증 데이터 축적을 진행한다.
```

## 0.2 비동기 Fable 리뷰 반영 — blocker 보강

읽기 전용 독립 리뷰 결과, 아래 항목을 실행 계획의 hard gate로 승격한다.

```text
1. Memory Write Guard는 첫 write-path 코드 변경이다.
   - outbox payload를 allowedSegments[] / assistantCandidate / blockedSegments[]로 분리한다.
   - blocked assistant answer는 PG18 brain 및 rollback SQLite brain에 쓰지 않는다.

2. Workspace hard boundary는 P5 사후감사가 아니라 P0 schema gate다.
   - 모든 신규 table/side table은 workspace_id 또는 workspace lookup guard를 갖는다.
   - migration PR마다 cross-workspace negative test를 포함한다.

3. raw_document / candidate_evidence는 final authority가 아니다.
   - high-impact claim이 raw-only/candidate-only evidence만 갖는 경우 final_export는 block 또는 review_required다.

4. consulting-web과 shared consulting brain은 paired branch/worktree 전략으로 움직인다.
   - consulting-web만 clean worktree로 빼고 /brain/consulting bind mount를 dirty live repo에서 수정하는 조합은 금지한다.

5. P0 ledger는 공통 trace/run correlation을 갖는다.
   - claim/exactness/judgment/retrieval/memory/artifact gate row는 trace_id 또는 consulting_ai_run_id로 연결한다.

6. Leiden/RAPTOR/community detection은 P6 labs로 보류한다.
   - P2에서는 no-dependency component summary/cache까지만 허용한다.
```

## 0.3 2026-07-09 P6 baseline 갱신

```text
product baseline command:
  pnpm --filter @consulting/api run test:p6-product-baseline

current baseline:
  config = rw020-prune4-top1
  allowed = true
  context_precision = 0.8310
  context_recall = 0.9111
  hit_rate = 0.9111
  worst_p95_latency_s = 4.1768
  app PG trace/retrieval/eval ledger rows = 1/1/1
  leakage_count = 0
```

따라서 이 문서의 ColBERT/SPLADE/RAPTOR 관련 항목은 “당장 제품 기본값으로 넣기”가 아니라
`docs/plans/2026-07-09-colbert-splade-raptor-restart-plan.md` 기준의 read-only comparison lab으로 재개한다.

2026-07-09 SPLADE-lite read-only spike는 baseline 대비 precision/recall/hit 개선이 0.0000이라 HOLD다. 제품 경로는 변경하지 않았다.

2026-07-09 RAPTOR-lite read-only spike는 global-summary 질문에서 coverage_delta=-0.0333, precision_delta=-0.0197이라 HOLD다. 제품 경로는 변경하지 않았다.

---

## 1. 현재 구조 진단 요약

### 1.1 이미 잘 잡힌 부분

| 영역 | 현재 구조 | 평가 |
|---|---|---|
| Gateway | Hermes Gateway를 run/SSE/model/tool runtime으로 활용 | 좋음 |
| Web 제품화 | workspace/project/channel/topic/thread 구조 | 좋음 |
| Shared Brain | `consulting` repo를 `/brain/consulting`으로 bind mount | 좋음 |
| GraphRAG | dialogue/file semantic + lexical + graph recall | 좋음 |
| Fusion | cosine/BM25 직접합산 대신 RRF 사용 | 좋음 |
| Trust Tier | final/qualified/raw weight 분리 | 좋음 |
| Verification | Local NLI, optional strict JSON verifier | 방향 좋음 |
| Exactness | 계산/법령/DB/수치 단정 차단 구조 | 방향 좋음 |
| Feedback Loop | completed web turn을 brain으로 재주입 | 방향 좋음 |
| Artifact | artifact_versions/export gate 초기 구조 | 확장 가능 |

### 1.2 현재 가장 부족한 부분

2026-07-08 23:54 KST live App PG readback 기준 현재 운영 DB 상태는 다음과 같다.

```text
claim_verification_verdicts = 0
exactness_runs              = 0
judgment_guard_runs         = 0
evidence_items              = 2
consulting_topic_links_non_project = 0
outbox_events.published     = 176
```

즉 다음과 같이 해석해야 한다.

```text
검증/정확성/Judgment Guard 레이어는 설계·일부 구현되어 있음
그러나 운영 row가 아직 0이라 실제 답변/산출물 경로에서 충분히 작동한다고 볼 수 없음
따라서 현재는 “검증 가능한 구조”이지, “검증 데이터가 누적되어 학습·운영되는 시스템”은 아님
```

또한 GraphRAG 실측값은 다음 상태다.

```text
real embedding / raw=0.20:
  context_precision = 0.2881
  recall/hit        = 0.8667
  p95 latency       = 4.1242s
```

해석:

```text
recall은 좋다.
필요한 근거를 아예 못 찾는 문제는 상대적으로 작다.

precision은 낮다.
검색된 context 안에 불필요하거나 약한 근거가 많이 섞인다.

따라서 다음 병목은 retrieval recall이 아니라 retrieval precision이다.
```

---

## 2. 목표 아키텍처 v2

현재 구조를 크게 갈아엎지 않고, 아래 레이어를 추가한다.

```text
[Web UI]
- chat
- evidence panel
- artifact viewer
- review queue
- eval dashboard
- trace viewer
- memory approval UI

        ↓

[NestJS API]
- auth/scope tree
- chat stream proxy
- evidence API
- verifier API
- artifact API
- trace collector
- tool registry
- approval workflow

        ↓

[AI Orchestration]
- intent router
- retrieval planner
- query rewrite/decomposition
- hybrid retriever
- graph retriever
- reranker
- verifier node
- exactness node
- writer node
- reviewer node
- memory write policy

        ↓

[Durable Workflow]
- document ingest workflow
- graph build workflow
- research workflow
- report generation workflow
- artifact export workflow
- batch verification workflow
- human approval pause/resume

        ↓

[Knowledge Layer]
- SQLite brain currently
- FTS5 + embeddings + graph edges
- claim ledger
- evidence ledger
- source quality ledger
- provenance graph
- topic/thread binding
- memory quarantine
- future: Qdrant/pgvector/Neo4j optional

        ↓

[Verification Layer]
- NLI
- FActScore-style atomic fact verification
- AlignScore-style factual consistency
- citation coverage
- exactness gate
- source freshness policy
- contradiction graph

        ↓

[Observability/Eval]
- OpenTelemetry GenAI spans
- Phoenix or Langfuse
- RAGAS metrics
- Promptfoo/DeepEval regression
- retrieval failure dataset
- cost/token/latency dashboard

        ↓

[Security/Control]
- tool permission registry
- MCP gateway policy
- prompt injection defense
- PII redaction
- tenant/project isolation audit
- human approval
- audit log
```

---

## 3. 최우선 개선사항

## 3.1 Claim Ledger 추가

### 문제

현재는 claim verification 구조는 있지만 `claim_verification_verdicts`가 비어 있다. 컨설팅 시스템은 “답변 로그”보다 “주장 단위의 검증 장부”가 중요하다.

### 추가할 것

```text
claim_ledger
- id
- workspace_id
- project_id
- scope_id
- claim_text
- normalized_claim
- claim_type
  - factual
  - numeric
  - legal
  - causal
  - recommendation
  - assumption
  - forecast
- decision_impact
- source_status
  - supported
  - contradicted
  - mixed
  - insufficient
  - stale
- confidence
- valid_from
- valid_to
- created_from_message_id
- created_from_artifact_id
- latest_verification_run_id
- created_at
- updated_at
```

### 적용 흐름

```text
assistant answer
→ atomic claim extraction
→ claim normalization
→ duplicate claim matching
→ evidence retrieval
→ NLI / factual consistency check
→ claim_ledger upsert
→ final answer / artifact에 claim status 표시
```

### 기대 효과

```text
- 같은 주장을 매번 새로 검증하지 않아도 됨
- 보고서/제안서에서 근거 없는 문장을 자동 표시 가능
- 프로젝트가 진행될수록 검증된 지식이 쌓임
- hallucination regression dataset을 자동 생성 가능
```

---

## 3.2 Evidence Ledger / Evidence Promotion Pipeline

### 문제

현재 `raw_document`가 1,132개로 많고, `final_usable`과 `qualified_usable`은 상대적으로 적다. raw를 완전히 제거하면 recall이 죽고, raw를 너무 신뢰하면 precision이 떨어진다.

### 추가할 것

```text
raw_document
→ parsed_document
→ candidate_evidence
→ verified_evidence
→ qualified_usable
→ final_usable
```

### evidence 테이블 설계

```text
evidence_items
- id
- source_id
- chunk_id
- project_id
- evidence_text
- evidence_type
  - quote
  - table
  - calculation
  - law
  - interview
  - report
  - dataset
  - web
- utility_tier
  - raw_document
  - candidate_evidence
  - verified_evidence
  - qualified_usable
  - final_usable
- source_quality_score
- freshness_score
- extraction_confidence
- human_review_status
- usage_count
- contradiction_count
- promoted_by
- promoted_at
- created_at
```

### promotion 규칙

```text
candidate_evidence → verified_evidence:
- source가 식별됨
- chunk 위치/page/section 추적 가능
- 최소 1개 claim을 support/refute함
- NLI confidence가 기준 이상

verified_evidence → qualified_usable:
- 사람이 승인했거나
- 여러 claim에서 반복적으로 안정 사용됨
- contradiction_count가 낮음

qualified_usable → final_usable:
- 보고서/제안서/최종 artifact에 사용됨
- export gate를 통과함
- provenance가 완전함
```

---

## 3.3 Exactness Gate 실행 데이터 누적

### 문제

Exactness Gate는 설계되어 있지만 `exactness_runs = 0`이다. 수치/법령/DB/계산 관련 답변은 실제 run을 남겨야 한다.

### 추가할 것

```text
exactness_runs
- id
- run_id
- message_id
- project_id
- trigger_type
  - numeric
  - calculation
  - legal
  - database
  - page_quote
  - row_count
- required
- status
  - skipped
  - passed
  - blocked
  - warning
- checks_json
- calculation_engine
- input_values_json
- output_values_json
- error_reason
- created_at
```

### 고급 수학/계산 엔진

수치 검증은 JS floating number에 맡기지 말고 아래 중 하나로 고정한다.

```text
1. decimal / bigint rational arithmetic
2. Python decimal.Decimal
3. DuckDB SQL calculation
4. spreadsheet-like formula engine
5. symbolic math: SymPy for equation validation
```

### 추가 exactness check 종류

```text
- sum_equals_total
- percentage_change
- ratio_percent
- weighted_average
- CAGR
- YoY/MoM/QoQ
- table_row_count
- distinct_count
- groupby_sum
- budget_constraint_check
- legal_clause_quote_match
- page_number_quote_match
- date_range_overlap
- unit_consistency_check
```

---

## 3.3b Judgment Guard 운영 row activation

### 최근 커밋 반영

`5c8b9df feat: add consulting judgment guard`로 판단 안전 게이트의 기본 구조는 이미 추가됐다.

```text
추가/확인된 기반:
- ConsultingJudgmentGuardService
- judgment_guard_runs table / migration 0021
- verifier gate policy issue codes
- prompt safety rules
- regression tests
```

하지만 live App PG 기준 `judgment_guard_runs = 0`이므로, 아직 “운영에서 작동하는 판단 안전 레이어”로 보기는 어렵다.

### 수정된 계획

```text
기존 계획: Exactness / NLI verifier 중심
수정 계획: Exactness + NLI verifier + Judgment Guard row activation을 P0에 포함
```

### 우선 activation case

```text
1. source intake parse failure
2. latest authority required
3. applicability map required
4. comparator consistency required
5. counterargument / overclaim risk
6. user correction detected
```

### 완료 기준

```text
deterministic post-answer test가 judgment_guard_runs row를 생성한다.
summary/review/export 경로에서 해당 warning/blocker가 읽힌다.
운영 답변에서 row count가 0을 벗어난다.
```

---

## 3.4 Retrieval Failure Dataset

### 문제

현재 precision이 낮다. precision을 올리려면 단순히 weight를 감으로 조정하는 것이 아니라 실패 데이터를 모아야 한다.

### 추가할 것

```text
retrieval_runs
- id
- query
- query_type
- workspace_id
- project_id
- thread_id
- retrieval_mode
- top_k
- created_at

retrieval_hits
- id
- retrieval_run_id
- source_type
- source_id
- chunk_id
- rank_before_rerank
- rank_after_rerank
- score_semantic
- score_lexical
- score_graph
- score_rrf
- score_rerank
- utility_tier
- scope_relation
- selected_for_context
- judged_relevant
- failure_type
```

### failure_type 후보

```text
wrong_project
wrong_topic
wrong_phase
wrong_client
raw_over_selected
lexical_false_positive
semantic_false_positive
graph_over_fanout
stale_source
unsupported_claim
citation_missing
duplicate_chunk
too_generic_context
query_rewrite_error
reranker_error
```

### 운영 흐름

```text
질문 → retrieval → 답변 → verifier/human feedback
→ 관련 없는 hit 표시
→ retrieval_failure_dataset 저장
→ eval set 자동 반영
→ RRF/weight/reranker/query rewrite 튜닝
```

---

## 3.5 Topic/Thread-level Scope Binding

### 문제

현재 `consulting_topic_links`는 project-level 중심이다. 프로젝트가 커질수록 다른 phase/topic/thread의 근거가 섞여 precision이 떨어질 수 있다.

### 개선 방향

```text
현재:
project → consulting_topic_slug

개선:
project → channel → topic → thread → consulting_topic_slug/session
```

### 추가할 테이블/필드

```text
scope_bindings
- id
- workspace_id
- project_id
- channel_id
- topic_id
- thread_id
- external_source
  - web
  - telegram
  - discord
  - email
  - drive
- external_chat_id
- external_thread_id
- consulting_topic_slug
- consulting_session_id
- binding_level
  - project
  - channel
  - topic
  - thread
- confidence
- status
- verified_by
- verified_at
```

### 검색 우선순위

```text
1. thread exact binding
2. topic binding
3. channel binding
4. project binding
5. cross-project only if explicitly allowed
```

---

## 3.6 Memory Write Policy / Memory Quarantine

### 문제

completed turn ingest는 좋지만, assistant 답변을 무조건 brain에 저장하면 오염된다. 특히 unsupported claim, 임시 아이디어, 추정치가 장기기억으로 들어가면 위험하다.

### 개선 흐름

```text
assistant answer
→ claim extraction
→ evidence verification
→ memory write candidate 생성
→ policy filter
→ quarantine or approved memory
→ brain insert
```

### memory 상태

```text
memory_candidates
- pending
- approved
- rejected
- quarantined
- expired
```

### 자동 저장 가능

```text
- 사용자 원문 발화
- 업로드 문서 chunk
- tool 결과
- 출처가 명확한 claim
- 사람이 승인한 artifact
- 회의 결정사항
- 액션아이템
```

### 저장 금지/격리

```text
- verifier가 unsupported로 판정한 claim
- exactness blocked 답변
- 출처 없는 수치
- 임시 브레인스토밍
- cross-project 근거가 섞인 답변
- 민감정보/개인정보
- prompt injection 가능성이 있는 원문 명령
```

---

## 4. RAG / Retrieval 고도화 기술

## 4.1 현재 구조

현재 구조는 이미 아래를 포함한다.

```text
- dialogue semantic retrieval
- dialogue lexical retrieval
- dialogue graph retrieval
- file semantic retrieval
- file lexical retrieval
- file graph retrieval
- RRF fusion
- trust tier weighting
- optional rerank
```

이 구조는 좋다. 다음 고도화는 “더 많은 retrieval”이 아니라 **더 좋은 query planning, reranking, filtering, evidence scoring**이다.

---

## 4.2 Query Intent Classifier

### 추가 이유

모든 질문에 같은 RAG 전략을 쓰면 precision이 낮아진다.

### query_type 후보

```text
definition       = 개념 설명
fact_lookup      = 특정 사실/문장 검색
numeric          = 계산/수치
legal            = 법령/조항/원문
strategy         = 전략/컨설팅 판단
diagnosis        = 문제 진단
comparison       = 비교
summary_global   = 전체 문서/프로젝트 요약
artifact_write   = 보고서/제안서 작성
memory_lookup    = 이전 결정/회의 내용 검색
action_execution = 도구/업무 실행
```

### query_type별 retrieval 정책

| query_type | 우선 검색 | 추가 처리 |
|---|---|---|
| fact_lookup | lexical + exact code + rerank | citation 필수 |
| numeric | DB/table/calculation | Exactness Gate 필수 |
| legal | lexical + page quote | 원문 quote/page 필수 |
| strategy | graph + qualified evidence | claim 검증 필수 |
| summary_global | GraphRAG community summary / RAPTOR | 전체 요약 |
| memory_lookup | thread/topic binding + graph | memory freshness |
| artifact_write | claim ledger + evidence ledger | export gate |

---

## 4.3 Query Decomposition

복합 질문을 여러 sub-question으로 나눈다.

```text
질문: “창원 조직진단에서 정원, 승진, 재정 부담을 근거 포함해서 보고서식으로 정리해줘”

분해:
1. 정원 관련 핵심 claim과 근거는?
2. 승진 관련 핵심 claim과 근거는?
3. 재정 부담 관련 수치/근거는?
4. 세 claim 간 관계/우선순위는?
5. 보고서 문장으로 쓸 수 있는 verified evidence는?
```

효과:

```text
- 긴 질문에서 근거 누락 감소
- 각 sub-query별 검색 전략 분리 가능
- verifier가 claim별로 판단 가능
```

---

## 4.4 RAG-Fusion / Multi-Query + RRF

### 개념

하나의 query만 검색하지 않고 LLM이 여러 변형 query를 만든 뒤, 각 query 결과를 RRF로 합친다.

```text
original query
→ query variants 3~8개 생성
→ 각 query로 semantic/lexical/graph 검색
→ RRF fusion
→ rerank
```

### 적용 위치

현재 이미 RRF가 있으므로 추가가 쉽다.

```text
현재:
query 1개 → semantic/lexical/graph → RRF

개선:
query N개 → semantic/lexical/graph → per-query RRF → global RRF
```

### 주의

```text
- query가 너무 많으면 latency 증가
- report/final_export에서는 source precision이 더 중요
- top-level router가 필요한 경우에만 활성화
```

---

## 4.5 HyDE

### 개념

질문에 대한 가상의 답변/문서를 먼저 생성하고, 그 가상 문서를 embedding해서 검색한다.

```text
query
→ hypothetical answer/document 생성
→ hypothetical document embedding
→ vector search
→ 실제 문서 검색
```

### 언제 좋나

```text
- 사용자의 질문이 짧거나 애매할 때
- 키워드가 부족할 때
- semantic gap이 클 때
- 내부 문서 용어와 사용자 표현이 다를 때
```

### 우리 시스템 적용

```text
if query_terms < 3 or EvidenceSufficiency = insufficient:
  HyDE query 생성
  semantic search 추가
  raw_document는 낮은 weight 유지
  rerank 필수
```

### 주의

HyDE가 만든 가상 문서를 답변 근거로 쓰면 안 된다. 검색용 query expansion으로만 사용한다.

---

## 4.6 Cross-Encoder Reranker 기본 활성화

### 문제

현재 bridge는 `--rerank`를 붙이지만, 운영상 항상 정확히 켜지는지와 실패 시 fallback 품질을 trace로 봐야 한다.

### 개선

```text
recall topK = 30~50
→ RRF fusion
→ cross-encoder reranker top 10
→ diversity/MMR filter
→ final context top 3~7
```

### 추천 모델 계열

```text
- BGE reranker 계열
- cross-encoder/ms-marco 계열
- multilingual reranker
- domain-specific reranker fine-tune
```

---

## 4.7 Late Interaction Retrieval: ColBERT / ColPali / ColQwen 계열

### 왜 필요한가

일반 embedding은 문서 전체를 하나의 벡터로 압축한다. late interaction은 query token과 document token 간 fine-grained matching을 남겨 lexical/semantic 균형이 좋다.

### 적용 후보

```text
- ColBERT: text passage retrieval
- ColPali: PDF page/image-like document retrieval
- ColQwen: multimodal/vision-language late interaction 계열
```

### 우리 시스템 적용 위치

```text
PDF/보고서/표가 많은 컨설팅 자료
→ 기존 chunk embedding + FTS5
→ page-level late interaction index 추가
→ exact page evidence 검색 강화
```

### 성숙도

```text
실험~고급형
문서량이 커지고 PDF page-level 검색 품질이 중요해질 때 적용
```

---

## 4.8 SPLADE / Neural Sparse Retrieval

### 왜 필요한가

BM25는 단어가 정확히 맞아야 강하고, dense embedding은 수치/코드/고유명사에서 흔들릴 수 있다. SPLADE는 sparse representation을 학습해서 lexical + semantic expansion을 동시에 노린다.

### 적용 위치

```text
현재 FTS5/BM25
→ 추가 sparse vector field
→ SPLADE sparse retrieval
→ BM25 + SPLADE + dense + graph RRF
```

### 효과

```text
- 고유명사/약어/유사 표현 대응 향상
- dense false positive 감소 가능
- inverted index 기반이라 운영 친화적
```

---

## 4.9 MMR / Diversity Filter

### 문제

RAG top-k가 서로 비슷한 chunk로 채워지면 답변 근거가 편향된다.

### Maximal Marginal Relevance

```text
MMR(d_i) = λ * Sim(query, d_i) - (1 - λ) * max Sim(d_i, selected_j)
```

추천:

```text
λ = 0.65~0.8
final context top 5 중 같은 문서/같은 페이지 중복 제한
```

### 적용

```text
rerank top 15
→ MMR diversity filter
→ source tier/freshness filter
→ final top 5
```

---

## 4.10 Dynamic Context Budget

현재 final hit는 최대 5개다. 질문 유형에 따라 context 수를 다르게 해야 한다.

```text
fact_lookup:      3~5 chunks
numeric/legal:    2~4 chunks + exact check
strategy:         5~8 chunks
summary_global:   community summary + 5 chunks
artifact_write:   section별 3~5 chunks
```

토큰 예산도 run마다 남긴다.

```text
context_token_budget
used_context_tokens
answer_token_budget
retrieval_latency_ms
rerank_latency_ms
model_latency_ms
```

---

## 5. GraphRAG / Knowledge Graph 고도화

## 5.1 GraphRAG Community Summary

### 현재

대화/문서 edge graph는 있지만, global question에 특화된 community summary layer는 명확하지 않다.

### 추가

```text
entity/relation extraction
→ graph build
→ community detection
→ community summary 생성
→ global question 시 community answers 생성
→ final synthesis
```

### 언제 쓰나

```text
- “이 프로젝트의 핵심 이슈는?”
- “전체 인터뷰에서 반복되는 문제는?”
- “이 고객사의 조직진단 구조를 요약해줘”
- “시장/경쟁/규제/고객 니즈를 전체적으로 정리해줘”
```

---

## 5.2 Leiden Community Detection

### 왜 Leiden인가

Louvain은 큰 그래프에서 disconnected community가 생길 수 있다. Leiden은 community 연결성을 보장하는 개선 알고리즘이다.

### 적용

```text
context_edges + dialogue_edges + file_edges
→ weighted graph
→ Leiden community detection
→ community_id 부여
→ community summary 생성
→ project issue map 생성
```

### 그래프 weight 예시

```text
same_project edge = 1.0
same_thread edge  = 1.2
same_claim edge   = 1.5
supports edge     = 1.3
contradicts edge  = 1.1
cross_project     = 0.4~0.6
stale edge        = 0.2
```

---

## 5.3 HippoRAG / Personalized PageRank Memory Retrieval

### 개념

LLM + Knowledge Graph + Personalized PageRank를 결합해서 인간 장기기억처럼 연관 근거를 활성화한다.

### 우리 시스템 적용

현재 context graph에 PPR diffusion이 있으므로, HippoRAG식으로 발전시키기 좋다.

```text
query entities
→ seed nodes 설정
→ Personalized PageRank
→ 관련 claim/evidence/source/community 활성화
→ vector/lexical retrieval과 fusion
```

### 적용하면 좋은 질문

```text
- 이 이슈와 연결된 과거 결정은?
- 이 근거와 충돌하는 자료가 있었나?
- 이 권고안이 영향을 주는 KPI/부서/리스크는?
- 비슷한 프로젝트에서 어떤 결론이 있었나?
```

---

## 5.4 LightRAG 스타일 Incremental Graph

### 문제

Microsoft GraphRAG식 full indexing은 무겁다. 현재처럼 대화와 문서가 계속 들어오는 시스템은 incremental update가 중요하다.

### 개선

```text
new document / completed turn
→ entity/relation extraction
→ local graph update
→ affected community만 재요약
→ global summary 전체 재생성 최소화
```

### 적용 추천

```text
- 일반 운영: LightRAG-style incremental KG
- 월간/보고서 전: full GraphRAG batch rebuild
```

---

## 5.5 Contradiction Graph

컨설팅에서는 서로 충돌하는 근거가 매우 중요하다.

```text
Claim A: 정원 증원이 필요하다
Claim B: 현재 정원 내 재배치로 충분하다
→ CONTRADICTS edge
```

추가 edge:

```text
SUPPORTS
REFUTES
QUALIFIES
DEPENDS_ON
ASSUMES
DERIVED_FROM
SUPERSEDES
STALE_AFTER
```

효과:

```text
- 보고서에서 반대근거 자동 표시
- decision risk score 계산 가능
- “근거가 갈리는 쟁점”을 리뷰 큐로 보낼 수 있음
```

---

## 5.6 Temporal Knowledge Graph

claim/evidence는 시간이 중요하다.

```text
valid_from
valid_to
observed_at
published_at
collected_at
superseded_by
```

검색 시 time-aware score:

```text
score_final = retrieval_score * freshness_weight * validity_weight
```

freshness 예시:

```text
freshness_weight = exp(-λ * age_days)
```

단, 법령/조직도/계약서처럼 시점이 중요한 자료는 “최신성”보다 “해당 시점 유효성”이 더 중요하다.

---

## 6. Long Document / Document Intelligence

## 6.1 RAPTOR Hierarchical Retrieval

### 문제

현재 chunk 기반 retrieval은 긴 보고서의 전체 구조를 놓칠 수 있다.

### RAPTOR식 구조

```text
chunk
→ embedding
→ clustering
→ cluster summary
→ summary embedding
→ upper-level clustering
→ tree 생성
```

### 검색

```text
query
→ leaf chunk + summary node 동시 검색
→ 전체 맥락 + 세부 근거 함께 제공
```

### 적용 대상

```text
- 긴 PDF 보고서
- 회의록 묶음
- 인터뷰 20개 이상
- 법령/조례/계약 문서
- 시장조사 자료 묶음
```

---

## 6.2 Document Parser 고도화

현재 PDF/문서가 많아질수록 parser 품질이 RAG 품질을 결정한다.

### 후보

| 도구 | 용도 | 적용 포인트 |
|---|---|---|
| Docling | PDF/DOCX/PPTX/XLSX/HTML 등을 Markdown/JSON으로 구조화 | enterprise 문서 전처리 |
| Unstructured | 다양한 문서 ingestion/pre-processing | 범용 ingestion |
| Marker | PDF/image/PPTX/DOCX/XLSX → Markdown/JSON/chunks/HTML | 표/수식/레이아웃 보존 |
| MinerU | OCR, table/formula recognition, reading order JSON | 복잡한 PDF/스캔 문서 |

### 추가 저장 필드

```text
document_elements
- id
- document_id
- page
- element_type
  - paragraph
  - title
  - table
  - figure
  - formula
  - footnote
  - header
  - footer
- bbox
- reading_order
- text
- html
- markdown
- image_path
- extraction_confidence
```

### 효과

```text
- 표/수치 검증 정확도 증가
- page quote/citation 개선
- PDF 근거 패널 품질 증가
- artifact export 시 원문 추적 가능
```

---

## 6.3 Multimodal Document Understanding

컨설팅 자료에는 그래프, 표, 조직도, 프로세스 다이어그램이 많다.

### 추가 기술

```text
- chart/table extraction
- image captioning for figures
- OCR + layout detection
- table-to-HTML/CSV 변환
- figure-to-structured-text 변환
- page screenshot evidence linking
```

### 적용 흐름

```text
PDF page
→ layout detection
→ text/table/figure 분리
→ table은 structured table로 저장
→ figure는 caption + image embedding 저장
→ chart 수치 추출은 human review 필수
```

---

## 7. Verification / Factuality 고도화

## 7.1 FActScore 스타일 Atomic Fact Verification

### 개념

긴 답변을 atomic fact로 쪼개고, 각 fact가 근거에 의해 support되는지 계산한다.

### 적용

```text
artifact draft
→ sentence split
→ atomic claim split
→ evidence retrieval
→ NLI/LLM judge
→ supported ratio 계산
→ unsupported high-impact claim block
```

### 지표

```text
artifact_fact_score = supported_atomic_facts / total_atomic_facts
```

추천 gate:

```text
general_chat: warning only
analysis_draft: supported ratio 0.65 미만 warning
report_decision: 0.75 미만 block or review
final_export: 0.85 미만 block
```

---

## 7.2 AlignScore / TRUE 스타일 Factual Consistency

현재 local NLI가 term-overlap-contradiction 기반이다. 빠르고 안전하지만 한계가 있다.

### 개선안

```text
1차: local heuristic NLI
2차: multilingual NLI model
3차: AlignScore-style alignment model
4차: strict JSON LLM verifier
5차: human review
```

### 모델/방식

```text
- mDeBERTa / XLM-R based NLI
- sentence-pair entailment classifier
- retrieval-grounded QA consistency
- AlignScore-style claim/context alignment
- LLM strict JSON verifier with schema validation
```

---

## 7.3 Citation Coverage Gate

답변에 citation이 있는지만 보면 부족하다. claim과 citation이 연결되어야 한다.

```text
claim_id → evidence_id → source_id → chunk_id → page/section
```

### gate 규칙

```text
if high_impact_claim and no evidence:
  block

if citation exists but evidence does not entail claim:
  block

if source is raw_document and claim is high impact:
  warning or review

if source is stale:
  warning or block depending on claim type
```

---

## 7.4 Source Freshness / Staleness Policy

### source_type별 freshness 규칙

| source_type | freshness 기준 |
|---|---|
| 법령/규정 | 최신 개정일 확인 필수 |
| 조직도/인력현황 | 수집일/기준일 필수 |
| 시장자료 | 6~12개월 이상이면 stale warning |
| 회의록 | 회의일 기준 유효 |
| 계약/제안서 | 버전/서명/확정 여부 필수 |
| 웹자료 | collected_at + published_at 둘 다 저장 |

### 추가 필드

```text
source_freshness
- source_id
- published_at
- collected_at
- effective_date
- expires_at
- superseded_by
- freshness_score
- freshness_policy
```

---

## 8. Observability / Evaluation / CI-CD

## 8.1 LLM Run-level Tracing

### 문제

현재 로그와 eval scripts는 있지만, run 단위로 “왜 이런 답변이 나왔는지”를 보는 dashboard가 필요하다.

### trace 구조

```text
run
├─ auth/scope check
├─ intent classification
├─ query rewrite
├─ scope fanout
├─ retrieval_dialogue_semantic
├─ retrieval_dialogue_lexical
├─ retrieval_file_semantic
├─ retrieval_file_lexical
├─ graph_walk
├─ RRF fusion
├─ rerank
├─ context injection
├─ Hermes run
├─ claim extraction
├─ NLI verification
├─ exactness gate
├─ artifact/export gate
└─ memory write policy
```

### 도구 후보

```text
- Phoenix
- Langfuse
- MLflow GenAI
- OpenTelemetry GenAI semantic conventions
```

---

## 8.2 RAGAS / Retrieval Metrics

### 필수 지표

```text
context_precision
context_recall
faithfulness
answer_relevancy
citation_correctness
context_entity_recall
retrieval_latency_p95
verifier_block_rate
unsupported_claim_rate
```

### retrieval metric 추가

```text
Recall@K
Precision@K
MRR
NDCG@K
Hit Rate
Mean Reciprocal Rank
```

### 운영 목표

```text
현재:
context_precision = 0.2881
recall/hit        = 0.8667

1차 목표:
context_precision >= 0.45
recall/hit        >= 0.80

2차 목표:
context_precision >= 0.60
recall/hit        = 0.75~0.85
```

---

## 8.3 Promptfoo / DeepEval / MLflow Regression

### 적용

```text
- prompt 변경 시 regression eval
- retrieval weight 변경 시 RAG eval
- model 변경 시 answer quality eval
- artifact export policy 변경 시 block/pass eval
- tool permission 변경 시 security eval
```

### eval case 예시

```yaml
- id: changwon-staffing-001
  query: "창원 조직진단에서 정원 관련 핵심 근거는?"
  expected_claims:
    - "정원 관련 이슈가 존재한다"
  required_sources:
    - "..."
  forbidden:
    - "근거 없는 수치 단정"
  metrics:
    - context_precision
    - citation_correctness
    - unsupported_claim_rate
```

---

## 8.4 Human Feedback Dataset

UI에 아래 버튼을 둔다.

```text
- 근거가 맞음
- 근거가 약함
- 다른 프로젝트 근거가 섞임
- 수치가 틀림
- 답변이 너무 일반적임
- 보고서에 사용 가능
- 보고서에 사용 불가
```

이 피드백은 다음 데이터로 변환한다.

```text
- retrieval relevance label
- claim verification label
- answer quality label
- artifact readiness label
- memory write approval label
```

---

## 9. Workflow / Agent 고도화

## 9.1 LangGraph-style State Machine

### 왜 필요한가

컨설팅 업무는 단발 Q&A가 아니라 상태가 있는 흐름이다.

```text
질문 → 검색 → 분석 → 검증 → 보고서 → 리뷰 → 수정 → 저장
```

### 추천 노드

```text
IntentRouter
→ TaskPlanner
→ RetrievalPlanner
→ ScopeResolver
→ Retriever
→ Reranker
→ EvidenceEvaluator
→ Analyzer
→ ClaimExtractor
→ Verifier
→ ExactnessChecker
→ Writer
→ Reviewer
→ MemoryDecider
→ FinalResponder
```

### 상태 예시

```ts
type ConsultingRunState = {
  query: string;
  queryType: QueryType;
  scope: ScopeContext;
  subQuestions: string[];
  retrievalHits: RetrievalHit[];
  selectedEvidence: Evidence[];
  claims: Claim[];
  verification: VerificationResult[];
  exactness: ExactnessResult[];
  draft: string;
  final: string;
  memoryCandidates: MemoryCandidate[];
  requiresHumanReview: boolean;
};
```

---

## 9.2 Temporal-style Durable Workflow

### 현재 BullMQ의 역할

BullMQ는 큐 처리에는 좋다. 하지만 장기 업무, 중단/재개, 사람 승인 대기, 단계별 재시도에는 durable workflow가 더 적합하다.

### Temporal로 빼면 좋은 작업

```text
- bulk document ingestion
- embedding backfill
- graph rebuild
- community summary rebuild
- web research job
- report generation job
- artifact export job
- batch verification job
- scheduled evaluation
```

### workflow 예시

```text
ReportGenerationWorkflow
1. load project scope
2. collect relevant claims
3. retrieve evidence
4. generate outline
5. section draft
6. claim extraction
7. verification
8. exactness check
9. human review wait
10. final export
11. memory write
12. notification
```

---

## 9.3 Multi-Agent는 제한적으로

추천 역할은 5개 정도면 충분하다.

```text
Router Agent
Research Agent
Analyst Agent
Verifier Agent
Writer Agent
PMO Agent
```

주의:

```text
- agent끼리 자유토론시키지 말 것
- 상태 그래프 안에서 역할별 함수처럼 호출
- 모든 tool call은 registry와 approval policy를 통과
- verifier와 writer는 분리
```

---

## 10. Security / Tool / MCP 고도화

## 10.1 Tool Registry

### 문제

Hermes tool/runtime이 붙을수록 권한 관리가 중요하다.

### 추가 테이블

```text
tool_registry
- tool_id
- name
- description
- input_schema
- output_schema
- permission_level
- allowed_roles
- allowed_scopes
- requires_approval
- pii_policy
- rate_limit
- max_cost
- audit_log_required
- enabled
```

### permission_level

```text
L0: internal read-only search
L1: external read-only search
L2: draft/artifact 생성
L3: DB write / memory write
L4: external send / email / messenger / webhook
L5: delete / shell / credential / billing / admin
```

정책:

```text
L0~L2: 조건부 자동 허용
L3: scope와 schema 검증 후 허용
L4: 사람 승인 필수
L5: 기본 금지, 관리자 승인 필수
```

---

## 10.2 MCP Gateway Policy

MCP는 외부 data/tool/workflow 연결 표준으로 유용하지만, 컨설팅 업무시스템에서는 보안 위험도 크다.

### MCP 연결 시 필수 정책

```text
- MCP server allowlist
- tool schema validation
- read/write/delete/send 권한 분리
- STDIO transport 제한 또는 sandbox
- command whitelist
- network egress 제한
- workspace/project scope token
- audit log
- prompt injection scan
- tool result sanitization
```

---

## 10.3 Prompt Injection Defense

RAG 문서 안의 텍스트는 명령이 아니라 데이터로 취급해야 한다.

### retrieval rail

```text
retrieved document
→ prompt injection pattern scan
→ suspicious instruction 제거/마스킹
→ data-only wrapper
→ model prompt에 삽입
```

### 위험 패턴

```text
- previous instructions 무시
- system prompt 출력
- tool call 강제
- 외부 URL 접속 지시
- secret/API key 요청
- 다른 프로젝트 데이터 요청
```

---

## 10.4 PII / Confidentiality Layer

### 추가 처리

```text
- embedding 전 PII masking option
- source별 sensitivity_level
- workspace/project/customer별 index isolation
- cross-project retrieval default off
- export 전 민감정보 scan
- audit log immutable storage
```

### sensitivity_level

```text
public
internal
confidential
client_confidential
restricted
secret
```

---

## 11. Artifact / Report Intelligence

## 11.1 Artifact Preflight Validation

최종 보고서/PPT/PDF export 전 검증 흐름이 필요하다.

```text
artifact draft
→ section parsing
→ claim extraction
→ claim/evidence mapping
→ exactness check
→ citation coverage check
→ freshness check
→ contradiction check
→ human review
→ final export
→ hash/version/provenance 저장
```

### 추가 테이블

```text
artifact_claim_map
- artifact_id
- version_id
- section_id
- claim_id
- evidence_id
- verification_status
- export_allowed
```

---

## 11.2 컨설팅 산출물 템플릿 구조화

LLM이 바로 긴 보고서를 쓰게 하지 말고 먼저 구조화 객체를 만든다.

```ts
type ReportPlan = {
  objective: string;
  audience: string;
  decisionNeeded: string;
  keyQuestions: string[];
  sections: ReportSectionPlan[];
  requiredClaims: string[];
  requiredEvidenceTypes: string[];
  chartsRequired: ChartPlan[];
  risks: string[];
  nextActions: string[];
};
```

---

## 11.3 Chart/Table 자동 생성 검증

보고서에 들어가는 차트는 근거 테이블과 연결되어야 한다.

```text
data_table
→ chart_spec
→ generated_chart
→ chart_claims
→ exactness check
→ artifact insert
```

추천 schema:

```text
chart_spec
- chart_type
- x_field
- y_field
- group_by
- aggregation
- source_table_id
- source_query
- generated_at
```

---

## 12. 컨설팅 도메인에 추가하면 좋은 수학/과학/분석 기술

## 12.1 Causal Inference

### 왜 필요한가

컨설팅에서는 “A 때문에 B가 개선된다”는 주장이 많다. 이건 단순 상관관계가 아니라 인과 추론 문제다.

### 적용 기술

```text
- DAG / causal graph
- backdoor adjustment
- propensity score matching
- difference-in-differences
- synthetic control
- double machine learning
- causal forest
- heterogeneous treatment effect
```

### 적용 예시

```text
- 조직개편이 민원 처리시간을 줄였는가?
- 교육 도입이 생산성을 올렸는가?
- 신규 시스템 도입이 비용 절감에 기여했는가?
- 특정 부서에만 개선 효과가 큰가?
```

### 시스템화

```text
claim_type = causal
→ confounder 후보 추출
→ 필요한 데이터 목록 생성
→ causal method 추천
→ 단정 대신 “인과로 보기 위한 조건” 출력
```

---

## 12.2 Bayesian Evidence Updating

### 왜 필요한가

컨설팅 판단은 근거가 늘어날수록 confidence가 바뀐다.

### 적용

```text
prior belief
→ evidence likelihood
→ posterior confidence
```

간단한 형태:

```text
posterior_odds = prior_odds * likelihood_ratio
```

사용 예:

```text
- 초기 가설 confidence
- 인터뷰 근거 추가
- 문서 근거 추가
- 반대 근거 발견
- 최종 recommendation confidence 업데이트
```

---

## 12.3 Monte Carlo Simulation

### 적용 대상

```text
- 비용 절감 추정
- 인력 수요 예측
- 일정 리스크
- 예산 초과 확률
- 투자 대비 효과
```

### 예시

```text
input distributions:
- 처리량 증가율: Normal(10%, 3%)
- 인건비 단가: Triangular(min, mode, max)
- 도입비용: LogNormal(...)

simulate 10,000 runs
→ expected ROI
→ P(ROI < 0)
→ P(cost overrun > 20%)
```

---

## 12.4 MCDA: AHP / TOPSIS / Weighted Scoring

### 왜 필요한가

컨설팅에서는 대안을 비교해야 한다.

```text
대안 A: 시스템 구축
대안 B: 프로세스 개선
대안 C: 인력 증원
```

### 적용 기술

```text
- AHP: pairwise comparison으로 기준 가중치 도출
- TOPSIS: 이상점과 최악점 거리 기반 대안 순위
- weighted scoring: 단순 가중합
- sensitivity analysis: 가중치 변화에 따른 순위 안정성
```

### 시스템화

```text
recommendation alternatives
→ criteria extraction
→ weight assignment
→ score table
→ sensitivity analysis
→ decision memo 생성
```

---

## 12.5 Optimization / Operations Research

### 적용 대상

```text
- 인력 배치
- 예산 배분
- 프로젝트 우선순위
- 일정 계획
- 자원 제약 하 실행계획
```

### 기술

```text
- Linear Programming
- Mixed Integer Linear Programming
- Constraint Programming
- Knapsack optimization
- Assignment problem
- Network flow
```

### 예시

```text
maximize expected_impact
subject to:
  budget <= B
  headcount <= H
  mandatory_projects included
  risk_score <= R
```

---

## 12.6 Network Analysis for Organization Diagnosis

### 적용 대상

```text
- 조직 내 병목 부서
- 의사결정 허브
- 커뮤니케이션 단절
- 업무 의존성
- 이해관계자 영향력
```

### 지표

```text
- degree centrality
- betweenness centrality
- eigenvector centrality
- PageRank
- community detection
- bridge node detection
- structural hole
```

### 시스템화

```text
interview/entity graph
→ department/person/process graph
→ centrality 계산
→ 병목/허브/단절 후보 표시
```

---

## 12.7 Scenario Planning / Sensitivity Analysis

컨설팅 권고안은 하나의 예측값보다 시나리오가 중요하다.

```text
base case
best case
worst case
stress case
```

각 시나리오에 대해:

```text
- assumptions
- expected impact
- risk
- required action
- leading indicators
- trigger points
```

---

## 13. 추가 DB/Schema 제안 종합

```text
claim_ledger
claim_evidence_links
evidence_items
source_quality_scores
source_freshness
retrieval_runs
retrieval_hits
verification_runs
exactness_runs
artifact_claim_map
memory_candidates
memory_policy_decisions
tool_registry
tool_invocations
approval_requests
eval_cases
eval_runs
eval_scores
trace_spans
scope_bindings
provenance_edges
contradiction_edges
community_summaries
document_elements
chart_specs
causal_hypotheses
decision_alternatives
scenario_assumptions
```

---

## 14. UI 개선 제안

## 14.1 Evidence Panel

```text
- 답변의 claim 목록
- claim별 support/refute/insufficient 상태
- evidence 원문 보기
- source tier 표시
- freshness 표시
- page/section 표시
- “보고서에 사용 가능” 승인 버튼
```

## 14.2 Review Queue

```text
- high-impact unsupported claim
- exactness blocked answer
- stale source
- cross-project evidence
- citation mismatch
- tool approval request
- memory write approval
```

## 14.3 Trace Viewer

```text
- query rewrite
- retrieval hits
- RRF score
- rerank score
- selected context
- model input/output
- verifier result
- exactness result
- memory write result
```

## 14.4 Evaluation Dashboard

```text
- context_precision trend
- recall trend
- unsupported_claim_rate
- exactness_block_rate
- artifact_export_block_rate
- average latency
- token cost
- top failure types
```

---

## 15. 구현 우선순위 Backlog

## R0. PG18 runtime truth reconciliation

```text
[ ] live API env(`CONSULTING_BRAIN_BACKEND`, `CONSULTING_BRAIN_WRITE_BACKEND`) 재측정
[ ] Phase8/9 문서·worklog와 현재 `pg/pg` runtime 불일치 해소
[ ] `pg/pg` controlled cutover로 인정할지, `dual` rollback할지 결정
[ ] 선택한 상태로 compose/code/docs/git diff 정리
[ ] API health + direct PG recall + outbox ingest + rollback smoke 확인
```

## P0. 바로 해야 할 것

```text
[ ] Memory Write Guard: allowedSegments[] / assistantCandidate / blockedSegments[] payload 분리
[ ] P0 schema 공통 gate: workspace_id + trace_id/consulting_ai_run_id + cross-workspace negative test
[ ] claim_ledger 추가
[ ] evidence_items 자동 생성/연결
[ ] exactness_runs 저장
[ ] judgment_guard_runs 저장/노출
[ ] retrieval_runs/retrieval_hits 저장
[ ] 모든 답변에 claim extraction 적용
[ ] final_export에서 citation/exactness/raw-only evidence blocker 실제 연결
[ ] memory write candidate/quarantine 정책 추가
[ ] thread/topic binding 테이블 보강
```

## P1. RAG 품질 개선

```text
[ ] query_type classifier
[ ] query decomposition
[ ] multi-query RAG-Fusion
[ ] reranker 항상 trace에 기록
[ ] RRF 전/후/rerank 전/후 score 저장
[ ] MMR diversity filter
[ ] source tier별 retrieval budget
[ ] context top-k dynamic policy
[ ] retrieval failure labels UI
```

## P2. Graph/Memory 개선

```text
[ ] contradiction graph
[ ] claim-source provenance graph
[ ] Leiden community detection batch
[ ] community summaries
[ ] HippoRAG/PPR seed retrieval
[ ] LightRAG-style incremental graph update
[ ] temporal validity/freshness scoring
```

## P3. Eval/Observability

```text
[ ] local trace_spans 먼저 도입
[ ] Phoenix or Langfuse는 명시 승인 후 도입
[ ] OpenTelemetry GenAI span schema는 runtime/config 위험 검토 후 적용
[ ] RAGAS-style metrics dashboard
[ ] Promptfoo/DeepEval CI regression
[ ] real failure → eval case 자동 생성
[ ] model/prompt/retriever versioning
```

## P4. Workflow/Product

```text
[ ] guided project setup browser QA / profile / connection / material flow hardening
[ ] Evidence Panel v2
[ ] Review Queue v2
[ ] Trace Viewer
[ ] LangGraph-style orchestration layer는 report/decision loop에서만 검토
[ ] Temporal-style durable workflow는 BullMQ/outbox state-machine 한계가 실측된 뒤 검토
[ ] report generation workflow
[ ] document ingest workflow
[ ] batch verification workflow
[ ] human review queue UI
[ ] artifact preflight validation
```

## P5. Security/Tool

```text
[ ] tool_registry
[ ] MCP gateway allowlist
[ ] tool approval policy
[ ] prompt injection retrieval rail
[ ] PII redaction/masking
[ ] tenant/project isolation audit
[ ] immutable audit log
[ ] red-team eval set
```

## P6. 고급 분석

```text
[ ] MCDA/AHP/TOPSIS 대안평가 모듈
[ ] Monte Carlo risk simulation
[ ] causal inference assistant
[ ] optimization solver integration
[ ] organization network analysis
[ ] scenario planning generator
```

---

## 16. 추천하지 않는 방향

```text
1. GraphRAG만 믿기
   - 정확한 수치/문구/법령/표 검색은 lexical/exact/evidence gate가 더 중요하다.

2. 메모리 무제한 저장
   - assistant hallucination이 장기기억으로 들어가면 시스템 전체가 오염된다.

3. 멀티에이전트 남발
   - agent 수가 많을수록 품질이 올라가는 것이 아니다.
   - 상태 그래프 + 검증 노드가 더 중요하다.

4. MCP/tool을 권한 없이 붙이기
   - prompt injection + excessive agency + data leakage 위험이 크다.

5. LLM judge만 믿기
   - judge 결과도 trace/eval/human feedback으로 검증해야 한다.

6. raw_document를 최종 근거처럼 사용
   - raw는 recall 후보로 쓰고, final/export에서는 verified evidence 중심으로 써야 한다.
```

---

## 17. 최종 제안 구조: Consulting AI OS

```text
Consulting AI OS =
  Hermes Gateway
  + consulting-web product layer
  + shared consulting brain
  + evidence/claim ledger
  + precision-first GraphRAG
  + exactness/factuality gate
  + project/thread memory
  + artifact intelligence
  + workflow engine
  + observability/eval loop
  + security/tool governance
  + consulting analytics toolkit
```

가장 중요한 원칙:

```text
답변을 잘하는 AI보다
근거가 추적되고,
주장이 검증되고,
오류가 데이터로 쌓이고,
산출물이 재검증되며,
프로젝트 기억이 오염되지 않는 시스템이 더 중요하다.
```

---

## 18. 참고 자료 / 기술 출처

### RAG / GraphRAG / Retrieval

- Microsoft GraphRAG paper: https://arxiv.org/abs/2404.16130
- Microsoft GraphRAG docs: https://microsoft.github.io/graphrag/
- LightRAG paper: https://arxiv.org/abs/2410.05779
- LightRAG GitHub: https://github.com/HKUDS/LightRAG
- Self-RAG paper: https://arxiv.org/abs/2310.11511
- CRAG paper: https://arxiv.org/abs/2401.15884
- RAPTOR paper: https://arxiv.org/abs/2401.18059
- RAFT paper: https://arxiv.org/abs/2403.10131
- HyDE paper: https://arxiv.org/abs/2212.10496
- ColBERT paper: https://arxiv.org/abs/2004.12832
- SPLADE v2 paper: https://arxiv.org/abs/2109.10086

### Factuality / Verification

- FActScore paper: https://arxiv.org/abs/2305.14251
- AlignScore: https://aclanthology.org/2023.acl-long.634/
- TRUE factual consistency benchmark: https://arxiv.org/abs/2204.04991
- RAGAS metrics: https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/

### Workflow / Observability / Eval

- LangGraph docs: https://docs.langchain.com/oss/python/langgraph/overview
- Temporal docs: https://docs.temporal.io/workflow-execution
- Phoenix tracing: https://arize.com/docs/phoenix/tracing/llm-traces
- Langfuse docs: https://langfuse.com/docs
- Promptfoo docs: https://www.promptfoo.dev/docs/intro/
- DeepEval docs: https://deepeval.com/docs/getting-started
- MLflow GenAI eval: https://mlflow.org/docs/latest/genai/eval-monitor/
- OpenTelemetry GenAI Semantic Conventions: https://opentelemetry.io/blog/2026/genai-observability/

### Security / Tool / Guardrails

- Model Context Protocol docs: https://modelcontextprotocol.io/docs/getting-started/intro
- MCP tools spec: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- OWASP Top 10 for LLM Applications: https://owasp.org/www-project-top-10-for-large-language-model-applications/
- OWASP GenAI LLM Top 10: https://genai.owasp.org/llm-top-10/
- NVIDIA NeMo Guardrails: https://docs.nvidia.com/nemo/guardrails/about-nemo-guardrails-library/overview

### Document Intelligence

- Docling GitHub: https://github.com/docling-project/docling
- Docling docs: https://docling-project.github.io/docling/
- Unstructured GitHub: https://github.com/Unstructured-IO/unstructured
- Marker GitHub: https://github.com/datalab-to/marker
- MinerU GitHub: https://github.com/opendatalab/MinerU

### Graph / Provenance / Causal

- Leiden algorithm: https://www.nature.com/articles/s41598-019-41695-z
- HippoRAG: https://arxiv.org/abs/2405.14831
- W3C PROV-DM: https://www.w3.org/TR/prov-dm/
- W3C PROV overview: https://www.w3.org/TR/prov-overview/
