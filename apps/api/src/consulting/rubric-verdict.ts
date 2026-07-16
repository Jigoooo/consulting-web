// Rubric-as-Verdict: turn the binary PASS/BLOCKED gate into a structured 5-axis
// score (0..1). Axes are derived DETERMINISTICALLY from existing verifier signals —
// there is no LLM self-scoring, which keeps the rubric immune to reward hacking.
//
// The point is targeted self-revision: instead of hedging a whole answer, the model
// only patches the axis that is actually weak. R5 (exactness) is the one HARD axis —
// a blocked numeric/legal check still gates report/export downstream.
//
// Design: docs/plans/2026-07-15-rubric-verdict-design.md

import type { ClaimVerdictKind } from './evidence-to-decision.service.js';
import type { ExactnessRunStatus } from './exactness-gate.service.js';
import type { VerifierGateMode } from './verifier-gate-policy.service.js';

export type ApplicabilityLabel =
  | 'directly_applicable'
  | 'analogical'
  | 'cross_project'
  | 'background_only';

export type CragStatus = 'sufficient' | 'ambiguous' | 'insufficient';

export interface RubricVerdictInput {
  claimId: string;
  verdict: ClaimVerdictKind;
  confidence: number;
  decisionImpact: number;
  applicability: ApplicabilityLabel;
}

export interface RubricInput {
  mode: VerifierGateMode;
  cragStatus: CragStatus;
  exactnessStatus: ExactnessRunStatus;
  citationIssueCount: number;
  verdicts: RubricVerdictInput[];
  overclaimRisk: boolean;
}

export type RubricAxis =
  | 'R1_evidence'
  | 'R2_applicability'
  | 'R3_citation'
  | 'R4_calibration'
  | 'R5_exactness';

export type RubricAxes = Record<RubricAxis, number>;

export interface RubricResult {
  axes: RubricAxes;
  weightsUsed: RubricAxes;
  weighted: number;
  weakAxes: RubricAxis[];
  reviseHints: Partial<Record<RubricAxis, string>>;
  hardExactnessFail: boolean;
}

const WEAK_THRESHOLD = 0.4;

// Mode-specific weight vectors (deliberative "category-spec" idea: emphasize the
// axes that matter for this surface). Each vector sums to 1.
const WEIGHTS: Record<VerifierGateMode, RubricAxes> = {
  general_chat: { R1_evidence: 0.2, R2_applicability: 0.2, R3_citation: 0.2, R4_calibration: 0.2, R5_exactness: 0.2 },
  analysis_draft: { R1_evidence: 0.25, R2_applicability: 0.25, R3_citation: 0.2, R4_calibration: 0.15, R5_exactness: 0.15 },
  report_decision: { R1_evidence: 0.25, R2_applicability: 0.2, R3_citation: 0.2, R4_calibration: 0.15, R5_exactness: 0.2 },
  final_export: { R1_evidence: 0.2, R2_applicability: 0.2, R3_citation: 0.25, R4_calibration: 0.1, R5_exactness: 0.25 },
};

const APPLICABILITY_SCORE: Record<ApplicabilityLabel, number> = {
  directly_applicable: 1.0,
  analogical: 0.5,
  cross_project: 0.3,
  background_only: 0.2,
};

const VERDICT_EVIDENCE_SCORE: Record<ClaimVerdictKind, number> = {
  supports: 1.0,
  mixed: 0.5,
  not_enough_info: 0.3,
  refutes: 0.0,
};

const REVISE_HINTS: Record<RubricAxis, string> = {
  R1_evidence: '이 주장은 직접 근거가 부족합니다. 근거를 보강하거나 "자료 기준"으로 표현을 낮춥니다.',
  R2_applicability: '이 근거는 현재 범위에 직접 적용되지 않습니다. analogical/참조 라벨을 붙입니다.',
  R3_citation: '인용이 검색 근거와 불일치합니다. 해당 문장의 인용을 재확인합니다.',
  R4_calibration: '결론 강도가 근거보다 강합니다. 조건부/재설계 필요로 강도를 낮춥니다.',
  R5_exactness: '수치·계산·법령 확인 게이트가 blocked 상태입니다. 원본으로 재검증합니다.',
};

function round4(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(4));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

// R1: evidence sufficiency — the weakest claim drives the axis (a report is only as
// strong as its worst load-bearing claim), then an insufficient CRAG halves it.
function evidenceAxis(verdicts: RubricVerdictInput[], crag: CragStatus): number {
  if (verdicts.length === 0) return 0.3; // no claims to verify → treat as unproven, not failed
  const worst = Math.min(...verdicts.map((v) => VERDICT_EVIDENCE_SCORE[v.verdict]));
  const cragPenalty = crag === 'insufficient' ? 0.5 : crag === 'ambiguous' ? 0.8 : 1.0;
  return clamp01(worst * cragPenalty);
}

// R2: applicability — worst applicability label across claims.
function applicabilityAxis(verdicts: RubricVerdictInput[]): number {
  if (verdicts.length === 0) return 0.5;
  return clamp01(Math.min(...verdicts.map((v) => APPLICABILITY_SCORE[v.applicability])));
}

// R3: citation integrity — each citation issue removes ~0.34.
function citationAxis(citationIssueCount: number): number {
  return clamp01(1 - Math.max(0, citationIssueCount) * 0.34);
}

// R4: conclusion calibration — the danger is asserting a HIGH-impact conclusion on
// LOW confidence (overreaching). Confidence exceeding impact is fine (well-evidenced
// stakes-appropriate claim), so we only penalize the overreach direction: impact that
// runs ahead of confidence. Overclaim flag applies a hard multiplier on top.
function calibrationAxis(verdicts: RubricVerdictInput[], overclaimRisk: boolean): number {
  if (verdicts.length === 0) return 0.7;
  const perClaim = verdicts.map((v) => {
    const overreach = Math.max(0, v.decisionImpact - v.confidence);
    return clamp01(1 - overreach);
  });
  const base = perClaim.reduce((s, x) => s + x, 0) / perClaim.length;
  return clamp01(overclaimRisk ? base * 0.4 : base);
}

// R5: exactness — hard axis. Passed=1, skipped(N/A)=0.7, blocked=0.
function exactnessAxis(status: ExactnessRunStatus): number {
  if (status === 'passed') return 1.0;
  if (status === 'blocked') return 0.0;
  return 0.7; // skipped / not applicable
}

export function computeRubric(input: RubricInput): RubricResult {
  const axes: RubricAxes = {
    R1_evidence: round4(evidenceAxis(input.verdicts, input.cragStatus)),
    R2_applicability: round4(applicabilityAxis(input.verdicts)),
    R3_citation: round4(citationAxis(input.citationIssueCount)),
    R4_calibration: round4(calibrationAxis(input.verdicts, input.overclaimRisk)),
    R5_exactness: round4(exactnessAxis(input.exactnessStatus)),
  };

  const weightsUsed = WEIGHTS[input.mode];
  const weighted = round4(
    (Object.keys(axes) as RubricAxis[]).reduce((sum, axis) => sum + axes[axis] * weightsUsed[axis], 0),
  );

  const weakAxes = (Object.keys(axes) as RubricAxis[]).filter((axis) => axes[axis] < WEAK_THRESHOLD);
  const reviseHints: Partial<Record<RubricAxis, string>> = {};
  for (const axis of weakAxes) reviseHints[axis] = REVISE_HINTS[axis];

  return {
    axes,
    weightsUsed,
    weighted,
    weakAxes,
    reviseHints,
    hardExactnessFail: input.exactnessStatus === 'blocked',
  };
}

// Render a compact self-revision contract for the LLM. Deliberative framing: instead of
// hedging the whole answer, the model is told to revise ONLY the weak axes. This is the
// mechanism that converts a low rubric score into a targeted, local fix (lever A).
export function renderRubricRevisionContract(result: RubricResult): string {
  const lines = [
    '### 루브릭 판정',
    `- weighted_score: ${result.weighted}`,
    `- axes: R1=${result.axes.R1_evidence} R2=${result.axes.R2_applicability} R3=${result.axes.R3_citation} R4=${result.axes.R4_calibration} R5=${result.axes.R5_exactness}`,
  ];
  if (result.weakAxes.length === 0) {
    lines.push('- 약한 축 없음 — 근거가 충분하면 보정 불필요, 명확히 결론을 제시한다.');
    return lines.join('\n');
  }
  lines.push('- 답변 전체를 유보하지 말고 아래 약한 축만 국소 보정한다:');
  for (const axis of result.weakAxes) {
    lines.push(`  - ${axis} (${result.axes[axis]}): ${result.reviseHints[axis] ?? ''}`);
  }
  if (result.hardExactnessFail) {
    lines.push('- R5_exactness는 하드 게이트다: 수치·법령 재검증 전에는 report/export를 진행하지 않는다.');
  }
  return lines.join('\n');
}
