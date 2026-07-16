import { describe, expect, it } from 'vitest';
import { computeRubric, renderRubricRevisionContract, type RubricInput } from '../src/consulting/rubric-verdict.js';

// Rubric axes are DERIVED deterministically from existing verifier signals — no LLM
// self-scoring (avoids reward hacking). This suite locks the axis math + weak-axis routing.
function input(overrides: Partial<RubricInput> = {}): RubricInput {
  return {
    mode: 'report_decision',
    cragStatus: 'sufficient',
    exactnessStatus: 'passed',
    citationIssueCount: 0,
    verdicts: [
      { claimId: 'c1', verdict: 'supports', confidence: 0.9, decisionImpact: 0.6, applicability: 'directly_applicable' },
    ],
    overclaimRisk: false,
    ...overrides,
  };
}

describe('rubric-verdict', () => {
  it('scores all five axes 0..1 for a well-supported, applicable, exact answer', () => {
    const r = computeRubric(input());
    expect(r.axes.R1_evidence).toBeCloseTo(1.0, 4);
    expect(r.axes.R2_applicability).toBeCloseTo(1.0, 4);
    expect(r.axes.R3_citation).toBeCloseTo(1.0, 4);
    expect(r.axes.R4_calibration).toBeGreaterThan(0.7);
    expect(r.axes.R5_exactness).toBeCloseTo(1.0, 4);
    expect(r.weighted).toBeGreaterThan(0.85);
    expect(r.weakAxes).toHaveLength(0);
  });

  it('drops R1 for unsupported claims and halves it under insufficient CRAG', () => {
    const nei = computeRubric(input({
      verdicts: [{ claimId: 'c1', verdict: 'not_enough_info', confidence: 0.3, decisionImpact: 0.5, applicability: 'analogical' }],
    }));
    expect(nei.axes.R1_evidence).toBeCloseTo(0.3, 4);

    const insufficient = computeRubric(input({
      cragStatus: 'insufficient',
      verdicts: [{ claimId: 'c1', verdict: 'supports', confidence: 0.9, decisionImpact: 0.5, applicability: 'directly_applicable' }],
    }));
    expect(insufficient.axes.R1_evidence).toBeCloseTo(0.5, 4); // 1.0 * 0.5 CRAG penalty
  });

  it('scores R2 by applicability label and R3 by citation issues', () => {
    const r = computeRubric(input({
      citationIssueCount: 2,
      verdicts: [{ claimId: 'c1', verdict: 'supports', confidence: 0.8, decisionImpact: 0.5, applicability: 'cross_project' }],
    }));
    expect(r.axes.R2_applicability).toBeCloseTo(0.3, 4); // cross_project
    expect(r.axes.R3_citation).toBeCloseTo(1 - 2 * 0.34, 2); // ~0.32
  });

  it('penalizes R4 calibration when a strong conclusion outruns its evidence (overclaim)', () => {
    const strong = computeRubric(input({
      overclaimRisk: true,
      verdicts: [{ claimId: 'c1', verdict: 'not_enough_info', confidence: 0.2, decisionImpact: 0.9, applicability: 'analogical' }],
    }));
    expect(strong.axes.R4_calibration).toBeLessThan(0.4);
    expect(strong.weakAxes).toContain('R4_calibration');
  });

  it('sets R5 exactness to 0 when blocked and marks it a hard axis', () => {
    const r = computeRubric(input({ exactnessStatus: 'blocked' }));
    expect(r.axes.R5_exactness).toBe(0);
    expect(r.hardExactnessFail).toBe(true);
  });

  it('lists weak axes (score < 0.4) so self-revise can target only what is broken', () => {
    const r = computeRubric(input({
      citationIssueCount: 3,
      verdicts: [{ claimId: 'c1', verdict: 'not_enough_info', confidence: 0.2, decisionImpact: 0.5, applicability: 'background_only' }],
    }));
    expect(r.weakAxes).toEqual(expect.arrayContaining(['R1_evidence', 'R2_applicability', 'R3_citation']));
    // Each weak axis carries a targeted revise hint.
    expect(r.reviseHints.R1_evidence).toMatch(/근거/);
    expect(r.reviseHints.R2_applicability).toMatch(/적용|라벨/);
  });

  it('weights axes by mode: final_export leans on citation + exactness', () => {
    const draft = computeRubric(input({ mode: 'analysis_draft' }));
    const finalExport = computeRubric(input({ mode: 'final_export' }));
    // Same perfect input scores high in both, but the weight vectors differ.
    expect(draft.weightsUsed.R5_exactness).toBeLessThan(finalExport.weightsUsed.R5_exactness);
    expect(finalExport.weightsUsed.R3_citation).toBeGreaterThanOrEqual(draft.weightsUsed.R3_citation);
  });

  it('aggregates multiple verdicts by taking the weakest R1/R2 (worst claim drives the axis)', () => {
    const r = computeRubric(input({
      verdicts: [
        { claimId: 'c1', verdict: 'supports', confidence: 0.9, decisionImpact: 0.6, applicability: 'directly_applicable' },
        { claimId: 'c2', verdict: 'not_enough_info', confidence: 0.3, decisionImpact: 0.5, applicability: 'cross_project' },
      ],
    }));
    expect(r.axes.R1_evidence).toBeCloseTo(0.3, 4); // weakest claim
    expect(r.axes.R2_applicability).toBeCloseTo(0.3, 4); // cross_project weakest
  });

  it('renders a targeted revision contract that lists ONLY weak axes for self-revise', () => {
    const r = computeRubric(input({
      citationIssueCount: 3,
      verdicts: [{ claimId: 'c1', verdict: 'not_enough_info', confidence: 0.2, decisionImpact: 0.5, applicability: 'background_only' }],
    }));
    const contract = renderRubricRevisionContract(r);
    expect(contract).toContain('### 루브릭 판정');
    expect(contract).toContain('R1_evidence');
    expect(contract).toContain('R3_citation');
    // The strong axis (R5 passed) must NOT appear as a revision target.
    expect(contract).not.toContain('R5_exactness 보정');
    // Deliberative framing: revise only the weak axis, do not hedge the whole answer.
    expect(contract).toMatch(/약한 축만|해당 축만/);
  });

  it('renders an all-clear contract when no axis is weak', () => {
    const r = computeRubric(input());
    const contract = renderRubricRevisionContract(r);
    expect(contract).toContain('### 루브릭 판정');
    expect(contract).toMatch(/약한 축 없음|보정 불필요/);
  });
});
