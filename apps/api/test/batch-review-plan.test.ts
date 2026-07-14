import { describe, expect, it } from 'vitest';
import {
  buildBatchReviewPlan,
  classifyReviewRow,
  reviewPlanFromAudit,
  type BatchAuditRow,
} from '../src/artifacts/batch-review-plan.js';
import { auditArtifactExportPreflight, artifactContentHash } from '../src/artifacts/artifact-export-preflight-audit.js';

function row(over: Partial<BatchAuditRow>): BatchAuditRow {
  return {
    artifactId: 'a', artifactVersionId: 'v', title: '제목', versionNo: 1,
    canExport: true, reason: 'OK', gateBlockerCount: 0, gateWarningCount: 0, redTeamVerdict: null,
    ...over,
  };
}

describe('classifyReviewRow', () => {
  it('marks a clean exportable artifact as clear with no human review', () => {
    const r = classifyReviewRow(row({}));
    expect(r.priority).toBe('clear');
    expect(r.needsHumanReview).toBe(false);
    expect(r.reasons).toEqual(['clean_export_ready']);
  });

  it('escalates a red-team BLOCKED artifact to critical', () => {
    const r = classifyReviewRow(row({ redTeamVerdict: 'BLOCKED' }));
    expect(r.priority).toBe('critical');
    expect(r.needsHumanReview).toBe(true);
    expect(r.reasons).toContain('red_team_blocked');
  });

  it('escalates a verifier-gate-blocked artifact to critical with blocker count', () => {
    const r = classifyReviewRow(row({ canExport: false, reason: 'VERIFIER_GATE_BLOCKED', gateBlockerCount: 2 }));
    expect(r.priority).toBe('critical');
    expect(r.reasons).toContain('verifier_gate_blocked:2');
  });

  it('marks verification-required as high priority', () => {
    const r = classifyReviewRow(row({ canExport: false, reason: 'ARTIFACT_VERIFICATION_REQUIRED' }));
    expect(r.priority).toBe('high');
    expect(r.reasons).toContain('verification_required');
  });

  it('marks structure-required as high priority', () => {
    const r = classifyReviewRow(row({ canExport: false, reason: 'ARTIFACT_STRUCTURE_REQUIRED' }));
    expect(r.priority).toBe('high');
    expect(r.reasons).toContain('structure_required');
  });

  it('fails closed when a contradictory row is not exportable but reports OK', () => {
    const r = classifyReviewRow(row({ canExport: false, reason: 'OK' }));
    expect(r.priority).toBe('critical');
    expect(r.needsHumanReview).toBe(true);
    expect(r.reasons).toContain('export_not_allowed');
  });

  it('marks an exportable-with-warnings artifact as medium', () => {
    const r = classifyReviewRow(row({ gateWarningCount: 1 }));
    expect(r.priority).toBe('medium');
    expect(r.needsHumanReview).toBe(true);
    expect(r.reasons).toContain('gate_warnings:1');
  });

  it('surfaces red-team warnings on an otherwise-clean artifact as medium', () => {
    const r = classifyReviewRow(row({ redTeamVerdict: 'PASS_WITH_WARNINGS' }));
    expect(r.priority).toBe('medium');
    expect(r.reasons).toContain('red_team_warnings');
  });

  it('keeps critical priority when both red-team block and gate warnings exist', () => {
    const r = classifyReviewRow(row({ canExport: false, reason: 'VERIFIER_GATE_BLOCKED', gateBlockerCount: 1, gateWarningCount: 3, redTeamVerdict: 'BLOCKED' }));
    expect(r.priority).toBe('critical');
    expect(r.reasons).toContain('red_team_blocked');
    expect(r.reasons).toContain('verifier_gate_blocked:1');
  });

  it.each([
    ['HUMAN_REVIEW_REJECTED', 'human_review_rejected'],
    ['HUMAN_REVIEW_LEDGER_INVALID', 'human_review_ledger_invalid'],
    ['RED_TEAM_REVIEW_REQUIRED', 'red_team_review_required'],
  ] as const)('classifies final blocker %s as critical', (reason, expectedReason) => {
    const r = classifyReviewRow(row({ canExport: false, reason }));
    expect(r.priority).toBe('critical');
    expect(r.needsHumanReview).toBe(true);
    expect(r.reasons).toContain(expectedReason);
  });
});

describe('buildBatchReviewPlan', () => {
  it('sorts the worklist by priority then title and counts each bucket', () => {
    const plan = buildBatchReviewPlan({
      projectId: 'p', projectName: '창원 프로젝트',
      rows: [
        row({ artifactId: 'clean', title: 'B 정상', reason: 'OK' }),
        row({ artifactId: 'blocked', title: 'A 차단', canExport: false, reason: 'VERIFIER_GATE_BLOCKED', gateBlockerCount: 1 }),
        row({ artifactId: 'warn', title: 'C 경고', gateWarningCount: 2 }),
        row({ artifactId: 'verify', title: 'D 검증필요', canExport: false, reason: 'ARTIFACT_VERIFICATION_REQUIRED' }),
      ],
    });
    expect(plan.worklist.map((w) => w.artifactId)).toEqual(['blocked', 'verify', 'warn', 'clean']);
    expect(plan.summary).toEqual({ total: 4, critical: 1, high: 1, medium: 1, clear: 1, needsHumanReview: 3 });
  });

  it('is deterministic and stable for ties (same priority sorted by title)', () => {
    const rows = [
      row({ artifactId: 'x', title: 'Z', gateWarningCount: 1 }),
      row({ artifactId: 'y', title: 'A', gateWarningCount: 1 }),
    ];
    const a = buildBatchReviewPlan({ projectId: 'p', projectName: 'n', rows });
    const b = buildBatchReviewPlan({ projectId: 'p', projectName: 'n', rows });
    expect(a).toEqual(b);
    expect(a.worklist.map((w) => w.title)).toEqual(['A', 'Z']);
  });

  it('reports zero human review needed when every artifact is clean', () => {
    const plan = buildBatchReviewPlan({
      projectId: 'p', projectName: 'n',
      rows: [row({ artifactId: '1', title: 'A' }), row({ artifactId: '2', title: 'B' })],
    });
    expect(plan.summary.needsHumanReview).toBe(0);
    expect(plan.summary.clear).toBe(2);
  });
});

describe('reviewPlanFromAudit (real audit output)', () => {
  it('maps a real auditArtifactExportPreflight result into a prioritized plan', () => {
    const structureRow = {
      artifactId: 'no-structure', artifactVersionId: 'v1', workspaceId: 'w', projectId: 'p',
      title: '구조 미비 산출물', versionNo: 1, content: '본문만 있음', governingMessage: null, soWhat: null,
      sourceThreadId: null, sourceMessageId: null, verification: null,
    };
    const cleanContent = '검증된 본문';
    const cleanRow = {
      artifactId: 'clean', artifactVersionId: 'v2', workspaceId: 'w', projectId: 'p',
      title: '정상 산출물', versionNo: 1, content: cleanContent, governingMessage: '핵심 결론', soWhat: '의미',
      sourceThreadId: null, sourceMessageId: null,
      verification: {
        artifactId: 'clean', artifactVersionId: 'v2', workspaceId: 'w', projectId: 'p',
        contentHash: artifactContentHash(cleanContent, '핵심 결론', '의미'),
        gate: { decision: 'PASS' as const, blockers: [], warnings: [] },
      },
    };
    const audit = auditArtifactExportPreflight({ projectId: 'p', projectName: '창원', redTeamMode: 'off', rows: [cleanRow, structureRow] });
    const plan = reviewPlanFromAudit(audit);

    expect(plan.summary.total).toBe(2);
    // Structure-required artifact must outrank the clean one.
    expect(plan.worklist[0]!.artifactId).toBe('no-structure');
    expect(plan.worklist[0]!.priority).toBe('high');
    expect(plan.worklist[0]!.reasons).toContain('structure_required');
    expect(plan.worklist[1]!.artifactId).toBe('clean');
    expect(plan.worklist[1]!.priority).toBe('clear');
    expect(plan.summary.needsHumanReview).toBe(1);
  });
});
