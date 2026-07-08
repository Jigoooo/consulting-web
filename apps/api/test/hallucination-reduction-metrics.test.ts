import { describe, expect, it } from 'vitest';
import { computeHallucinationIssueRates, computeHallucinationReduction } from '../src/consulting/verification-quality-metrics.js';

describe('hallucination reduction metrics', () => {
  it('measures unsupported, refuted, citation, and numeric issue rates before and after verifier repair', () => {
    const before = computeHallucinationIssueRates({
      claimCount: 10,
      unsupportedClaims: 3,
      refutedClaims: 2,
      citationIssues: 1,
      numericBlocked: 1,
    });
    const after = computeHallucinationIssueRates({
      claimCount: 10,
      unsupportedClaims: 1,
      refutedClaims: 0,
      citationIssues: 0,
      numericBlocked: 1,
    });

    expect(before).toEqual(expect.objectContaining({
      unsupportedClaimRate: 0.3,
      refutedClaimRate: 0.2,
      citationIssueRate: 0.1,
      numericBlockedRate: 0.1,
      overallIssueRate: 0.7,
    }));
    expect(after.overallIssueRate).toBe(0.2);

    const reduction = computeHallucinationReduction(before, after);
    expect(reduction.reductionRate).toBeCloseTo(0.7143, 4);
    expect(reduction.regressions).toEqual([]);
    expect(reduction.ok).toBe(true);
  });

  it('flags verifier regressions when after-rates get worse', () => {
    const before = computeHallucinationIssueRates({ claimCount: 4, unsupportedClaims: 1, refutedClaims: 0, citationIssues: 0, numericBlocked: 0 });
    const after = computeHallucinationIssueRates({ claimCount: 4, unsupportedClaims: 1, refutedClaims: 1, citationIssues: 1, numericBlocked: 0 });

    const reduction = computeHallucinationReduction(before, after);
    expect(reduction.ok).toBe(false);
    expect(reduction.reductionRate).toBeLessThan(0);
    expect(reduction.regressions).toEqual(expect.arrayContaining(['refutedClaimRate', 'citationIssueRate', 'overallIssueRate']));
  });
});
