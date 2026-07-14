/**
 * Batch verification review plan (P4) — turns the existing per-artifact export
 * preflight audit into a PRIORITIZED, reason-tagged human-review worklist.
 *
 * Pure, dependency-free, deterministic. It does NOT re-run verification (that
 * stays in ArtifactVerificationService); it consumes the already-computed audit
 * rows and answers "which artifacts must a human review first, and why?".
 *
 * Ties into the W3 shadow workflow: an artifact that the shadow graph would
 * block, or that carries red-team blockers, is escalated to the top of the
 * review queue so a human sees the riskiest items first (defense-in-depth).
 */

export type PreflightReason =
  | 'OK'
  | 'ARTIFACT_STRUCTURE_REQUIRED'
  | 'ARTIFACT_VERIFICATION_REQUIRED'
  | 'VERIFIER_GATE_BLOCKED'
  | 'RED_TEAM_BLOCKED'
  | 'RED_TEAM_REVIEW_REQUIRED'
  | 'HUMAN_REVIEW_REQUIRED'
  | 'HUMAN_REVIEW_REJECTED'
  | 'HUMAN_REVIEW_LEDGER_INVALID';

export type RedTeamVerdict = 'PASS' | 'PASS_WITH_WARNINGS' | 'BLOCKED' | null;

export interface BatchAuditRow {
  artifactId: string;
  artifactVersionId: string;
  title: string;
  versionNo: number;
  canExport: boolean;
  reason: PreflightReason;
  gateBlockerCount: number;
  gateWarningCount: number;
  redTeamVerdict: RedTeamVerdict;
}

export type ReviewPriority = 'critical' | 'high' | 'medium' | 'clear';

export interface ReviewWorklistItem {
  artifactId: string;
  artifactVersionId: string;
  title: string;
  versionNo: number;
  priority: ReviewPriority;
  /** Ordered, human-readable reasons — codes/summaries only, no document text. */
  reasons: string[];
  /** True when a human decision is required before this artifact can publish. */
  needsHumanReview: boolean;
}

export interface BatchReviewPlan {
  projectId: string;
  projectName: string;
  summary: {
    total: number;
    critical: number;
    high: number;
    medium: number;
    clear: number;
    needsHumanReview: number;
  };
  /** Sorted: critical → high → medium → clear, then by title for stability. */
  worklist: ReviewWorklistItem[];
}

const PRIORITY_RANK: Record<ReviewPriority, number> = { critical: 0, high: 1, medium: 2, clear: 3 };

/**
 * Classify a single audit row into a review priority + reasons.
 *
 * critical: red-team BLOCKED or a blocked gate on a would-be export → hard stop.
 * high:     verification/structure required, or gate blockers present.
 * medium:   exportable but carries warnings (gate or red-team) a human should see.
 * clear:    exportable, no warnings — no human review needed.
 */
export function classifyReviewRow(row: BatchAuditRow): ReviewWorklistItem {
  const reasons: string[] = [];
  let priority: ReviewPriority = 'clear';

  if (!row.canExport && row.reason === 'OK') {
    priority = 'critical';
    reasons.push('export_not_allowed');
  }
  if (row.redTeamVerdict === 'BLOCKED') {
    priority = 'critical';
    reasons.push('red_team_blocked');
  }
  if (row.reason === 'VERIFIER_GATE_BLOCKED' || (!row.canExport && row.gateBlockerCount > 0)) {
    priority = 'critical';
    reasons.push(`verifier_gate_blocked:${row.gateBlockerCount}`);
  }
  if (row.reason === 'RED_TEAM_BLOCKED' && !reasons.includes('red_team_blocked')) {
    priority = 'critical';
    reasons.push('red_team_blocked');
  }
  if (row.reason === 'RED_TEAM_REVIEW_REQUIRED') {
    priority = 'critical';
    reasons.push('red_team_review_required');
  }
  if (row.reason === 'HUMAN_REVIEW_REJECTED') {
    priority = 'critical';
    reasons.push('human_review_rejected');
  }
  if (row.reason === 'HUMAN_REVIEW_LEDGER_INVALID') {
    priority = 'critical';
    reasons.push('human_review_ledger_invalid');
  }
  if (row.reason === 'ARTIFACT_VERIFICATION_REQUIRED') {
    priority = priority === 'critical' ? priority : 'high';
    reasons.push('verification_required');
  }
  if (row.reason === 'ARTIFACT_STRUCTURE_REQUIRED') {
    priority = priority === 'critical' ? priority : 'high';
    reasons.push('structure_required');
  }
  if (row.reason === 'HUMAN_REVIEW_REQUIRED' && priority === 'clear') {
    priority = 'medium';
    reasons.push('human_review_required');
  }
  if (priority !== 'critical' && priority !== 'high' && row.gateWarningCount > 0) {
    priority = 'medium';
    reasons.push(`gate_warnings:${row.gateWarningCount}`);
  }
  if (priority !== 'critical' && priority !== 'high' && row.redTeamVerdict === 'PASS_WITH_WARNINGS') {
    priority = priority === 'medium' ? priority : 'medium';
    reasons.push('red_team_warnings');
  }
  if (reasons.length === 0) reasons.push('clean_export_ready');

  const needsHumanReview = priority === 'critical' || priority === 'high' || priority === 'medium';
  return {
    artifactId: row.artifactId,
    artifactVersionId: row.artifactVersionId,
    title: row.title,
    versionNo: row.versionNo,
    priority,
    reasons,
    needsHumanReview,
  };
}

export function buildBatchReviewPlan(input: {
  projectId: string;
  projectName: string;
  rows: BatchAuditRow[];
}): BatchReviewPlan {
  const worklist = input.rows
    .map(classifyReviewRow)
    .sort((a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      || a.title.localeCompare(b.title)
      || a.versionNo - b.versionNo);

  const summary = {
    total: worklist.length,
    critical: worklist.filter((w) => w.priority === 'critical').length,
    high: worklist.filter((w) => w.priority === 'high').length,
    medium: worklist.filter((w) => w.priority === 'medium').length,
    clear: worklist.filter((w) => w.priority === 'clear').length,
    needsHumanReview: worklist.filter((w) => w.needsHumanReview).length,
  };

  return { projectId: input.projectId, projectName: input.projectName, summary, worklist };
}

// ---------------------------------------------------------------------------
// Adapter: map the existing ArtifactExportPreflightAuditResult (from
// auditArtifactExportPreflight) into a batch review plan without re-running any
// verification. A minimal structural shape keeps this module import-light.
// ---------------------------------------------------------------------------
export interface AuditResultLike {
  projectId: string;
  projectName: string;
  rows: Array<{
    artifactId: string;
    artifactVersionId: string;
    title: string;
    versionNo: number;
    canExport: boolean;
    reason: PreflightReason;
    gate: { blockers: unknown[]; warnings: unknown[] } | null;
    redTeam: { verdict: RedTeamVerdict };
  }>;
}

export function reviewPlanFromAudit(audit: AuditResultLike): BatchReviewPlan {
  return buildBatchReviewPlan({
    projectId: audit.projectId,
    projectName: audit.projectName,
    rows: audit.rows.map((r) => ({
      artifactId: r.artifactId,
      artifactVersionId: r.artifactVersionId,
      title: r.title,
      versionNo: r.versionNo,
      canExport: r.canExport,
      reason: r.reason,
      gateBlockerCount: r.gate ? r.gate.blockers.length : 0,
      gateWarningCount: r.gate ? r.gate.warnings.length : 0,
      redTeamVerdict: r.redTeam.verdict,
    })),
  });
}
