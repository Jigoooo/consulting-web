# P3 eval-observability — RAG metrics · 실패→fixture · CI regression (read-only)

작성일: 2026-07-12 · 상태: **순수 계산 코어 + DB 대시보드 스크립트 구현·실측 완료. DB write/배포 없음.**
근거 로드맵: §3.4(retrieval failure taxonomy) · §3.5(eval 지표) · W1 §3.4 라벨 피드백

## 문제
retrieval_hits에 사람 라벨(`judged_relevant` 👍/👎, `failure_type`)이 이미 수집되지만,
이를 **eval 지표로 집계하는 층이 없었다**. P3는 그 누락된 집계·회귀 게이트를 채운다.

## 구현
- `apps/api/src/consulting/rag-metrics.ts` — 의존성 0, 결정론.
  - `computeRagMetrics()`: precision@k, MRR, hit-rate@k, 실패 taxonomy 분해. 미라벨 run 자동 제외.
  - `compareRagRegression()`: baseline 대비 tolerance(기본 0.05) 초과 하락만 CI 실패. 개선은 항상 통과.
  - `exportFailureFixtures()`: 라벨된 실패를 dedup 키로 fixture화 → 관측된 실수를 영구 회귀 가드로.
- 유닛테스트 `test/rag-metrics.test.ts` **12/12 통과**(precision/MRR/hit-rate/failure/regression/fixture).
- 대시보드 `scripts/rag_eval_dashboard.ts` — DB의 라벨 hit를 run별로 묶어 집계(read-only, `--workspace` 필터).

## 실측 (격리 PG18, QA 워크스페이스에 라벨 6 hit 시드→집계→정리)
- precision@1/3/5 = **0.5**, MRR = **0.75**, hit-rate@3 = **1.0**
- failureBreakdown: duplicate_chunk·semantic_false_positive·wrong_project 각 1
- 실패 fixture **3건** export(runId:rank:type dedup 키)
- 유닛테스트 기대값과 실 DB 집계 **완전 일치**. 시드 정리 후 잔여 0.

## 검증
- API `typecheck`·`lint`·`build` 그린. W3+P3 코어 합산 테스트 **33/33**.

## 남은 배선 (후속, 선택)
- 대시보드 지표를 웹 Trace/Observability 화면에 카드로 노출.
- `exportFailureFixtures` 출력을 graphrag eval gate 입력 fixture로 커밋 → CI에서 `compareRagRegression` 게이트화.
- baseline 지표를 artifacts/에 스냅샷하여 라벨 50건 축적 후 precision 0.3251→0.45 추적.
