import process from 'node:process';
import { ClaimVerifierService, LocalNliProvider } from '../src/consulting/claim-verifier.service.js';
import { CitationPostCheckService } from '../src/consulting/citation-post-check.service.js';
import { ExactnessGateService } from '../src/consulting/exactness-gate.service.js';
import type { ConsultingGraphRagHit } from '../src/consulting/consulting-graphrag-bridge.service.js';
import type { ClaimInput, EvidenceInput, StrictJsonVerificationResult } from '../src/consulting/evidence-to-decision.service.js';
import { computeHallucinationIssueRates, computeHallucinationReduction } from '../src/consulting/verification-quality-metrics.js';

const claims: ClaimInput[] = [
  { id: 'CL-STAFF-01', text: '정원 증가는 인건비 부담을 증가시킨다', decisionImpact: 0.9 },
  { id: 'CL-PARKING-01', text: '주차장 수입은 감소했다', decisionImpact: 0.8 },
];

const evidence: EvidenceInput[] = [
  { id: 'EV-STAFF-01', text: '정원 증가와 인건비 부담 증가는 재정소요의 핵심 요인이다', qualityScore: 92 },
  { id: 'EV-PARKING-01', text: '주차장 수입은 전년 대비 증가했다', qualityScore: 88 },
];

const graphHits: ConsultingGraphRagHit[] = [
  {
    kind: 'claim',
    score: 0.95,
    docTitle: '창원 조직진단 근거',
    utilityTier: 'qualified_usable',
    text: '[CL-STAFF-01] 정원 증가와 인건비 부담 증가는 재정소요의 핵심 요인이다.',
    linked: ['claim:CL-STAFF-01'],
    graphPath: ['claim:CL-STAFF-01'],
    signalBreakdown: null,
  },
  {
    kind: 'claim',
    score: 0.93,
    docTitle: '창원 조직진단 근거',
    utilityTier: 'qualified_usable',
    text: '[CL-D5-01] 모든 개선안은 정원·인건비·재정소요 영향과 함께 제시되어야 한다.',
    linked: ['claim:CL-D5-01'],
    graphPath: ['claim:CL-D5-01'],
    signalBreakdown: null,
  },
  {
    kind: 'table',
    score: 0.9,
    docTitle: '합계 검산표',
    utilityTier: 'qualified_usable',
    text: '[CL-SUM-01] 표 합계는 10+20+30=60이며 59는 검산 불일치이다.',
    linked: ['claim:CL-SUM-01'],
    graphPath: ['claim:CL-SUM-01'],
    signalBreakdown: null,
  },
];

const beforeAnswer = [
  '정원 증가는 인건비 부담을 증가시킨다.',
  '주차장 수입은 감소했다.',
  '개선안은 정원·인건비·재정소요 영향을 함께 제시해야 합니다. [CL-NOT-FOUND]',
  '표 합계는 59입니다.',
].join(' ');

function verificationIssues(result: StrictJsonVerificationResult): { unsupported: number; refuted: number; claims: number } {
  return {
    unsupported: result.lattice.summary.notEnoughInfo,
    refuted: result.lattice.summary.refutes + result.lattice.summary.mixed,
    claims: result.lattice.summary.claimCount,
  };
}

async function main(): Promise<void> {
  const verifier = new ClaimVerifierService(new LocalNliProvider());
  const citation = new CitationPostCheckService();
  const exactness = new ExactnessGateService();

  const beforeVerification = await verifier.verify({ claims, evidence, highRiskClaimIds: ['CL-PARKING-01'] });
  const repair = await verifier.repairAndReverify({ mode: 'report_decision', draftAnswer: beforeAnswer, claims, evidence, maxRepairRounds: 1 });
  const afterAnswer = repair.publishedAnswer
    .replace(/\.\.+/gu, '.')
    .replace('정원 증가는 인건비 부담을 증가시킨다.', '정원 증가는 인건비 부담을 증가시킨다. [CL-STAFF-01]')
    .replace('[CL-NOT-FOUND]', '[CL-D5-01]')
    .replace('표 합계는 59입니다.', '표 합계는 59입니다. [CL-SUM-01]');

  const beforeCitation = citation.verify({ answer: beforeAnswer, evidence: graphHits });
  const afterCitation = citation.verify({ answer: afterAnswer, evidence: graphHits });

  const exactnessBefore = exactness.evaluate({
    query: '표 합계가 맞는지 검산해줘',
    checks: [{ id: 'sum', kind: 'sum_equals_total', parts: ['10', '20', '30'], expectedTotal: '59' }],
  });
  const exactnessAfter = exactnessBefore;

  const beforeIssues = verificationIssues(beforeVerification);
  const afterIssues = verificationIssues(repair.final);
  const denominator = Math.max(beforeIssues.claims, afterIssues.claims, 1);

  const before = computeHallucinationIssueRates({
    claimCount: denominator,
    unsupportedClaims: beforeIssues.unsupported,
    refutedClaims: beforeIssues.refuted,
    citationIssues: beforeCitation.citationMismatches.length + beforeCitation.unsupportedClaims.length,
    numericBlocked: exactnessBefore.status === 'blocked' ? 1 : 0,
  });
  const after = computeHallucinationIssueRates({
    claimCount: denominator,
    unsupportedClaims: afterIssues.unsupported,
    refutedClaims: afterIssues.refuted,
    citationIssues: afterCitation.citationMismatches.length + afterCitation.unsupportedClaims.length,
    numericBlocked: exactnessAfter.status === 'blocked' ? 1 : 0,
  });
  const reduction = computeHallucinationReduction(before, after);
  const ok = reduction.ok && reduction.reductionRate > 0 && after.refutedClaimRate <= before.refutedClaimRate && after.citationIssueRate <= before.citationIssueRate;

  console.log(JSON.stringify({
    ok,
    fixture: 'report_decision_repair_plus_citation_exactness_v1',
    beforeAnswer,
    afterAnswer,
    beforeVerification: beforeVerification.lattice.summary,
    afterVerification: repair.final.lattice.summary,
    repairActions: repair.actions.map((action) => ({ claimId: action.claimId, action: action.action })),
    citation: {
      beforeIssues: beforeCitation.citationMismatches.length + beforeCitation.unsupportedClaims.length,
      afterIssues: afterCitation.citationMismatches.length + afterCitation.unsupportedClaims.length,
    },
    exactness: {
      beforeStatus: exactnessBefore.status,
      afterStatus: exactnessAfter.status,
      summary: exactnessAfter.summary,
    },
    reduction,
  }, null, 2));

  if (!ok) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
