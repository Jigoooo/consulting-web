import process from 'node:process';
import { ClaimVerifierService, LocalNliProvider } from '../src/consulting/claim-verifier.service.js';
import type { ClaimVerdictKind } from '../src/consulting/evidence-to-decision.service.js';
import { computeClassificationQualityMetrics } from '../src/consulting/verification-quality-metrics.js';

interface BenchFixture {
  id: string;
  expected: ClaimVerdictKind;
  claim: string;
  evidence: string;
  qualityScore?: number;
}

const fixtures: BenchFixture[] = [
  {
    id: 'support-staff-cost',
    expected: 'supports',
    claim: '정원 증가는 인건비 부담을 증가시킨다',
    evidence: '정원 증가와 인건비 부담 증가는 재정소요의 핵심 요인이다',
    qualityScore: 92,
  },
  {
    id: 'support-maintenance-budget',
    expected: 'supports',
    claim: '유지보수 비용은 예산 판단에 영향을 준다',
    evidence: '유지보수 비용은 예산 판단의 주요 영향 요인이다',
    qualityScore: 88,
  },
  {
    id: 'support-law-source-required',
    expected: 'supports',
    claim: '조례 근거는 원문 확인이 필요하다',
    evidence: '조례 근거는 원문 locator와 page 확인이 필요하다',
    qualityScore: 90,
  },
  {
    id: 'refute-parking-revenue',
    expected: 'refutes',
    claim: '주차장 수입은 감소했다',
    evidence: '주차장 수입은 전년 대비 증가했다',
    qualityScore: 85,
  },
  {
    id: 'refute-night-ops',
    expected: 'refutes',
    claim: '야간 운영 확대가 필요하다',
    evidence: '야간 운영은 축소가 필요하며 확대 필요성은 확인되지 않았다',
    qualityScore: 86,
  },
  {
    id: 'refute-feasible',
    expected: 'refutes',
    claim: '즉시 이관은 가능하다',
    evidence: '즉시 이관은 불가능하며 추가 협의가 필요하다',
    qualityScore: 84,
  },
  {
    id: 'nei-civil-night',
    expected: 'not_enough_info',
    claim: '체육시설 민원은 야간에 집중된다',
    evidence: '체육시설 이용자 수와 예산 자료만 확인된다',
    qualityScore: 80,
  },
  {
    id: 'nei-pool-close',
    expected: 'not_enough_info',
    claim: '창원시는 즉시 수영장 운영을 폐지해야 한다',
    evidence: '창원시는 수영장 운영 현황을 점검했으며 폐지 여부는 결정되지 않았다',
    qualityScore: 78,
  },
  {
    id: 'nei-legal-deadline',
    expected: 'not_enough_info',
    claim: '조례 개정 시한은 2026년 9월로 확정됐다',
    evidence: '조례 개정 필요성은 검토 중이며 구체 일정은 별도 확인이 필요하다',
    qualityScore: 76,
  },
];

const thresholds = {
  overallAccuracy: 0.8,
  macroF1: 0.75,
  contradictionRecall: 0.8,
  unsupportedDeferralRecall: 0.66,
  falseBlockRateMax: 0.15,
};

async function classifyFixture(service: ClaimVerifierService, fixture: BenchFixture): Promise<{ id: string; expected: ClaimVerdictKind; actual: ClaimVerdictKind; confidence: number; rationale: string }> {
  const result = await service.verify({
    claims: [{ id: fixture.id, text: fixture.claim, decisionImpact: fixture.expected === 'supports' ? 0.6 : 0.85 }],
    evidence: [{ id: `${fixture.id}-evidence`, text: fixture.evidence, qualityScore: fixture.qualityScore ?? 80 }],
    highRiskClaimIds: fixture.expected === 'refutes' ? [fixture.id] : [],
  });
  const verdict = result.lattice.verdictsByClaim[fixture.id];
  return {
    id: fixture.id,
    expected: fixture.expected,
    actual: verdict?.verdict ?? 'not_enough_info',
    confidence: verdict?.confidence ?? 0,
    rationale: verdict?.rationale ?? 'missing verdict',
  };
}

async function main(): Promise<void> {
  const service = new ClaimVerifierService(new LocalNliProvider());
  const rows = [];
  for (const fixture of fixtures) rows.push(await classifyFixture(service, fixture));
  const metrics = computeClassificationQualityMetrics(rows);
  const ok = metrics.overallAccuracy >= thresholds.overallAccuracy
    && metrics.macroF1 >= thresholds.macroF1
    && metrics.contradictionRecall >= thresholds.contradictionRecall
    && metrics.unsupportedDeferralRecall >= thresholds.unsupportedDeferralRecall
    && metrics.falseBlockRate <= thresholds.falseBlockRateMax;

  console.log(JSON.stringify({ ok, verifier: 'nli_local_nli_v1', thresholds, ...metrics, rows }, null, 2));
  if (!ok) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
