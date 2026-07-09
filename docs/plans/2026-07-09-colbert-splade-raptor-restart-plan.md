# ColBERT / SPLADE / RAPTOR 재개 계획

> **For Hermes:** Use `consulting-advanced-graphrag-hardening`, `writing-plans`, and `test-driven-development` before implementing this plan task-by-task.

**Goal:** 현재 통과한 P6 product baseline을 기준선으로 고정하고, ColBERT / SPLADE / RAPTOR를 별도 branch에서 안전하게 비교 실험한다.

**Architecture:** 운영 product path는 기존 `rw020-prune4-top1` rerank baseline을 유지한다. ColBERT/SPLADE/RAPTOR는 live write 없이 read-only candidate generator로 붙이고, `p6_precision_trace_loop.py`의 동일 metric/ledger gate로 baseline 대비 개선 여부만 판단한다.

**Tech Stack:** Python eval runner, shared consulting brain PG backend, app Postgres trace/eval/retrieval ledger, optional isolated model/index artifacts under ignored `artifacts/`.

---

## 0. 현재 상태 — 완료와 미완료 분리

```text
완료:
- P6 entry runner 구현
- real embedding repeat=3 matrix
- app PG trace/eval/retrieval ledger write + readback
- product baseline package script 추가
- SPLADE-lite read-only spike 완료: baseline 대비 개선 없음 → HOLD
- RAPTOR-lite read-only spike 완료: global-summary coverage/precision 개선 없음 → HOLD

현행 product baseline:
- command: pnpm --filter @consulting/api run test:p6-product-baseline
- config: rw020-prune4-top1
- repeat: 3 / required_repeats: 3
- context_precision: 0.8310
- context_recall: 0.9111
- hit_rate: 0.9111
- worst_p95_latency_s: 4.1768
- trace_rows/retrieval_rows/eval_rows: 1/1/1
- leakage_count: 0
- decision: allowed=true

아직 안 한 것:
- ColBERT product integration
- SPLADE product integration
- RAPTOR product integration
- extra dependency installation
- live index/table writes
```

**중요 판단:** ColBERT/SPLADE/RAPTOR는 “지금 당장 제품 경로에 넣을 기능”이 아니라, baseline보다 좋아지는지 증명해야 하는 별도 comparison lab이다.

---

## 1. 재개 조건

아래가 모두 참일 때만 시작한다.

```text
1. git worktree clean
2. baseline command가 현재 환경에서 PASS
3. app PG ledger readback이 trace/retrieval/eval row를 생성
4. Telegram/gateway 운영 변경과 분리된 branch 또는 commit slice
5. heavy dependency 설치 전 사용자 승인
```

Baseline 재측정 명령:

```bash
cd /home/jigoo/.hermes/workspace/consulting-web
pnpm --filter @consulting/api run test:p6-product-baseline
python3 - <<'PY'
import json
from pathlib import Path
p = Path('artifacts/p6-product-baseline/latest/p6_entry_decision.json')
d = json.loads(p.read_text())
print(d['allowed'], d['selected_config'], d['trace_probe'])
PY
```

Expected:

```text
allowed=True
selected_config=rw020-prune4-top1
trace_probe.checked=True
trace_rows/retrieval_rows/eval_rows >= 1
leakage_count=0
```

---

## 2. 공통 실험 원칙

- 운영 path를 바꾸지 않는다.
- 새 dependency를 product image에 바로 넣지 않는다.
- live DB write는 금지한다. 단, eval/trace ledger write는 `p6_precision_trace_loop.py`가 이미 검증한 범위에서만 허용한다.
- `artifacts/` 아래 생성물은 커밋하지 않는다.
- 비교는 감상이 아니라 같은 45문항 eval + 같은 gate로 한다.
- 성공 기준은 baseline 대비 명확해야 한다.

성공 기준 초안:

```text
required:
- context_precision >= baseline + 0.03
- context_recall >= baseline - 0.02
- hit_rate >= baseline - 0.02
- worst_p95_latency_s <= baseline * 1.50
- warning_count = 0
- fake_embedding_runs = 0
- cross_encoder_failures = 0
- ledger leakage_count = 0

otherwise:
- HOLD, product path unchanged
```

---

## 3. Task A — baseline lock 재검증

**Objective:** 비교 기준이 흔들리지 않게 현재 baseline을 새 artifact로 재측정한다.

**Files:**
- Read: `apps/api/package.json`
- Read: `apps/api/scripts/p6_precision_trace_loop.py`
- Artifact only: `artifacts/p6-product-baseline/latest/`

**Step 1: run baseline**

```bash
pnpm --filter @consulting/api run test:p6-product-baseline
```

**Step 2: inspect decision**

```bash
python3 - <<'PY'
import json
from pathlib import Path
out = Path('artifacts/p6-product-baseline/latest')
print((out / 'p6_entry_decision.json').read_text())
PY
```

**Step 3: stop condition**

If `allowed=false`, do not start ColBERT/SPLADE/RAPTOR. Fix baseline regression first.

---

## 4. Task B — ColBERT read-only spike

**Objective:** late interaction text retrieval이 현재 rerank baseline보다 precision을 올리는지 확인한다.

**Files:**
- Create only if proceeding: `apps/api/scripts/p6_colbert_candidate_probe.py`
- Test: `apps/api/test_python/test_p6_colbert_candidate_probe.py`
- No product service files at first.

**Step 1: RED test**

Test must prove:

```text
- probe accepts query set and returns candidate ids/scores
- raw prompt text is not stored
- missing optional dependency returns structured skipped result, not product fallback mutation
- no live DB write except explicit eval artifact/ledger
```

**Step 2: minimal implementation**

Implement candidate generation behind an isolated script. Do not wire API recall path.

**Step 3: compare through gate**

Extend `p6_precision_trace_loop.py` only if needed with a `--candidate-source colbert` experimental flag. Default remains baseline.

**Step 4: decision**

```text
PASS → keep as experimental candidate source, still not product default.
FAIL/SKIP → record result in docs, delete temporary generated artifacts, product unchanged.
```

---

## 5. Task C — SPLADE read-only spike

**Status:** 2026-07-09 dependency-free SPLADE-lite spike 완료 → HOLD.

```text
command: pnpm --filter @consulting/api run test:p6-splade-lite
mode: dependency-free SPLADE-style sparse query expansion
real SPLADE dependency: not installed; no heavy dependency added
questions: 45
baseline precision/recall/hit: 0.8310 / 0.9111 / 0.9111
splade-lite precision/recall/hit: 0.8310 / 0.9111 / 0.9111
precision_delta: +0.0000
recall_delta: +0.0000
hit_rate_delta: +0.0000
latency_ratio: 0.9589
changed_rows: 0 / 45
decision: hold
blocker: precision_delta_low
product_path_mutated: false
```

**Objective:** Korean lexical/identifier precision을 SPLADE sparse expansion이 개선하는지 확인한다.

**Files:**
- Create only if proceeding: `apps/api/scripts/p6_splade_candidate_probe.py`
- Test: `apps/api/test_python/test_p6_splade_candidate_probe.py`

**Step 1: RED test**

Test must prove:

```text
- Korean terms / code ids / numeric tokens are preserved
- sparse scores are normalized before RRF merge
- dependency missing means skipped, not silent fake success
```

**Step 2: minimal implementation**

Build a probe script that produces sparse candidate IDs. No DB schema migration in first slice.

**Step 3: compare**

Run same 45-question gate against SPLADE candidate source.

**Step 4: decision**

Product adoption only if it beats baseline without large latency/cost regression.

---

## 6. Task D — RAPTOR read-only spike

**Status:** 2026-07-09 dependency-free RAPTOR-lite spike 완료 → HOLD.

```text
command: pnpm --filter @consulting/api run test:p6-raptor-lite
mode: dependency-free hierarchical summary query expansion
real RAPTOR dependency: not installed; no heavy dependency added
summary_rows: 4
global_questions: 4
baseline global_coverage/global_precision/hit: 0.8389 / 0.5333 / 1.0000
raptor-lite global_coverage/global_precision/hit: 0.8056 / 0.5136 / 1.0000
coverage_delta: -0.0333
precision_delta: -0.0197
hit_rate_delta: +0.0000
latency_ratio: 0.6510
changed_rows: 4 / 4
decision: hold
blocker: coverage_delta_low
product_path_mutated: false
```

**Objective:** long-document/global-summary queries에서 hierarchical summaries가 recall/precision을 개선하는지 확인한다.

**Files:**
- Prefer shared brain side first: `/home/jigoo/.hermes/workspace/consulting/scripts/dialogue_memory/advanced_graphrag_layers.py`
- Web eval side: `apps/api/scripts/p6_precision_trace_loop.py` only if comparison flag is needed
- Tests in both repos if code crosses boundary.

**Step 1: scope guard**

RAPTOR rows must be additive and lineaged. No overwrite of source chunks.

**Step 2: no-dep/minimal summary cache**

Start with deterministic summary fixtures or existing component-summary layer. Do not introduce heavy clustering deps before proving query class benefit.

**Step 3: compare by query class**

Separate `summary_global` / `strategy` / `legal` / `numeric` cases. RAPTOR should only win where long-context hierarchy matters.

**Step 4: decision**

If it only improves broad summaries but hurts exact/legal/numeric questions, keep as intent-gated optional source, not default.

---

## 7. Task E — final product decision gate

**Objective:** decide whether any experimental source enters product path.

Required final report:

```text
method | precision | recall | hit_rate | p95 | ledger_ok | leakage | decision
baseline rw020-prune4-top1 | ... | ... | ... | ... | yes | 0 | keep
ColBERT | ... | ... | ... | ... | ... | ... | adopt/hold
SPLADE | ... | ... | ... | ... | ... | ... | adopt/hold
RAPTOR | ... | ... | ... | ... | ... | ... | adopt/hold
```

Adoption rule:

```text
- adopt only one method at a time
- commit tests + script + docs together
- deploy only after focused tests, full p6 baseline, app PG ledger readback, and product smoke
```

---

## 8. Non-goals

- Do not migrate product DB to vector extension for this spike.
- Do not replace current rerank path.
- Do not install heavy ML dependencies into the production Docker image without explicit approval.
- Do not claim “advanced retrieval done” from a single query demo.

---

## 9. Current next action when resumed

```text
1. Re-run `pnpm --filter @consulting/api run test:p6-product-baseline`.
2. Pick exactly one: ColBERT OR SPLADE OR RAPTOR.
3. Create read-only probe + RED test.
4. Compare against baseline using same P6 gate.
5. Decide adopt/hold with numbers.
```
