/**
 * Decision analytics (W3) — MCDA sensitivity + Monte Carlo interval estimation.
 *
 * Pure, dependency-free, and deterministic. These tools sit ON TOP of the
 * existing `buildDecisionScorecard` MCDA engine (roadmap §3.5): given the same
 * normalized criteria + ratings, they answer "how stable is the ranking under
 * ±weight perturbation?" and "what is the impact interval given input spread?".
 *
 * Determinism: Monte Carlo uses a seeded mulberry32 PRNG so a given (inputs, seed,
 * iterations) triple always yields identical intervals — required for auditable
 * consulting outputs.
 */

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — small, fast, reproducible. Not crypto.
// ---------------------------------------------------------------------------
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function round4(v: number): number {
  return Number(v.toFixed(4));
}

// ---------------------------------------------------------------------------
// MCDA weight-sensitivity analysis (roadmap §3.5: 가중치 ±20% 순위 안정성)
// ---------------------------------------------------------------------------
export interface WeightedCriterion {
  id: string;
  label: string;
  /** Normalized weight in [0,1], summing to 1 across criteria. */
  normalizedWeight: number;
  direction?: 'higher_is_better' | 'lower_is_better';
}

export interface AlternativeScoreInput {
  alternativeId: string;
  label: string;
  /** Raw directional score per criterion in [0,1]. */
  scoresByCriterion: Record<string, number>;
  /** Optional scorecard uncertainty per criterion in [0,1]. */
  uncertaintyByCriterion?: Record<string, number>;
}

export interface SensitivityResult {
  baselineWinnerId: string | null;
  /** Fraction of perturbed scenarios where the baseline winner stays #1. */
  winnerStability: number;
  perturbationPct: number;
  scenarios: number;
  /** Per-criterion: does perturbing THIS criterion's weight alone flip the winner? */
  criticalCriteria: Array<{
    criterionId: string;
    label: string;
    flipsWinner: boolean;
    /** Smallest signed relative weight change that flips #1 within the requested perturbation range. */
    thresholdPct: number | null;
    challengerId: string | null;
  }>;
}

function weightedTotals(
  criteria: WeightedCriterion[],
  alternatives: AlternativeScoreInput[],
  weights: number[],
): Array<{ alternativeId: string; total: number }> {
  const sum = weights.reduce((s, w) => s + w, 0) || 1;
  return alternatives.map((alt) => {
    let total = 0;
    criteria.forEach((c, i) => {
      const raw = clamp01(alt.scoresByCriterion[c.id] ?? 0);
      const directional = c.direction === 'lower_is_better' ? 1 - raw : raw;
      const uncertainty = clamp01(alt.uncertaintyByCriterion?.[c.id] ?? 0);
      total += directional * (1 - uncertainty * 0.35) * (weights[i]! / sum);
    });
    return { alternativeId: alt.alternativeId, total };
  });
}

const SCORE_TIE_EPSILON = 1e-12;

function winnerOf(totals: Array<{ alternativeId: string; total: number }>): string | null {
  if (totals.length === 0) return null;
  const maximum = Math.max(...totals.map((item) => item.total));
  const winners = totals.filter((item) => Math.abs(item.total - maximum) <= SCORE_TIE_EPSILON);
  return winners.length === 1 ? winners[0]!.alternativeId : null;
}

/**
 * Monte Carlo weight perturbation: jitter each criterion weight by ±perturbationPct
 * (uniform) across `scenarios` seeded draws, and measure how often the baseline
 * winner survives. Also flags per-criterion single-axis flips (one-at-a-time).
 */
export function analyzeWeightSensitivity(input: {
  criteria: WeightedCriterion[];
  alternatives: AlternativeScoreInput[];
  perturbationPct?: number;
  scenarios?: number;
  seed?: number;
}): SensitivityResult {
  const scenarioInput = input.scenarios ?? 1000;
  const perturbationPct = input.perturbationPct ?? 0.2;
  const seed = input.seed ?? 0x5eed;
  if (!Number.isSafeInteger(scenarioInput) || scenarioInput < 1 || scenarioInput > 100_000) {
    throw new RangeError('sensitivity scenarios must be a safe integer between 1 and 100000');
  }
  if (!Number.isFinite(perturbationPct) || perturbationPct < 0 || perturbationPct > 1) {
    throw new RangeError('sensitivity perturbation must be finite and between 0 and 1');
  }
  if (!Number.isSafeInteger(seed)) throw new RangeError('sensitivity seed must be a safe integer');
  if (input.criteria.length === 0 || input.alternatives.length === 0) {
    throw new RangeError('sensitivity analysis requires criteria and alternatives');
  }
  if (new Set(input.criteria.map((criterion) => criterion.id)).size !== input.criteria.length) {
    throw new RangeError('sensitivity criterion ids must be unique');
  }
  if (new Set(input.alternatives.map((alternative) => alternative.alternativeId)).size !== input.alternatives.length) {
    throw new RangeError('sensitivity alternative ids must be unique');
  }
  const weights = input.criteria.map((criterion) => criterion.normalizedWeight);
  if (weights.some((weight) => !Number.isFinite(weight) || weight < 0 || weight > 1)
    || weights.reduce((sum, weight) => sum + weight, 0) <= 0) {
    throw new RangeError('sensitivity weights must be finite values in [0,1] with a positive sum');
  }
  for (const alternative of input.alternatives) {
    if (Object.values(alternative.scoresByCriterion)
      .some((score) => !Number.isFinite(score) || score < 0 || score > 1)) {
      throw new RangeError('sensitivity scores must be finite values in [0,1]');
    }
    if (Object.values(alternative.uncertaintyByCriterion ?? {})
      .some((uncertainty) => !Number.isFinite(uncertainty) || uncertainty < 0 || uncertainty > 1)) {
      throw new RangeError('sensitivity uncertainty must be finite values in [0,1]');
    }
  }
  const scenarios = scenarioInput;
  const rng = mulberry32(seed);
  const criteria = input.criteria;
  const baseWeights = criteria.map((c) => c.normalizedWeight);
  const baselineWinnerId = winnerOf(weightedTotals(criteria, input.alternatives, baseWeights));
  if (baselineWinnerId === null) {
    return {
      baselineWinnerId: null,
      winnerStability: 0,
      perturbationPct,
      scenarios,
      criticalCriteria: criteria.map((criterion) => ({
        criterionId: criterion.id,
        label: criterion.label,
        flipsWinner: false,
        thresholdPct: null,
        challengerId: null,
      })),
    };
  }

  let stayed = 0;
  for (let s = 0; s < scenarios; s += 1) {
    const jittered = baseWeights.map((w) => {
      const delta = (rng() * 2 - 1) * perturbationPct; // uniform [-p, +p]
      return Math.max(0, w * (1 + delta));
    });
    if (winnerOf(weightedTotals(criteria, input.alternatives, jittered)) === baselineWinnerId) stayed += 1;
  }

  const criticalCriteria = criteria.map((c, idx) => {
    const winnerAt = (delta: number): string | null => {
      const candidateWeights = baseWeights.slice();
      candidateWeights[idx] = Math.max(0, baseWeights[idx]! * (1 + delta));
      return winnerOf(weightedTotals(criteria, input.alternatives, candidateWeights));
    };
    const thresholds: Array<{ thresholdPct: number; challengerId: string }> = [];
    for (const direction of [-1, 1] as const) {
      const extremeDelta = direction * perturbationPct;
      const extremeWinner = winnerAt(extremeDelta);
      if (extremeWinner === null || extremeWinner === baselineWinnerId) continue;
      let stable = 0;
      let flipped = perturbationPct;
      for (let iteration = 0; iteration < 40; iteration += 1) {
        const midpoint = (stable + flipped) / 2;
        if (winnerAt(direction * midpoint) === baselineWinnerId) stable = midpoint;
        else flipped = midpoint;
      }
      thresholds.push({ thresholdPct: round4(direction * flipped), challengerId: extremeWinner });
    }
    thresholds.sort((a, b) => Math.abs(a.thresholdPct) - Math.abs(b.thresholdPct));
    const nearest = thresholds[0];
    return {
      criterionId: c.id,
      label: c.label,
      flipsWinner: Boolean(nearest),
      thresholdPct: nearest?.thresholdPct ?? null,
      challengerId: nearest?.challengerId ?? null,
    };
  });

  return {
    baselineWinnerId,
    winnerStability: round4(stayed / scenarios),
    perturbationPct,
    scenarios,
    criticalCriteria,
  };
}

// ---------------------------------------------------------------------------
// Monte Carlo impact interval (roadmap §3.5: 통상임금 파급액 구간 추정)
// ---------------------------------------------------------------------------
export interface ImpactDriver {
  id: string;
  label: string;
  /** Triangular distribution bounds for this driver's value. */
  min: number;
  mode: number;
  max: number;
}

export interface ImpactModelInput {
  drivers: ImpactDriver[];
  /** Combine sampled driver values into a single impact figure. */
  combine: (sample: Record<string, number>) => number;
  iterations?: number;
  seed?: number;
}

export interface ImpactInterval {
  iterations: number;
  mean: number;
  p10: number;
  p50: number;
  p90: number;
  min: number;
  max: number;
}

/** Inverse-CDF sample from a triangular(min, mode, max) distribution. */
export function sampleTriangular(u: number, min: number, mode: number, max: number): number {
  if (![u, min, mode, max].every(Number.isFinite)
    || u < 0 || u > 1
    || min > mode || mode > max) {
    throw new RangeError('triangular distribution requires finite 0<=u<=1 and min<=mode<=max');
  }
  if (max === min) return min;
  const c = (mode - min) / (max - min);
  if (u < c) return min + Math.sqrt(u * (max - min) * (mode - min));
  return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = clamp01(p) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = idx - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

export function estimateImpactInterval(input: ImpactModelInput): ImpactInterval {
  if (input.drivers.length === 0) throw new RangeError('impact model requires at least one driver');
  if (new Set(input.drivers.map((driver) => driver.id)).size !== input.drivers.length) {
    throw new RangeError('impact driver ids must be unique');
  }
  const iterationInput = input.iterations ?? 10000;
  if (!Number.isSafeInteger(iterationInput) || iterationInput < 1 || iterationInput > 100_000) {
    throw new RangeError('impact iterations must be a safe integer between 1 and 100000');
  }
  const iterations = iterationInput;
  const seed = input.seed ?? 0x1c9a5;
  if (!Number.isSafeInteger(seed)) throw new RangeError('impact seed must be a safe integer');
  const rng = mulberry32(seed);
  const outcomes: number[] = new Array<number>(iterations).fill(0);
  let sum = 0;
  for (let i = 0; i < iterations; i += 1) {
    const sample: Record<string, number> = {};
    for (const d of input.drivers) sample[d.id] = sampleTriangular(rng(), d.min, d.mode, d.max);
    const value = input.combine(sample);
    if (!Number.isFinite(value)) throw new RangeError('impact model must return a finite value');
    outcomes[i] = value;
    sum += value;
  }
  outcomes.sort((a, b) => a - b);
  return {
    iterations,
    mean: round4(sum / iterations),
    p10: round4(percentile(outcomes, 0.1)),
    p50: round4(percentile(outcomes, 0.5)),
    p90: round4(percentile(outcomes, 0.9)),
    min: round4(outcomes[0]!),
    max: round4(outcomes[iterations - 1]!),
  };
}
