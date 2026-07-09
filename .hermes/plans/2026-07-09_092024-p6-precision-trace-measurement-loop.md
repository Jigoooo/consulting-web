# P6 Precision/Trace Measurement Loop Implementation Plan

> **For Hermes:** Use subagent-driven-development skill only if this plan is later promoted from measurement-loop design to implementation. This file itself is the P6 entry gate, not the P6 labs build.

**Goal:** Advanced GraphRAG labs(P6: ColBERT/SPLADE/RAPTOR/Leiden 등)는 현재 바로 착수하지 않고, real-embedding precision/trace 지표가 안정적으로 통과될 때만 열리도록 반복 측정 루프를 만든다.

**Architecture:** Existing `apps/api/scripts/graphrag_eval_gate.py` remains the source of truth for claim-linked RAGAS/STaRK-lite metrics. A thin runner will execute controlled real-embedding configurations, persist JSON/Markdown artifacts, compare against the last approved baseline, and emit a single `p6_entry_decision.json`. Trace coverage is measured from the deployed app Postgres trace/eval/retrieval ledgers so that “precision up” and “why it happened” are both visible.

**Tech Stack:** Python 3.12, existing consulting brain venv, Postgres/Drizzle tables, `pnpm`, existing `graphrag_eval_gate.py`, Hermes gateway-safe Korean reports.

---

## 1. Current measured baseline

Use this as the starting line, not as a target to celebrate:

```text
real embeddings / raw_weight=0.20 / rerank=true / top_k=2:
  context_precision = 0.2881
  context_recall    = 0.8667
  hit_rate          = 0.8667
  p95_latency_s     = 4.1242
```

Interpretation:
- Recall is already acceptable enough to avoid blind broadening.
- Precision is too low for P6 labs; adding heavy labs now would hide whether the core retrieval stack is actually improving.
- P6 opens only after precision gains are repeatable with trace evidence.

Runner smoke after implementation (`rw020-prune4-top2`, repeat 1, PG-only real embedding):

```text
context_precision = 0.1274
context_recall    = 0.3111
hit_rate          = 0.3111
p95_latency_s     = 0.5477
rerank_modes      = [pg-lexical-graph]
decision          = blocked
```

Interpretation: the runner is doing its job by surfacing a current PG measurement gap; this is a blocker for P6 labs, not a reason to hide or bypass the gate.

---

## 2. P6 entry gates

All gates must pass on **real embeddings**, not fake embeddings.

### Hard gates

| Gate | Required value | Why |
|---|---:|---|
| `questions` | `>= 40` | Avoid tiny eval-set wins |
| `failures` | `0` | Runtime errors invalidate metrics |
| `warning_count` | `0` | Missing signal breakdown means trace is not explainable |
| `cross_encoder_ok` | `true` when rerank is on | Avoid silent reranker fallback |
| `context_recall` / `hit_rate` | `>= 0.80` | Do not buy precision by losing the answer |
| `context_precision` | `>= 0.45` OR `+0.15 absolute vs baseline` | P6 only after a real precision step-change |
| `p95_latency_s` | `<= 8.0` | Keep interactive use viable |
| repeated runs | 3 consecutive runs, same config | Guard against lucky query variance |

### Trace gates

| Gate | Required value |
|---|---:|
| trace rows for the measurement window | `> 0` |
| retrieval/eval ledger rows linked to run or measurement marker | `> 0` if endpoint path emits them |
| raw prompt/output leakage in trace API/UI | `0` occurrences of SECRET/API key/email/raw prompt patterns |
| top failure classes report | present when any gate fails |

If trace ledgers are not yet emitted by the CLI eval path, do **not** fake it. Mark the CLI run as metric-only and run a second deployed API/browser marker trace probe for trace coverage.

---

## 3. Measurement matrix

Initial matrix is deliberately small. Do not run labs yet.

```text
raw_weight:    0.00, 0.10, 0.20, 0.30
rerank_prune:  4, 8, 16
top_k:         2, 3
rerank:        true
embeddings:    real only (--no-fake-embeddings)
backend:       pg only
```

Stop early if:
- `context_recall < 0.80` for a config family.
- `p95_latency_s > 8.0` for two consecutive configs.
- cross-encoder falls back or signal breakdown warnings appear.

---

## 4. Exact commands

### Single baseline measurement

```bash
set -euo pipefail
mkdir -p artifacts/p6-entry
CONSULTING_BRAIN_BACKEND=pg \
CONSULTING_BRAIN_WRITE_BACKEND=pg \
CONSULTING_BRAIN_STATE_BACKEND=pg \
CONSULTING_PG_DSN_DRIVER=psycopg \
CONSULTING_RERANKER_KEEP_LOADED=1 \
python3 apps/api/scripts/graphrag_eval_gate.py \
  --rerank \
  --no-fake-embeddings \
  --top-k 2 \
  --rerank-prune 4 \
  --raw-weight 0.20 \
  --output artifacts/p6-entry/real-rw020-prune4-top2.json \
  --report-output artifacts/p6-entry/real-rw020-prune4-top2.md
```

Expected:
- exits `0` only if current script gates pass.
- output JSON contains `summary.context_precision`, `summary.context_recall`, `summary.p95_latency_s`, `summary.evaluation_config`.

### Implemented runner command

```bash
python3 apps/api/scripts/p6_precision_trace_loop.py \
  --topic changwon-org-mgmt-diagnosis \
  --repeat 3 \
  --output-dir artifacts/p6-entry/$(date +%Y%m%d-%H%M%S) \
  --baseline-json artifacts/graphrag-eval-baseline.json
```

Package script:

```bash
pnpm --filter @consulting/api run test:p6-entry
```

Expected outputs:

```text
artifacts/p6-entry/<run>/matrix.json
artifacts/p6-entry/<run>/matrix.md
artifacts/p6-entry/<run>/p6_entry_decision.json
artifacts/p6-entry/<run>/p6_entry_decision.md
```

`artifacts/` is gitignored; commit only the runner/test/docs, not generated measurement outputs.

---

## 5. Implementation tasks

### Task 1: Add a small matrix runner

**Objective:** Automate the existing eval script without changing retrieval behavior.

**Files:**
- Create: `apps/api/scripts/p6_precision_trace_loop.py`
- Test: `apps/api/test_python/test_p6_precision_trace_loop.py`

**Steps:**
1. Parse raw weights, prune values, top-k values, repeat count, output dir, baseline JSON.
2. For each config, call `graphrag_eval_gate.py` as a subprocess with PG-only env and `--no-fake-embeddings`.
3. Capture exit code, summary JSON, report path, stderr tail.
4. Aggregate by config: mean precision/recall/hit-rate/p95 plus worst p95 and failure count.
5. Emit `matrix.json` and `matrix.md`.
6. Unit-test with a fake subprocess runner; no real embeddings in unit tests.

### Task 2: Add P6 decision evaluator

**Objective:** Convert matrix metrics into a single “P6 allowed / blocked” decision.

**Files:**
- Modify: `apps/api/scripts/p6_precision_trace_loop.py`
- Test: `apps/api/test_python/test_p6_precision_trace_loop.py`

**Rules:**
- `allowed=false` by default.
- Require 3 consecutive successful real runs for the same config.
- Require hard gates from §2.
- Include top blocker reasons in priority order: runtime failure, reranker fallback, precision low, recall loss, latency high, trace missing.
- Persist `p6_entry_decision.json` and Markdown summary.

### Task 3: Add trace readback probe

**Objective:** Make trace coverage a measurable gate without exposing raw sensitive data.

**Files:**
- Modify: `apps/api/scripts/p6_precision_trace_loop.py`
- Possibly reuse API/store code only if there is already a safe read path; otherwise keep this as direct read-only SQL.

**Checks:**
- Recent `trace_spans` count for marker/window.
- Recent eval/retrieval ledger rows if available.
- Trace API redaction probe via authenticated app API if the measurement used deployed API/browser path.
- Secret/raw leakage regex count must be zero.

### Task 4: Add a package script only after tests exist

**Objective:** Provide one reproducible command.

**Files:**
- Modify: `apps/api/package.json`

Suggested script:

```json
"test:p6-entry": "python3 scripts/p6_precision_trace_loop.py --repeat 3 --output-dir ../../artifacts/p6-entry/latest"
```

Keep generated `artifacts/` out of git.

---

## 6. Verification

Before any P6 labs implementation:

```bash
pnpm --filter @consulting/api exec vitest run test/observability-trace-viewer.test.ts test/artifact-export-gate.test.ts
/home/jigoo/.hermes/workspace/consulting/.venv/bin/python -m pytest apps/api/test_python/test_graphrag_eval_gate.py apps/api/test_python/test_p6_precision_trace_loop.py -q
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Operational proof:
- Run one real measurement matrix.
- Confirm `p6_entry_decision.json` says `allowed=false` until precision/trace gates pass.
- If `allowed=true`, dispatch a fresh blocker-only review before starting P6 labs.

---

## 7. Risks and guardrails

- Do not tune metrics using fake embeddings; fake mode is CI stability only.
- Do not broaden top-k to inflate recall while precision remains low.
- Do not treat trace absence as success; trace missing means “not explainable yet”.
- Do not start P6 labs if the runner finds a cheaper fix in raw weighting, rerank prune, claim linking, or signal breakdown.
- Generated measurement artifacts are evidence, not source; keep them in `artifacts/` and commit only selected summaries if the user asks.

---

## 8. Definition of done

P6 entry loop is complete when:

1. Runner exists and is unit-tested.
2. One real PG-only smoke measurement has been run through the runner; full matrix may run later because it is intentionally heavy.
3. `p6_entry_decision.json` explains allowed/blocked with exact metric values.
4. Trace coverage and redaction are represented as an explicit gate (`--trace-json` when available); absence blocks P6 instead of being treated as success.
5. A fresh independent reviewer finds no blocker in the measurement loop before any P6 lab is productized.

Until then, P6 labs remain blocked.
