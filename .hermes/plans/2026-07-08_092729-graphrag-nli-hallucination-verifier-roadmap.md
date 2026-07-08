# GraphRAG/NLI/Hallucination/Verifier Quality Roadmap

> **For Hermes:** execute with `test-driven-development`; implementation slices must keep existing consulting-web scope boundaries and shared consulting brain SoT.

**Goal:** Turn GraphRAG, NLI, hallucination detection, and verifier gating into measurable quality controls instead of ad-hoc UI features.

**Architecture:** Keep `/home/jigoo/.hermes/workspace/consulting/db/consulting.db` as the shared consulting brain SoT. Add deterministic evaluation scripts/fixtures in `apps/api/scripts` and `apps/api/test`, then expose only stable aggregate verdicts through existing Evidence-to-Decision contracts. Verifier enforcement is tiered: objective exactness/citation failures can block, semantic NLI starts as shadow/warning, final report/export gets release-gate semantics.

**Tech Stack:** NestJS/TypeScript, Vitest, `tsx` scripts, Python GraphRAG eval, Drizzle/Postgres, existing `EvidenceDecisionStore`, `ClaimVerifierService`, `CitationPostCheckService`, `ExactnessGateService`, and `graphrag_eval_gate.py`.

---

## Baseline measured on 2026-07-08

Commands:

```bash
pnpm --filter @consulting/api exec vitest run \
  test/claim-verifier-cascade.test.ts \
  test/evidence-sufficiency-evaluator.test.ts \
  test/citation-post-check.service.test.ts \
  test/consulting-memory-context.builder.test.ts --reporter=dot

python3 apps/api/scripts/graphrag_eval_gate.py \
  --rerank --top-k 2 \
  --output artifacts/graphrag-eval-current.json \
  --report-output artifacts/graphrag-eval-current.md
```

Result:

```text
Vitest: 4 files, 13 tests passed
GraphRAG eval: ok=true, questions=45, hit_rate=0.8889,
  context_recall=0.8889, context_precision=0.2432,
  citation_correctness=1.0, p95_latency_s=4.5878,
  rerank_modes=[cross-encoder], warning_count=0
```

## Current implementation map

### Already implemented

- GraphRAG retrieval eval baseline:
  - `apps/api/scripts/graphrag_eval_gate.py`
  - Metrics: hit rate, RAGAS-lite context recall/precision, citation correctness, p95 latency, cross-encoder gate.
- CRAG/Self-RAG style sufficiency classifier:
  - `apps/api/src/consulting/evidence-sufficiency-evaluator.service.ts`
  - Injected into `ConsultingMemoryContextBuilder`.
- Citation/evidence post-check:
  - `apps/api/src/consulting/citation-post-check.service.ts`
  - Flags missing citation, unretrieved citation, low-overlap citation.
- NLI/verifier cascade:
  - `apps/api/src/consulting/claim-verifier.service.ts`
  - Local NLI provider, env-gated Hermes strict JSON verifier, latency/provider metrics.
- Evidence-to-Decision durable loop:
  - `apps/api/src/consulting/evidence-decision.store.ts`
  - Persists `claim_verification_verdicts`, scorecards, review queue, exactness runs.
- Message-level verification badges:
  - `apps/api/src/chat/chat-message.store.ts`
  - Contracts in `packages/contracts/src/spaces.ts`.
- Report/decision repair primitive:
  - `ClaimVerifierService.repairAndReverify()`
  - General chat does not auto-rerun; report/decision repairs once.

### Gaps to close

1. **NLI accuracy is not yet benchmarked as a model-quality metric.**
   - Current tests prove behavior slices, not dataset-level accuracy/F1/false-block rate.
2. **Hallucination reduction is not yet measured before vs after verifier.**
   - Existing post-check finds issues, but no script reports unsupported/citation/numeric/contradiction reduction.
3. **Verifier gate semantics are implicit.**
   - Existing loop has warnings/review/repair, but no explicit `PASS | PASS_WITH_WARNINGS | BLOCKED` policy object.
4. **GraphRAG eval exists but needs a quality ledger.**
   - Current `context_precision=0.2432` is measurable; improvements should compare against a saved baseline with thresholds.

---

## Rollout policy

```text
General chat:
  semantic NLI = warning/review only
  exactness/citation structural failures = visible warning, no silent assertion

Analysis draft:
  insufficient/refuted claims trigger rewrite suggestions and review queue

Report/decision draft:
  max-1 targeted repair + re-verify
  unresolved refuted/high-impact unsupported claims require manual action

Final export/PDF/PPT/release gate:
  numeric mismatch, missing source, missing citation, unretrieved citation, or high-impact contradiction => BLOCKED
  semantic insufficiency without contradiction => PASS_WITH_WARNINGS unless configured stricter
```

---

## Task 1: Add deterministic NLI benchmark

**Objective:** Measure verifier label quality with accuracy, macro F1, contradiction recall, false-block rate, and unsupported deferral.

**Files:**
- Create: `apps/api/src/consulting/verification-quality-metrics.ts`
- Create: `apps/api/scripts/nli_verifier_bench.ts`
- Modify: `apps/api/package.json`
- Test: `apps/api/test/verification-quality-metrics.test.ts`

**Step 1: RED test**

Add a Vitest test proving metric computation:

- fixture with supports/refutes/not_enough_info rows
- assert overall accuracy
- assert contradiction recall
- assert false-block rate counts predicted refutes/NEI on expected supports
- assert macro F1 bounded 0..1

Run:

```bash
pnpm --filter @consulting/api exec vitest run test/verification-quality-metrics.test.ts --reporter=dot
```

Expected: FAIL because module does not exist.

**Step 2: GREEN implementation**

Implement pure metric functions in `verification-quality-metrics.ts` and script `nli_verifier_bench.ts` using existing `ClaimVerifierService` + `LocalNliProvider`.

Script output shape:

```json
{
  "ok": true,
  "rows": 12,
  "overallAccuracy": 1,
  "macroF1": 1,
  "contradictionRecall": 1,
  "unsupportedDeferralRecall": 1,
  "falseBlockRate": 0,
  "thresholds": {...}
}
```

**Step 3: Verify**

```bash
pnpm --filter @consulting/api exec vitest run test/verification-quality-metrics.test.ts test/claim-verifier-cascade.test.ts --reporter=dot
pnpm --filter @consulting/api exec tsx scripts/nli_verifier_bench.ts
```

---

## Task 2: Add hallucination reduction meter

**Objective:** Measure unsupported/refuted/citation/numeric issue rate before vs after a verifier/repair pass.

**Files:**
- Extend: `apps/api/src/consulting/verification-quality-metrics.ts`
- Create: `apps/api/scripts/hallucination_reduction_eval.ts`
- Test: `apps/api/test/hallucination-reduction-metrics.test.ts`
- Modify: `apps/api/package.json`

**Metrics:**

- `unsupportedClaimRate`
- `refutedClaimRate`
- `citationIssueRate`
- `numericBlockedRate`
- `overallIssueRate`
- `reductionRate = (before - after) / before`

**Gate:**

- no negative reduction
- after `refutedClaimRate <= before`
- after `citationIssueRate <= before`
- numeric mismatch remains hard-blocked, not silently repaired

---

## Task 3: Make verifier policy explicit

**Objective:** Convert scattered verdicts into a stable policy decision: `PASS`, `PASS_WITH_WARNINGS`, `BLOCKED`.

**Files:**
- Create: `apps/api/src/consulting/verifier-gate-policy.service.ts`
- Test: `apps/api/test/verifier-gate-policy.service.test.ts`
- Later extend contracts only if UI needs this aggregate field.

**Rules:**

- `BLOCKED`: exactness blocked, missing source, missing citation in release mode, unretrieved citation, high-impact refute.
- `PASS_WITH_WARNINGS`: semantic NEI, cross-project-only evidence, low confidence, non-final draft warnings.
- `PASS`: all objective gates pass and no high-impact semantic problems.

---

## Task 4: Wire policy into report/export path only

**Objective:** Avoid productivity loss by not hard-blocking normal chat.

**Files likely to change:**
- `apps/api/src/consulting/evidence-decision.store.ts`
- future report/export usecase files once identified.

**Constraint:** No forced auto-block in general chat. General chat stays review/warning.

---

## Task 5: GraphRAG quality ledger

**Objective:** Persist or version baseline eval summaries so search-quality work can prove improvement/regression.

**Files likely to change:**
- Extend: `apps/api/scripts/graphrag_eval_gate.py`
- Add fixture/baseline JSON under a non-generated path if small and deterministic.
- Keep generated artifacts under `artifacts/` uncommitted.

**Current target:** Maintain `hit_rate >= 0.8889`, improve `context_precision` from `0.2432` without hurting recall or p95.

---

## Risks / guardrails

- Do not let NLI hard-block ordinary conversation.
- Do not treat missing retrieval as falsehood; label it as insufficient evidence.
- Do not claim verifier pass means truth. It means “passed available checks.”
- Keep live DB writes out of eval scripts unless explicitly approved.
- Keep GraphRAG SoT in shared consulting brain; no new pgvector/store first.
- Heavy dependency/build/Docker changes require explicit approval.

---

## First execution slice

Start with Task 1 + Task 2 pure metrics/scripts because they are deterministic, low-risk, and provide the measurement substrate for every later enforcement decision.
