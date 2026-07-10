# 로드맵 구현 실측 감사 + 컨설팅 방법론 구조화 계획

> 작성일: 2026-07-10
> 기준 문서: `consulting-ai-system-improvement-roadmap.md` (2026-07-08, 수정하지 않음 — 본 문서는 별도 감사/계획)
> 성격: **읽기전용 실측 감사 + 신규 구조화 제안**. 이 문서 작성 과정에서 코드/DB는 일절 변경하지 않았다.
> 실측 기준: 2026-07-10 웹 App PG(`consulting-web-pg-1`) + 뇌 PG18(`consulting-web-pg18-rehearsal-pg18-1`) 라이브 readback.

---

## 0. 한 줄 결론

로드맵의 **R0~P0는 사실상 완료**됐고(원장 테이블 전부 존재 + 운영 row 축적 시작), P1~P5는 **절반 구현**이다.
미구현 항목 중 4개는 **"안 하는 게 맞다"**(이미 더 강한 대체물이 있거나 중복), 6개는 **"지금 스키마/게이트만 만들고 알고리즘은 게이트 통과 시 붙이는"** 방식으로 진행해야 한다.
가장 큰 공백은 기술이 아니라 **컨설팅 방법론(MECE·피라미드·이슈트리·가설주도)이 기계검증 가능한 구조로 인코딩되지 않은 것**이다 — 이것이 본 계획의 핵심 신규 제안이다.

---

## 1. 로드맵 항목별 구현 실측표 (2026-07-10)

### 1.1 스키마 존재 여부 (웹 App PG)

| 로드맵 제안 테이블 | 실측 | 운영 row | 비고 |
|---|---|---|---|
| claim_verification_verdicts | EXISTS | **22** | 문서 시점 0 → 운영 축적 시작됨 |
| exactness_runs | EXISTS | 3 | 〃 |
| judgment_guard_runs | EXISTS | 4 | 〃 |
| retrieval_runs / retrieval_hits | EXISTS | 6 / 1 | rank_before/after_rerank 컬럼까지 있음 |
| trace_spans | EXISTS | 8 | 0026 |
| eval_cases / eval_runs / eval_scores | EXISTS | 3 / 7 / 15 | 0026 |
| memory_write_candidates | EXISTS | 1 | P4 실전 스모크로 첫 행 (2026-07-10) |
| evidence_items | EXISTS | 5 | |
| artifact_version_verifications | EXISTS | 8 | content-bound v4 (로드맵 11.1보다 강함) |
| provenance_graph_edges | EXISTS | 1 | 0025 |
| approval_requests | EXISTS | 0 | P5 런타임 승인 원장 (경로 연결됨, 발동 사례 0) |
| scope_profiles | EXISTS | 70 | 채널/토픽 프로필 |
| **claim_ledger** | **MISSING** | — | §2.1 판정 참조 (만들면 안 됨) |
| **scope_bindings** | **MISSING** | — | §2.2 (불필요) |
| **verification_runs** | **MISSING** | — | §2.3 (불필요) |
| **artifact_claim_map** | **MISSING** | — | §2.4 (불필요) |
| **source_freshness** | **MISSING** | — | §3.1 (해야 함) |
| **source_quality_scores** | **MISSING** | — | §3.1에 병합 |
| **contradiction_edges** | **MISSING** | — | §3.2 (해야 함) |
| **community_summaries** | **MISSING** | — | §3.3 (스키마만 지금) |
| **document_elements** | **MISSING** | — | §3.6 (부분 대체 존재) |
| **chart_specs** | **MISSING** | — | §3.6 |
| **tool_registry / tool_invocations** | **MISSING** | — | §2.5 (부분 대체 존재) |

### 1.2 코드/파이프라인 레벨

| 로드맵 항목 | 실측 | 근거 |
|---|---|---|
| query_type classifier (4.2) | **구현됨** | `consulting-memory-context.builder.ts:168 classifyQuery()` (artifact_export/numeric_check 등) |
| dynamic context budget (4.10) | **구현됨** | `retrievalBudget(queryType)` |
| cross-encoder rerank (4.6) | **구현됨** | bge-reranker ONNX + PG recall parity 커밋 c3ab90a |
| RRF fusion + trust tier (4.1) | **구현됨** | pg_backend.py tier_weight 1.0/0.75/0.20 |
| component summary (5.1 경량판) | **구현됨** | pg_backend `_component_summary_hits` — P6 hold 결정에 부합 |
| Telegram exact binding (3.5 일부) | **구현됨** | dialogue_telegram_thread_bindings 6행 active |
| toolsets fail-closed allowlist (10.1 일부) | **구현됨** | hermes-runs-client.ts:406 `/v1/toolsets` 검증, 차단 시 run 시작 거부 |
| prompt injection/PII rail (10.3/10.4 일부) | **구현됨** | p5-runtime-safety-rails (GraphRAG/profile 주입 전 sanitize) |
| Memory Write Guard (3.6) | **구현+실전 1행** | quarantine 파이프라인 2026-07-10 라이브 검증 |
| P1 신규 프로젝트 뇌 자동 프로비저닝 | **구현됨(로드맵 외)** | ensure_topic, consulting@430dec5 + consulting-web@eaac5d7 |
| multi-query RAG-Fusion (4.4) | **미구현** | 코드 검색 0건 |
| HyDE (4.5) | **미구현** | 〃 |
| query decomposition (4.3) | **미구현** | 〃 |
| MMR diversity filter (4.9) | **미구현** | 〃 |
| freshness/staleness scoring (5.6/7.4) | **미구현** | 〃 |
| retrieval failure labels UI (3.4) | **미구현** | retrieval_hits.failure_type 컬럼 없음, UI 없음 |
| FActScore atomic gate (7.1) | **부분** | atomic claim 분해는 artifact v4 검증기에 있음; supported-ratio 게이트 임계는 미도입 |
| Leiden/RAPTOR/SPLADE/ColBERT (4.7/4.8/5.2/6.1) | **HOLD (정당)** | 2026-07-09 read-only spike 실측: SPLADE 개선 0.0000, RAPTOR coverage −0.0333 → 로드맵 0.3절 자체 기록과 일치 |
| LangGraph orchestration (9.1) | **미도입 (기존 결정: report/decision 루프만 스파이크)** | §5 재판정 |
| Temporal durable workflow (9.2) | **미도입 (BullMQ 한계 실측 전 보류)** | 유지 |
| 인과추론/MCDA/몬테카를로 (12.x) | **미구현** | §3.5 |

### 1.3 뇌(brain_raw)에 이미 존재하는 컨설팅 OS 원장 — 로드맵이 간과한 자산

로드맵 3.1은 claim_ledger를 "새로 만들 것"으로 제안했지만, **공유 뇌에는 이미 성숙한 원장이 있다**:

```text
brain_raw.claims                = 37   (maturity/승급 이벤트 98건)
brain_raw.claim_evidence_links  = 137
brain_raw.claim_logic_edges     = 35   (논리 게이트 그래프!)
brain_raw.atomic_statements     = 662
brain_raw.counterarguments      = 37   (반론 매트릭스)
brain_raw.directions            = 11
brain_raw.executive_decisions   = 9
brain_raw.assumption_register   = 9
brain_raw.contradiction_items   = 1
```

이 사실이 §2 판정의 근거다: **웹에 평행 원장을 새로 파면 이중 장부가 된다** (로드맵 0.2절의 duplicate-schema 경고 그대로).

---

## 2. 미구현 항목 판정 — "안 하는 게 맞다" (4건)

### 2.1 claim_ledger (웹 신규 테이블) → 만들지 말 것
- 뇌에 claims/claim_evidence_links/claim_maturity_events가 이미 있고(§1.3), 웹에는 claim_verification_verdicts(22행)가 검증 결과를 담는다.
- 필요한 것은 새 테이블이 아니라 **웹 verdicts ↔ 뇌 claims 조인 뷰/브릿지** (claim_code 정규화 키). 신규 테이블은 이중 장부 + 동기화 버그 원천.

### 2.2 scope_bindings 전용 테이블 → 불필요
- `consulting_topic_links`가 이미 project/channel/topic/thread 4-레벨 컬럼 + link_level + partial unique index를 갖췄다. 로드맵 3.5의 검색 우선순위(thread>topic>channel>project)는 resolver의 "most specific active bridge" 로직으로 구현돼 있다.
- 남은 실제 갭은 테이블이 아니라 **non-project 레벨 링크의 운영 활용**(현재 project-level 위주)이다 — 데이터 문제지 스키마 문제가 아님.

### 2.3 verification_runs → 불필요
- claim_verification_verdicts + trace_spans 조합이 동일 역할. run 단위 묶음이 필요하면 trace_id로 그룹.

### 2.4 artifact_claim_map → 불필요 (더 강한 대체물 존재)
- artifact_version_verifications(v4)가 **버전+콘텐츠 해시 귀속**으로 로드맵 제안(섹션 단위 매핑)보다 우회 불가능성이 강하다. 섹션 단위 표시가 필요해지면 verifications의 claims JSON에서 파생 뷰로.

### 2.5 tool_registry 테이블 → 지금은 불필요 (정적 allowlist가 fail-closed로 이미 작동)
- 현 규모(단일 테넌트, 고정 toolset)에서 DB 레지스트리는 관리 표면만 늘린다. hermes-runs-client의 정적 allowlist + `/v1/toolsets` fail-closed 게이트 유지.
- 재검토 트리거: 워크스페이스별 tool 차등이 필요해지는 시점(외부 고객 온보딩).

### 2.6 Leiden/RAPTOR/SPLADE/ColBERT → HOLD 유지 (단, §3.3의 스키마 선행과 병행)
- read-only spike 실측이 개선 0을 보였다. 알고리즘 재개 게이트는 기존 계획(`2026-07-09-colbert-splade-raptor-restart-plan.md`) 유지.
- **주인님 원칙 반영**: "데이터 쌓이면 그때 결정"이 아니라, community_summaries **테이블·조회 경로·트레이스는 지금** 만들어 두고(§3.3), 채우는 알고리즘만 게이트 뒤에 둔다. 이러면 알고리즘 도입일에 스키마 마이그레이션이 없다.

---

## 3. 해야 하는 것 (미구현 중 가치 확인, "지금 구조화" 원칙 적용)

> 공통 원칙: **스키마·게이트·원장은 데이터가 적을 때 만들어야 싸다.** 지금 만들면 모든 신규 row가 태어날 때부터 구조를 갖고, 나중에 만들면 백필+재검증 비용을 치른다. 각 항목에 [지금-스키마] / [지금-게이트] / [나중-알고리즘] 라벨을 붙였다.

### 3.1 source_freshness + 신선도 게이트 — 우선순위 1
- **실사례 근거**: 2026-07-08 Emma — "부산, 대구, 인천의 호봉테이블 변경 이슈가 있어 … 업데이트 해야하겠음" → 자료 신선도가 실제 결함을 만들었다. 대전 급식비 재제출 건도 동일 클래스.
- [지금-스키마] `source_freshness(source_id, published_at, collected_at, effective_date, expires_at, superseded_by, freshness_policy)` — 로드맵 7.4 그대로. file_ingest/수신자료 인테이크에 effective_date 기록 의무화.
- [지금-게이트] Judgment Guard에 `stale_source_warning` 발동 케이스 추가: 호봉표/법령/조직도 소스가 기준일 없이 수치 근거로 쓰이면 warning row.
- [나중-알고리즘] freshness_weight 지수감쇠를 recall 스코어에 곱하는 것은 eval로 A/B 후.
- 검증 지표: 신선도 경고 발동률, 재제출 자료 반영 누락 0건.

### 3.2 contradiction edge 승격 — 우선순위 2
- 현재 contradiction은 NLI 방향쌍(코드 상수)과 뇌 contradiction_items(1행)에 갇혀 있다. 컨설팅은 반대근거 관리가 본질(Emma의 반론 대응 흐름이 매 토픽 반복).
- [지금-스키마] 뇌 `claim_logic_edges`에 edge_type `CONTRADICTS/QUALIFIES/SUPERSEDES` 허용값 추가(이미 35행 있는 테이블 확장 — 신규 테이블 아님).
- [지금-게이트] verdicts가 refuted를 낼 때 해당 claim쌍에 CONTRADICTS 엣지 자동 기록. 리뷰 큐에 "근거가 갈리는 쟁점" 필터.
- [나중-알고리즘] contradiction 기반 decision risk score.
- 검증 지표: 반론 카드가 있는 결론 비율, 리뷰 큐 처리 시간.

### 3.3 community_summaries 스키마 선행 — 우선순위 3
- [지금-스키마] `community_summaries(topic_id, community_key, member_chunk_ids, summary, method, built_at)` 생성. 지금은 **기존 no-dep component summary**가 이 테이블에 쓰도록 연결(method='connected_component').
- [나중-알고리즘] Leiden은 재개 게이트 통과 시 method='leiden'으로 같은 테이블에 쓴다. 스키마 변경 0.
- 검증 지표: summary_global 질의에서 community hit 사용률.

### 3.4 retrieval failure 라벨 축적 — 우선순위 4 (precision 개선의 데이터 기반)
- [지금-스키마] retrieval_hits에 `judged_relevant boolean` + `failure_type text` 컬럼 추가 (로드맵 3.4의 failure taxonomy 그대로).
- [지금-게이트] 웹 근거 패널에 👍/👎 + 사유 1클릭 (로드맵 8.4 축소판 — 버튼 2개부터).
- [나중-알고리즘] 라벨 50건 이상 모이면 RRF weight/rerank prune 튜닝 eval에 투입.
- 검증 지표: 라벨 수집률, precision 추이 (현 0.3251 → 1차 목표 0.45).

### 3.5 판단 정량 도구 3종 (MCDA·몬테카를로·민감도) — 우선순위 5, 로드맵 12장 중 실수요만
- 창원 실수요와 직결: 수당 신설 우선순위 **5축 평가**(A~E)는 이미 수동 MCDA다. 이를 `decision_alternatives` + weighted scoring + 민감도(가중치 ±20% 순위 안정성)로 도구화하면 매 토픽 재사용.
- 몬테카를로는 통상임금 파급액 추산(이미 수동 공식 존재)의 구간 추정에 즉시 적용 가능.
- 인과추론(12.1)은 [나중]: 현재 과업엔 처치효과 데이터가 없다. claim_type='causal' 라벨만 지금 달아 둔다.
- 검증 지표: 5축 평가표 생성 시간, 민감도 표가 포함된 판정 비율.

### 3.6 document_elements/chart_specs — 조건부
- document_extractions + document_retrieval_units + page_visual 해시가 이미 부분 커버. **표가 많은 PDF에서 exactness가 표 셀을 못 찾는 실패가 관측되면** 그때 element-level로 내려간다 (실패 로그가 트리거, 지금은 스키마도 보류).

---

## 4. 신규 제안 — 컨설팅 방법론의 기계검증 인코딩 (로드맵에 없던 핵심 갭)

> 대형 컨설팅펌 방법론은 "잘 쓰는 법"이 아니라 **검증 가능한 구조 계약**으로 넣어야 시스템이 된다. 아래는 병렬 리서치(14회 웹 교차검증, 원발명자 확인: MECE=Minto 본인, growth-share=Henderson/BCG 1970, 7-step=Conn&McLean 2019)로 출처 검증 완료. LLM 선례: Sun et al., "Pyramid Principle Guided Integration of LLMs" (arXiv:2410.12298, 2024).
> 리서치 핵심 통찰: **기존 시스템은 잎 수준(사실 검증: claim/evidence/NLI/exactness)은 이미 강하고, 갭은 중간 구조층**(주장 간 논리 형상)이다.

### 4.1 Minto Pyramid / SCQA — 보고서 구조 게이트 (리서치 우선순위 1)
- 출처: Barbara Minto, *The Pyramid Principle* (1987; McKinsey 사내 문서 표준에서 출발).
- 규칙: 결론 선행(top-down) / **수직 논리**: 부모 메시지 = 자식들의 요약 / **수평 논리**: 형제는 MECE + 동일 종류(전부 귀납 or 전부 연역) + 논리적 순서 / 도입부 SCQA.
- **인코딩**: ReportPlan에 `governing_message`(1문장) + 섹션별 `key_line` + `logic_type: inductive|deductive`. 게이트 3종: (a) 수직 게이트 — "자식 메시지 집합 → 부모" NLI 함의 검사(기존 verdicts 재사용, **구현비 최소·효과 최대**), (b) 수평 게이트 — 형제 logic_type 혼재 FAIL, (c) 생성 후 각 문단 첫 문장만 추출해 피라미드 역구성 → 스키마와 diff.
- 검증 지표: 부모-자식 NLI 함의율, 역구성 트리 일치율.

### 4.2 MECE 게이트 — 분류의 기계 검사
- 규칙 + 실무 통계: 중복 위반이 누락보다 약 3:1로 흔함. 가장 흔한 위반은 **분할축 혼용**(예: "비용/인력/단기과제").
- **인코딩**: 형제 집합에 `dimension_label`(단일 분할축) 선언 필수. 게이트 3종: (a) 중복 — 형제 간 임베딩 코사인 상한 + NLI 상호함의 검출 + 동일 evidence chunk 공유 시 WARN, (b) 포괄 — 정량 트리는 잎 합계==부모(exactness 재활용), 정성 트리는 `기타/잔여` 노드 강제 + 사람 확인, (c) 축 일관성 — 형제 라벨이 선언축과 일치하는지 분류.
- 검증 지표: 형제쌍 중복률, 합산 오차율, 축 위반 건수.

### 4.3 가설주도 / Initial Hypothesis — 가설 원장 (리서치 우선순위 2)
- 출처: Rasiel, *The McKinsey Way* (1999) — Initial Hypothesis("Day 1 answer"는 실무 관용어, 간행 원전은 IH); Conn & McLean (2019).
- 이미 자산 있음: dialogue_state의 working_hypotheses + maturity. **제안한 kill_criteria가 리서치의 `falsification_condition`과 정확히 수렴** — 독립 검증됨.
- **인코딩 보강**: (a) 가설별 `falsification_condition`(생성 시점 필수 — 없으면 분석 착수 차단), (b) **확증편향 게이트**: 가설당 지지+반박 evidence 탐색 로그가 **둘 다** 존재해야 supported 승급(반박 탐색 0건 = FAIL), (c) 전환 감사: refuted 가설이 최종 보고서에 잔존하면 차단(stale-term QA 동형), (d) 규모 커지면 dialogue_state 필드 → 정식 `hypotheses` 테이블(statement/status/falsification_condition/required_analyses/linked_claims/revision_of 계보)로 승격.
- 검증 지표: **가설 기각률(0%면 확증편향 의심 신호)**, 반박 탐색 수행률.

### 4.4 이슈트리 — 질문 트리와 주장 트리의 형 분리
- 출처: Conn & McLean (2019); Garrette, Phelps & Sibony, *Cracked It!* (Palgrave, 2018) — **가설 피라미드(주장문 트리) vs 이슈트리(질문 트리)의 명시적 이원화**.
- **인코딩**: directions에 `parent_direction_id` + `tree_kind: diagnostic|solution|hypothesis_pyramid` + `node_form: question|assertion`. 게이트: (a) diagnostic 트리에 처방형 화행 검출 FAIL(기존 '사실↔권고 분리' 가드레일 동형), (b) 한 트리 내 질문/주장 혼재 금지, (c) question→assertion 승격은 verified claim 경유 필수, (d) 잎은 `analysis_ready`(필요 데이터가 inventory에 존재) 판정 없이 workplan 생성 차단.
- 검증 지표: 화행 위반 건수, 질문→주장 승격 추적 완전성.

### 4.5 Red team / Murder board — 버전 결박 적대 리뷰 (리서치가 설계 강화)
- 출처: 머더보드=미군 브리핑 심사 유래; Schwenk, "Devil's advocacy" (Business Horizons, 1989); 프리와이어링=Rasiel & Friga, *The McKinsey Mind* (2001).
- **인코딩 (리서치 보강분)**: `red_team_runs` 테이블 — 대상 산출물 **버전 해시**, 공격 페르소나(노조/의회/감사원 — 공공 컨설팅 직결), attacks[]/defense[]/verdict. **export 게이트에 "현재 버전 해시에 대한 red_team PASS" 조건 추가 — 본문 수정 시 자동 무효화(기존 v4 content-bound 게이트와 동형 메커니즘 재사용)**. 공격 페르소나는 별도 컨텍스트 실행(자기 채점 방지 — 기존 T2 리뷰 규약 그대로).
- 검증 지표: 공격 생존율, 사전 발견 반론 수 vs 사후(Emma 지적) 반론 수 역전.

### 4.6 산출물 스토리라인 QA — dot-dash / 액션 타이틀 / so-what (상향: 저비용 확인됨)
- 출처: McKinsey 실무 관행(Working With McKinsey, 2013); Bain "answer first" + so-what 슬라이드 규율.
- 리서치 발견: **기존 자산이 이미 부분 구현** — `ppt_content_readiness_gate`(phase3 content-spec-only)는 고스트 덱 게이트의 부분 구현이고, MCP `create_ppt_deck`의 "18자+ 결론형 title" 검증기는 액션 타이틀 린터와 동형. 일반화만 하면 됨.
- **인코딩**: (a) dot-dash 스토리보드(slides[].dot/dashes[], dash마다 claim_id) 승인 전 렌더링 차단, (b) 모든 exhibit/표/차트에 `so_what` 필드(비면 export 차단) + so_what이 기술문 아닌 함의문인지 화행 분류 + 데이터에서 NLI 함의되는지 검사, (c) **proof-point 붕괴 전파**: proof_point claim이 refuted되면 answer 자동 강등 + 산출물 stale 마킹(기존 policy-version invalidation 재사용), (d) 수평 흐름 — 제목만 이어 읽어 논증 성립하는지 인접 NLI 연쇄.
- 검증 지표: so_what 충전율·함의율, proof-point 붕괴 전파 지연.

### 4.7 엘리베이터 테스트 — 요약-원문 동치 게이트 (리서치 신규)
- 출처: Rasiel (1999). 30초 설명 불가 = 이해 미완.
- **인코딩**: `executive_one_liner`(공백 포함 200자 상한) 필수 + governing_message와 **양방향 NLI**(one-liner→결론 과잉주장 없음, 결론→one-liner 핵심 누락 없음).

### 4.8 7-step 프로세스 + 80/20 자원배분 (리서치 신규, 경량 적용)
- 출처: Conn & McLean (2019) 7-step; Rasiel 80/20; Koch, *The 80/20 Principle* (1997).
- **인코딩(경량)**: (a) 토픽에 `problem_statement` 오브젝트(decision_maker/deadline/constraints/accuracy_bar) — 미완이면 분석 단계 잠금, (b) direction에 impact×tractability 2축 점수(근거 링크 필수) + **deprioritized 이슈는 보고서에 "검토 범위 외" 명시 강제(암묵 방치 금지 — 주인님의 '누락/암묵보류 불호' 원칙과 일치)**, (c) 자원 로그 집계로 하위 사분면 과소비 WARN("바다 끓이기" 탐지).

---

## 5. LangGraph 판정 (리서치 반영 확정)

기존 결정(스킬 기록): "one-shot 검증엔 부적합, report/decision의 draft→verify→targeted repair→re-verify→publish 루프/human interrupt에만 스파이크."

**최종 판정: 기존 결정이 2025–2026 증거로 재확인·강화됨. 채팅 경로 보류 확정 + 리포트 루프 LangGraph.js shadow 스파이크는 지금 시작할 가치 있음.**

### 5.1 근거 (리서치 실측 사례)
1. **채팅 경로 순비용 확인**: Dotzlaw 프로덕션 사례(2025) — state 직렬화가 응답시간의 **15–25%**; Aerospike(2024→2026) — checkpoint는 superstep마다 PG write; Azguards "Checkpoint Bloat" — retrieved chunks를 state에 넣으면 PG TOAST write-amplification. 벤치마크(n1n.ai 2026-02, 벤더 편향 할인)에서도 오케스트레이션 계층이 P95에 수 초 단위로 드러남. → **GraphRAG chunk를 들고 다니는 우리 채팅 경로에 직격이므로 보류가 정답.**
2. **리포트 루프는 적합 확인**: LangGraph 1.0 GA(2025-10-22, **Python·TypeScript 동시**) — `interrupt()`/`Command(resume)`/PG checkpointer가 안정 API. 분·시간 단위 작업이라 오버헤드 비중 무시 가능. LangChain 공식 분석대로 지연의 본체는 verify/repair가 추가하는 LLM 호출 자체(프레임워크 무관).
3. **손익분기 경험칙**: "게이트 5개+승인+diff면 이득, 게이트 2개면 순수 함수가 더 쌈" — 현 리포트 경로는 claim coverage + exactness + citation + (신설) freshness + (신설) red-team + 사람 승인으로 **분기점 도달**. 현 채팅 경로(verify 1+repair 1)는 분기점 미달.
4. **checkpoint ≠ durable execution** (Diagrid 2025): LangGraph 체크포인트는 노드 사이 state만 저장 — 크래시 감지·중복 side-effect 방지는 사용자 몫. 단 우리는 **content-hash export gate가 이미 멱등성을 애플리케이션 층에서 확보** → Temporal급 내구성 없이도 안전.
5. **JS 생태계 격차 실재** (star ~10배, 다운로드 ~6배, 공식 포럼 스태프 인정): 도입 시 에지 케이스는 소스 직접 읽을 각오. 그래도 Python 마이크로서비스 분리보다 동일 스택(NestJS/TS) 유지가 낫다.
6. **XState 재판정**: durable resume/checkpointer 내장 없음 → human-approval-wait 재개가 핵심 요구인 이상 **1순위에서 제외**. LangGraph.js 스파이크가 에지 케이스로 막힐 때의 폴백으로만 유지.

### 5.2 스파이크 설계 (경계 고정)
- 대상: **ReportGenerationWorkflow 1개만** (draft→verify→repair→re-verify→publish + human interrupt). 채팅 경로 접촉 금지.
- **shadow 모드부터**: 발행 권한 없이 판정만 — 기존 경로와 병행 실행해 판정 일치율 비교.
- **Pointer State Pattern 필수**: state에는 content-hash·artifact 참조만, retrieved 원문 금지 (Checkpoint Bloat 차단).
- checkpointer는 기존 PG에 **스키마 분리**, 격리된 패키지 경계로 langchain-core 버전 churn 차단.
- **노드화 금지선 명문화**: GraphRAG/rerank/NLI 캐스케이드/Exactness Gate는 이미 검증된 코드 — 그래프는 발행 오케스트레이션 전용, 내부 로직은 기존 서비스 호출. (최대 리스크는 기술이 아니라 scope creep)
- 성공 기준: (a) human-wait 중 프로세스 kill→재기동 시 체크포인트 재개, (b) 노드 전이가 trace_spans에 연속 기록, (c) 동일 입력 재실행 시 결정 재현, (d) shadow 판정이 기존 경로와 불일치 0.
- Temporal/Inngest/Restate: 도입 안 함. **트리거 조건 명시** — "승인 대기가 며칠 단위 + 배포 중에도 run 생존 필요" 또는 "발행 exactly-once가 계약 요건"이 되면 LangGraph를 대체가 아니라 **감싸는 내구층**으로 재검토 (Grid Dynamics 이관 사례 참조).

---

## 6. 실행 순서 제안 (승인 전 착수 없음)

```text
W1 (스키마 선행 일괄 — 데이터 적은 지금이 가장 쌈):
[ ] source_freshness 테이블 + effective_date 인테이크 의무화 (§3.1)
[ ] claim_logic_edges CONTRADICTS/QUALIFIES/SUPERSEDES 확장 (§3.2)
[ ] community_summaries 테이블 + component-summary 연결 (§3.3)
[ ] retrieval_hits.judged_relevant/failure_type 컬럼 (§3.4)
[ ] directions parent_id/tree_kind (§4.4)
[ ] dialogue_state kill_criteria 필드 (§4.3)
    → 전부 additive migration, 기존 경로 무변경. cross-workspace negative test 동반.

W2 (게이트 활성화):
[ ] stale_source Judgment Guard 케이스 (§3.1)
[ ] refuted→CONTRADICTS 자동 엣지 + 리뷰 큐 필터 (§3.2)
[ ] governing_thought/so_what artifact preflight 게이트 (§4.1)
[ ] 근거 패널 👍/👎 라벨 버튼 (§3.4)
[ ] 최종 PDF 전 red-team 리뷰 1회 상시화 (§4.5)

W3 (스파이크/도구):
[ ] ReportGenerationWorkflow LangGraph.js **shadow 스파이크** (§5.2 경계 고정, 2주 박스; XState는 폴백)
[ ] MCDA 5축 평가표 + 민감도 도구 (§3.5)
[ ] 몬테카를로 파급액 구간 추정 (§3.5)

상시 게이트(변경 없음): P6 알고리즘 재개는 기존 restart-plan 게이트, Temporal은 BullMQ 한계 실측 후.
```

---

## 7. 검증 계획 요약

| 항목 | 검증 방법 | 성공 기준 |
|---|---|---|
| 실측표(§1) | 본 문서 자체가 라이브 readback | 재실행 시 동일 (probe SQL 재사용) |
| freshness 게이트 | 재제출 자료 시나리오 회귀 테스트 | 기준일 없는 수치 근거 → warning row 생성 |
| contradiction 엣지 | refuted verdict fixture | CONTRADICTS 엣지 + 리뷰 큐 노출 |
| 방법론 게이트 | governing_thought 없는 draft export 시도 | preflight 차단 |
| LangGraph 스파이크 | human-wait 중 프로세스 kill → 재기동 | 체크포인트 재개 + trace 연속성 |
| precision 개선 | 기존 `test:p6-product-baseline` | 0.3251 → 0.45 (라벨 50건 축적 후) |

---

## 8. 리서치 반영 이력

- [RESEARCH-A 반영 완료 2026-07-11] 컨설팅펌 방법론 14회 웹 교차검증 (원발명자 확인 포함). §4 전면 개편: 수직/수평 논리 게이트 구체화, falsification_condition 수렴 확인, red-team 버전 해시 결박, so-what/proof-point 붕괴 전파, 엘리베이터 테스트·7-step·80/20 신규 추가. 전문: `~/.hermes/cache/delegation/subagent-summary-0-20260711_001543_636057.txt`
- [RESEARCH-B 반영 완료 2026-07-11] LangGraph 2025–2026 근거 13개 출처. §5 확정: 채팅 보류(직렬화 15–25% 실측), 리포트 루프 LangGraph.js 1.0 shadow 스파이크 승인 가능, XState 1순위 제외(durable resume 부재), Temporal 트리거 조건 명시. 전문: `~/.hermes/cache/delegation/subagent-summary-1-20260711_001543_636567.txt`
- 판정 변경 사항: ① 초안의 "LangGraph.js vs XState 2주 비교" → **LangGraph.js 단독 shadow 스파이크**(XState는 폴백)로 수정 — durable resume 요건이 XState를 탈락시킴. ② §4가 6개 항목에서 8개로 확장(엘리베이터·7-step/80-20 추가). ③ W3의 스파이크 항목도 동일하게 수정.

## 9. 참고 (본 문서 신규 인용분)

- Barbara Minto, *The Pyramid Principle*, 1987 (MECE 원발명자 — McKinsey 동문 인터뷰로 확인)
- Ethan M. Rasiel, *The McKinsey Way*, McGraw-Hill, 1999 (Initial Hypothesis, 80/20, 엘리베이터 테스트)
- Rasiel & Friga, *The McKinsey Mind*, 2001 (프리와이어링)
- Charles Conn & Robert McLean, *Bulletproof Problem Solving*, Wiley, 2019 (7-step 공간판, 이슈트리 유형)
- Garrette, Phelps & Sibony, *Cracked It!*, Palgrave Macmillan, 2018 (가설 피라미드 vs 이슈트리 이원화)
- Schwenk, "Devil's advocacy and the board", *Business Horizons*, 1989 (악마의 변호인 제도화)
- Sun et al., "Pyramid Principle Guided Integration of LLMs", arXiv:2410.12298, 2024 (피라미드 원칙 LLM 적용 선례)
- Richard Koch, *The 80/20 Principle*, 1997; Bruce Henderson/BCG growth-share matrix, 1970
- LangGraph 1.0 GA (LangChain changelog, 2025-10-22); Diagrid "Checkpoints Aren't Durable Execution" (2025); Dotzlaw Consulting 직렬화 15–25% 사례 (2025); Aerospike LangGraph in Production (2024/2026); Azguards "Checkpoint Bloat" (2025–2026); Grid Dynamics LangGraph→Temporal 이관 (temporal.io, 2025); cordum.io "Temporal vs LangChain" (2026)
- 기존 로드맵 18장 참고자료는 그대로 유효 (중복 인용 생략)
