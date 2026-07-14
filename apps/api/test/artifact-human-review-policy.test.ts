import { describe, expect, it } from 'vitest';
import type { ArtifactExportPreflightResponse } from '@consulting/contracts';
import { evaluateArtifactHumanReviewExport, type ArtifactHumanReviewDecision } from '../src/artifacts/artifact-human-review-policy.js';

const HASH = 'a'.repeat(64);
const clean: ArtifactExportPreflightResponse = {
  canExport: true,
  reason: 'OK',
  versionNo: 1,
  gate: { decision: 'PASS', blockers: [], warnings: [] },
  messages: [],
  redTeam: { mode: 'warning', status: 'completed', verdict: 'PASS', contentHash: HASH, policyVersion: 'p1', attacks: [], defenses: [], reviewedAt: '2026-07-13T00:00:00.000Z' },
};
const warning: ArtifactExportPreflightResponse = {
  ...clean,
  messages: ['적대 검토 보완 필요'],
  redTeam: { ...clean.redTeam, verdict: 'PASS_WITH_WARNINGS', attacks: [{ persona: '감사원', severity: 'warning', category: '근거', message: '보완 필요' }] },
};
const redTeamBlocked: ArtifactExportPreflightResponse = {
  ...warning,
  redTeam: { ...warning.redTeam, verdict: 'BLOCKED', attacks: [{ persona: '감사원', severity: 'blocker', category: '허위', message: '차단 필요' }] },
};
const redTeamPending: ArtifactExportPreflightResponse = {
  ...warning,
  redTeam: { ...warning.redTeam, status: 'pending', verdict: null, contentHash: null, policyVersion: null, reviewedAt: null, attacks: [], defenses: [] },
};
const blocked: ArtifactExportPreflightResponse = {
  ...clean,
  canExport: false,
  reason: 'VERIFIER_GATE_BLOCKED',
  gate: { decision: 'BLOCKED', blockers: [{ code: 'high_impact_unsupported', severity: 'blocker', message: '근거 부족' }], warnings: [] },
  messages: ['근거 부족'],
};

function decision(action: 'approve' | 'reject', contentHash = HASH): ArtifactHumanReviewDecision {
  return { id: 'd1', action, contentHash, decidedAt: '2026-07-13T00:00:00.000Z' };
}

describe('artifact human-review export policy', () => {
  it('never lets human approval override a verifier hard blocker', () => {
    expect(evaluateArtifactHumanReviewExport(blocked, HASH, decision('approve'))).toEqual({ canExport: false, reason: 'VERIFIER_GATE_BLOCKED' });
    expect(evaluateArtifactHumanReviewExport(redTeamBlocked, HASH, decision('approve'))).toEqual({ canExport: false, reason: 'RED_TEAM_BLOCKED' });
  });

  it('requires current-version approval for exportable warnings', () => {
    expect(evaluateArtifactHumanReviewExport(warning, HASH, null)).toEqual({ canExport: false, reason: 'HUMAN_REVIEW_REQUIRED' });
    expect(evaluateArtifactHumanReviewExport(warning, HASH, decision('approve'))).toEqual({ canExport: true, reason: 'OK' });
  });

  it('does not allow pre-approval while red-team review is incomplete or stale', () => {
    expect(evaluateArtifactHumanReviewExport(redTeamPending, HASH, decision('approve'))).toEqual({ canExport: false, reason: 'RED_TEAM_REVIEW_REQUIRED' });
  });

  it('blocks a current reject and ignores stale-hash approvals', () => {
    expect(evaluateArtifactHumanReviewExport(clean, HASH, decision('reject'))).toEqual({ canExport: false, reason: 'HUMAN_REVIEW_REJECTED' });
    expect(evaluateArtifactHumanReviewExport(warning, HASH, decision('approve', 'b'.repeat(64)))).toEqual({ canExport: false, reason: 'HUMAN_REVIEW_REQUIRED' });
  });

  it('keeps a clean artifact exportable without redundant approval', () => {
    expect(evaluateArtifactHumanReviewExport(clean, HASH, null)).toEqual({ canExport: true, reason: 'OK' });
  });
});
