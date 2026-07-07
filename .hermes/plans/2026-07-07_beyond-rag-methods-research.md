# Beyond GraphRAG: consulting-web / shared consulting brain 적용 후보 리서치

작성일: 2026-07-07

## 결론 요약

현재 시스템은 GraphRAG 자체보다 **증거를 의사결정으로 바꾸는 층**이 더 부족하다. 다음 경쟁력은 `더 잘 찾기`가 아니라 다음 7개 층에서 나온다.

1. Evidence/claim verification lattice — FEVER식 `SUPPORTS / REFUTES / NOT ENOUGH INFO` + citation/NLI 검증
2. Truth maintenance / belief revision — 새 근거가 들어오면 기존 주장·보고서·의사결정의 유효성을 자동 재계산
3. Calibrated uncertainty / conformal abstention — 답변 가능/보류/추가증거요청을 확률적으로 캘리브레이션
4. Decision science layer — AHP/TOPSIS/PROMETHEE/VOI로 “검색 결과”를 “대안 선택”으로 전환
5. Causal layer — 상관·유사도 대신 DAG/SCM/반사실 질문으로 컨설팅 권고의 원인성을 관리
6. Weak supervision + active learning — 사람 검토를 가장 정보가 큰 항목에 배정하고 라벨링 함수를 축적
7. Document AI / multimodal retrieval — PDF 표·도면·레이아웃까지 검색·인용·검증 대상으로 올림

GraphRAG 관련 물리/수학 기법 중 지금 바로 쓸 만한 것은 Leiden보다 **PPR/heat-kernel diffusion, spectral gap, graph signal smoothing**이다. heavy GNN/TDA/optimal transport는 아직 ROI가 낮고, eval corpus와 graph 밀도가 더 쌓인 뒤가 맞다.

## 현재 시스템 상태에서 보이는 강점/부족

### 이미 강한 것

- Hybrid retrieval + RRF/cross-encoder rerank가 동작하고 eval/ralph 게이트가 있음.
- context_edges로 workspace 내부 cross-project 참조가 시작됨.
- CRAG/Self-RAG류의 evidence sufficiency / citation post-check가 일부 구현됨.
- shared consulting brain에 RAPTOR, community, ToG-2, cross-topic links, degradation observability가 있음.
- consulting repo에는 claim/evidence map, Toulmin KPI, human review, weekly KPI reporter 같은 논리 OS 흔적이 있음.

### 아직 부족한 것

- 증거가 `claim을 지지/반박/불충분`하는지 구조화된 판정이 약함.
- 근거 변경 시 기존 결론을 자동 invalidation/supersession하지 못함.
- confidence가 retrieval score 중심이고, calibrated uncertainty/abstention이 아님.
- 최종 산출물이 “답변” 중심이지 “대안 비교/결정” 중심으로 정규화되지 않음.
- 컨설팅 권고의 원인/개입/반사실 구조가 약함.
- human review backlog는 있으나 active learning/VOI 기반 우선순위화가 약함.
- PDF/표/이미지 레이아웃 기반 evidence retrieval은 아직 충분히 productized되지 않음.

## 우선순위 로드맵

| 우선 | 기술층 | 방법론 | 왜 필요한가 | 첫 구현 |
|---|---|---|---|---|
| P0 | Claim verification lattice | FEVER, NLI, citation verification | 컨설팅 보고서의 핵심은 “찾았다”가 아니라 “이 주장이 근거로 지지되는가” | `claim_verdicts`: SUPPORTS/REFUTES/NEI + cited evidence span + verifier score |
| P0 | Truth maintenance | TMS, AGM belief revision | 근거가 바뀌면 과거 결론의 유효성도 바뀜 | evidence/claim/report sentence dependency graph + invalidation queue |
| P0 | Uncertainty calibration | CONFLARE, conformal prediction | 답해야 할 때/말아야 할 때를 score가 아니라 보장 수준으로 판단 | eval set 기준 `answer/ask/abstain` threshold calibration |
| P0 | Decision layer | MCDA, AHP/TOPSIS/PROMETHEE, VOI | 고객은 검색결과보다 선택지를 원함 | decision question → alternatives → criteria → evidence-weighted scorecard |
| P1 | Causal layer | SCM/DAG, CausalRAG, counterfactual | 정책/조직진단은 “왜/하면 어떻게 되나”가 핵심 | claim edge에 `causes/enables/blocks/confounds` 추가 + causal question template |
| P1 | Active learning | Snorkel/data programming, uncertainty sampling | 사람 검토 시간을 아끼고 품질을 빠르게 올림 | review queue priority = uncertainty × impact × evidence gap |
| P1 | Argument mining | Toulmin, stance, attack/support | 보고서 논리 구조를 자동 점검 | claim→warrant→backing→qualifier→rebuttal UI/API 연결 |
| P1 | Graph diffusion | PPR, heat kernel, graph signal smoothing | 작은 graph에서도 heavy Leiden 없이 근접 관련성 개선 | `context_edges` 1-hop + PPR score + dampened cross-project injection |
| P1 | Document AI | ColPali, LayoutLMv3, table OCR | 컨설팅 원천자료는 표/PDF/스캔이 많음 | page image embedding + table cell locator + screenshot citation |
| P2 | Process mining | event logs, conformance checking | 컨설팅 수행 과정/조직 프로세스 분석에 유용 | Hermes/consulting workflow event log → bottleneck/SLO map |
| P2 | Optimal transport | distribution alignment | claim set과 evidence corpus 간 coverage/gap 분석 | evidence-topic distribution vs report-outline distribution distance |
| P2 | TDA | persistent homology | coverage holes/anomaly 탐지 가능하나 실익 불확실 | eval-only experiment, product path 보류 |
| P2 | GNN/SBM/Leiden | graph learning/community | 현재 graph 작음. 도입 비용 대비 실익 낮음 | graph > 수백 노드 + eval improvement 확인 후 재평가 |

## 주요 근거 문헌/방법론

### RAG/GraphRAG 직접 관련

- Agentic RAG Survey, arXiv:2501.09136 — static RAG 한계를 agentic workflow로 확장.
- LightRAG, arXiv:2410.05779 — flat chunks의 contextual awareness 부족을 graph-index로 보완.
- RAPTOR, arXiv:2401.18059 — chunk-only retrieval 한계를 tree summary로 보완.
- Self-RAG, arXiv:2310.11511 — retrieve/generate/critique를 reflection token으로 제어.
- CRAG, arXiv:2401.15884 — retrieval evaluator로 잘못된 검색 결과를 보정.
- STaRK, arXiv:2404.13207 — text+relational semi-structured KB retrieval benchmark.
- RAGAS, arXiv:2309.15217 — reference-free RAG 평가.
- ARES, arXiv:2311.09476 — context relevance, answer faithfulness, answer relevance 평가를 lightweight judge + PPI로 자동화.

### 검색/문서 이해

- ColBERT, arXiv:2004.12832 — late interaction retrieval.
- SPLADE v2, arXiv:2109.10086 — sparse lexical expansion retrieval.
- SPLATE, arXiv:2404.13950 — sparse late interaction.
- HyDE, arXiv:2212.10496 — hypothetical document embedding으로 zero-shot dense retrieval 개선.
- ColPali, arXiv:2407.01449 — visually rich document retrieval; PDF 레이아웃/표/이미지에 중요.
- LayoutLMv3, arXiv:2204.08387 — document AI multimodal pretraining.

### 검증/불확실성/추론

- FEVER, arXiv:1803.05355 — claim을 SUPPORTS/REFUTES/NOT ENOUGH INFO로 분류하고 evidence sentence를 기록.
- Chain-of-Verification, arXiv:2309.11495 — 초안→검증질문→독립답변→수정답변으로 hallucination 감소.
- CONFLARE, arXiv:2404.04287 — conformal retrieval로 RAG failure/contradiction에 보장형 불확실성 처리.
- ReAct, arXiv:2210.03629 — reasoning/action interleaving.
- Tree of Thoughts, arXiv:2305.10601 — exploration/lookahead.
- Graph of Thoughts, arXiv:2308.09687 — thought를 graph로 합성/정제.
- Reflexion, arXiv:2303.11366 — weight update 없이 verbal feedback으로 agent 개선.

### 인과/의사결정/논증

- CausalRAG, arXiv:2503.19878 — causal graph를 retrieval에 통합해 chunking/semantic similarity 한계를 보완.
- LLMs and Causal Inference Survey, arXiv:2403.09606; Causal Inference with LLM Survey, arXiv:2409.09822 — LLM과 causal inference 협업.
- CausalEval, arXiv:2410.16676 — LLM causal reasoning 평가/개선.
- LLMs in Argument Mining Survey, arXiv:2506.16383 — claim/evidence/stance/argument quality를 LLM 시대에 재정의.
- MCDA/AHP/TOPSIS/PROMETHEE — 다기준 의사결정. 컨설팅 권고/대안 선택에 직접 맞음.
- Bayesian evidence synthesis / value of information — 불확실성 하에서 어떤 근거를 더 모을지 결정.

### 데이터품질/인간검토/수학·물리 그래프

- Snorkel, VLDB Journal 2020 — hand labeling 없이 labeling function으로 약지도 학습, SME가 2.8배 빠르게 모델 구축했다는 사용자 연구 포함.
- Graph Diffusion, arXiv:1911.05485 — PPR/heat kernel diffusion으로 noisy edge 문제 완화.
- Heat-kernel community detection, arXiv:1403.3148 — seed 주변 local community 탐지.
- Personalized PageRank ↔ stochastic block model connection, PNAS 2017 — PPR과 community structure의 통계적 연결.
- Dempster–Shafer evidence theory — 불완전/충돌 증거 결합용.
- Truth maintenance / AGM belief revision — belief/claim 변경 전파와 최소수정 원칙.

## 바로 적용할 설계

### 1. Claim Verification Lattice

스키마:

```text
claim_verdicts(
  claim_id,
  evidence_id,
  verdict: supports|refutes|not_enough_info|mixed,
  verifier: lexical|nli|llm|human,
  confidence,
  evidence_span_locator,
  rationale,
  created_at
)
```

검색 결과를 바로 답변에 넣지 말고, claim 단위로 판정 후 답변/보고서에 반영한다.

### 2. Truth Maintenance Queue

```text
evidence changed → affected claims → affected report sentences/slides → stale badge/recheck queue
```

보고서/PPT가 “근거 변경 후에도 맞는지”를 자동 추적한다. 컨설팅 산출물 신뢰도에 가장 직접적이다.

### 3. Decision Question Layer

```text
DQ: 무엇을 결정해야 하나?
Alternatives: 가능한 선택지
Criteria: 비용/실행가능성/리스크/근거강도/고객수용성
Evidence: 각 기준을 지지/반박하는 근거
Score: MCDA + uncertainty
Recommendation: 선택/보류/추가조사
```

### 4. Review Priority = VOI

사람 검토 큐를 단순 최신순/중요도순이 아니라 다음 점수로 정렬한다.

```text
priority = decision_impact × uncertainty × evidence_gap × deadline_weight
```

### 5. Graph Diffusion before Leiden

현재 graph 규모에서는 Leiden보다 아래가 먼저다.

```text
anchor scopes → 1~3 hop PPR/heat-kernel diffusion → score dampening → evidence retrieval fanout
```

cross-project는 기존처럼 dampen하고, workspace 밖은 금지.

## 도입 보류 기준

- GNN/Leiden/igraph: graph가 수백~수천 노드, eval에서 community recall이 병목으로 확인될 때.
- Optimal transport: 보고서 outline과 evidence corpus 간 coverage gap을 계량화할 eval set이 있을 때.
- TDA: coverage hole detection이 실제 수작업 QA보다 나은지 작은 실험으로 증명될 때.
- Full agentic planner: 현재는 운영 위험이 크므로 read-only planner/judge부터.

## 추천 실행 순서

1. P0-1: FEVER식 claim verdict table + citation/NLI/LLM verifier + UI badge
2. P0-2: truth maintenance invalidation queue
3. P0-3: decision question/alternative/criteria scorecard
4. P1-1: PPR/heat-kernel graph diffusion retrieval score
5. P1-2: ColPali/LayoutLM-style document page/table retrieval pilot
6. P1-3: active learning review queue + weak supervision labeling functions

## 성공 지표

- unsupported claim rate 감소
- stale report sentence 발견/차단 수
- human review 1건당 품질개선량 증가
- answer abstain이 실제 불충분 케이스에서 늘고, 충분 케이스에서 과잉보류하지 않음
- decision scorecard가 고객 보고서 문장/슬라이드와 traceable하게 연결됨
- PDF/table evidence locator 누락률 감소
