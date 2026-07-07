import { ClaimVerifierService, type NliProvider } from '../src/consulting/claim-verifier.service.js';
import { EvidenceToDecisionService } from '../src/consulting/evidence-to-decision.service.js';
import { ExactnessGateService } from '../src/consulting/exactness-gate.service.js';

const service = new EvidenceToDecisionService();
const exactness = new ExactnessGateService();

const lattice = service.buildClaimVerificationLattice({
  claims: [
    { id: 'CL-STAFF-01', text: '정원 증가는 인건비 부담을 증가시킨다', decisionImpact: 0.9 },
    { id: 'CL-PARKING-01', text: '주차장 수입은 감소했다', decisionImpact: 0.7 },
    { id: 'CL-CIVIL-01', text: '체육시설 민원은 야간에 집중된다', decisionImpact: 0.5 },
  ],
  evidence: [
    { id: 'EV-BUDGET-01', text: '정원 증가와 인건비 부담 증가는 재정소요의 핵심 요인이다', qualityScore: 90 },
    { id: 'EV-PARKING-01', text: '주차장 수입은 전년 대비 증가했으며 감소했다는 근거는 없다', qualityScore: 85 },
  ],
});

const changwonKoreanLattice = service.buildClaimVerificationLattice({
  claims: [
    { id: 'CW-PROMOTION-01', text: '창원시 본청 공무직은 별도 승진체계가 없다', decisionImpact: 0.88 },
    { id: 'CW-LEPORTS-01', text: '레포츠파크 이관은 즉시 확정됐다', decisionImpact: 0.9 },
    { id: 'CW-LAW-01', text: '지방공기업 설립기준 조례 근거는 원문 확인이 필요하다', decisionImpact: 0.84 },
  ],
  evidence: [
    { id: 'CW-EV-PROMOTION', text: '창원시 본청 공무직에는 별도 승진체계가 확인되지 않으며, 공단과 비교 검토가 필요하다', qualityScore: 92 },
    { id: 'CW-EV-LEPORTS', text: '레포츠파크 이관 가능성은 검토 대상이나 즉시 확정된 것은 아니다', qualityScore: 90 },
    { id: 'CW-EV-LAW', text: '지방공기업 설립기준과 조례 근거는 원문 locator/page 확인 전 단정하지 않는다', qualityScore: 88 },
  ],
});

const truthQueue = service.buildTruthMaintenanceQueue({
  changedEvidenceIds: ['EV-BUDGET-01'],
  verdicts: lattice.verdicts,
  artifacts: [{ id: 'REPORT-ORG-01', kind: 'report', title: '조직진단 보고서', claimIds: ['CL-STAFF-01'] }],
});

const scorecard = service.buildDecisionScorecard({
  question: '조직진단 후속조치 우선순위는?',
  alternatives: [
    { id: 'ALT-STAFF', label: '인력 재배치' },
    { id: 'ALT-HOURS', label: '시설 운영시간 조정' },
  ],
  criteria: [
    { id: 'impact', label: '효과', weight: 0.5 },
    { id: 'feasibility', label: '실행가능성', weight: 0.3 },
    { id: 'risk', label: '리스크', weight: 0.2, direction: 'lower_is_better' },
  ],
  ratings: [
    { alternativeId: 'ALT-STAFF', criterionId: 'impact', score: 0.9, uncertainty: 0.1, evidenceIds: ['EV-BUDGET-01'] },
    { alternativeId: 'ALT-STAFF', criterionId: 'feasibility', score: 0.7, uncertainty: 0.2, evidenceIds: ['EV-OPS-01'] },
    { alternativeId: 'ALT-STAFF', criterionId: 'risk', score: 0.3, uncertainty: 0.2, evidenceIds: ['EV-RISK-01'] },
    { alternativeId: 'ALT-HOURS', criterionId: 'impact', score: 0.5, uncertainty: 0.2, evidenceIds: ['EV-CIVIL-01'] },
    { alternativeId: 'ALT-HOURS', criterionId: 'feasibility', score: 0.8, uncertainty: 0.15, evidenceIds: ['EV-OPS-02'] },
    { alternativeId: 'ALT-HOURS', criterionId: 'risk', score: 0.2, uncertainty: 0.1, evidenceIds: [] },
  ],
});

const diffusion = service.diffuseGraph({
  seedIds: ['thread:current'],
  edges: [
    { from: 'thread:current', to: 'topic:budget', weight: 1, relation: 'same_project' },
    { from: 'topic:budget', to: 'project:benchmark', weight: 0.8, relation: 'cross_project' },
    { from: 'thread:current', to: 'topic:noise', weight: 0.1, relation: 'same_project' },
  ],
  mode: 'ppr',
  iterations: 12,
});

const documentUnits = service.buildDocumentRetrievalUnits({
  documents: [
    {
      id: 'DOC-BUDGET-01',
      title: '예산표.pdf',
      text: '창원시설공단 예산 자료\n| 항목 | 금액 |\n| 인건비 | 120 |\n| 유지보수 | 30 |\n본문 설명',
      qualityScore: 80,
    },
    {
      id: 'DOC-VISUAL-CHART-01',
      title: '시설별 수지율 차트.pdf',
      text: '시설별 수지율 chart/figure: 수영장 71%, 주차장 108%, 레포츠파크 62%. 이미지형 차트가 포함된 페이지다.',
      qualityScore: 78,
    },
    {
      id: 'DOC-SCANNED-01',
      title: '스캔본-조례근거.pdf',
      text: '스캔 페이지 OCR: 지방공기업 설립기준 조례 근거 확인 필요. 원문 locator/page 기반 확인 전 단정 금지.',
      qualityScore: 72,
    },
  ],
});

const exactnessFixtures = [
  {
    id: 'percentage-change-staffing',
    result: exactness.evaluate({ query: '정원 12명에서 15명으로 늘면 증감률이 얼마야?', checks: [{ id: 'staffing_pct', kind: 'percentage_change', oldValue: '12', newValue: '15' }] }),
  },
  {
    id: 'money-unit-sum-mismatch',
    result: exactness.evaluate({ query: '인건비 120, 유지보수 30, 총액 200이 맞는지 검산', checks: [{ id: 'money_sum', kind: 'sum_equals_total', parts: ['120', '30'], expectedTotal: '200' }] }),
  },
  {
    id: 'law-source-locator-required',
    result: exactness.evaluate({ query: '지방공기업 설립기준 조례 근거 조항을 원문 없이 단정해줘', checks: [] }),
  },
];

const repairNli: NliProvider = {
  providerId: 'eval_repair_nli',
  model: 'fixture-repair-v1',
  classify({ claim }) {
    if (claim.id === 'CL-PARKING-01') return Promise.resolve({ label: 'contradiction', confidence: 0.87, latencyMs: 2, rationale: 'fixture refute' });
    return Promise.resolve({ label: 'entailment', confidence: 0.91, latencyMs: 2, rationale: 'fixture support' });
  },
};

async function main(): Promise<void> {
const repairWorkflow = await new ClaimVerifierService(repairNli).repairAndReverify({
  mode: 'report_decision',
  draftAnswer: '정원 증가는 인건비 부담을 증가시킨다. 주차장 수입은 감소했다.',
  claims: [
    { id: 'CL-STAFF-01', text: '정원 증가는 인건비 부담을 증가시킨다', decisionImpact: 0.9 },
    { id: 'CL-PARKING-01', text: '주차장 수입은 감소했다', decisionImpact: 0.7 },
  ],
  evidence: [
    { id: 'EV-BUDGET-01', text: '정원 증가와 인건비 부담 증가는 재정소요의 핵심 요인이다', qualityScore: 90 },
    { id: 'EV-PARKING-01', text: '주차장 수입은 전년 대비 증가했으며 감소했다는 근거는 없다', qualityScore: 85 },
  ],
  maxRepairRounds: 1,
});

const reviewQueue = service.prioritizeReviewQueue({
  now: new Date('2026-07-07T00:00:00Z'),
  items: [
    { id: 'RV-LOW', kind: 'claim', title: '낮은 영향 claim', decisionImpact: 0.2, uncertainty: 0.4, evidenceGap: 0.5 },
    { id: 'RV-URGENT', kind: 'decision', title: '임원 보고 핵심 판단', decisionImpact: 0.95, uncertainty: 0.8, evidenceGap: 0.9, dueAt: new Date('2026-07-07T06:00:00Z') },
  ],
});

console.log(JSON.stringify({
  claim_verdict_summary: lattice.summary,
  changwon_korean_fixture_summary: changwonKoreanLattice.summary,
  changwon_korean_verdicts: changwonKoreanLattice.verdicts.map((item) => ({ claimId: item.claimId, verdict: item.verdict, confidence: item.confidence, evidenceId: item.evidenceId })),
  truth_queue_items: truthQueue.length,
  top_truth_priority: truthQueue[0]?.priorityScore ?? 0,
  recommended_alternative: scorecard.recommendedAlternativeId,
  decision_ranked: scorecard.ranked.map((item) => ({ id: item.alternativeId, score: item.weightedScore, action: item.requiredAction, coverage: item.evidenceCoverage })),
  diffusion_method: diffusion.method,
  diffusion_top3: diffusion.ranked.slice(0, 3),
  document_units_by_modality: documentUnits.reduce<Record<string, number>>((acc, unit) => {
    acc[unit.modality] = (acc[unit.modality] ?? 0) + 1;
    return acc;
  }, {}),
  visual_pdf_fixtures: documentUnits.filter((unit) => unit.modality === 'page_visual' || unit.modality === 'table').map((unit) => ({ documentId: unit.documentId, modality: unit.modality, locator: unit.locator, scorePrior: unit.scorePrior })).slice(0, 12),
  exactness_fixtures: exactnessFixtures.map((fixture) => ({ id: fixture.id, status: fixture.result.status, required: fixture.result.required, summary: fixture.result.summary, checks: fixture.result.checks.map((check) => ({ id: check.id, kind: check.kind, status: check.status, value: check.value, expected: check.expected })) })),
  repair_workflow: {
    repairRounds: repairWorkflow.repairRounds,
    actions: repairWorkflow.actions.map((action) => ({ claimId: action.claimId, action: action.action })),
    requiresManualAction: repairWorkflow.requiresManualAction,
    finalSummary: repairWorkflow.final.lattice.summary,
    nodeDurationsMs: repairWorkflow.nodeDurationsMs,
    langGraph: repairWorkflow.langGraph,
  },
  review_top: reviewQueue[0] ? { id: reviewQueue[0].id, score: reviewQueue[0].priorityScore, reasons: reviewQueue[0].reasons } : null,
}, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
