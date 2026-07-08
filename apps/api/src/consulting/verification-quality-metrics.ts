import type { ClaimVerdictKind } from './evidence-to-decision.service.js';

export interface ClassificationQualityRow {
  id: string;
  expected: ClaimVerdictKind;
  actual: ClaimVerdictKind;
}

export interface LabelQualityMetrics {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

export interface ClassificationQualityMetrics {
  rowCount: number;
  overallAccuracy: number;
  macroF1: number;
  contradictionRecall: number;
  unsupportedDeferralRecall: number;
  falseBlockRate: number;
  perLabel: Record<ClaimVerdictKind, LabelQualityMetrics>;
}

export interface HallucinationIssueCounts {
  claimCount: number;
  unsupportedClaims: number;
  refutedClaims: number;
  citationIssues: number;
  numericBlocked: number;
}

export interface HallucinationIssueRates extends HallucinationIssueCounts {
  unsupportedClaimRate: number;
  refutedClaimRate: number;
  citationIssueRate: number;
  numericBlockedRate: number;
  overallIssueRate: number;
}

export interface HallucinationReductionMetrics {
  before: HallucinationIssueRates;
  after: HallucinationIssueRates;
  reductionRate: number;
  regressions: string[];
  ok: boolean;
}

const LABELS: ClaimVerdictKind[] = ['supports', 'refutes', 'not_enough_info', 'mixed'];

function round4(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(4));
}

function safeRate(numerator: number, denominator: number, emptyValue = 0): number {
  return denominator === 0 ? emptyValue : numerator / denominator;
}

function f1(precision: number, recall: number): number {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

export function computeClassificationQualityMetrics(rows: ClassificationQualityRow[]): ClassificationQualityMetrics {
  const perLabel = Object.fromEntries(
    LABELS.map((label) => {
      const truePositive = rows.filter((row) => row.expected === label && row.actual === label).length;
      const falsePositive = rows.filter((row) => row.expected !== label && row.actual === label).length;
      const falseNegative = rows.filter((row) => row.expected === label && row.actual !== label).length;
      const precision = safeRate(truePositive, truePositive + falsePositive);
      const recall = safeRate(truePositive, truePositive + falseNegative);
      const support = rows.filter((row) => row.expected === label).length;
      return [
        label,
        {
          truePositive,
          falsePositive,
          falseNegative,
          precision: round4(precision),
          recall: round4(recall),
          f1: round4(f1(precision, recall)),
          support,
        },
      ];
    }),
  ) as Record<ClaimVerdictKind, LabelQualityMetrics>;

  const observedLabels = LABELS.filter((label) => perLabel[label].support > 0 || rows.some((row) => row.actual === label));
  const expectedSupports = rows.filter((row) => row.expected === 'supports');
  const expectedRefutes = rows.filter((row) => row.expected === 'refutes');
  const expectedNei = rows.filter((row) => row.expected === 'not_enough_info');

  return {
    rowCount: rows.length,
    overallAccuracy: round4(safeRate(rows.filter((row) => row.expected === row.actual).length, rows.length)),
    macroF1: round4(safeRate(observedLabels.reduce((sum, label) => sum + perLabel[label].f1, 0), observedLabels.length)),
    contradictionRecall: round4(safeRate(expectedRefutes.filter((row) => row.actual === 'refutes').length, expectedRefutes.length)),
    unsupportedDeferralRecall: round4(safeRate(expectedNei.filter((row) => row.actual === 'not_enough_info').length, expectedNei.length)),
    falseBlockRate: round4(safeRate(expectedSupports.filter((row) => row.actual !== 'supports').length, expectedSupports.length)),
    perLabel,
  };
}

export function computeHallucinationIssueRates(counts: HallucinationIssueCounts): HallucinationIssueRates {
  const claimCount = Math.max(0, Math.round(counts.claimCount));
  const unsupportedClaims = Math.max(0, Math.round(counts.unsupportedClaims));
  const refutedClaims = Math.max(0, Math.round(counts.refutedClaims));
  const citationIssues = Math.max(0, Math.round(counts.citationIssues));
  const numericBlocked = Math.max(0, Math.round(counts.numericBlocked));
  const denominator = Math.max(1, claimCount);
  return {
    claimCount,
    unsupportedClaims,
    refutedClaims,
    citationIssues,
    numericBlocked,
    unsupportedClaimRate: round4(unsupportedClaims / denominator),
    refutedClaimRate: round4(refutedClaims / denominator),
    citationIssueRate: round4(citationIssues / denominator),
    numericBlockedRate: round4(numericBlocked / denominator),
    overallIssueRate: round4((unsupportedClaims + refutedClaims + citationIssues + numericBlocked) / denominator),
  };
}

export function computeHallucinationReduction(before: HallucinationIssueRates, after: HallucinationIssueRates): HallucinationReductionMetrics {
  const comparableKeys = ['unsupportedClaimRate', 'refutedClaimRate', 'citationIssueRate', 'numericBlockedRate', 'overallIssueRate'] as const;
  const regressions = comparableKeys.filter((key) => after[key] > before[key]);
  const reductionRate = before.overallIssueRate === 0 ? (after.overallIssueRate === 0 ? 0 : -1) : (before.overallIssueRate - after.overallIssueRate) / before.overallIssueRate;
  return {
    before,
    after,
    reductionRate: round4(reductionRate),
    regressions,
    ok: regressions.length === 0 && reductionRate >= 0,
  };
}
