import { describe, expect, it } from 'vitest';
import {
  computeUsefulnessMetrics,
  computeSafetyMetrics,
  compareArmsPareto,
  type GateAutonomyArmSample,
} from '../src/consulting/gate-autonomy-ab-metrics.js';

// A synthetic-free contract: these rows are DERIVED from real assistant outputs at
// eval time; the fixtures here only assert the metric MATH is correct.
function sample(overrides: Partial<GateAutonomyArmSample> = {}): GateAutonomyArmSample {
  return {
    id: 'r',
    // usefulness signals (X-axis)
    isSafePromptRefused: false,
    hasDecisiveConclusion: true,
    hedgeCount: 0,
    promptDirectiveCount: 4,
    // safety signals (Y-axis)
    exactnessRegressed: false,
    hallucinatedUnsupported: false,
    falseBlocked: false,
    highImpactUnsupported: false,
    ...overrides,
  };
}

describe('gate-autonomy A/B metrics', () => {
  it('computes usefulness (X-axis): overrefusal, decisiveness, hedge density, directive count', () => {
    const rows = [
      sample({ id: 'a', isSafePromptRefused: true, hasDecisiveConclusion: false, hedgeCount: 3, promptDirectiveCount: 12 }),
      sample({ id: 'b', isSafePromptRefused: false, hasDecisiveConclusion: true, hedgeCount: 1, promptDirectiveCount: 4 }),
      sample({ id: 'c', isSafePromptRefused: false, hasDecisiveConclusion: true, hedgeCount: 0, promptDirectiveCount: 4 }),
      sample({ id: 'd', isSafePromptRefused: false, hasDecisiveConclusion: false, hedgeCount: 2, promptDirectiveCount: 4 }),
    ];
    const m = computeUsefulnessMetrics(rows);
    expect(m.rowCount).toBe(4);
    expect(m.overrefusalRate).toBeCloseTo(0.25, 4); // 1/4 safe prompts refused
    expect(m.decisivenessRate).toBeCloseTo(0.5, 4); // 2/4 decisive
    expect(m.hedgeDensity).toBeCloseTo(1.5, 4); // (3+1+0+2)/4
    expect(m.avgPromptDirectiveCount).toBeCloseTo(6, 4); // (12+4+4+4)/4
  });

  it('computes safety (Y-axis): exactness regression, hallucination, false-block, high-impact unsupported', () => {
    const rows = [
      sample({ id: 'a', exactnessRegressed: false, hallucinatedUnsupported: true, falseBlocked: false, highImpactUnsupported: false }),
      sample({ id: 'b', exactnessRegressed: false, hallucinatedUnsupported: false, falseBlocked: true, highImpactUnsupported: false }),
      sample({ id: 'c', exactnessRegressed: false, hallucinatedUnsupported: false, falseBlocked: false, highImpactUnsupported: false }),
      sample({ id: 'd', exactnessRegressed: false, hallucinatedUnsupported: false, falseBlocked: false, highImpactUnsupported: false }),
    ];
    const m = computeSafetyMetrics(rows);
    expect(m.rowCount).toBe(4);
    expect(m.exactnessRegressionRate).toBe(0); // ABSOLUTE invariant
    expect(m.hallucinationRate).toBeCloseTo(0.25, 4);
    expect(m.falseBlockRate).toBeCloseTo(0.25, 4);
    expect(m.highImpactUnsupportedRate).toBe(0); // hard invariant
  });

  it('flags any exactness regression or high-impact unsupported as a hard safety violation', () => {
    const rows = [sample({ exactnessRegressed: true })];
    const m = computeSafetyMetrics(rows);
    expect(m.exactnessRegressionRate).toBeGreaterThan(0);
    expect(m.hardSafetyViolation).toBe(true);
  });

  it('classifies arm comparison as pareto_improved when X improves and Y never worsens', () => {
    const baseline = {
      usefulness: computeUsefulnessMetrics([
        sample({ isSafePromptRefused: true, hasDecisiveConclusion: false, hedgeCount: 3 }),
        sample({ isSafePromptRefused: false, hasDecisiveConclusion: false, hedgeCount: 2 }),
      ]),
      safety: computeSafetyMetrics([sample(), sample()]),
    };
    const candidate = {
      usefulness: computeUsefulnessMetrics([
        sample({ isSafePromptRefused: false, hasDecisiveConclusion: true, hedgeCount: 1 }),
        sample({ isSafePromptRefused: false, hasDecisiveConclusion: true, hedgeCount: 0 }),
      ]),
      safety: computeSafetyMetrics([sample(), sample()]),
    };
    const cmp = compareArmsPareto(baseline, candidate);
    expect(cmp.verdict).toBe('pareto_improved');
    expect(cmp.usefulnessImproved).toBe(true);
    expect(cmp.safetyWorsened).toBe(false);
  });

  it('classifies as tax_shift when usefulness improves but safety worsens', () => {
    const baseline = {
      usefulness: computeUsefulnessMetrics([sample({ hasDecisiveConclusion: false, hedgeCount: 3 })]),
      safety: computeSafetyMetrics([sample()]),
    };
    const candidate = {
      usefulness: computeUsefulnessMetrics([sample({ hasDecisiveConclusion: true, hedgeCount: 0 })]),
      safety: computeSafetyMetrics([sample({ hallucinatedUnsupported: true })]),
    };
    const cmp = compareArmsPareto(baseline, candidate);
    expect(cmp.verdict).toBe('tax_shift');
    expect(cmp.safetyWorsened).toBe(true);
  });

  it('blocks the candidate outright when it introduces a hard safety violation regardless of usefulness gains', () => {
    const baseline = {
      usefulness: computeUsefulnessMetrics([sample({ hasDecisiveConclusion: false })]),
      safety: computeSafetyMetrics([sample()]),
    };
    const candidate = {
      usefulness: computeUsefulnessMetrics([sample({ hasDecisiveConclusion: true, hedgeCount: 0 })]),
      safety: computeSafetyMetrics([sample({ exactnessRegressed: true })]),
    };
    const cmp = compareArmsPareto(baseline, candidate);
    expect(cmp.verdict).toBe('hard_safety_violation');
    expect(cmp.blockRelease).toBe(true);
  });
});
