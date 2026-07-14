import type { ArtifactExportPreflightResponse } from '@consulting/contracts';

export type ArtifactHumanReviewAction = 'approve' | 'reject';
export type ArtifactHumanReviewExportReason =
  | ArtifactExportPreflightResponse['reason']
  | 'RED_TEAM_BLOCKED'
  | 'RED_TEAM_REVIEW_REQUIRED'
  | 'HUMAN_REVIEW_REQUIRED'
  | 'HUMAN_REVIEW_REJECTED'
  | 'HUMAN_REVIEW_LEDGER_INVALID';

export interface ArtifactHumanReviewDecision {
  id: string;
  action: ArtifactHumanReviewAction;
  contentHash: string;
  decidedAt: string;
}

export interface ArtifactHumanReviewExportDecision {
  canExport: boolean;
  reason: ArtifactHumanReviewExportReason;
}

export type ArtifactHumanReviewStatus = 'not_required' | 'pending' | 'approved' | 'rejected' | 'blocked' | 'invalid';

export function artifactHumanReviewStatus(
  preflight: ArtifactExportPreflightResponse,
  human: ArtifactHumanReviewExportDecision,
): ArtifactHumanReviewStatus {
  if (human.reason === 'HUMAN_REVIEW_LEDGER_INVALID') return 'invalid';
  if (human.reason === 'HUMAN_REVIEW_REJECTED') return 'rejected';
  if (human.reason === 'HUMAN_REVIEW_REQUIRED') return 'pending';
  if (!human.canExport) return 'blocked';
  const requiredApproval = preflight.messages.length > 0
    || preflight.redTeam.verdict === 'PASS_WITH_WARNINGS';
  return requiredApproval ? 'approved' : 'not_required';
}

/**
 * Human review can narrow exportability but can never override verifier blockers.
 * Decisions are version-content bound; a stale hash is equivalent to no decision.
 */
export function evaluateArtifactHumanReviewExport(
  preflight: ArtifactExportPreflightResponse,
  currentContentHash: string,
  latestDecision: ArtifactHumanReviewDecision | null,
): ArtifactHumanReviewExportDecision {
  if (!preflight.canExport) return { canExport: false, reason: preflight.reason };
  if (preflight.redTeam.verdict === 'BLOCKED') return { canExport: false, reason: 'RED_TEAM_BLOCKED' };
  if (preflight.redTeam.mode === 'warning' && preflight.redTeam.status !== 'completed') {
    return { canExport: false, reason: 'RED_TEAM_REVIEW_REQUIRED' };
  }

  const currentDecision = latestDecision?.contentHash === currentContentHash ? latestDecision : null;
  if (currentDecision?.action === 'reject') {
    return { canExport: false, reason: 'HUMAN_REVIEW_REJECTED' };
  }

  const needsHumanReview = preflight.reason === 'OK' && (
    preflight.messages.length > 0
    || preflight.redTeam.verdict === 'PASS_WITH_WARNINGS'
  );
  if (needsHumanReview && currentDecision?.action !== 'approve') {
    return { canExport: false, reason: 'HUMAN_REVIEW_REQUIRED' };
  }
  return { canExport: true, reason: 'OK' };
}
