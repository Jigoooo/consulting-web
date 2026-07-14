import { describe, expect, it, vi } from 'vitest';
import { ArtifactHumanReviewService } from '../src/artifacts/artifact-human-review.service.js';
import { artifactContentHash } from '../src/artifacts/artifact-export-preflight-audit.js';

const target = {
  workspaceId: '84000000-0000-4000-8000-000000000001',
  projectId: '84000000-0000-4000-8000-000000000002',
  artifactId: '84000000-0000-4000-8000-000000000003',
  artifactVersionId: '84000000-0000-4000-8000-000000000004',
  versionNo: 1,
  title: '차단 산출물',
  content: '본문',
  governingMessage: '결론',
  soWhat: '의미',
  sourceThreadId: null,
  sourceMessageId: null,
};
const hash = artifactContentHash(target.content, target.governingMessage, target.soWhat);
const approved = {
  id: '84000000-0000-4000-8000-000000000005',
  action: 'approve' as const,
  contentHash: hash,
  decidedAt: '2026-07-14T00:00:00.000Z',
};

describe('artifact human-review worklist', () => {
  it('shows a verifier/red-team blocker as blocked even when a prior approval exists', async () => {
    const service = new ArtifactHumanReviewService(
      {} as never,
      { loadProjectHeadTargets: vi.fn().mockResolvedValue({ projectId: target.projectId, projectName: '프로젝트', targets: [target] }) } as never,
      { preflightVersion: vi.fn().mockResolvedValue({
        canExport: true,
        reason: 'OK',
        versionNo: 1,
        gate: { decision: 'PASS', blockers: [], warnings: [] },
        messages: [],
        redTeam: {
          mode: 'warning', status: 'completed', verdict: 'BLOCKED', contentHash: hash,
          policyVersion: 'p1', attacks: [], defenses: [], reviewedAt: '2026-07-14T00:00:00.000Z',
        },
      }) } as never,
    );
    Object.defineProperty(service, 'latestPublicDecision', { value: vi.fn().mockResolvedValue({
      id: approved.id,
      action: approved.action,
      note: '',
      actorKind: 'user',
      decidedByUserId: '84000000-0000-4000-8000-000000000006',
      decidedAt: approved.decidedAt,
    }), configurable: true });
    vi.spyOn(service, 'latestDecisionState').mockResolvedValue({ valid: true, decision: approved });

    const plan = await service.projectPlan(target.projectId);
    expect(plan.worklist[0]).toEqual(expect.objectContaining({
      reviewStatus: 'blocked',
      needsHumanReview: false,
    }));
    expect(plan.summary).toEqual(expect.objectContaining({ blocked: 1, approved: 0 }));
  });

  it('caps each page at 500 targets and bounds verifier concurrency', async () => {
    const targets = Array.from({ length: 501 }, (_, index) => ({
      ...target,
      artifactId: `artifact-${index}`,
      artifactVersionId: `version-${index}`,
      title: `artifact ${index}`,
    }));
    const loadProjectHeadTargets = vi.fn().mockResolvedValue({
      projectId: target.projectId,
      projectName: 'large project',
      totalCandidates: 501,
      offset: 0,
      targets,
    });
    let active = 0;
    let maxActive = 0;
    const preflightVersion = vi.fn().mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return {
        canExport: true,
        reason: 'OK',
        versionNo: 1,
        gate: { decision: 'PASS', blockers: [], warnings: [] },
        messages: [],
        redTeam: { mode: 'off', status: 'disabled', verdict: null, contentHash: null, policyVersion: null, attacks: [], defenses: [], reviewedAt: null },
      };
    });
    const service = new ArtifactHumanReviewService(
      {} as never,
      { loadProjectHeadTargets } as never,
      { preflightVersion } as never,
    );
    vi.spyOn(service, 'latestDecisionState').mockResolvedValue({ valid: true, decision: null });

    const plan = await service.projectPlan(target.projectId);
    expect(loadProjectHeadTargets).toHaveBeenCalledWith(target.projectId, 500, 0);
    expect(plan.worklist).toHaveLength(500);
    expect(plan.cohort).toEqual({
      totalCandidates: 501,
      offset: 0,
      returned: 500,
      nextOffset: 500,
      summaryScope: 'returned_page',
    });
    expect(preflightVersion).toHaveBeenCalledTimes(500);
    expect(maxActive).toBeLessThanOrEqual(10);
  });

  it('maps a Drizzle-wrapped concurrent terminal-reject guard to the public rejected reason', async () => {
    const cause = Object.assign(new Error('artifact review reject is terminal for this version'), { code: '23514' });
    const dbError = Object.assign(new Error('Failed query: insert into artifact_review_decisions'), { cause });
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({ returning: vi.fn().mockRejectedValue(dbError) })),
      })),
    };
    const service = new ArtifactHumanReviewService(db as never, {} as never, {} as never);
    vi.spyOn(service, 'latestDecisionState').mockResolvedValue({ valid: true, decision: null });

    await expect(service.recordDecision({
      target,
      preflight: {
        canExport: true,
        reason: 'OK',
        versionNo: 1,
        gate: { decision: 'PASS', blockers: [], warnings: [] },
        messages: ['사람 검토 필요'],
        redTeam: { mode: 'off', status: 'disabled', verdict: null, contentHash: null, policyVersion: null, attacks: [], defenses: [], reviewedAt: null },
      },
      action: 'approve',
      note: '',
      decidedByUserId: '84000000-0000-4000-8000-000000000006',
    })).resolves.toEqual({ ok: false, reason: 'HUMAN_REVIEW_REJECTED' });
  });

  it('rejects every review action while the final gate is hard-blocked', async () => {
    const insert = vi.fn();
    const service = new ArtifactHumanReviewService({ insert } as never, {} as never, {} as never);
    vi.spyOn(service, 'latestDecisionState').mockResolvedValue({ valid: true, decision: null });

    await expect(service.recordDecision({
      target,
      preflight: {
        canExport: true,
        reason: 'OK',
        versionNo: 1,
        gate: { decision: 'PASS', blockers: [], warnings: [] },
        messages: [],
        redTeam: { mode: 'warning', status: 'completed', verdict: 'BLOCKED', contentHash: hash, policyVersion: 'p1', attacks: [], defenses: [], reviewedAt: '2026-07-14T00:00:00.000Z' },
      },
      action: 'reject',
      note: 'blocked',
      decidedByUserId: '84000000-0000-4000-8000-000000000006',
    })).resolves.toEqual({ ok: false, reason: 'RED_TEAM_BLOCKED' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('rejects a repeated reject after the version is terminally rejected', async () => {
    const insert = vi.fn();
    const service = new ArtifactHumanReviewService({ insert } as never, {} as never, {} as never);
    vi.spyOn(service, 'latestDecisionState').mockResolvedValue({
      valid: true,
      decision: { ...approved, action: 'reject' },
    });

    await expect(service.recordDecision({
      target,
      preflight: {
        canExport: true,
        reason: 'OK',
        versionNo: 1,
        gate: { decision: 'PASS', blockers: [], warnings: [] },
        messages: ['사람 검토 필요'],
        redTeam: { mode: 'off', status: 'disabled', verdict: null, contentHash: null, policyVersion: null, attacks: [], defenses: [], reviewedAt: null },
      },
      action: 'reject',
      note: 'again',
      decidedByUserId: '84000000-0000-4000-8000-000000000006',
    })).resolves.toEqual({ ok: false, reason: 'HUMAN_REVIEW_REJECTED' });
    expect(insert).not.toHaveBeenCalled();
  });
});
