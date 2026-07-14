import { describe, expect, it } from 'vitest';
import type { ArtifactExportPreflightResponse } from '@consulting/contracts';
import {
  decideNextNode,
  initialReportState,
  preflightToVerdict,
  shadowParityHolds,
  shadowPromotionParityHolds,
  type ReportWorkflowState,
} from '../src/workflows/report-workflow.core.js';

function preflight(over: Partial<ArtifactExportPreflightResponse>): ArtifactExportPreflightResponse {
  return {
    canExport: true,
    reason: 'OK',
    versionNo: 1,
    gate: { decision: 'PASS', blockers: [], warnings: [] },
    messages: [],
    redTeam: { mode: 'off', status: 'disabled', verdict: null, contentHash: null, policyVersion: null, attacks: [], defenses: [], reviewedAt: null },
    ...over,
  };
}

const base = () => initialReportState({
  workspaceId: 'w', projectId: 'p', artifactId: 'a', artifactVersionId: 'v', contentHash: 'h',
});

function walk(state: ReportWorkflowState, maxRepair: number): ReportWorkflowState {
  let s: ReportWorkflowState = { ...state, visited: ['draft'] };
  for (let i = 0; i < 20; i += 1) {
    const { next, patch } = decideNextNode(s, maxRepair);
    s = { ...s, ...patch };
    if (next === 'END') return s;
    s = { ...s, visited: [...s.visited, next] };
  }
  throw new Error('workflow did not terminate');
}

describe('preflightToVerdict', () => {
  it('maps a clean export to PASS with no blockers/warnings', () => {
    expect(preflightToVerdict(preflight({}))).toEqual({ verdict: 'PASS', gateBlockers: [], gateWarnings: [], redTeamVerdict: null });
  });

  it('maps warnings-only to PASS_WITH_WARNINGS carrying only codes', () => {
    const r = preflightToVerdict(preflight({
      gate: { decision: 'PASS_WITH_WARNINGS', blockers: [], warnings: [{ code: 'stale_source_warning', severity: 'warning', message: '기준일 없음' }] },
    }));
    expect(r.verdict).toBe('PASS_WITH_WARNINGS');
    expect(r.gateWarnings).toEqual(['stale_source_warning']);
    // pointer state must never carry the human message text
    expect(JSON.stringify(r)).not.toContain('기준일 없음');
  });

  it('maps a blocked export to BLOCKED', () => {
    const r = preflightToVerdict(preflight({
      canExport: false, reason: 'VERIFIER_GATE_BLOCKED',
      gate: { decision: 'BLOCKED', blockers: [{ code: 'high_impact_unsupported', severity: 'blocker', message: 'x' }], warnings: [] },
    }));
    expect(r.verdict).toBe('BLOCKED');
    expect(r.gateBlockers).toEqual(['high_impact_unsupported']);
  });
});

describe('report workflow decision core', () => {
  it('drives a clean PASS through approval to would_publish', () => {
    const s = walk({ ...base(), verdict: 'PASS', humanApproved: true }, 2);
    expect(s.shadowDecision).toBe('would_publish');
    expect(s.visited).toEqual(['draft', 'verify', 'human_approve', 'publish']);
  });

  it('blocks when the human declines approval even on a PASS', () => {
    const s = walk({ ...base(), verdict: 'PASS', humanApproved: false }, 2);
    expect(s.shadowDecision).toBe('would_block');
    expect(s.visited).not.toContain('publish');
  });

  it('routes an immutable hard block directly to the terminal block node', () => {
    const s = { ...base(), verdict: 'BLOCKED' as const, visited: ['draft', 'verify'] as ReportWorkflowState['visited'] };
    expect(decideNextNode(s, 2)).toEqual({ next: 'block', patch: {} });
  });

  it('treats a red-team BLOCKED as a hard block even when the gate passes', () => {
    const s = {
      ...base(),
      verdict: 'PASS' as const,
      redTeamVerdict: 'BLOCKED' as const,
      visited: ['draft', 'verify'] as ReportWorkflowState['visited'],
    };
    expect(decideNextNode(s, 1)).toEqual({ next: 'block', patch: {} });
  });

  it('is deterministic: identical input yields identical trace and decision (criterion c)', () => {
    const input = { ...base(), verdict: 'PASS_WITH_WARNINGS' as const, humanApproved: true };
    const a = walk(input, 2);
    const b = walk(input, 2);
    expect(a.shadowDecision).toBe(b.shadowDecision);
    expect(a.visited).toEqual(b.visited);
  });
});

describe('shadow parity (criterion d)', () => {
  it('would_publish is only legal when the real preflight allows export', () => {
    expect(shadowParityHolds('would_publish', true)).toBe(true);
    expect(shadowParityHolds('would_publish', false)).toBe(false);
  });
  it('would_block is always parity-safe', () => {
    expect(shadowParityHolds('would_block', true)).toBe(true);
    expect(shadowParityHolds('would_block', false)).toBe(true);
  });
  it('requires exact decision parity before promotion', () => {
    expect(shadowPromotionParityHolds('would_publish', true)).toBe(true);
    expect(shadowPromotionParityHolds('would_block', false)).toBe(true);
    expect(shadowPromotionParityHolds('would_publish', false)).toBe(false);
    expect(shadowPromotionParityHolds('would_block', true)).toBe(false);
  });
});
