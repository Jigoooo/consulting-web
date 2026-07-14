import type { RagEvalMetricsSummary } from '@consulting/contracts';

export interface RagMetricCardView {
  label: string;
  value: string;
  detail: string;
}

export function buildRagMetricPresentation(summary: RagEvalMetricsSummary, k = 3): {
  cards: RagMetricCardView[];
  failures: Array<{ label: string; count: number }>;
  notice: string | null;
} {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const measured = summary.status !== 'insufficient_labels';
  const topKEvaluatedRuns = summary.precisionEvaluatedRunsAtK[k] ?? 0;
  const topKMeasured = measured && topKEvaluatedRuns > 0;
  const cohortLabel = summary.cohortTruncated && summary.cohortLimit
    ? `최근 최대 ${summary.cohortLimit.toLocaleString('ko-KR')}개`
    : '전체';
  const notices: string[] = [];
  if (summary.status === 'insufficient_labels') {
    notices.push('사람이 판정한 검색 라벨이 없어 품질 점수를 계산할 수 없습니다.');
  } else if (summary.status === 'partial_labels') {
    notices.push('일부 검색 실행만 라벨링된 잠정 수치입니다. 전체 실행으로 일반화하지 마세요.');
  }
  if (measured && !topKMeasured) {
    notices.push(`top-${k} 안에 판정 라벨이 없어 Precision과 Hit-rate를 측정할 수 없습니다.`);
  }
  if (summary.cohortTruncated && summary.cohortLimit) {
    notices.push(`전체 기간이 아닌 최근 최대 ${summary.cohortLimit.toLocaleString('ko-KR')}개 실행 표본입니다.`);
  }
  return {
    cards: [
      {
        label: `Precision@${k}`,
        value: topKMeasured ? pct(summary.precisionAtK[k] ?? 0) : '—',
        detail: `판정 실행 ${topKEvaluatedRuns}/${summary.labeledRuns} · top-k 범위 ${pct(summary.precisionCoverageAtK[k] ?? 0)}`,
      },
      {
        label: 'MRR',
        value: measured ? summary.mrr.toFixed(3) : '—',
        detail: `라벨 실행 ${summary.labeledRuns}/${summary.totalRuns} · ${cohortLabel} ${pct(summary.labeledRunCoverage)}`,
      },
      {
        label: `Hit-rate@${k}`,
        value: topKMeasured ? pct(summary.hitRateAtK[k] ?? 0) : '—',
        detail: `관련 근거 ${summary.relevantHits}/${summary.labeledHits}`,
      },
    ],
    failures: summary.failureBreakdown.map((item) => ({ label: item.failureType, count: item.count })),
    notice: notices.length > 0 ? notices.join(' ') : null,
  };
}
