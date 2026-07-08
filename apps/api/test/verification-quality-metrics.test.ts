import { describe, expect, it } from 'vitest';
import { computeClassificationQualityMetrics } from '../src/consulting/verification-quality-metrics.js';

describe('verification quality metrics', () => {
  it('computes NLI accuracy, macro F1, contradiction recall, and false-block rate', () => {
    const metrics = computeClassificationQualityMetrics([
      { id: 'support-ok', expected: 'supports', actual: 'supports' },
      { id: 'support-blocked', expected: 'supports', actual: 'not_enough_info' },
      { id: 'refute-ok', expected: 'refutes', actual: 'refutes' },
      { id: 'refute-missed', expected: 'refutes', actual: 'not_enough_info' },
      { id: 'nei-ok', expected: 'not_enough_info', actual: 'not_enough_info' },
      { id: 'nei-wrong-support', expected: 'not_enough_info', actual: 'supports' },
    ]);

    expect(metrics.rowCount).toBe(6);
    expect(metrics.overallAccuracy).toBeCloseTo(0.5, 4);
    expect(metrics.contradictionRecall).toBeCloseTo(0.5, 4);
    expect(metrics.unsupportedDeferralRecall).toBeCloseTo(0.5, 4);
    expect(metrics.falseBlockRate).toBeCloseTo(0.5, 4);
    expect(metrics.perLabel.refutes).toEqual(expect.objectContaining({ truePositive: 1, falseNegative: 1, falsePositive: 0 }));
    expect(metrics.perLabel.supports.f1).toBeGreaterThan(0);
    expect(metrics.macroF1).toBeGreaterThan(0);
    expect(metrics.macroF1).toBeLessThanOrEqual(1);
  });
});
