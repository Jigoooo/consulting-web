import { describe, expect, it } from 'vitest';
import {
  analyzeWeightSensitivity,
  estimateImpactInterval,
  mulberry32,
  sampleTriangular,
  type AlternativeScoreInput,
  type WeightedCriterion,
} from '../src/consulting/decision-analytics.js';

const criteria: WeightedCriterion[] = [
  { id: 'cost', label: '비용', normalizedWeight: 0.5, direction: 'lower_is_better' },
  { id: 'impact', label: '효과', normalizedWeight: 0.3 },
  { id: 'risk', label: '위험', normalizedWeight: 0.2, direction: 'lower_is_better' },
];

const alternatives: AlternativeScoreInput[] = [
  { alternativeId: 'A', label: '수당 신설', scoresByCriterion: { cost: 0.3, impact: 0.9, risk: 0.2 } },
  { alternativeId: 'B', label: '기존 유지', scoresByCriterion: { cost: 0.8, impact: 0.4, risk: 0.5 } },
];

describe('mulberry32 PRNG', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    for (const v of seqA) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
  it('produces different sequences for different seeds', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe('analyzeWeightSensitivity', () => {
  it('identifies the baseline winner and reports stability in [0,1]', () => {
    const r = analyzeWeightSensitivity({ criteria, alternatives, seed: 7, scenarios: 500 });
    expect(r.baselineWinnerId).toBe('A');
    expect(r.winnerStability).toBeGreaterThanOrEqual(0);
    expect(r.winnerStability).toBeLessThanOrEqual(1);
    expect(r.scenarios).toBe(500);
    expect(r.perturbationPct).toBe(0.2);
  });

  it('is deterministic: identical input+seed yields identical stability', () => {
    const a = analyzeWeightSensitivity({ criteria, alternatives, seed: 99, scenarios: 300 });
    const b = analyzeWeightSensitivity({ criteria, alternatives, seed: 99, scenarios: 300 });
    expect(a.winnerStability).toBe(b.winnerStability);
    expect(a.criticalCriteria).toEqual(b.criticalCriteria);
  });

  it('reports high stability for a clearly dominant alternative', () => {
    const dominant: AlternativeScoreInput[] = [
      { alternativeId: 'A', label: '압도', scoresByCriterion: { cost: 0.05, impact: 0.98, risk: 0.05 } },
      { alternativeId: 'B', label: '열위', scoresByCriterion: { cost: 0.95, impact: 0.1, risk: 0.9 } },
    ];
    const r = analyzeWeightSensitivity({ criteria, alternatives: dominant, seed: 7, scenarios: 500 });
    expect(r.winnerStability).toBe(1);
    expect(r.criticalCriteria.every((c) => !c.flipsWinner)).toBe(true);
  });

  it('flags a critical criterion when one-at-a-time weight swings flip a close race', () => {
    // A wins only because of its edge on `impact`. B is better on cost and risk,
    // so if impact's weight collapses to its −p extreme, B takes the win →
    // `impact` is a critical criterion.
    const close: AlternativeScoreInput[] = [
      { alternativeId: 'A', label: 'A', scoresByCriterion: { cost: 0.6, impact: 0.7, risk: 0.6 } },
      { alternativeId: 'B', label: 'B', scoresByCriterion: { cost: 0.3, impact: 0.3, risk: 0.3 } },
    ];
    const impactHeavy: WeightedCriterion[] = [
      { id: 'cost', label: '비용', normalizedWeight: 0.1, direction: 'lower_is_better' },
      { id: 'impact', label: '효과', normalizedWeight: 0.8 },
      { id: 'risk', label: '위험', normalizedWeight: 0.1, direction: 'lower_is_better' },
    ];
    const r = analyzeWeightSensitivity({ criteria: impactHeavy, alternatives: close, perturbationPct: 0.95, seed: 7, scenarios: 400 });
    expect(r.baselineWinnerId).toBe('A');
    const impact = r.criticalCriteria.find((c) => c.criterionId === 'impact');
    expect(impact?.flipsWinner).toBe(true);
    expect(impact?.thresholdPct).not.toBeNull();
    expect(Math.abs(impact?.thresholdPct ?? 2)).toBeGreaterThan(0);
    expect(Math.abs(impact?.thresholdPct ?? 2)).toBeLessThanOrEqual(0.95);
    expect(impact?.challengerId).toBe('B');
    // A large ±95% weight swing should also dent Monte Carlo stability below 1.
    expect(r.winnerStability).toBeLessThan(1);
  });
  it.each([
    ['scenarios', { criteria, alternatives, scenarios: Number.NaN }],
    ['perturbation', { criteria, alternatives, scenarios: 1, perturbationPct: Number.NaN }],
    ['seed', { criteria, alternatives, scenarios: 1, seed: Number.POSITIVE_INFINITY }],
    ['weight', {
      criteria: [{ ...criteria[0]!, normalizedWeight: Number.POSITIVE_INFINITY }, ...criteria.slice(1)],
      alternatives,
      scenarios: 1,
    }],
    ['score', {
      criteria,
      alternatives: [{ ...alternatives[0]!, scoresByCriterion: { ...alternatives[0]!.scoresByCriterion, cost: Number.NaN } }],
      scenarios: 1,
    }],
  ] as Array<[string, Parameters<typeof analyzeWeightSensitivity>[0]]>)(
    'rejects non-finite sensitivity %s input',
    (_name, input) => {
      expect(() => analyzeWeightSensitivity(input)).toThrow(RangeError);
    },
  );

  it('uses the scorecard uncertainty penalty when determining the baseline winner', () => {
    const result = analyzeWeightSensitivity({
      criteria: [{ id: 'benefit', label: '효과', normalizedWeight: 1 }],
      alternatives: [
        { alternativeId: 'raw_high', label: '원점수 우위', scoresByCriterion: { benefit: 1 }, uncertaintyByCriterion: { benefit: 1 } },
        { alternativeId: 'auditable', label: '확실한 대안', scoresByCriterion: { benefit: 0.8 }, uncertaintyByCriterion: { benefit: 0 } },
      ],
      scenarios: 10,
      seed: 1,
    });
    expect(result.baselineWinnerId).toBe('auditable');
  });

  it('rejects duplicate criterion and alternative identities', () => {
    expect(() => analyzeWeightSensitivity({
      criteria: [criteria[0]!, { ...criteria[1]!, id: criteria[0]!.id }],
      alternatives,
      scenarios: 1,
    })).toThrow('sensitivity criterion ids must be unique');
    expect(() => analyzeWeightSensitivity({
      criteria,
      alternatives: [alternatives[0]!, { ...alternatives[1]!, alternativeId: alternatives[0]!.alternativeId }],
      scenarios: 1,
    })).toThrow('sensitivity alternative ids must be unique');
  });
});

describe('sampleTriangular', () => {
  it('stays within [min, max] and respects the mode ordering', () => {
    for (let i = 0; i <= 10; i += 1) {
      const v = sampleTriangular(i / 10, 100, 150, 300);
      expect(v).toBeGreaterThanOrEqual(100);
      expect(v).toBeLessThanOrEqual(300);
    }
    expect(sampleTriangular(0, 100, 150, 300)).toBe(100);
    expect(sampleTriangular(1, 100, 150, 300)).toBe(300);
  });
  it('degenerates to the point value when min==max', () => {
    expect(sampleTriangular(0.5, 42, 42, 42)).toBe(42);
  });

  it.each([
    [0.9, 0, 2, 1],
    [0.1, 0, -1, 1],
    [0.5, 2, 2, 1],
    [Number.NaN, 0, 0.5, 1],
    [1.1, 0, 0.5, 1],
  ])('rejects invalid or non-finite triangular inputs', (u, min, mode, max) => {
    expect(() => sampleTriangular(u, min, mode, max)).toThrow(RangeError);
  });
});

describe('estimateImpactInterval', () => {
  const drivers = [
    { id: 'headcount', label: '인원', min: 10, mode: 12, max: 15 },
    { id: 'unitCost', label: '단가', min: 1_000_000, mode: 1_200_000, max: 1_500_000 },
  ];
  const combine = (s: Record<string, number>) => s.headcount! * s.unitCost! * 12;

  it('produces ordered percentiles within the outcome range', () => {
    const r = estimateImpactInterval({ drivers, combine, iterations: 5000, seed: 123 });
    expect(r.min).toBeLessThanOrEqual(r.p10);
    expect(r.p10).toBeLessThanOrEqual(r.p50);
    expect(r.p50).toBeLessThanOrEqual(r.p90);
    expect(r.p90).toBeLessThanOrEqual(r.max);
    expect(r.mean).toBeGreaterThan(r.min);
    expect(r.mean).toBeLessThan(r.max);
    expect(r.iterations).toBe(5000);
  });

  it('is reproducible for a fixed seed (auditable output)', () => {
    const a = estimateImpactInterval({ drivers, combine, iterations: 3000, seed: 2026 });
    const b = estimateImpactInterval({ drivers, combine, iterations: 3000, seed: 2026 });
    expect(a).toEqual(b);
  });

  it('shifts the interval when driver ranges shift', () => {
    const low = estimateImpactInterval({ drivers, combine, iterations: 3000, seed: 5 });
    const higher = estimateImpactInterval({
      drivers: [
        { id: 'headcount', label: '인원', min: 20, mode: 22, max: 25 },
        { id: 'unitCost', label: '단가', min: 1_000_000, mode: 1_200_000, max: 1_500_000 },
      ],
      combine, iterations: 3000, seed: 5,
    });
    expect(higher.p50).toBeGreaterThan(low.p50);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('rejects a non-finite combined impact value', (value) => {
    expect(() => estimateImpactInterval({
      drivers,
      combine: () => value,
      iterations: 1,
      seed: 1,
    })).toThrow(RangeError);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 100_001])(
    'rejects unsafe iteration count %s',
    (iterations) => {
      expect(() => estimateImpactInterval({
        drivers,
        combine,
        iterations,
        seed: 1,
      })).toThrow('impact iterations must be a safe integer between 1 and 100000');
    },
  );

  it('rejects empty or duplicate driver identities', () => {
    expect(() => estimateImpactInterval({ drivers: [], combine: () => 1, iterations: 1 })).toThrow(
      'impact model requires at least one driver',
    );
    expect(() => estimateImpactInterval({
      drivers: [drivers[0]!, { ...drivers[1]!, id: drivers[0]!.id }],
      combine,
      iterations: 1,
    })).toThrow('impact driver ids must be unique');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5])('rejects unsafe impact seed %s', (seed) => {
    expect(() => estimateImpactInterval({ drivers, combine, iterations: 1, seed })).toThrow(
      'impact seed must be a safe integer',
    );
  });
});
