import { describe, expect, it } from 'vitest';
import {
  compareRagRegression,
  computeRagMetrics,
  exportFailureFixtures,
  type RetrievalRunLabels,
} from '../src/consulting/rag-metrics.js';

const runs: RetrievalRunLabels[] = [
  {
    runId: 'run-1',
    hits: [
      { rank: 1, judgedRelevant: true, failureType: null },
      { rank: 2, judgedRelevant: false, failureType: 'semantic_false_positive' },
      { rank: 3, judgedRelevant: true, failureType: null },
    ],
  },
  {
    runId: 'run-2',
    hits: [
      { rank: 1, judgedRelevant: false, failureType: 'wrong_project' },
      { rank: 2, judgedRelevant: true, failureType: null },
      { rank: 3, judgedRelevant: false, failureType: 'semantic_false_positive' },
    ],
  },
  {
    // Unlabeled run — must be excluded from labeled metrics.
    runId: 'run-3',
    hits: [
      { rank: 1, judgedRelevant: null, failureType: null },
      { rank: 2, judgedRelevant: null, failureType: null },
    ],
  },
];

describe('computeRagMetrics', () => {
  it('counts labeled vs total runs and relevant hits', () => {
    const m = computeRagMetrics(runs);
    expect(m.totalRuns).toBe(3);
    expect(m.labeledRuns).toBe(2);
    expect(m.labeledHits).toBe(6); // 3 + 3 labeled, run-3 excluded
    expect(m.relevantHits).toBe(3);
  });

  it('computes precision@1 as the mean over labeled runs', () => {
    // run-1 P@1 = 1/1 (rank1 relevant); run-2 P@1 = 0/1 (rank1 failure) → mean 0.5
    const m = computeRagMetrics(runs, [1]);
    expect(m.precisionAtK[1]).toBe(0.5);
  });

  it('computes precision@3 over all labeled top-3 hits', () => {
    // run-1: 2/3, run-2: 1/3 → mean = (0.6667 + 0.3333)/2 = 0.5
    const m = computeRagMetrics(runs, [3]);
    expect(m.precisionAtK[3]).toBeCloseTo(0.5, 3);
  });

  it('reports precision judgment coverage instead of hiding partially labeled runs', () => {
    const partial: RetrievalRunLabels[] = [
      { runId: 'top-labeled', hits: [{ rank: 1, judgedRelevant: true, failureType: null }] },
      { runId: 'tail-only', hits: [{ rank: 10, judgedRelevant: false, failureType: 'wrong_topic' }] },
    ];
    const m = computeRagMetrics(partial, [1]);

    expect(m.precisionAtK[1]).toBe(1);
    expect(m.precisionEvaluatedRunsAtK[1]).toBe(1);
    expect(m.precisionCoverageAtK[1]).toBe(0.5);
  });

  it('computes MRR from the first relevant rank per run', () => {
    // run-1 first relevant rank 1 → 1.0; run-2 first relevant rank 2 → 0.5 → mean 0.75
    const m = computeRagMetrics(runs);
    expect(m.mrr).toBe(0.75);
  });

  it('computes hit-rate@k over labeled runs', () => {
    const m = computeRagMetrics(runs, [1, 3]);
    // @1: run-1 yes, run-2 no → 0.5 ; @3: both yes → 1.0
    expect(m.hitRateAtK[1]).toBe(0.5);
    expect(m.hitRateAtK[3]).toBe(1);
  });

  it('breaks down failures by type, descending', () => {
    const m = computeRagMetrics(runs);
    expect(m.failureBreakdown).toEqual([
      { failureType: 'semantic_false_positive', count: 2 },
      { failureType: 'wrong_project', count: 1 },
    ]);
  });

  it('returns zeros for an empty or fully-unlabeled set', () => {
    const m = computeRagMetrics([runs[2]!], [1, 3]);
    expect(m.labeledRuns).toBe(0);
    expect(m.mrr).toBe(0);
    expect(m.precisionAtK[1]).toBe(0);
    expect(m.failureBreakdown).toEqual([]);
  });
});

describe('compareRagRegression', () => {
  const baseline = { mrr: 0.75, precisionAtK: { 1: 0.6, 3: 0.5 } };

  it('passes when metrics improve or hold', () => {
    const r = compareRagRegression(baseline, { mrr: 0.8, precisionAtK: { 1: 0.6, 3: 0.55 } });
    expect(r.passed).toBe(true);
    expect(r.regressions).toEqual([]);
    expect(r.deltas.mrr).toBeCloseTo(0.05, 3);
  });

  it('passes when a drop is within tolerance (label noise)', () => {
    const r = compareRagRegression(baseline, { mrr: 0.72, precisionAtK: { 1: 0.57, 3: 0.5 } }, 0.05);
    expect(r.passed).toBe(true);
  });

  it('fails when a metric drops beyond tolerance', () => {
    const r = compareRagRegression(baseline, { mrr: 0.6, precisionAtK: { 1: 0.4, 3: 0.5 } }, 0.05);
    expect(r.passed).toBe(false);
    expect(r.regressions).toContain('mrr:-0.15');
    expect(r.regressions.some((s) => s.startsWith('precision@1'))).toBe(true);
  });

  it('fails when judged precision improves only because top-k label coverage collapsed', () => {
    const coveredBaseline = {
      mrr: 0.5,
      precisionAtK: { 1: 0.5 },
      precisionCoverageAtK: { 1: 1 },
    };
    const sparseCurrent = {
      mrr: 0.5,
      precisionAtK: { 1: 1 },
      precisionCoverageAtK: { 1: 0.5 },
    };
    const r = compareRagRegression(coveredBaseline, sparseCurrent, 0.05);

    expect(r.passed).toBe(false);
    expect(r.regressions).toContain('precision_coverage@1:-0.5');
  });
  it('rejects non-finite metrics and tolerance instead of passing CI by NaN comparison', () => {
    const coveredBaseline = {
      mrr: 0.5,
      precisionAtK: { 1: 0.5 },
      precisionCoverageAtK: { 1: 1 },
    };

    expect(() => compareRagRegression(coveredBaseline, {
      mrr: Number.NaN,
      precisionAtK: { 1: 0.5 },
      precisionCoverageAtK: { 1: 1 },
    })).toThrow(RangeError);
    expect(() => compareRagRegression(coveredBaseline, {
      mrr: 0.5,
      precisionAtK: { 1: Number.POSITIVE_INFINITY },
      precisionCoverageAtK: { 1: 1 },
    })).toThrow(RangeError);
    expect(() => compareRagRegression(coveredBaseline, {
      mrr: 0.5,
      precisionAtK: { 1: 0.5 },
      precisionCoverageAtK: { 1: Number.NaN },
    })).toThrow(RangeError);
    expect(() => compareRagRegression(coveredBaseline, coveredBaseline, Number.POSITIVE_INFINITY))
      .toThrow(RangeError);
  });
});

describe('exportFailureFixtures', () => {
  it('exports one fixture per labeled failure, deduped and sorted', () => {
    const fx = exportFailureFixtures(runs);
    expect(fx.map((f) => f.fixtureKey)).toEqual([
      'run-1:2:semantic_false_positive',
      'run-2:1:wrong_project',
      'run-2:3:semantic_false_positive',
    ]);
  });

  it('does not export relevant or unlabeled hits', () => {
    const fx = exportFailureFixtures(runs);
    expect(fx.every((f) => f.failureType)).toBe(true);
    expect(fx.length).toBe(3);
  });
});
