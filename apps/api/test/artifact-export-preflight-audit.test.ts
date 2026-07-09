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
          exactnessStatus: 'blocked',
          verdicts: [{ claimId: 'CL-EXPORT-1', claimText: '정원 증가는 인건비 부담을 줄입니다.', verdict: 'refutes', confidence: 0.94, rationale: 'contradiction' }],
        },
        {
          artifactId: 'artifact-clean',
          title: '통과 산출물',
          versionNo: 2,
          sourceThreadId: 'thread-1',
          sourceMessageId: 'message-clean',
          exactnessStatus: 'passed',
          verdicts: [{ claimId: 'CL-EXPORT-2', claimText: '정원 증가는 인건비 부담을 증가시킵니다.', verdict: 'supports', confidence: 0.91, rationale: 'supported' }],
        },
        {
          artifactId: 'artifact-missing-telemetry',
          title: '검증 row 없는 source 산출물',
          versionNo: 1,
          sourceThreadId: 'thread-1',
          sourceMessageId: 'message-no-telemetry',
          exactnessStatus: null,
          verdicts: [],
        },
        {
          artifactId: 'artifact-unsourced',
          title: '무source 산출물',
          versionNo: 1,
          sourceThreadId: null,
          sourceMessageId: null,
          exactnessStatus: null,
          verdicts: [],
        },
      ],
    });

    expect(result.readOnly).toBe(true);
    expect(result.status).toBe('blocked');
    expect(result.summary).toEqual({ total: 4, exportable: 2, blocked: 2, noSourceMessage: 1 });
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
    expect(result.rows.find((row) => row.artifactId === 'artifact-unsourced')).toMatchObject({ canExport: true, reason: 'NO_SOURCE_MESSAGE' });
  });
});
