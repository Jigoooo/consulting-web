import type { ArtifactExportPreflightResponse } from '@consulting/contracts';

/**
 * ReportGenerationWorkflow — shadow spike (W3).
 *
 * Boundary (roadmap §5.2): this graph orchestrates the PUBLISH decision only. It
 * NEVER re-implements verification/exactness/red-team logic (those stay in the
 * proven services) and NEVER performs an export side-effect. In shadow mode it
 * produces a decision and we compare it against the existing preflight contract.
 *
 * Pointer State Pattern: state carries references + verdict codes only, never
 * retrieved evidence text or claim bodies (Checkpoint Bloat guard).
 */

export type ReportWorkflowVerdict = 'PASS' | 'PASS_WITH_WARNINGS' | 'BLOCKED';
export type ReportShadowDecision = 'would_publish' | 'would_block';
export type ReportWorkflowNode =
  | 'draft'
  | 'verify'
  | 'human_approve'
  | 'block'
  | 'publish';

export interface ReportWorkflowState {
  workspaceId: string;
  projectId: string;
  artifactId: string;
  artifactVersionId: string;
  /** Content hash instead of the document body (bloat guard). */
  contentHash: string;
  /** Gate verdict from the verifier preflight, null until verify runs. */
  verdict: ReportWorkflowVerdict | null;
  /** Message codes only — never evidence/claim text. */
  gateBlockers: string[];
  gateWarnings: string[];
  redTeamVerdict: ReportWorkflowVerdict | null;
  attempt: number;
  humanApproved: boolean;
  shadowDecision: ReportShadowDecision | null;
  /** Append-only node transition log for trace_spans continuity. */
  visited: ReportWorkflowNode[];
}

/**
 * The one contract the workflow depends on: run the EXISTING preflight and
 * return its already-computed verdict. No new verification logic here.
 */
export interface PreflightPort {
  preflight(input: {
    workspaceId: string;
    projectId: string;
    artifactId: string;
    artifactVersionId: string;
    title: string;
    versionNo: number;
    content: string;
    governingMessage: string | null;
    soWhat: string | null;
    sourceThreadId: string | null;
    sourceMessageId: string | null;
  }): Promise<ArtifactExportPreflightResponse>;
}

/** Map a preflight response into the pointer-state verdict fields (codes only). */
export function preflightToVerdict(preflight: ArtifactExportPreflightResponse): {
  verdict: ReportWorkflowVerdict;
  gateBlockers: string[];
  gateWarnings: string[];
  redTeamVerdict: ReportWorkflowVerdict | null;
} {
  const gate = preflight.gate;
  const verdict: ReportWorkflowVerdict = !preflight.canExport
    ? 'BLOCKED'
    : gate && gate.warnings.length > 0
      ? 'PASS_WITH_WARNINGS'
      : 'PASS';
  return {
    verdict,
    gateBlockers: gate ? gate.blockers.map((b) => b.code) : preflight.canExport ? [] : [preflight.reason],
    gateWarnings: gate ? gate.warnings.map((w) => w.code) : [],
    redTeamVerdict: preflight.redTeam.verdict,
  };
}

/**
 * Pure decision core (no LangGraph, no DB) — the heart of the shadow spike, so it
 * can be unit-tested for success criterion (c) determinism and (d) parity.
 *
 * Rules:
 *  - BLOCKED verdict → terminal would_block. The artifact version/content hash
 *    is immutable, so retrying the same preflight cannot repair it.
 *  - PASS / PASS_WITH_WARNINGS → requires human approval → would_publish.
 *  - red-team BLOCKED is a hard block regardless of gate.
 */
export function decideNextNode(
  state: ReportWorkflowState,
  _maxRepairAttempts: number,
): { next: ReportWorkflowNode | 'END'; patch: Partial<ReportWorkflowState> } {
  const last = state.visited.at(-1);

  if (last === 'draft') return { next: 'verify', patch: {} };

  if (last === 'verify') {
    const hardBlock = state.verdict === 'BLOCKED' || state.redTeamVerdict === 'BLOCKED';
    if (hardBlock) {
      return { next: 'block', patch: {} };
    }
    return { next: 'human_approve', patch: {} };
  }


  if (last === 'human_approve') {
    if (!state.humanApproved) return { next: 'block', patch: {} };
    return { next: 'publish', patch: {} };
  }

  if (last === 'block') return { next: 'END', patch: { shadowDecision: 'would_block' } };
  if (last === 'publish') return { next: 'END', patch: { shadowDecision: 'would_publish' } };

  return { next: 'verify', patch: {} };
}

/**
 * Parity check for success criterion (d): the shadow decision must never
 * contradict what the existing export preflight would allow. would_publish is
 * only legal when the real preflight says canExport.
 */
export function shadowParityHolds(
  shadowDecision: ReportShadowDecision,
  preflightCanExport: boolean,
): boolean {
  return shadowDecision === 'would_publish' ? preflightCanExport === true : true;
}

/** Promotion requires exact behavioral parity, not merely one-sided safety. */
export function shadowPromotionParityHolds(
  shadowDecision: ReportShadowDecision,
  preflightCanExport: boolean,
): boolean {
  return (shadowDecision === 'would_publish') === preflightCanExport;
}

export function initialReportState(input: {
  workspaceId: string;
  projectId: string;
  artifactId: string;
  artifactVersionId: string;
  contentHash: string;
}): ReportWorkflowState {
  return {
    ...input,
    verdict: null,
    gateBlockers: [],
    gateWarnings: [],
    redTeamVerdict: null,
    attempt: 0,
    humanApproved: false,
    shadowDecision: null,
    visited: [],
  };
}
