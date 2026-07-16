import { createHash } from 'node:crypto';
import type {
  DecisionAnalyticsImpact,
  DecisionAnalyticsImpactRequest,
  DecisionAnalyticsSensitivity,
} from '@consulting/contracts';
import {
  analyzeWeightSensitivity,
  estimateImpactInterval,
  type AlternativeScoreInput,
  type WeightedCriterion,
} from './decision-analytics.js';

const METHOD_VERSION = 'decision_analytics_v2' as const;
const MAX_AUDITABLE_KRW = 1_000_000_000_000_000;

type Direction = 'higher_is_better' | 'lower_is_better';

type BreakdownInput = {
  criterionId: string;
  label: string;
  normalizedWeight: number;
  direction?: Direction;
  score: number;
  uncertainty: number;
};

export type DecisionAnalyticsAuditInput = {
  scorecardId: string;
  source: string;
  ranked: Array<{
    alternativeId: string;
    label: string;
    criteriaBreakdown: BreakdownInput[];
  }>;
  perturbationPct: number;
  scenarios: number;
  artifact?: { versionId: string; contentHash: string };
  impact?: DecisionAnalyticsImpactRequest;
};

export type DecisionAnalyticsAudit = {
  methodVersion: typeof METHOD_VERSION;
  inputHash: string;
  inputSnapshot: Record<string, unknown>;
  artifactVersionId: string | null;
  artifactContentHash: string | null;
  sensitivity: DecisionAnalyticsSensitivity;
  impact: DecisionAnalyticsImpact | null;
};

export class DecisionAnalyticsSourceIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DecisionAnalyticsSourceIntegrityError';
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function legacyDirection(source: string, criterionId: string): Direction | null {
  if (source !== 'post_answer_verification_v1') return null;
  if (criterionId === 'support') return 'higher_is_better';
  if (criterionId === 'contradiction_risk') return 'lower_is_better';
  return null;
}

function finiteUnit(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${field} must be a finite value in [0,1]`);
  }
  return value;
}

function normalizeScorecard(input: DecisionAnalyticsAuditInput): {
  criteria: WeightedCriterion[];
  alternatives: AlternativeScoreInput[];
  snapshot: Record<string, unknown>;
} {
  if (input.ranked.length === 0) throw new RangeError('decision analytics requires scorecard alternatives');
  const orderedAlternatives = [...input.ranked].sort((left, right) => left.alternativeId.localeCompare(right.alternativeId));
  if (new Set(orderedAlternatives.map((item) => item.alternativeId)).size !== orderedAlternatives.length) {
    throw new RangeError('scorecard alternative ids must be unique');
  }
  const first = orderedAlternatives[0]!;
  if (first.criteriaBreakdown.length === 0) throw new RangeError('decision analytics requires criteria breakdown');
  const firstCriteria = [...first.criteriaBreakdown].sort((left, right) => left.criterionId.localeCompare(right.criterionId));
  if (new Set(firstCriteria.map((item) => item.criterionId)).size !== firstCriteria.length) {
    throw new RangeError('scorecard criterion ids must be unique');
  }
  const criteria = firstCriteria.map((item) => {
    const direction = item.direction ?? legacyDirection(input.source, item.criterionId);
    if (direction !== 'higher_is_better' && direction !== 'lower_is_better') {
      throw new RangeError(`criterion direction is unavailable: ${item.criterionId}`);
    }
    return {
      id: item.criterionId,
      label: item.label,
      normalizedWeight: finiteUnit(item.normalizedWeight, 'criterion weight'),
      direction,
    } satisfies WeightedCriterion;
  });
  if (criteria.reduce((sum, criterion) => sum + criterion.normalizedWeight, 0) <= 0) {
    throw new RangeError('scorecard criterion weights must have a positive sum');
  }
  const criterionById = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const alternatives = orderedAlternatives.map((alternative) => {
    const breakdown = [...alternative.criteriaBreakdown].sort((left, right) => left.criterionId.localeCompare(right.criterionId));
    if (breakdown.length !== criteria.length || new Set(breakdown.map((item) => item.criterionId)).size !== criteria.length) {
      throw new RangeError('scorecard alternatives must share one exact criterion set');
    }
    const scoresByCriterion: Record<string, number> = {};
    const uncertaintyByCriterion: Record<string, number> = {};
    for (const item of breakdown) {
      const criterion = criterionById.get(item.criterionId);
      const direction = item.direction ?? legacyDirection(input.source, item.criterionId);
      if (!criterion || (direction !== 'higher_is_better' && direction !== 'lower_is_better')
        || criterion.label !== item.label
        || criterion.direction !== direction
        || Math.abs(criterion.normalizedWeight - finiteUnit(item.normalizedWeight, 'criterion weight')) > 0.000_001) {
        throw new RangeError('scorecard criterion metadata is inconsistent across alternatives');
      }
      scoresByCriterion[item.criterionId] = finiteUnit(item.score, 'criterion score');
      uncertaintyByCriterion[item.criterionId] = finiteUnit(item.uncertainty, 'criterion uncertainty');
    }
    return {
      alternativeId: alternative.alternativeId,
      label: alternative.label,
      scoresByCriterion,
      uncertaintyByCriterion,
    } satisfies AlternativeScoreInput;
  });
  return {
    criteria,
    alternatives,
    snapshot: {
      scorecardId: input.scorecardId,
      source: input.source,
      criteria,
      alternatives,
    },
  };
}

export function buildDecisionAnalyticsAudit(input: DecisionAnalyticsAuditInput): DecisionAnalyticsAudit {
  let normalized: ReturnType<typeof normalizeScorecard>;
  try {
    normalized = normalizeScorecard(input);
  } catch (error) {
    if (error instanceof Error) {
      throw new DecisionAnalyticsSourceIntegrityError(error.message, { cause: error });
    }
    throw new DecisionAnalyticsSourceIntegrityError('decision scorecard source is malformed');
  }
  if (input.artifact && !/^[a-f0-9]{64}$/u.test(input.artifact.contentHash)) {
    throw new DecisionAnalyticsSourceIntegrityError('artifact content hash must be lowercase sha256');
  }
  const orderedImpact = input.impact
    ? { ...input.impact, drivers: [...input.impact.drivers].sort((left, right) => left.id.localeCompare(right.id)) }
    : null;
  const inputSnapshot: Record<string, unknown> = {
    methodVersion: METHOD_VERSION,
    scorecard: normalized.snapshot,
    artifact: input.artifact ?? null,
    sensitivity: { perturbationPct: input.perturbationPct, scenarios: input.scenarios },
    impact: orderedImpact,
  };
  const inputHash = createHash('sha256').update(canonicalJson(inputSnapshot), 'utf8').digest('hex');
  const seed = Number.parseInt(inputHash.slice(0, 8), 16);
  const sensitivity = analyzeWeightSensitivity({
    criteria: normalized.criteria,
    alternatives: normalized.alternatives,
    perturbationPct: input.perturbationPct,
    scenarios: input.scenarios,
    seed,
  });
  let impact: DecisionAnalyticsImpact | null = null;
  if (orderedImpact) {
    let maximum = orderedImpact.fixedMultiplier;
    for (const driver of orderedImpact.drivers) maximum *= driver.max;
    if (!Number.isFinite(maximum) || maximum > MAX_AUDITABLE_KRW) {
      throw new RangeError('impact maximum exceeds the auditable KRW ceiling');
    }
    const interval = estimateImpactInterval({
      drivers: orderedImpact.drivers,
      iterations: orderedImpact.iterations,
      seed,
      combine: (sample) => orderedImpact.drivers.reduce(
        (total, driver) => total * sample[driver.id]!,
        orderedImpact.fixedMultiplier,
      ),
    });
    impact = { ...orderedImpact, seed, interval };
  }
  return {
    methodVersion: METHOD_VERSION,
    inputHash,
    inputSnapshot,
    artifactVersionId: input.artifact?.versionId ?? null,
    artifactContentHash: input.artifact?.contentHash ?? null,
    sensitivity,
    impact,
  };
}
