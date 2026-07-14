import { describe, expect, it } from 'vitest';
import type { RagEvalMetricsSummary } from '@consulting/contracts';
import { buildRagMetricPresentation } from './ragEvalPresentation';

const summary: RagEvalMetricsSummary = {
  runKind: 'retrieval_human_labels',
  scope: 'workspace',
  status: 'ready',
  cohortLimit: null,
  cohortTruncated: false,
  totalRuns: 2,
  labeledRuns: 2,
  labeledRunCoverage: 1,
  labeledHits: 6,
  relevantHits: 3,
  precisionAtK: { 1: 0.5, 3: 0.5, 5: 0.5 },
  precisionEvaluatedRunsAtK: { 1: 2, 3: 2, 5: 2 },
  precisionCoverageAtK: { 1: 1, 3: 1, 5: 1 },
  mrr: 0.75,
  hitRateAtK: { 1: 0.5, 3: 1, 5: 1 },
  failureBreakdown: [{ failureType: 'semantic_false_positive', count: 2 }],
  failureFixtureCount: 2,
};

describe('RAG eval metric cards', () => {
  it('presents precision, MRR, hit-rate and label coverage without raw evidence', () => {
    const view = buildRagMetricPresentation(summary, 3);
    expect(view.cards).toEqual([
      { label: 'Precision@3', value: '50.0%', detail: '판정 실행 2/2 · top-k 범위 100.0%' },
      { label: 'MRR', value: '0.750', detail: '라벨 실행 2/2 · 전체 100.0%' },
      { label: 'Hit-rate@3', value: '100.0%', detail: '관련 근거 3/6' },
    ]);
    expect(view.failures).toEqual([{ label: 'semantic_false_positive', count: 2 }]);
    expect(view.notice).toBeNull();
  });

  it('marks a sparse labeled cohort as provisional rather than ready', () => {
    const view = buildRagMetricPresentation({
      ...summary,
      status: 'partial_labels',
      totalRuns: 100,
      labeledRuns: 1,
      labeledRunCoverage: 0.01,
      precisionEvaluatedRunsAtK: { 1: 1, 3: 1, 5: 1 },
    }, 3);
    expect(view.cards[1]?.detail).toContain('1/100');
    expect(view.notice).toContain('잠정 수치');
  });

  it('does not present unlabeled zeroes as measured retrieval quality', () => {
    const view = buildRagMetricPresentation({
      ...summary,
      status: 'insufficient_labels',
      labeledRuns: 0,
      labeledRunCoverage: 0,
      labeledHits: 0,
      relevantHits: 0,
      precisionAtK: { 1: 0, 3: 0, 5: 0 },
      precisionEvaluatedRunsAtK: { 1: 0, 3: 0, 5: 0 },
      precisionCoverageAtK: { 1: 0, 3: 0, 5: 0 },
      mrr: 0,
      hitRateAtK: { 1: 0, 3: 0, 5: 0 },
    }, 3);
    expect(view.cards.map((card) => card.value)).toEqual(['—', '—', '—']);
    expect(view.notice).toContain('라벨이 없어');
  });

  it('does not present top-k precision as 0% when no run was evaluated at k', () => {
    const view = buildRagMetricPresentation({
      ...summary,
      precisionAtK: { 1: 0, 3: 0, 5: 0 },
      precisionEvaluatedRunsAtK: { 1: 0, 3: 0, 5: 0 },
      precisionCoverageAtK: { 1: 0, 3: 0, 5: 0 },
      hitRateAtK: { 1: 0, 3: 0, 5: 0 },
    }, 3);
    expect(view.cards[0]?.value).toBe('—');
    expect(view.cards[2]?.value).toBe('—');
    expect(view.notice).toContain('top-3 안에 판정 라벨이 없어');
  });

  it('labels a truncated cohort as the latest bounded sample', () => {
    const view = buildRagMetricPresentation({
      ...summary,
      cohortLimit: 1_000,
      cohortTruncated: true,
    }, 3);
    expect(view.cards[1]?.detail).toContain('최근 최대 1,000개');
    expect(view.notice).toContain('전체 기간이 아닌');
  });
});
