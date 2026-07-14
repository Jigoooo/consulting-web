import { describe, expect, it } from 'vitest';
import type { ArtifactExportPreflightResponse } from '@consulting/contracts';
import { artifactRedTeamRefetchInterval } from './collab';

function preflight(status: ArtifactExportPreflightResponse['redTeam']['status']): ArtifactExportPreflightResponse {
  return {
    canExport: true,
    reason: 'OK',
    versionNo: 1,
    gate: { decision: 'PASS', blockers: [], warnings: [] },
    messages: [],
    redTeam: {
      mode: 'warning',
      status,
      verdict: status === 'completed' ? 'PASS' : null,
      contentHash: status === 'disabled' || status === 'missing' ? null : 'a'.repeat(64),
      policyVersion: status === 'disabled' || status === 'missing' ? null : 'artifact_red_team_v1',
      attacks: [],
      defenses: [],
      reviewedAt: status === 'completed' ? '2026-07-11T12:00:00.000Z' : null,
    },
  };
}

describe('artifact red-team preflight polling', () => {
  it('polls only while the durable reviewer job is non-terminal', () => {
    expect(artifactRedTeamRefetchInterval(preflight('pending'))).toBe(1_500);
    expect(artifactRedTeamRefetchInterval(preflight('processing'))).toBe(1_500);
    expect(artifactRedTeamRefetchInterval(preflight('completed'))).toBe(false);
    expect(artifactRedTeamRefetchInterval(preflight('failed'))).toBe(false);
    expect(artifactRedTeamRefetchInterval(undefined)).toBe(false);
  });
});
