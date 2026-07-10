import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { auditArtifactExportPreflight } from '../src/artifacts/artifact-export-preflight-audit.js';

describe('artifact export preflight audit', () => {
  it('requires a matching artifact-version content verification and ignores legacy source-message telemetry', () => {
    const content = '# 검증 완료 보고서\n\n정성 분석 결과입니다.';
    const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
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
      ],
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
        sourceThreadId: null,
        sourceMessageId: null,
        verification: {
          artifactId: 'artifact-warning',
          artifactVersionId: 'version-warning',
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
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
        sourceThreadId: null,
        sourceMessageId: null,
        verification: {
          artifactId: 'artifact-malformed-pass',
          artifactVersionId: 'version-malformed-pass',
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
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
});
