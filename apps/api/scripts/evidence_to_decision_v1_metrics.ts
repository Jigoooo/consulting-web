import { EvidenceToDecisionService } from '../src/consulting/evidence-to-decision.service.js';

const service = new EvidenceToDecisionService();

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
  documents: [{
    id: 'DOC-BUDGET-01',
    title: '예산표.pdf',
    text: '창원시설공단 예산 자료\n| 항목 | 금액 |\n| 인건비 | 120 |\n| 유지보수 | 30 |\n본문 설명',
    qualityScore: 80,
  }],
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
  review_top: reviewQueue[0] ? { id: reviewQueue[0].id, score: reviewQueue[0].priorityScore, reasons: reviewQueue[0].reasons } : null,
}, null, 2));
