import { describe, expect, it } from 'vitest';
import { VerifierGatePolicyService } from '../src/consulting/verifier-gate-policy.service.js';
import type { ClaimVerdict } from '../src/consulting/evidence-to-decision.service.js';

function verdict(overrides: Partial<ClaimVerdict>): ClaimVerdict {
  return {
    claimId: 'c1',
    claimText: 'claim',
    evidenceId: 'e1',
    verdict: 'supports',
    confidence: 0.9,
    matchedTerms: [],
    contradictedTerms: [],
    rationale: 'fixture',
    decisionImpact: 0.5,
    ...overrides,
  };
}

const service = new VerifierGatePolicyService();

describe('VerifierGatePolicyService', () => {
  it('never hard-blocks general chat, but returns warnings for exactness, citation, and NLI issues', () => {
    const result = service.evaluate({
      mode: 'general_chat',
      exactnessStatus: 'blocked',
      citationIssueCount: 1,
      verdicts: [verdict({ claimId: 'r1', verdict: 'refutes', decisionImpact: 0.95 })],
    });

    expect(result.decision).toBe('PASS_WITH_WARNINGS');
    expect(result.blockers).toHaveLength(0);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'exactness_blocked' }),
      expect.objectContaining({ code: 'citation_issue' }),
      expect.objectContaining({ code: 'high_impact_refute' }),
    ]));
  });

  it('blocks report decisions on objective exactness/citation failures and high-impact refutes', () => {
    const result = service.evaluate({
      mode: 'report_decision',
      exactnessStatus: 'blocked',
      citationIssueCount: 2,
      verdicts: [verdict({ claimId: 'r1', verdict: 'refutes', decisionImpact: 0.91 })],
    });

    expect(result.decision).toBe('BLOCKED');
    expect(result.blockers.map((item) => item.code)).toEqual(expect.arrayContaining(['exactness_blocked', 'citation_issue', 'high_impact_refute']));
  });

  it('lets semantic insufficiency through as warnings before final export, but blocks high-impact unsupported claims in final export', () => {
    const draft = service.evaluate({
      mode: 'analysis_draft',
      exactnessStatus: 'passed',
      citationIssueCount: 0,
      verdicts: [verdict({ claimId: 'u1', verdict: 'not_enough_info', decisionImpact: 0.93 })],
    });
    const final = service.evaluate({
      mode: 'final_export',
      exactnessStatus: 'passed',
      citationIssueCount: 0,
      verdicts: [verdict({ claimId: 'u1', verdict: 'not_enough_info', decisionImpact: 0.93 })],
    });

    expect(draft.decision).toBe('PASS_WITH_WARNINGS');
    expect(draft.blockers).toHaveLength(0);
    expect(final.decision).toBe('BLOCKED');
    expect(final.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'high_impact_unsupported' })]));
  });

  it('promotes judgment guard blockers into report/final gates and keeps general chat warning-only', () => {
    const judgmentIssues = [
      { code: 'source_intake_parse_failure' as const, severity: 'blocker' as const, message: 'empty pdf extraction', requiredAction: 'run OCR' },
      { code: 'user_correction_pattern' as const, severity: 'warning' as const, message: 'user corrected the answer', requiredAction: 'update gate pattern' },
      { code: 'overclaim_strength_risk' as const, severity: 'warning' as const, message: 'strong conclusion risk', requiredAction: 'downgrade claim strength' },
    ];
    const general = service.evaluate({ mode: 'general_chat', judgmentIssues });
    const report = service.evaluate({ mode: 'report_decision', judgmentIssues });
    const final = service.evaluate({ mode: 'final_export', judgmentIssues });

    expect(general.decision).toBe('PASS_WITH_WARNINGS');
    expect(general.blockers).toHaveLength(0);
    expect(general.warnings.map((item) => item.code)).toEqual(expect.arrayContaining(['judgment_guard_blocker', 'user_correction_pattern', 'overclaim_strength_risk']));
    expect(report.decision).toBe('BLOCKED');
    expect(report.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'judgment_guard_blocker' })]));
    expect(final.decision).toBe('BLOCKED');
  });
});
