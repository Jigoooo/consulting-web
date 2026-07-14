/**
 * RAG retrieval metrics (P3) — compute precision@k / MRR / coverage / failure
 * taxonomy from the human relevance labels captured on retrieval_hits
 * (judged_relevant, failure_type). Pure, dependency-free, deterministic.
 *
 * The labels already exist (W1 §3.4 feedback buttons); this is the missing
 * aggregation layer that turns 👍/👎 into eval metrics and a CI regression gate.
 */

export type RetrievalFailureType =
  | 'wrong_project' | 'wrong_topic' | 'wrong_phase' | 'wrong_client'
  | 'raw_over_selected' | 'lexical_false_positive' | 'semantic_false_positive'
  | 'graph_over_fanout' | 'stale_source' | 'unsupported_claim' | 'citation_missing'
  | 'duplicate_chunk' | 'too_generic_context' | 'query_rewrite_error' | 'reranker_error';

export interface LabeledHit {
  /** 1-based rank within its retrieval run. */
  rank: number;
  /** true = relevant (👍), false = failure (👎), null = unlabeled. */
  judgedRelevant: boolean | null;
  failureType: RetrievalFailureType | null;
}

export interface RetrievalRunLabels {
  runId: string;
  hits: LabeledHit[];
}

export interface RagMetrics {
  /** Runs that have at least one labeled hit. */
  labeledRuns: number;
  totalRuns: number;
  labeledHits: number;
  relevantHits: number;
  /** Judged-only precision@k, averaged over runs with a judged hit inside top-k. */
  precisionAtK: Record<number, number>;
  /** Number of labeled runs that actually have a judgment inside top-k. */
  precisionEvaluatedRunsAtK: Record<number, number>;
  /** evaluated runs / labeled runs; must accompany precision to expose label coverage. */
  precisionCoverageAtK: Record<number, number>;
  /** Mean reciprocal rank of the first relevant hit, over labeled runs. */
  mrr: number;
  /** Fraction of labeled runs with at least one relevant hit in top-k. */
  hitRateAtK: Record<number, number>;
  /** Count per failure type (descending), only over labeled failures. */
  failureBreakdown: Array<{ failureType: RetrievalFailureType; count: number }>;
}

function round4(v: number): number {
  return Number(v.toFixed(4));
}

/** A run is "labeled" if any hit carries a non-null judgedRelevant. */
function isLabeled(run: RetrievalRunLabels): boolean {
  return run.hits.some((h) => h.judgedRelevant !== null);
}

function precisionAtKForRun(hits: LabeledHit[], k: number): number | null {
  const topK = hits.filter((h) => h.rank <= k);
  const labeled = topK.filter((h) => h.judgedRelevant !== null);
  if (labeled.length === 0) return null;
  const relevant = labeled.filter((h) => h.judgedRelevant === true).length;
  return relevant / labeled.length;
}

function reciprocalRankForRun(hits: LabeledHit[]): number {
  const firstRelevant = hits
    .filter((h) => h.judgedRelevant === true)
    .reduce((min, h) => Math.min(min, h.rank), Number.POSITIVE_INFINITY);
  return Number.isFinite(firstRelevant) ? 1 / firstRelevant : 0;
}

export function computeRagMetrics(runs: RetrievalRunLabels[], ks: number[] = [1, 3, 5]): RagMetrics {
  const labeledRuns = runs.filter(isLabeled);
  const precisionAtK: Record<number, number> = {};
  const precisionEvaluatedRunsAtK: Record<number, number> = {};
  const precisionCoverageAtK: Record<number, number> = {};
  const hitRateAtK: Record<number, number> = {};

  for (const k of ks) {
    const perRun = labeledRuns.map((r) => precisionAtKForRun(r.hits, k)).filter((v): v is number => v !== null);
    precisionAtK[k] = perRun.length > 0 ? round4(perRun.reduce((s, v) => s + v, 0) / perRun.length) : 0;
    precisionEvaluatedRunsAtK[k] = perRun.length;
    precisionCoverageAtK[k] = labeledRuns.length > 0 ? round4(perRun.length / labeledRuns.length) : 0;

    const hitRuns = labeledRuns.filter((r) => r.hits.some((h) => h.rank <= k && h.judgedRelevant === true));
    hitRateAtK[k] = labeledRuns.length > 0 ? round4(hitRuns.length / labeledRuns.length) : 0;
  }

  const mrrVals = labeledRuns.map((r) => reciprocalRankForRun(r.hits));
  const mrr = mrrVals.length > 0 ? round4(mrrVals.reduce((s, v) => s + v, 0) / mrrVals.length) : 0;

  const failureCounts = new Map<RetrievalFailureType, number>();
  for (const run of labeledRuns) {
    for (const hit of run.hits) {
      if (hit.judgedRelevant === false && hit.failureType) {
        failureCounts.set(hit.failureType, (failureCounts.get(hit.failureType) ?? 0) + 1);
      }
    }
  }
  const failureBreakdown = [...failureCounts.entries()]
    .map(([failureType, count]) => ({ failureType, count }))
    .sort((a, b) => b.count - a.count || a.failureType.localeCompare(b.failureType));

  const allLabeledHits = labeledRuns.flatMap((r) => r.hits.filter((h) => h.judgedRelevant !== null));

  return {
    labeledRuns: labeledRuns.length,
    totalRuns: runs.length,
    labeledHits: allLabeledHits.length,
    relevantHits: allLabeledHits.filter((h) => h.judgedRelevant === true).length,
    precisionAtK,
    precisionEvaluatedRunsAtK,
    precisionCoverageAtK,
    mrr,
    hitRateAtK,
    failureBreakdown,
  };
}

// ---------------------------------------------------------------------------
// CI regression gate: compare current metrics against a stored baseline.
// ---------------------------------------------------------------------------
export interface RagRegressionResult {
  passed: boolean;
  /** Per-metric deltas (current - baseline). Negative = regression. */
  deltas: {
    totalRuns: number;
    labeledRuns: number;
    labeledHits: number;
    mrr: number;
    precisionAtK: Record<number, number>;
    precisionCoverageAtK: Record<number, number>;
  };
  /** Metrics that dropped by more than `tolerance` below baseline. */
  regressions: string[];
  tolerance: number;
}

type ComparableRagMetrics = Pick<RagMetrics, 'mrr' | 'precisionAtK'>
  & Partial<Pick<RagMetrics, 'precisionCoverageAtK' | 'totalRuns' | 'labeledRuns' | 'labeledHits'>>;

function assertCount(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function assertUnitMetric(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be a finite value in [0,1]`);
  }
}

function assertMetricRecord(record: Record<number, number>, label: string): void {
  for (const [kRaw, value] of Object.entries(record)) {
    const k = Number(kRaw);
    if (!Number.isSafeInteger(k) || k < 1) throw new RangeError(`${label} k must be a positive integer`);
    assertUnitMetric(value, `${label}@${k}`);
  }
}

/**
 * A metric "regresses" only when it drops MORE than `tolerance` below baseline —
 * small noise from label churn does not fail CI. Improvements never fail. When
 * a baseline carries top-k judgment coverage, missing current coverage is zero
 * and therefore fails closed instead of letting sparse labels inflate precision.
 */
export function compareRagRegression(
  baseline: ComparableRagMetrics,
  current: ComparableRagMetrics,
  tolerance = 0.05,
): RagRegressionResult {
  assertUnitMetric(tolerance, 'tolerance');
  assertUnitMetric(baseline.mrr, 'baseline.mrr');
  assertUnitMetric(current.mrr, 'current.mrr');
  assertMetricRecord(baseline.precisionAtK, 'baseline.precision');
  assertMetricRecord(current.precisionAtK, 'current.precision');
  assertMetricRecord(baseline.precisionCoverageAtK ?? {}, 'baseline.precision_coverage');
  assertMetricRecord(current.precisionCoverageAtK ?? {}, 'current.precision_coverage');
  assertCount(baseline.totalRuns, 'baseline.totalRuns');
  assertCount(baseline.labeledRuns, 'baseline.labeledRuns');
  assertCount(baseline.labeledHits, 'baseline.labeledHits');
  assertCount(current.totalRuns, 'current.totalRuns');
  assertCount(current.labeledRuns, 'current.labeledRuns');
  assertCount(current.labeledHits, 'current.labeledHits');
  const regressions: string[] = [];
  const precisionDeltas: Record<number, number> = {};
  const coverageDeltas: Record<number, number> = {};
  const totalRunsDelta = (current.totalRuns ?? 0) - (baseline.totalRuns ?? 0);
  const labeledRunsDelta = (current.labeledRuns ?? 0) - (baseline.labeledRuns ?? 0);
  const labeledHitsDelta = (current.labeledHits ?? 0) - (baseline.labeledHits ?? 0);
  if (baseline.totalRuns !== undefined && totalRunsDelta < 0) regressions.push(`total_runs:${totalRunsDelta}`);
  if (baseline.labeledRuns !== undefined && labeledRunsDelta < 0) regressions.push(`labeled_runs:${labeledRunsDelta}`);
  if (baseline.labeledHits !== undefined && labeledHitsDelta < 0) regressions.push(`labeled_hits:${labeledHitsDelta}`);

  const mrrDelta = round4(current.mrr - baseline.mrr);
  if (mrrDelta < -tolerance) regressions.push(`mrr:${mrrDelta}`);

  for (const kStr of Object.keys(baseline.precisionAtK)) {
    const k = Number(kStr);
    const base = baseline.precisionAtK[k] ?? 0;
    const cur = current.precisionAtK[k] ?? 0;
    const delta = round4(cur - base);
    precisionDeltas[k] = delta;
    if (delta < -tolerance) regressions.push(`precision@${k}:${delta}`);
  }

  for (const kStr of Object.keys(baseline.precisionCoverageAtK ?? {})) {
    const k = Number(kStr);
    const base = baseline.precisionCoverageAtK?.[k] ?? 0;
    const cur = current.precisionCoverageAtK?.[k] ?? 0;
    const delta = round4(cur - base);
    coverageDeltas[k] = delta;
    if (delta < -tolerance) regressions.push(`precision_coverage@${k}:${delta}`);
  }

  return {
    passed: regressions.length === 0,
    deltas: { totalRuns: totalRunsDelta, labeledRuns: labeledRunsDelta, labeledHits: labeledHitsDelta, mrr: mrrDelta, precisionAtK: precisionDeltas, precisionCoverageAtK: coverageDeltas },
    regressions,
    tolerance,
  };
}

// ---------------------------------------------------------------------------
// Failure → fixture: turn labeled failures into reusable eval fixtures so a
// once-observed retrieval mistake becomes a permanent regression guard.
// ---------------------------------------------------------------------------
export interface RetrievalFailureFixture {
  runId: string;
  rank: number;
  failureType: RetrievalFailureType;
  /** Stable dedup key so the same failure is not exported twice. */
  fixtureKey: string;
}

export function exportFailureFixtures(runs: RetrievalRunLabels[]): RetrievalFailureFixture[] {
  const out: RetrievalFailureFixture[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    for (const hit of run.hits) {
      if (hit.judgedRelevant === false && hit.failureType) {
        const fixtureKey = `${run.runId}:${hit.rank}:${hit.failureType}`;
        if (seen.has(fixtureKey)) continue;
        seen.add(fixtureKey);
        out.push({ runId: run.runId, rank: hit.rank, failureType: hit.failureType, fixtureKey });
      }
    }
  }
  return out.sort((a, b) => a.fixtureKey.localeCompare(b.fixtureKey));
}
