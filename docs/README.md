# consulting-web docs

> Last cleaned: 2026-07-09

## 지금 읽을 문서

| 목적 | 문서 |
|---|---|
| 전체 구조/운영 레이어 맵 | `consulting-layer-map.md` |
| SQLite → PostgreSQL 전환 현재 상태 | `consulting-db-postgres-review.md` |
| 컨설팅 AI OS 장기 로드맵 | `plans/consulting-ai-system-improvement-roadmap.md` |
| ColBERT/SPLADE/RAPTOR 재개 계획 | `plans/2026-07-09-colbert-splade-raptor-restart-plan.md` |
| 문서 처리/OCR 레이어 | `document-intelligence-layer.md` |
| 창원 운영/온보딩 | `changwon-operations.md`, `changwon-onboarding.md` |

## 완료되어 삭제한 문서

아래 PG18 migration 단계별 보고서는 현행 상태 문서와 중복되고, 오래된 “보류/미완료” 판단이 남아 있어 혼동을 만들었다. 내용은 Git history에서 복구 가능하므로 `docs/`에서는 제거한다.

```text
pg18-migration-baseline-20260708.md
pg18-migration-phase2-20260708.md
pg18-migration-phase3-20260708.md
pg18-migration-phase4-20260708.md
pg18-migration-phase5-20260708.md
pg18-migration-phase6-20260708.md
pg18-migration-phase7-20260708.md
pg18-migration-phase8-20260708.md
pg18-migration-phase9-preflight-20260708.md
pg18-migration-worklog.md
```

## P6 현재 기준선

```text
command: pnpm --filter @consulting/api run test:p6-product-baseline
config: rw020-prune4-top1
decision: allowed=true
context_precision: 0.8310
context_recall: 0.9111
hit_rate: 0.9111
worst_p95_latency_s: 4.1768
ledger: trace/retrieval/eval rows 1/1/1, leakage_count 0
```

ColBERT/SPLADE/RAPTOR는 완료된 product baseline을 대체하지 않는다. 다음에 다시 한다면 `plans/2026-07-09-colbert-splade-raptor-restart-plan.md`대로 read-only comparison lab에서 baseline 대비 개선을 증명해야 한다.

## P6 advanced lab 최근 결과

```text
2026-07-09 SPLADE-lite read-only spike:
command: pnpm --filter @consulting/api run test:p6-splade-lite
decision: hold
reason: precision_delta_low
baseline precision/recall/hit: 0.8310 / 0.9111 / 0.9111
splade-lite precision/recall/hit: 0.8310 / 0.9111 / 0.9111
changed_rows: 0 / 45
product_path_mutated: false

2026-07-09 RAPTOR-lite read-only spike:
command: pnpm --filter @consulting/api run test:p6-raptor-lite
decision: hold
reason: coverage_delta_low
summary_rows: 4
global_questions: 4
baseline global_coverage/global_precision/hit: 0.8389 / 0.5333 / 1.0000
raptor-lite global_coverage/global_precision/hit: 0.8056 / 0.5136 / 1.0000
coverage_delta: -0.0333
precision_delta: -0.0197
latency_ratio: 0.6510
changed_rows: 4 / 4
product_path_mutated: false
```

해석: dependency-free SPLADE-style sparse query expansion은 안전하지만 현재 데이터셋에서는 baseline보다 낫지 않다. RAPTOR-lite hierarchical query expansion은 global-summary 질문에서도 baseline coverage를 넘지 못했다. real SPLADE/RAPTOR 모델·인덱스 실험은 heavy dependency 승인 후 별도 branch에서만 재개한다.
