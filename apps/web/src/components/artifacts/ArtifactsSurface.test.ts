import { describe, expect, it } from 'vitest';
import {
  artifactPreflightIssue,
  artifactRedTeamDetail,
  artifactVersionSource,
  claimArtifactSubmission,
  createArtifactVersionSourceSnapshot,
  filterArtifactReviewItems,
  isArtifactReviewApprovalReady,
  isArtifactReviewGateReady,
  isArtifactHumanReviewReady,
  isArtifactExportReady,
  nextArtifactReviewPage,
  previousArtifactReviewPage,
  resolveArtifactProjectId,
  visibleVersionExportIssue,
  visibleVersionReviewNote,
} from './ArtifactsSurface';

const disabledRedTeam = { mode: 'off' as const, status: 'disabled' as const, verdict: null, contentHash: null, policyVersion: null, attacks: [], defenses: [], reviewedAt: null };

describe('artifact preflight issue', () => {
  it('explains missing decision structure as an export blocker', () => {
    expect(artifactPreflightIssue({
      canExport: false,
      reason: 'ARTIFACT_STRUCTURE_REQUIRED',
      versionNo: 2,
      gate: null,
      messages: [
        '산출물의 핵심 결론(governing message)을 입력하세요.',
        '이 결론이 의사결정에 주는 의미(so what)를 입력하세요.',
      ],
      redTeam: disabledRedTeam,
    })).toEqual({
      tone: 'blocked',
      title: '내보내기 전에 의사결정 구조가 필요합니다',
      messages: [
        '산출물의 핵심 결론(governing message)을 입력하세요.',
        '이 결론이 의사결정에 주는 의미(so what)를 입력하세요.',
      ],
    });
  });

  it('attributes creation to an allowlisted explicit selection or active filter', () => {
    const projects = [{ id: 'project-first' }, { id: 'project-active' }];
    expect(resolveArtifactProjectId('', 'project-active', projects)).toBe('project-active');
    expect(resolveArtifactProjectId('project-first', 'project-active', projects)).toBe('project-first');
    expect(resolveArtifactProjectId('foreign-project', 'stale-project', projects)).toBe('project-first');
  });

  it('does not carry a prior version export issue into a new version', () => {
    const issue = {
      tone: 'blocked' as const,
      title: 'v1 차단',
      messages: ['v1 근거 부족'],
    };
    expect(visibleVersionExportIssue({ versionId: 'version-v1', issue }, 'version-v1')).toEqual(issue);
    expect(visibleVersionExportIssue({ versionId: 'version-v1', issue }, 'version-v2')).toBeNull();
  });

  it('does not carry a review note into another artifact version', () => {
    const note = { versionId: 'version-v1', note: 'v1 반려 사유' };
    expect(visibleVersionReviewNote(note, 'version-v1')).toBe('v1 반려 사유');
    expect(visibleVersionReviewNote(note, 'version-v2')).toBe('');
  });

  it('returns through visited review offsets without assuming a fixed page size', () => {
    const page125 = nextArtifactReviewPage('project-1', 0, [], 125);
    const page375 = nextArtifactReviewPage('project-1', page125.offset, page125.history, 375);
    expect(previousArtifactReviewPage('project-1', page375.history)).toEqual(page125);
    expect(previousArtifactReviewPage('project-1', page125.history)).toEqual({
      projectId: 'project-1', offset: 0, history: [],
    });
  });

  it('uses v1 preflight on an old API and waits for the review plan on v2', () => {
    expect(isArtifactReviewGateReady(false, false, undefined)).toBe(true);
    expect(isArtifactReviewGateReady(undefined, false, undefined)).toBe(false);
    expect(isArtifactReviewGateReady(true, false, undefined)).toBe(false);
    expect(isArtifactReviewGateReady(true, true, undefined)).toBe(true);
  });

  it('groups repeated verifier messages instead of rendering indistinguishable duplicates', () => {
    expect(artifactPreflightIssue({
      canExport: false,
      reason: 'VERIFIER_GATE_BLOCKED',
      versionNo: 1,
      gate: null,
      messages: ['핵심 claim의 근거가 부족합니다.', '핵심 claim의 근거가 부족합니다.'],
      redTeam: disabledRedTeam,
    })?.messages).toEqual(['핵심 claim의 근거가 부족합니다. (2건)']);
  });

  it('shows red-team rollout findings as a named warning without disabling export', () => {
    const preflight = {
      canExport: true,
      reason: 'OK' as const,
      versionNo: 3,
      gate: { decision: 'PASS' as const, blockers: [], warnings: [] },
      messages: ['전환 비용 상한의 반대 근거가 없습니다.'],
      redTeam: {
        mode: 'warning' as const,
        status: 'completed' as const,
        verdict: 'PASS_WITH_WARNINGS' as const,
        contentHash: 'a'.repeat(64),
        policyVersion: 'artifact_red_team_v1',
        attacks: [{ persona: '감사원' as const, severity: 'warning' as const, category: 'cost', message: '전환 비용 상한의 반대 근거가 없습니다.' }],
        defenses: [],
        reviewedAt: '2026-07-11T12:00:00.000Z',
      },
    };

    expect(artifactPreflightIssue(preflight)).toEqual({
      tone: 'warn',
      title: '적대 검토 경고가 있습니다',
      messages: preflight.messages,
    });
    expect(isArtifactExportReady(3, false, false, preflight)).toBe(true);
  });

  it('presents red-team attacks with their indexed defenses', () => {
    expect(artifactRedTeamDetail({
      mode: 'warning',
      status: 'completed',
      verdict: 'PASS_WITH_WARNINGS',
      contentHash: 'a'.repeat(64),
      policyVersion: 'artifact_red_team_v1',
      attacks: [{ persona: '의회', severity: 'warning', category: '비용', message: '전환비용 상한 근거가 약합니다.' }],
      defenses: [{ attackIndex: 0, response: '공식 견적서 3건을 추가했습니다.', disposition: 'mitigated' }],
      reviewedAt: '2026-07-11T12:00:00.000Z',
    })).toEqual(expect.objectContaining({
      tone: 'warn',
      title: '적대 검토 · 주의 포함 통과',
      findings: [{
        key: '0-의회-비용',
        label: '의회 · 주의 · 비용',
        message: '전환비용 상한 근거가 약합니다.',
        defense: '공식 견적서 3건을 추가했습니다. (완화됨)',
      }],
    }));
  });

  it('keeps export fail-closed until required review approval and filters the queue', () => {
    const pending = {
      artifactId: '10000000-0000-4000-8000-000000000001',
      artifactVersionId: '10000000-0000-4000-8000-000000000002',
      title: '검토 대상',
      versionNo: 1,
      priority: 'medium' as const,
      reasons: ['red_team_warnings'],
      needsHumanReview: true,
      reviewStatus: 'pending' as const,
      latestDecision: null,
    };
    expect(isArtifactHumanReviewReady(pending)).toBe(false);
    expect(isArtifactHumanReviewReady({ ...pending, reviewStatus: 'approved' })).toBe(true);
    expect(isArtifactHumanReviewReady({ ...pending, reviewStatus: 'rejected' })).toBe(false);
    expect(isArtifactHumanReviewReady({ ...pending, needsHumanReview: false, reviewStatus: 'blocked' })).toBe(false);
    expect(isArtifactHumanReviewReady({ ...pending, needsHumanReview: false, reviewStatus: 'invalid' })).toBe(false);
    expect(isArtifactReviewApprovalReady(pending, {
      canExport: false,
      reason: 'HUMAN_REVIEW_REQUIRED',
      redTeam: disabledRedTeam,
    })).toBe(true);
    expect(isArtifactReviewApprovalReady({ ...pending, needsHumanReview: false, reviewStatus: 'blocked' }, {
      canExport: false,
      reason: 'RED_TEAM_BLOCKED',
      redTeam: disabledRedTeam,
    })).toBe(false);
    expect(filterArtifactReviewItems([pending], 'pending')).toEqual([pending]);
    expect(filterArtifactReviewItems([pending], 'approved')).toEqual([]);
    expect(filterArtifactReviewItems([pending], 'medium')).toEqual([pending]);
  });

  it('keeps a cached explicit PASS exportable during a background polling refetch', () => {
    const ready = isArtifactExportReady;
    expect(ready(undefined, false, false, { versionNo: 2, canExport: true })).toBe(false);
    expect(ready(2, true, false, { versionNo: 2, canExport: true })).toBe(false);
    expect(ready(2, false, true, { versionNo: 2, canExport: true })).toBe(true);
    expect(ready(2, false, false, undefined)).toBe(false);
    expect(ready(2, false, false, { versionNo: 2, canExport: false })).toBe(false);
    expect(ready(2, false, false, { versionNo: 1, canExport: true })).toBe(false);
    expect(ready(2, false, false, { versionNo: 2, canExport: true })).toBe(true);
  });

  it('claims a submission lock only once until the handler releases it', () => {
    const lock = { current: false };

    expect(claimArtifactSubmission(lock)).toBe(true);
    expect(claimArtifactSubmission(lock)).toBe(false);
    lock.current = false;
    expect(claimArtifactSubmission(lock)).toBe(true);
  });

  it('inherits chat source attribution when adding a new artifact version', () => {
    expect(artifactVersionSource({
      sourceThreadId: '11111111-1111-4111-8111-111111111111',
      sourceMessageId: '22222222-2222-4222-8222-222222222222',
    })).toEqual({
      sourceThreadId: '11111111-1111-4111-8111-111111111111',
      sourceMessageId: '22222222-2222-4222-8222-222222222222',
    });
    expect(artifactVersionSource({ sourceThreadId: null, sourceMessageId: null })).toEqual({});
    expect(artifactVersionSource(undefined)).toEqual({});
  });

  it('keeps the source snapshot from editor-open time when the viewed version later changes', () => {
    const openedVersion = {
      sourceThreadId: '11111111-1111-4111-8111-111111111111',
      sourceMessageId: '22222222-2222-4222-8222-222222222222',
    };
    const snapshot = createArtifactVersionSourceSnapshot(openedVersion);

    openedVersion.sourceThreadId = '33333333-3333-4333-8333-333333333333';
    openedVersion.sourceMessageId = '44444444-4444-4444-8444-444444444444';

    expect(snapshot).toEqual({
      sourceThreadId: '11111111-1111-4111-8111-111111111111',
      sourceMessageId: '22222222-2222-4222-8222-222222222222',
    });
  });
});
