import process from 'node:process';
import { EvidenceToDecisionService, type ClaimVerdictKind } from '../src/consulting/evidence-to-decision.service.js';

const service = new EvidenceToDecisionService();

const fixtures: Array<{
  id: string;
  expected: ClaimVerdictKind;
  claim: string;
  evidence: string[];
}> = [
  {
    id: 'support-budget-staffing',
    expected: 'supports',
    claim: '정원 증가는 인건비 부담을 증가시킨다',
    evidence: ['정원 증가와 인건비 부담 증가는 재정소요의 핵심 요인이다'],
  },
  {
    id: 'support-maintenance-cost',
    expected: 'supports',
    claim: '유지보수 비용은 예산 판단에 영향을 준다',
    evidence: ['유지보수 비용은 예산 판단의 주요 영향 요인이다'],
  },
  {
    id: 'refute-parking-down',
    expected: 'refutes',
    claim: '주차장 수입은 감소했다',
    evidence: ['주차장 수입은 전년 대비 증가했으며 감소했다는 근거는 없다'],
  },
  {
    id: 'refute-expand-ops',
    expected: 'refutes',
    claim: '야간 운영 확대가 필요하다',
    evidence: ['야간 운영은 축소가 필요하며 확대 필요성은 확인되지 않았다'],
  },
  {
    id: 'nei-civil-night',
    expected: 'not_enough_info',
    claim: '체육시설 민원은 야간에 집중된다',
    evidence: ['체육시설 이용자 수와 예산 자료만 확인된다'],
  },
  {
    id: 'nei-false-positive-guard',
    expected: 'not_enough_info',
    claim: '창원시는 즉시 수영장 운영을 폐지해야 한다',
    evidence: ['창원시는 수영장 운영 현황을 점검했다. 폐지 여부는 결정되지 않았다.'],
  },
];

const rows = fixtures.map((fixture) => {
  const result = service.buildStrictJsonVerification({
    claims: [{ id: fixture.id, text: fixture.claim }],
    evidence: fixture.evidence.map((text, index) => ({ id: `${fixture.id}-ev-${index + 1}`, text, qualityScore: 90 })),
  });
  const actual = result.lattice.verdicts[0]?.verdict ?? 'not_enough_info';
  return { ...fixture, actual, pass: actual === fixture.expected };
});

function rate(kind: ClaimVerdictKind): number {
  const subset = rows.filter((row) => row.expected === kind);
  return subset.length === 0 ? 1 : subset.filter((row) => row.pass).length / subset.length;
}

const metrics = {
  verifier: 'strict_json_local_nli_v1',
  evidence_supported_rate: rate('supports'),
  refute_detection_rate: rate('refutes'),
  unsupported_deferral_rate: rate('not_enough_info'),
  overall_accuracy: rows.filter((row) => row.pass).length / rows.length,
  rows: rows.map((row) => ({ id: row.id, expected: row.expected, actual: row.actual, pass: row.pass })),
  thresholds: {
    evidence_supported_rate: 1,
    refute_detection_rate: 1,
    unsupported_deferral_rate: 1,
  },
};

console.log(JSON.stringify(metrics, null, 2));

if (
  metrics.evidence_supported_rate < metrics.thresholds.evidence_supported_rate ||
  metrics.refute_detection_rate < metrics.thresholds.refute_detection_rate ||
  metrics.unsupported_deferral_rate < metrics.thresholds.unsupported_deferral_rate
) {
  process.exit(1);
}
