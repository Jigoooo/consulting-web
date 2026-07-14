import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ArtifactExportPreflightResponseSchema } from '@consulting/contracts';
import { artifactContentHash, auditArtifactExportPreflight } from '../src/artifacts/artifact-export-preflight-audit.js';

describe('artifact export preflight audit', () => {
  it('blocks an otherwise verified artifact when governing message or so-what is structurally missing', () => {
    const content = '# 분석 결과\n\n근거 본문입니다.';
    const passGate = { decision: 'PASS' as const, blockers: [], warnings: [] };
    const base = {
      artifactId: 'artifact-structure',
      artifactVersionId: 'version-structure',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      title: '구조 게이트 대상 산출물',
      versionNo: 1,
      content,
      sourceThreadId: null,
      sourceMessageId: null,
      verification: {
        artifactId: 'artifact-structure',
        artifactVersionId: 'version-structure',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
        gate: passGate,
      },
    };

    const missingGoverning = auditArtifactExportPreflight({
      projectId: 'project-1',
      projectName: '창원시 컨설팅',
      rows: [{ ...base, governingMessage: null, soWhat: '이 분석은 예산 우선순위를 조정해야 함을 의미합니다.' }],
    });
    const missingSoWhat = auditArtifactExportPreflight({
      projectId: 'project-1',
      projectName: '창원시 컨설팅',
      rows: [{ ...base, governingMessage: '핵심 결론은 사업 범위를 단계적으로 축소해야 한다는 것입니다.', soWhat: '   ' }],
    });

    expect(missingGoverning.rows[0]).toMatchObject({
      canExport: false,
      reason: 'ARTIFACT_STRUCTURE_REQUIRED',
      gate: null,
    });
    expect(missingGoverning.rows[0]!.messages).toContain('산출물의 핵심 결론(governing message)을 입력하세요.');
    expect(missingSoWhat.rows[0]).toMatchObject({ canExport: false, reason: 'ARTIFACT_STRUCTURE_REQUIRED' });
    expect(missingSoWhat.rows[0]!.messages).toContain('이 결론이 의사결정에 주는 의미(so what)를 입력하세요.');
  });

  it('requires a matching artifact-version content verification and ignores legacy source-message telemetry', () => {
    const content = '# 검증 완료 보고서\n\n정성 분석 결과입니다.';
    const structure = {
      governingMessage: '핵심 결론은 검증된 근거에 따라 사업 범위를 조정해야 한다는 것입니다.',
      soWhat: '따라서 의사결정자는 예산과 실행 일정을 함께 재확정해야 합니다.',
    };
    const contentHash = artifactContentHash(content, structure.governingMessage, structure.soWhat);
    const passGate = { decision: 'PASS', blockers: [], warnings: [] } as const;
    const blockedGate = {
      decision: 'BLOCKED',
      blockers: [{ code: 'exactness_blocked', severity: 'blocker', message: '수치 검증 실패' }],
      warnings: [],
    } as const;
    const legacyVerdicts = Array.from({ length: 101 }, (_, index) => ({
      claimId: `LEGACY-${index + 1}`,
      claimText: '과거 원본 답변 telemetry는 artifact version 검증을 대신할 수 없습니다.',
      verdict: 'refutes' as const,
      confidence: 0.99,
      rationale: 'legacy source-message telemetry',
    }));

    const result = auditArtifactExportPreflight({
      projectId: 'project-1',
      projectName: '창원시 컨설팅',
      rows: [
        {
          artifactId: 'artifact-unsourced-unverified',
          artifactVersionId: 'version-unsourced-unverified',
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          title: '무원본 미검증 산출물',
          versionNo: 1,
          content,
          sourceThreadId: null,
          sourceMessageId: null,
          sourceValid: null,
          exactnessStatus: null,
          verdicts: [],
          verification: null,
        },
        {
          artifactId: 'artifact-blocked-v1',
          artifactVersionId: 'version-blocked-v1',
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          title: '차단된 v1',
          versionNo: 1,
          content,
          sourceThreadId: 'thread-1',
          sourceMessageId: 'message-blocked',
          sourceValid: true,
          exactnessStatus: 'passed',
          verdicts: [],
          verification: {
            artifactId: 'artifact-blocked-v1',
            artifactVersionId: 'version-blocked-v1',
            workspaceId: 'workspace-1',
            projectId: 'project-1',
            contentHash,
            gate: blockedGate,
          },
        },
        {
          artifactId: 'artifact-blocked-v1',
          artifactVersionId: 'version-unsourced-v2',
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          title: '차단 v1 뒤 무원본 v2',
          versionNo: 2,
          content: `${content}\n\n검증 없이 수정했습니다.`,
          sourceThreadId: null,
          sourceMessageId: null,
          sourceValid: null,
          exactnessStatus: null,
          verdicts: [],
          verification: null,
        },
        {
          artifactId: 'artifact-content-changed',
          artifactVersionId: 'version-content-changed',
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          title: '검증 뒤 본문 변경',
          versionNo: 1,
          sourceThreadId: 'thread-1',
          sourceMessageId: 'message-passed',
          sourceValid: true,
          content: `${content}\n\n검증 후 바뀐 문장입니다.`,
          exactnessStatus: 'passed',
          verdicts: legacyVerdicts,
          verification: {
            artifactId: 'artifact-content-changed',
            artifactVersionId: 'version-content-changed',
            workspaceId: 'workspace-1',
            projectId: 'project-1',
            contentHash,
            gate: passGate,
          },
        },
        {
          artifactId: 'artifact-workspace-mismatch',
          artifactVersionId: 'version-workspace-mismatch',
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          title: '다른 workspace 검증 row',
          versionNo: 1,
          content,
          sourceThreadId: null,
          sourceMessageId: null,
          sourceValid: null,
          exactnessStatus: 'passed',
          verdicts: [],
          verification: {
            artifactId: 'artifact-workspace-mismatch',
            artifactVersionId: 'version-workspace-mismatch',
            workspaceId: 'workspace-foreign',
            projectId: 'project-1',
            contentHash,
            gate: passGate,
          },
        },
        {
          artifactId: 'artifact-valid-manual',
          artifactVersionId: 'version-valid-manual',
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          title: '수동 작성 후 본문 검증 완료',
          versionNo: 1,
          content,
          sourceThreadId: null,
          sourceMessageId: null,
          sourceValid: null,
          exactnessStatus: null,
          verdicts: [],
          verification: {
            artifactId: 'artifact-valid-manual',
            artifactVersionId: 'version-valid-manual',
            workspaceId: 'workspace-1',
            projectId: 'project-1',
            contentHash,
            gate: passGate,
          },
        },
        {
          artifactId: 'artifact-valid-cross-project-provenance',
          artifactVersionId: 'version-valid-cross-project-provenance',
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          title: '원본은 provenance일 뿐',
          versionNo: 1,
          content,
          sourceThreadId: 'thread-other-project',
          sourceMessageId: 'message-other-project',
          sourceValid: false,
          exactnessStatus: 'blocked',
          verdicts: legacyVerdicts,
          verification: {
            artifactId: 'artifact-valid-cross-project-provenance',
            artifactVersionId: 'version-valid-cross-project-provenance',
            workspaceId: 'workspace-1',
            projectId: 'project-1',
            contentHash,
            gate: passGate,
          },
        },
      ].map((row) => ({ ...structure, ...row })),
    } as any);

    expect(result.readOnly).toBe(true);
    expect(result.status).toBe('blocked');
    expect(result.summary).toEqual({ total: 7, exportable: 2, blocked: 5, verificationRequired: 4 });
    expect(result.rows.find((row) => row.artifactVersionId === 'version-unsourced-unverified')).toMatchObject({
      canExport: false,
      reason: 'ARTIFACT_VERIFICATION_REQUIRED',
    });
    expect(result.rows.find((row) => row.artifactVersionId === 'version-blocked-v1')).toMatchObject({
      canExport: false,
      reason: 'VERIFIER_GATE_BLOCKED',
      gate: { blockers: [expect.objectContaining({ code: 'exactness_blocked' })] },
    });
    expect(result.rows.find((row) => row.artifactVersionId === 'version-unsourced-v2')).toMatchObject({
      canExport: false,
      reason: 'ARTIFACT_VERIFICATION_REQUIRED',
    });
    expect(result.rows.find((row) => row.artifactVersionId === 'version-content-changed')).toMatchObject({
      canExport: false,
      reason: 'ARTIFACT_VERIFICATION_REQUIRED',
    });
    expect(result.rows.find((row) => row.artifactVersionId === 'version-workspace-mismatch')).toMatchObject({
      canExport: false,
      reason: 'ARTIFACT_VERIFICATION_REQUIRED',
    });
    expect(result.rows.find((row) => row.artifactVersionId === 'version-valid-manual')).toMatchObject({ canExport: true, reason: 'OK' });
    expect(result.rows.find((row) => row.artifactVersionId === 'version-valid-cross-project-provenance')).toMatchObject({ canExport: true, reason: 'OK' });
  });

  it('blocks a matching verification unless its final-export decision is exactly PASS', () => {
    const content = '근거가 부족한 일반 claim이 있습니다.';
    const governingMessage = '핵심 결론은 현재 근거만으로 최종 결정을 확정할 수 없다는 것입니다.';
    const soWhat = '따라서 추가 근거를 확보할 때까지 집행 결정을 보류해야 합니다.';
    const result = auditArtifactExportPreflight({
      projectId: 'project-1',
      projectName: '창원시 컨설팅',
      rows: [{
        artifactId: 'artifact-warning',
        artifactVersionId: 'version-warning',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        title: '경고 상태 산출물',
        versionNo: 1,
        content,
        governingMessage,
        soWhat,
        sourceThreadId: null,
        sourceMessageId: null,
        verification: {
          artifactId: 'artifact-warning',
          artifactVersionId: 'version-warning',
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          contentHash: artifactContentHash(content, governingMessage, soWhat),
          gate: {
            decision: 'PASS_WITH_WARNINGS',
            blockers: [],
            warnings: [{
              code: 'semantic_unsupported',
              severity: 'warning',
              message: '근거가 부족한 claim이 있습니다.',
            }],
          },
        },
      }],
    });

    expect(result.rows[0]).toMatchObject({
      canExport: false,
      reason: 'VERIFIER_GATE_BLOCKED',
      gate: { decision: 'PASS_WITH_WARNINGS' },
    });
  });

  it('blocks a malformed PASS gate that still contains blockers or warnings', () => {
    const content = '검증 결과가 손상된 산출물입니다.';
    const governingMessage = '핵심 결론은 손상된 검증 결과를 의사결정에 사용할 수 없다는 것입니다.';
    const soWhat = '따라서 원장을 복구하고 다시 검증하기 전에는 내보내기를 중단해야 합니다.';
    const result = auditArtifactExportPreflight({
      projectId: 'project-1',
      projectName: '창원시 컨설팅',
      rows: [{
        artifactId: 'artifact-malformed-pass',
        artifactVersionId: 'version-malformed-pass',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        title: '손상된 PASS 산출물',
        versionNo: 1,
        content,
        governingMessage,
        soWhat,
        sourceThreadId: null,
        sourceMessageId: null,
        verification: {
          artifactId: 'artifact-malformed-pass',
          artifactVersionId: 'version-malformed-pass',
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          contentHash: artifactContentHash(content, governingMessage, soWhat),
          gate: {
            decision: 'PASS',
            blockers: [{
              code: 'exactness_blocked',
              severity: 'blocker',
              message: '수치 검증 실패',
            }],
            warnings: [],
          },
        },
      }],
    });

    expect(result.rows[0]).toMatchObject({
      canExport: false,
      reason: 'VERIFIER_GATE_BLOCKED',
      gate: { decision: 'PASS' },
    });
  });

  it('keeps large verifier issue sets inside the preflight response contract', () => {
    const content = '검증 경고가 많은 산출물입니다.';
    const governingMessage = '핵심 결론은 경고가 많아도 검증 결과를 구조화해 보여줘야 한다는 것입니다.';
    const soWhat = '따라서 opaque 500 대신 제한된 검토 메시지와 차단 상태를 반환해야 합니다.';
    const result = auditArtifactExportPreflight({
      projectId: 'project-1',
      projectName: '창원시 컨설팅',
      rows: [{
        artifactId: 'artifact-many-issues',
        artifactVersionId: 'version-many-issues',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        title: '검토 항목이 많은 산출물',
        versionNo: 1,
        content,
        governingMessage,
        soWhat,
        sourceThreadId: null,
        sourceMessageId: null,
        verification: {
          artifactId: 'artifact-many-issues',
          artifactVersionId: 'version-many-issues',
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          contentHash: artifactContentHash(content, governingMessage, soWhat),
          gate: {
            decision: 'PASS_WITH_WARNINGS',
            blockers: [],
            warnings: Array.from({ length: 24 }, (_, index) => ({
              code: 'semantic_unsupported',
              severity: 'warning' as const,
              message: `근거 보강이 필요한 claim ${index + 1}`,
            })),
          },
        },
      }],
    });
    const row = result.rows[0]!;

    expect(row.messages).toHaveLength(20);
    expect(() => ArtifactExportPreflightResponseSchema.parse({
      canExport: row.canExport,
      reason: row.reason,
      versionNo: row.versionNo,
      gate: row.gate,
      messages: row.messages,
    })).not.toThrow();
  });

  it('rolls content-bound red-team review from silent shadow to non-blocking warnings', () => {
    const content = '최종 의사결정 보고서 본문입니다.';
    const governingMessage = '핵심 결론은 단계적 전환이 가장 안전하다는 것입니다.';
    const soWhat = '따라서 전환 전 이해관계자 반론을 검토해야 합니다.';
    const contentHash = artifactContentHash(content, governingMessage, soWhat);
    const row = {
      artifactId: 'artifact-red-team',
      artifactVersionId: 'version-red-team',
      workspaceId: 'workspace-red-team',
      projectId: 'project-red-team',
      title: '적대 검토 대상 보고서',
      versionNo: 1,
      content,
      governingMessage,
      soWhat,
      sourceThreadId: null,
      sourceMessageId: null,
      verification: {
        artifactId: 'artifact-red-team',
        artifactVersionId: 'version-red-team',
        workspaceId: 'workspace-red-team',
        projectId: 'project-red-team',
        contentHash,
        gate: { decision: 'PASS' as const, blockers: [], warnings: [] },
      },
    };
    const review = {
      artifactId: row.artifactId,
      artifactVersionId: row.artifactVersionId,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      contentHash,
      status: 'completed' as const,
      verdict: 'BLOCKED' as const,
      policyVersion: 'artifact_red_team_v1',
      reviewedAt: '2026-07-11T12:00:00.000Z',
      attacks: [{
        persona: '감사원' as const,
        severity: 'warning' as const,
        category: 'unsupported_assumption',
        message: '전환 비용의 상한 근거가 본문에 없습니다.',
      }],
      defenses: [],
    };

    const shadow = auditArtifactExportPreflight({
      projectId: row.projectId,
      projectName: row.title,
      redTeamMode: 'shadow',
      rows: [{ ...row, redTeam: review }],
    });
    const warningMissing = auditArtifactExportPreflight({
      projectId: row.projectId,
      projectName: row.title,
      redTeamMode: 'warning',
      rows: [{ ...row, redTeam: null }],
    });
    const warningStale = auditArtifactExportPreflight({
      projectId: row.projectId,
      projectName: row.title,
      redTeamMode: 'warning',
      rows: [{ ...row, redTeam: { ...review, contentHash: artifactContentHash(`${content} 변경`) } }],
    });
    const warningBlocked = auditArtifactExportPreflight({
      projectId: row.projectId,
      projectName: row.title,
      redTeamMode: 'warning',
      rows: [{ ...row, redTeam: review }],
    });

    expect(shadow.rows[0]).toMatchObject({ canExport: true, reason: 'OK', messages: [] });
    expect(warningMissing.rows[0]).toMatchObject({ canExport: true, reason: 'OK' });
    expect(warningMissing.rows[0]!.messages).toContain('현재 산출물 버전에 대한 적대 검토가 아직 없습니다. 내보내기는 허용되지만 검토를 권장합니다.');
    expect(warningStale.rows[0]).toMatchObject({ redTeam: { mode: 'warning', status: 'stale', verdict: null } });
    expect(warningStale.rows[0]!.messages).toContain('산출물 본문이 변경되어 이전 적대 검토가 무효화되었습니다. 현재 버전의 재검토를 권장합니다.');
    expect(warningBlocked.rows[0]).toMatchObject({ canExport: true, reason: 'OK' });
    expect(warningBlocked.rows[0]!.messages).toContain('감사원: 전환 비용의 상한 근거가 본문에 없습니다.');
  });
});
