import { describe, expect, it } from 'vitest';
import { schema } from '@consulting/db-schema';
import { EvidenceToDecisionService } from '../src/consulting/evidence-to-decision.service.js';
import { ClaimVerifierService } from '../src/consulting/claim-verifier.service.js';
import type { ClaimVerdict } from '../src/consulting/evidence-to-decision.service.js';

const service = new EvidenceToDecisionService();

function verdict(map: Record<string, ClaimVerdict>, claimId: string): ClaimVerdict {
  const found = map[claimId];
  expect(found).toBeDefined();
  return found!;
}

describe('EvidenceToDecisionService', () => {
  it('emits strict JSON verifier fixtures for support, refute, NEI, and false-positive guard', () => {
    const result = service.buildStrictJsonVerification({
      claims: [
        { id: 'support-tp', text: '정원 증가는 인건비 부담을 증가시킨다' },
        { id: 'refute-tp', text: '주차장 수입은 감소했다' },
        { id: 'nei-tp', text: '체육시설 민원은 야간에 집중된다' },
        { id: 'fp-guard', text: '창원시는 즉시 수영장 운영을 폐지해야 한다' },
      ],
      evidence: [
        { id: 'ev-support', text: '정원 증가와 인건비 부담 증가는 재정소요의 핵심 요인이다', qualityScore: 90 },
        { id: 'ev-refute', text: '주차장 수입은 전년 대비 증가했으며 감소했다는 근거는 없다', qualityScore: 85 },
        { id: 'ev-guard', text: '창원시는 수영장 운영 현황을 점검했다. 폐지 여부는 결정되지 않았다.', qualityScore: 80 },
      ],
    });

    expect(result.verifier).toBe('strict_json_local_nli_v1');
    expect(result.metrics.totalLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.lattice.verdicts[0]?.verifierTrace).toEqual(expect.objectContaining({ provider: 'local_nli', latencyMs: expect.any(Number) }));
    expect(result.strictJson.verdicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ claim_id: 'support-tp', verdict: 'supports' }),
      expect.objectContaining({ claim_id: 'refute-tp', verdict: 'refutes' }),
      expect.objectContaining({ claim_id: 'nei-tp', verdict: 'not_enough_info' }),
      expect.objectContaining({ claim_id: 'fp-guard', verdict: expect.not.stringMatching(/^supports$/) }),
    ]));
  });

  it('builds a FEVER-style claim verification lattice with supports, refutes, and not_enough_info', () => {
    expect(schema.claimVerificationVerdicts).toBeDefined();

    const lattice = service.buildClaimVerificationLattice({
      claims: [
        { id: 'c1', text: '정원 증가는 인건비 부담을 증가시킨다', decisionImpact: 0.9 },
        { id: 'c2', text: '주차장 수입은 감소했다', decisionImpact: 0.7 },
        { id: 'c3', text: '체육시설 민원은 야간에 집중된다', decisionImpact: 0.5 },
      ],
      evidence: [
        { id: 'e1', text: '정원 증가와 인건비 부담 증가는 재정소요의 핵심 요인이다', qualityScore: 90 },
        { id: 'e2', text: '주차장 수입은 전년 대비 증가했으며 감소했다는 근거는 없다', qualityScore: 85 },
      ],
    });

    expect(verdict(lattice.verdictsByClaim, 'c1').verdict).toBe('supports');
    expect(verdict(lattice.verdictsByClaim, 'c2').verdict).toBe('refutes');
    expect(verdict(lattice.verdictsByClaim, 'c3').verdict).toBe('not_enough_info');
    expect(lattice.summary.supports).toBe(1);
    expect(lattice.summary.refutes).toBe(1);
    expect(lattice.summary.notEnoughInfo).toBe(1);
  });

  it('routes Korean contradiction verdicts into review-queue candidates on the live verifier path', async () => {
    const verifier = new ClaimVerifierService();
    const result = await verifier.verify({
      claims: [
        { id: 'c1', text: '정원 증가는 인건비 부담을 증가시킵니다.', decisionImpact: 0.82 },
        { id: 'c2', text: '주차장 수입은 감소했습니다.', decisionImpact: 0.82 },
      ],
      evidence: [{ id: 'e1', text: '창원 예산표\n정원 증가와 인건비 부담 증가는 재정소요의 핵심 요인이다. 주차장 수입은 전년 대비 증가했다.', qualityScore: 70 }],
      highRiskClaimIds: ['c1', 'c2'],
    });
    expect(verdict(result.lattice.verdictsByClaim, 'c1').verdict).toBe('supports');
    expect(verdict(result.lattice.verdictsByClaim, 'c2').verdict).toBe('refutes');

    const queue = service.prioritizeReviewQueue({
      items: result.lattice.verdicts
        .filter((item) => item.verdict !== 'supports')
        .map((item) => ({
          id: item.claimId,
          kind: item.verdict === 'refutes' || item.verdict === 'mixed' ? 'refuted_claim' : 'unsupported_claim',
          title: item.claimText,
          decisionImpact: item.decisionImpact,
          uncertainty: 1 - item.confidence,
          evidenceGap: item.verdict === 'not_enough_info' ? 1 : 0.75,
        })),
    });
    expect(queue).toHaveLength(1);
    expect(queue[0]).toEqual(expect.objectContaining({ id: 'c2', kind: 'refuted_claim' }));
  });

  it('creates a truth-maintenance recheck queue for claims and artifacts affected by changed evidence', () => {
    expect(schema.truthMaintenanceQueue).toBeDefined();

    const lattice = service.buildClaimVerificationLattice({
      claims: [{ id: 'c1', text: '정원 증가는 인건비 부담을 증가시킨다', decisionImpact: 0.9 }],
      evidence: [{ id: 'e1', text: '정원 증가와 인건비 부담 증가는 재정소요의 핵심 요인이다', qualityScore: 90 }],
    });
    const queue = service.buildTruthMaintenanceQueue({
      changedEvidenceIds: ['e1'],
      verdicts: lattice.verdicts,
      artifacts: [{ id: 'r1', kind: 'report', title: '조직진단 보고서', claimIds: ['c1'] }],
    });

    expect(queue).toHaveLength(1);
    expect(queue[0]).toEqual(expect.objectContaining({ affectedClaimIds: ['c1'], affectedArtifactIds: ['r1'], reason: 'changed_evidence:e1' }));
    expect(queue[0]!.priorityScore).toBeGreaterThan(0.8);
  });

  it('turns evidence-backed alternatives and criteria into a decision scorecard', () => {
    expect(schema.decisionScorecards).toBeDefined();
    expect(schema.decisionScorecardItems).toBeDefined();

    const scorecard = service.buildDecisionScorecard({
      question: '조직진단 후속조치 우선순위는?',
      alternatives: [
        { id: 'a1', label: '인력 재배치' },
        { id: 'a2', label: '시설 운영시간 조정' },
      ],
      criteria: [
        { id: 'impact', label: '효과', weight: 0.5 },
        { id: 'feasibility', label: '실행가능성', weight: 0.3 },
        { id: 'risk', label: '리스크', weight: 0.2, direction: 'lower_is_better' },
      ],
      ratings: [
        { alternativeId: 'a1', criterionId: 'impact', score: 0.9, uncertainty: 0.1, evidenceIds: ['e1'] },
        { alternativeId: 'a1', criterionId: 'feasibility', score: 0.7, uncertainty: 0.2, evidenceIds: ['e2'] },
        { alternativeId: 'a1', criterionId: 'risk', score: 0.3, uncertainty: 0.2, evidenceIds: ['e3'] },
        { alternativeId: 'a2', criterionId: 'impact', score: 0.5, uncertainty: 0.2, evidenceIds: ['e4'] },
        { alternativeId: 'a2', criterionId: 'feasibility', score: 0.8, uncertainty: 0.15, evidenceIds: ['e5'] },
        { alternativeId: 'a2', criterionId: 'risk', score: 0.2, uncertainty: 0.1, evidenceIds: [] },
      ],
    });

    expect(scorecard.ranked[0]?.alternativeId).toBe('a1');
    expect(scorecard.ranked[0]?.requiredAction).toBe('recommend');
    expect(scorecard.ranked[1]?.evidenceCoverage).toBeLessThan(1);
  });

  it('diffuses graph scores with PPR-style and heat-kernel-style propagation before heavy Leiden', () => {
    const ppr = service.diffuseGraph({
      seedIds: ['thread:seed'],
      edges: [
        { from: 'thread:seed', to: 'topic:near', weight: 1, relation: 'same_project' },
        { from: 'topic:near', to: 'project:far', weight: 0.8, relation: 'cross_project' },
        { from: 'thread:seed', to: 'topic:noise', weight: 0.1, relation: 'same_project' },
      ],
      mode: 'ppr',
      iterations: 12,
    });
    const heat = service.diffuseGraph({
      seedIds: ['thread:seed'],
      edges: [
        { from: 'thread:seed', to: 'topic:near', weight: 1, relation: 'same_project' },
        { from: 'topic:near', to: 'project:far', weight: 0.8, relation: 'cross_project' },
      ],
      mode: 'heat',
      iterations: 4,
    });

    expect(ppr.scores['topic:near']).toBeGreaterThan(ppr.scores['topic:noise'] ?? 0);
    expect(ppr.scores['project:far']).toBeLessThan(ppr.scores['topic:near'] ?? 0);
    expect(heat.method).toBe('heat_kernel_no_dep');
  });

  it('creates PDF/table multimodal retrieval units from document extraction text', () => {
    expect(schema.documentRetrievalUnits).toBeDefined();

    const units = service.buildDocumentRetrievalUnits({
      documents: [{
        id: 'doc1',
        title: '예산표.pdf',
        text: '창원시설공단 예산 자료\n| 항목 | 금액 |\n| 인건비 | 120 |\n| 유지보수 | 30 |\n본문 설명',
        qualityScore: 80,
      }],
    });

    expect(units.some((unit) => unit.modality === 'table')).toBe(true);
    expect(units.some((unit) => unit.modality === 'text')).toBe(true);
    expect(units.find((unit) => unit.modality === 'table')?.locator).toContain('table');
  });

  it('prioritizes active review items by decision impact, uncertainty, evidence gap, and deadline weight', () => {
    expect(schema.activeReviewItems).toBeDefined();

    const ranked = service.prioritizeReviewQueue({
      now: new Date('2026-07-07T00:00:00Z'),
      items: [
        { id: 'low', kind: 'claim', title: '낮은 영향', decisionImpact: 0.2, uncertainty: 0.4, evidenceGap: 0.5 },
        { id: 'urgent', kind: 'decision', title: '임원 보고 핵심 판단', decisionImpact: 0.95, uncertainty: 0.8, evidenceGap: 0.9, dueAt: new Date('2026-07-07T06:00:00Z') },
      ],
    });

    expect(ranked[0]?.id).toBe('urgent');
    expect(ranked[0]?.priorityScore).toBeGreaterThan(ranked[1]?.priorityScore ?? 0);
    expect(ranked[0]?.reasons.join(' ')).toContain('deadline');
  });

  it('builds typed contradiction/provenance edges and review items for conflicting evidence', () => {
    expect(schema.provenanceGraphEdges).toBeDefined();

    const graph = service.buildProvenanceGraph({
      asOf: new Date('2026-07-07T00:00:00Z'),
      evidence: [
        { id: 'e-support', text: '정원 증가는 인건비 부담을 증가시킨다', validFrom: '2026-01-01', observedAt: '2026-07-01' },
        { id: 'e-refute', text: '정원 증가는 필요하지만 인건비 부담은 증가하지 않는다', validFrom: '2026-06-01', observedAt: '2026-07-02' },
      ],
      verdicts: [
        { claimId: 'c1', claimText: '정원 증가는 인건비 부담을 증가시킨다', evidenceId: 'e-support', verdict: 'supports', confidence: 0.86, matchedTerms: ['정원', '인건비'], contradictedTerms: [], rationale: 'supported', decisionImpact: 0.9 },
        { claimId: 'c1', claimText: '정원 증가는 인건비 부담을 증가시킨다', evidenceId: 'e-refute', verdict: 'refutes', confidence: 0.78, matchedTerms: ['정원'], contradictedTerms: ['증가↔감소'], rationale: 'counter evidence', decisionImpact: 0.9 },
      ],
    });

    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceRef: 'evidence:e-support', targetRef: 'claim:c1', edgeType: 'SUPPORTS', validFrom: '2026-01-01T00:00:00.000Z' }),
      expect.objectContaining({ sourceRef: 'evidence:e-refute', targetRef: 'claim:c1', edgeType: 'REFUTES', validFrom: '2026-06-01T00:00:00.000Z' }),
    ]));
    expect(graph.reviewItems[0]).toEqual(expect.objectContaining({
      id: 'contradiction:c1',
      kind: 'contradiction',
      title: expect.stringContaining('근거가 갈리는 쟁점'),
    }));
  });

  it('selects evidence by validity window before newest publication time', () => {
    const selected = service.selectTemporallyValidEvidence({
      asOf: new Date('2025-06-01T00:00:00Z'),
      evidence: [
        { id: 'old-rule', text: '2025년 적용 조례', validFrom: '2025-01-01', validTo: '2025-12-31', publishedAt: '2025-01-10' },
        { id: 'new-rule', text: '2026년 적용 조례', validFrom: '2026-01-01', publishedAt: '2025-11-01' },
        { id: 'superseded', text: '폐기된 조직도', validFrom: '2024-01-01', validTo: '2025-12-31', supersededBy: 'old-rule' },
      ],
    });

    expect(selected.active.map((item) => item.id)).toEqual(['old-rule']);
    expect(selected.superseded.map((item) => item.id)).toEqual(['superseded']);
    expect(selected.timeline[0]?.id).toBe('old-rule');
  });
});
