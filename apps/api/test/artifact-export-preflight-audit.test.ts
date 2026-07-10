import { describe, expect, it } from 'vitest';
import { auditArtifactExportPreflight } from '../src/artifacts/artifact-export-preflight-audit.js';

describe('artifact export preflight audit', () => {
  it('classifies final export readiness from persisted exactness and verifier rows', () => {
    const result = auditArtifactExportPreflight({
      projectId: 'project-1',
      projectName: '창원시 컨설팅',
      rows: [
        {
          artifactId: 'artifact-blocked',
          title: '차단 산출물',
          versionNo: 1,
          sourceThreadId: 'thread-1',
          sourceMessageId: 'message-blocked',
          sourceValid: true,
          exactnessStatus: 'blocked',
          verdicts: [{ claimId: 'CL-EXPORT-1', claimText: '정원 증가는 인건비 부담을 줄입니다.', verdict: 'refutes', confidence: 0.94, rationale: 'contradiction' }],
        },
        {
          artifactId: 'artifact-clean',
          title: '통과 산출물',
          versionNo: 2,
          sourceThreadId: 'thread-1',
          sourceMessageId: 'message-clean',
          sourceValid: true,
          exactnessStatus: 'passed',
          verdicts: [{ claimId: 'CL-EXPORT-2', claimText: '정원 증가는 인건비 부담을 증가시킵니다.', verdict: 'supports', confidence: 0.91, rationale: 'supported' }],
        },
        {
          artifactId: 'artifact-missing-telemetry',
          title: '검증 row 없는 source 산출물',
          versionNo: 1,
          sourceThreadId: 'thread-1',
          sourceMessageId: 'message-no-telemetry',
          sourceValid: true,
          exactnessStatus: null,
          verdicts: [],
        },
        {
          artifactId: 'artifact-invalid-source',
          title: '다른 프로젝트 source 산출물',
          versionNo: 1,
          sourceThreadId: 'thread-other-project',
          sourceMessageId: 'message-other-project',
          sourceValid: false,
          exactnessStatus: 'passed',
          verdicts: [{ claimId: 'CL-EXPORT-3', claimText: '검증 row가 있어도 다른 프로젝트 원본은 내보낼 수 없습니다.', verdict: 'supports', confidence: 0.91, rationale: 'supported' }],
        },
        {
          artifactId: 'artifact-unsourced',
          title: '무source 산출물',
          versionNo: 1,
          sourceThreadId: null,
          sourceMessageId: null,
          sourceValid: null,
          exactnessStatus: null,
          verdicts: [],
        },
      ],
    });

    expect(result.readOnly).toBe(true);
    expect(result.status).toBe('blocked');
    expect(result.summary).toEqual({ total: 5, exportable: 2, blocked: 3, noSourceMessage: 1, invalidSourceMessage: 1 });
    expect(result.rows.find((row) => row.artifactId === 'artifact-blocked')).toMatchObject({
      canExport: false,
      reason: 'VERIFIER_GATE_BLOCKED',
      gate: {
        decision: 'BLOCKED',
        blockers: expect.arrayContaining([
          expect.objectContaining({ code: 'exactness_blocked' }),
          expect.objectContaining({ code: 'high_impact_refute', claimId: 'CL-EXPORT-1' }),
        ]),
      },
    });
    expect(result.rows.find((row) => row.artifactId === 'artifact-clean')).toMatchObject({ canExport: true, reason: 'OK' });
    expect(result.rows.find((row) => row.artifactId === 'artifact-missing-telemetry')).toMatchObject({
      canExport: false,
      reason: 'VERIFIER_GATE_BLOCKED',
      gate: { blockers: [expect.objectContaining({ code: 'missing_verifier_telemetry' })] },
    });
    expect(result.rows.find((row) => row.artifactId === 'artifact-invalid-source')).toMatchObject({
      canExport: false,
      reason: 'INVALID_SOURCE_MESSAGE',
      gate: null,
    });
    expect(result.rows.find((row) => row.artifactId === 'artifact-unsourced')).toMatchObject({ canExport: true, reason: 'NO_SOURCE_MESSAGE' });
  });
});
