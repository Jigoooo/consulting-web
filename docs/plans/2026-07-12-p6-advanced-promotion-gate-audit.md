# P6 Advanced — 승격 게이트 재감사 및 HOLD 결정

작성일: 2026-07-12 · 상태: **조건부 마일스톤 완료(HOLD)** · 제품 경로 변경 없음

## 결론
P6 advanced의 신규 heavy 알고리즘(Leiden·LightRAG·ColBERT·SPLADE·RAPTOR·인과추론)은 **현재 승격 게이트를 통과하지 못했다**. 현재 product baseline을 유지하는 것이 품질·복잡도·운영 리스크 기준으로 우월하다.

`p6-advanced`의 목표는 "무조건 추가"가 아니라 **승격 게이트 충족 시에만 도입**이다. 따라서 이번 재감사에서 HOLD가 재확인된 것으로 조건부 마일스톤을 닫는다.

## 1. 현재 product baseline 재측정
명령: `pnpm --filter @consulting/api run test:p6-product-baseline`

- `allowed=true`
- config: `rw020-prune4-top1`
- real embedding 3/3 (`fake_embedding_runs=0`)
- context precision **0.8310**
- context recall **0.9111**
- hit rate **0.9111**
- mean p95 **4.2791s**, worst p95 **5.7788s**
- trace/retrieval/eval ledger **1/1/1**
- leakage **0**, warning **0**, blocker **0**

판정: 기준선은 현재도 통과한다. latency는 이전 기록보다 흔들렸지만 허용 게이트 안이며, 신규 알고리즘을 넣을 품질 근거는 아니다.

## 2. 후보 재비교
### SPLADE-lite (real embeddings)
명령: `test:p6-splade-lite`

- decision `hold`
- blocker `precision_delta_low`
- precision/recall/hit delta **0.0000 / 0.0000 / 0.0000**
- latency ratio **0.9831**
- product path mutated **false**

### RAPTOR-lite (real embeddings)
명령: `test:p6-raptor-lite`

- decision `hold`
- blocker `coverage_delta_low`
- global coverage delta **-0.0333**
- global precision delta **-0.0197**
- hit-rate delta **0.0000**
- latency ratio **0.7484**
- product path mutated **false**

판정: SPLADE는 개선 0, RAPTOR는 핵심 품질이 악화한다. 제품 통합 금지.

## 3. 이미 제품에 있는 실익 P6 기능
- no-dependency PPR/heat graph diffusion (`EvidenceToDecisionService.diffuseGraph`)
- context graph fanout + diffusion-weighted scope
- on-the-fly connected-component summary
- community summary용 선행 스키마(method 확장 가능)

회귀: `evidence-to-decision.service` + `consulting-memory-context.builder` + `context-graph-activation` **17/17 통과**.

## 4. 승격 데이터 조건 실측
- retrieval 사람 라벨: **0건** (재튜닝 트리거 50건 미달)
- retrieval failure 라벨: **0건**
- `community_summaries`: 운영 문서 기준 **0행**, recall은 on-the-fly component summary 사용
- causal 처치/결과 데이터: 구조화 원장 없음; App verdict에는 `claim_type` 컬럼도 없음
- git worktree: 누적 production 작업으로 clean 아님
- heavy dependency: 별도 사용자 승인 필요

따라서 Leiden/LightRAG/ColBERT 및 causal inference의 재개 전제도 충족되지 않는다.

## 5. 최종 결정
- **유지**: rw020-prune4-top1, PPR/heat diffusion, component summary.
- **HOLD**: Leiden·LightRAG·ColBERT·SPLADE·RAPTOR 제품 통합.
- **HOLD**: causal inference(처치·결과·교란변수 데이터 부재).
- **완료**: MCDA·민감도·Monte Carlo는 W3 analytics에서 실수요 범위 구현·검증됨.
- 신규 dependency/index/table write·runtime path 변경 **0**.

## 6. 재개 트리거(전부 충족해야 함)
1. clean isolated branch/worktree
2. retrieval 사람 라벨 ≥ **50**
3. current baseline 3회 연속 PASS + ledger 1/1/1 + leakage 0
4. 후보가 precision/recall 중 하나를 유의미하게 개선하고 다른 하나를 악화시키지 않음
5. p95 latency와 운영 복잡도 예산 통과
6. heavy dependency 설치 명시 승인
7. causal은 처치·결과·교란변수·시간축이 구조화된 뒤 별도 방법론 검토
