/**
 * W3 decision-analytics demo — 창원 실수요 시나리오로 MCDA 5축 민감도 + 몬테카를로
 * 파급액 구간을 실측한다. read-only 계산만. 배포/DB write 없음.
 */
import {
  analyzeWeightSensitivity,
  estimateImpactInterval,
  type AlternativeScoreInput,
  type WeightedCriterion,
} from '../src/consulting/decision-analytics.js';

// 5축 평가(A~E): 법적정합·재정부담·형평성·운영난이도·수용성
const criteria: WeightedCriterion[] = [
  { id: 'legal', label: '법적 정합성', normalizedWeight: 0.30 },
  { id: 'fiscal', label: '재정 부담', normalizedWeight: 0.25, direction: 'lower_is_better' },
  { id: 'equity', label: '형평성', normalizedWeight: 0.20 },
  { id: 'ops', label: '운영 난이도', normalizedWeight: 0.15, direction: 'lower_is_better' },
  { id: 'accept', label: '수용성', normalizedWeight: 0.10 },
];

const alternatives: AlternativeScoreInput[] = [
  { alternativeId: 'new_allowance', label: '수당 신설', scoresByCriterion: { legal: 0.7, fiscal: 0.6, equity: 0.8, ops: 0.5, accept: 0.75 } },
  { alternativeId: 'expand_existing', label: '기존 수당 확대', scoresByCriterion: { legal: 0.85, fiscal: 0.5, equity: 0.6, ops: 0.3, accept: 0.6 } },
  { alternativeId: 'status_quo', label: '현행 유지', scoresByCriterion: { legal: 0.9, fiscal: 0.1, equity: 0.35, ops: 0.1, accept: 0.4 } },
];

const sensitivity = analyzeWeightSensitivity({ criteria, alternatives, seed: 2026, scenarios: 2000 });

// 통상임금 파급액 구간: 대상인원 × 월평균 추가액 × 12개월 × 소급계수
const impact = estimateImpactInterval({
  drivers: [
    { id: 'headcount', label: '대상 인원', min: 820, mode: 900, max: 1010 },
    { id: 'monthlyAdd', label: '월 추가액(원)', min: 90_000, mode: 120_000, max: 160_000 },
    { id: 'retroFactor', label: '소급 계수', min: 1.0, mode: 1.2, max: 1.6 },
  ],
  combine: (s) => s.headcount! * s.monthlyAdd! * 12 * s.retroFactor!,
  iterations: 20000,
  seed: 2026,
});

const won = (n: number) => `${Math.round(n).toLocaleString('ko-KR')}원`;

console.log(JSON.stringify({
  sensitivity: {
    baselineWinner: sensitivity.baselineWinnerId,
    winnerStability: sensitivity.winnerStability,
    criticalCriteria: sensitivity.criticalCriteria.filter((c) => c.flipsWinner).map((c) => c.label),
  },
  impactInterval: {
    p10: won(impact.p10), p50: won(impact.p50), p90: won(impact.p90), mean: won(impact.mean),
  },
}, null, 2));
