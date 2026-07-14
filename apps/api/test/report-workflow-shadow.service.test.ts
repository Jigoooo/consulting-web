import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';
import type { ArtifactExportPreflightResponse } from '@consulting/contracts';
import { ReportWorkflowShadowService, reportWorkflowTraceId } from '../src/workflows/report-workflow-shadow.service.js';

const target = {
  workspaceId: '92000000-0000-4000-8000-000000000001',
  projectId: '92000000-0000-4000-8000-000000000002',
  artifactId: '92000000-0000-4000-8000-000000000003',
  artifactVersionId: '92000000-0000-4000-8000-000000000004',
  title: '워크플로 보고서',
  versionNo: 1,
  content: '본문',
  governingMessage: '결론',
  soWhat: '의미',
  sourceThreadId: null,
  sourceMessageId: null,
  contentHash: 'a'.repeat(64),
};
const clean: ArtifactExportPreflightResponse = {
  canExport: true,
  reason: 'OK',
  versionNo: 1,
  gate: { decision: 'PASS', blockers: [], warnings: [] },
  messages: [],
  redTeam: { mode: 'warning', status: 'completed', verdict: 'PASS', contentHash: target.contentHash, policyVersion: 'p1', attacks: [], defenses: [], reviewedAt: '2026-07-13T00:00:00.000Z' },
};
const warning: ArtifactExportPreflightResponse = {
  ...clean,
  messages: ['보완 필요'],
  redTeam: { ...clean.redTeam, verdict: 'PASS_WITH_WARNINGS' },
};
const blocked: ArtifactExportPreflightResponse = {
  ...clean,
  canExport: false,
  reason: 'VERIFIER_GATE_BLOCKED',
  gate: { decision: 'BLOCKED', blockers: [{ code: 'high_impact_unsupported', severity: 'blocker', message: '차단' }], warnings: [] },
  messages: ['차단'],
};

function service(mode: 'off' | 'observe') {
  const traces = { recordSpan: vi.fn().mockResolvedValue({}) };
  const subject = new ReportWorkflowShadowService({ REPORT_WORKFLOW_SHADOW_MODE: mode } as never, traces as never);
  if (mode === 'observe') (subject as unknown as { saver: MemorySaver }).saver = new MemorySaver();
  return { subject, traces };
}

describe('ReportWorkflowShadowService', () => {
  it('uses a deterministic content-bound trace id and off as an instant rollback', async () => {
    expect(reportWorkflowTraceId(target.artifactVersionId, target.contentHash)).toBe(reportWorkflowTraceId(target.artifactVersionId, target.contentHash));
    const { subject } = service('off');
    await expect(subject.observe(target, clean)).resolves.toEqual({ status: 'disabled', traceId: null, decision: null, exactParity: null });
  });

  it('auto-completes a clean preflight with exact parity', async () => {
    const { subject, traces } = service('observe');
    const result = await subject.observe(target, clean);
    expect(result).toMatchObject({ status: 'completed', decision: 'would_publish', exactParity: true });
    expect(traces.recordSpan).toHaveBeenCalledWith(expect.objectContaining({ name: 'report_workflow.parity', status: 'ok' }));
    const parityWrites = () => traces.recordSpan.mock.calls.filter(([span]) => span.name === 'report_workflow.parity').length;
    expect(parityWrites()).toBe(1);
    await expect(subject.observe(target, clean)).resolves.toMatchObject({ status: 'completed', exactParity: true });
    expect(parityWrites()).toBe(1);
  });

  it('retries an exact-parity write that failed after the terminal checkpoint', async () => {
    const { subject, traces } = service('observe');
    let failParity = true;
    traces.recordSpan.mockImplementation(async (span) => {
      if (span.name === 'report_workflow.parity' && failParity) {
        failParity = false;
        throw new Error('trace store unavailable');
      }
      return {};
    });
    const retryTarget = { ...target, artifactVersionId: '92000000-0000-4000-8000-000000000077' };
    await expect(subject.observe(retryTarget, clean)).resolves.toMatchObject({ status: 'degraded' });
    await expect(subject.observe(retryTarget, clean)).resolves.toMatchObject({
      status: 'completed', decision: 'would_publish', exactParity: true,
    });
    expect(traces.recordSpan.mock.calls.filter(([span]) => span.name === 'report_workflow.parity')).toHaveLength(2);
    await expect(subject.observe(retryTarget, clean)).resolves.toMatchObject({ status: 'completed' });
    expect(traces.recordSpan.mock.calls.filter(([span]) => span.name === 'report_workflow.parity')).toHaveLength(2);
  });

  it('durably pauses warnings and resumes from the same checkpoint after approval', async () => {
    const { subject } = service('observe');
    await expect(subject.observe(target, warning)).resolves.toMatchObject({ status: 'paused', decision: null });
    await expect(subject.resume(target, warning, true, true)).resolves.toMatchObject({
      status: 'completed', decision: 'would_publish', exactParity: true,
    });
  });

  it('terminates a repeated hard blocker as would_block with exact parity', async () => {
    const { subject, traces } = service('observe');
    const blockedTarget = { ...target, artifactVersionId: '92000000-0000-4000-8000-000000000005' };
    await expect(subject.observe(blockedTarget, blocked)).resolves.toMatchObject({
      status: 'completed', decision: 'would_block', exactParity: true,
    });
    const names = () => traces.recordSpan.mock.calls.map(([span]) => span.name);
    expect(names()).not.toContain('report_workflow.repair');
    expect(names()).not.toContain('report_workflow.re_verify');
    expect(names()).toContain('report_workflow.block');
    const writes = names().length;
    await expect(subject.observe(blockedTarget, blocked)).resolves.toMatchObject({
      status: 'completed', decision: 'would_block', exactParity: true,
    });
    expect(names()).toHaveLength(writes);
  });

  it('checkpoints a human rejection as a terminal would_block decision', async () => {
    const { subject, traces } = service('observe');
    const rejectedTarget = { ...target, artifactVersionId: '92000000-0000-4000-8000-000000000006' };
    await expect(subject.observe(rejectedTarget, warning, false)).resolves.toMatchObject({ status: 'paused' });
    await expect(subject.resume(rejectedTarget, warning, false, false)).resolves.toMatchObject({
      status: 'completed', decision: 'would_block', exactParity: true,
    });
    const writes = traces.recordSpan.mock.calls.length;
    await expect(subject.observe(rejectedTarget, warning, false)).resolves.toMatchObject({
      status: 'completed', decision: 'would_block', exactParity: true,
    });
    expect(traces.recordSpan).toHaveBeenCalledTimes(writes);
  });

  it('singleflights concurrent observes for one content-bound trace', async () => {
    const { subject, traces } = service('observe');
    let releaseDraft!: () => void;
    const draftGate = new Promise<void>((resolve) => { releaseDraft = resolve; });
    traces.recordSpan.mockImplementation(async (span) => {
      if (span.name === 'report_workflow.draft') await draftGate;
      return {};
    });
    const concurrentTarget = { ...target, artifactVersionId: '92000000-0000-4000-8000-000000000007' };
    const first = subject.observe(concurrentTarget, clean);
    await vi.waitFor(() => {
      expect(traces.recordSpan.mock.calls.filter(([span]) => span.name === 'report_workflow.draft')).toHaveLength(1);
    });
    const second = subject.observe(concurrentTarget, clean);
    releaseDraft();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'completed', exactParity: true }),
      expect.objectContaining({ status: 'completed', exactParity: true }),
    ]);
    expect(traces.recordSpan.mock.calls.filter(([span]) => span.name === 'report_workflow.draft')).toHaveLength(1);
  });

  it('does not singleflight semantically different clean and warning preflights', async () => {
    const { subject, traces } = service('observe');
    let releaseDraft!: () => void;
    const draftGate = new Promise<void>((resolve) => { releaseDraft = resolve; });
    traces.recordSpan.mockImplementation(async (span) => {
      if (span.name === 'report_workflow.draft') await draftGate;
      return {};
    });
    const changedTarget = { ...target, artifactVersionId: '92000000-0000-4000-8000-000000000078' };
    const first = subject.observe(changedTarget, clean);
    await vi.waitFor(() => {
      expect(traces.recordSpan.mock.calls.filter(([span]) => span.name === 'report_workflow.draft')).toHaveLength(1);
    });
    const second = subject.observe(changedTarget, warning);
    try {
      const entry = (subject as unknown as { inFlight: Map<string, { pending?: unknown }> }).inFlight.values().next().value;
      expect(entry?.pending).toBeDefined();
    } finally {
      releaseDraft();
      await Promise.all([first, second]);
    }
  });

  it('queues the latest hard blocker behind an active warning for the same trace', async () => {
    const { subject, traces } = service('observe');
    let releaseDraft!: () => void;
    const draftGate = new Promise<void>((resolve) => { releaseDraft = resolve; });
    traces.recordSpan.mockImplementation(async (span) => {
      if (span.name === 'report_workflow.draft') await draftGate;
      return {};
    });
    const changedTarget = { ...target, artifactVersionId: '92000000-0000-4000-8000-000000000079' };
    const staleWarning = subject.observe(changedTarget, warning, false, 'HUMAN_REVIEW_REQUIRED');
    await vi.waitFor(() => {
      expect(traces.recordSpan.mock.calls.filter(([span]) => span.name === 'report_workflow.draft')).toHaveLength(1);
    });
    const latestHardBlock = subject.observe(changedTarget, warning, false, 'RED_TEAM_BLOCKED');
    releaseDraft();
    await expect(staleWarning).resolves.toMatchObject({ status: 'paused' });
    await expect(latestHardBlock).resolves.toMatchObject({
      status: 'completed', decision: 'would_block', exactParity: true,
    });
  });

  it('supersedes pending B when the latest request returns to active A', async () => {
    const { subject } = service('observe');
    const admit = (subject as unknown as {
      admit: (
        traceId: string,
        fingerprint: string,
        operation: (signal: AbortSignal) => Promise<{
          status: 'degraded'; traceId: null; decision: null; exactParity: null;
        }>,
      ) => Promise<{ status: 'degraded'; traceId: null; decision: null; exactParity: null }>;
    }).admit.bind(subject);
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const calls: string[] = [];
    const result = { status: 'degraded', traceId: null, decision: null, exactParity: null } as const;
    const activeA = admit('aba-trace', 'A', async () => { calls.push('A'); await gateA; return result; });
    const pendingB = admit('aba-trace', 'B', async () => { calls.push('B'); return result; });
    const latestA = admit('aba-trace', 'A', async () => result);
    expect(latestA).toBe(activeA);
    let pendingResolved = false;
    void pendingB.then(() => { pendingResolved = true; });
    try {
      await vi.waitFor(() => { expect(pendingResolved).toBe(true); });
    } finally {
      releaseA();
      await Promise.all([activeA, pendingB, latestA]);
    }
    expect(calls).toEqual(['A']);
  });

  it('routes a non-approvable final blocker directly to terminal block', async () => {
    const { subject, traces } = service('observe');
    const hardTarget = { ...target, artifactVersionId: '92000000-0000-4000-8000-000000000008' };
    await expect(subject.observe(hardTarget, warning, false, 'RED_TEAM_REVIEW_REQUIRED')).resolves.toMatchObject({
      status: 'completed', decision: 'would_block', exactParity: true,
    });
    const names = traces.recordSpan.mock.calls.map(([span]) => span.name);
    expect(names).not.toContain('report_workflow.human_approve');
    expect(names).toContain('report_workflow.block');
  });

  it('supersedes a paused approval checkpoint when observation becomes hard-blocked', async () => {
    const { subject } = service('observe');
    const changedTarget = { ...target, artifactVersionId: '92000000-0000-4000-8000-000000000080' };
    await expect(subject.observe(changedTarget, warning, false, 'HUMAN_REVIEW_REQUIRED')).resolves.toMatchObject({ status: 'paused' });
    await expect(subject.observe(changedTarget, warning, false, 'RED_TEAM_BLOCKED')).resolves.toMatchObject({
      status: 'completed', decision: 'would_block', exactParity: true,
    });
  });

  it('cannot approve a paused checkpoint after final eligibility becomes hard-blocked', async () => {
    const { subject } = service('observe');
    const changedTarget = { ...target, artifactVersionId: '92000000-0000-4000-8000-000000000081' };
    await expect(subject.observe(changedTarget, warning, false, 'HUMAN_REVIEW_REQUIRED')).resolves.toMatchObject({ status: 'paused' });
    await expect(subject.resume(changedTarget, warning, true, false, 'RED_TEAM_BLOCKED')).resolves.toMatchObject({
      status: 'completed', decision: 'would_block', exactParity: true,
    });
  });

  it('persists a parity error when a completed publish later becomes ineligible', async () => {
    const { subject, traces } = service('observe');
    const changedTarget = { ...target, artifactVersionId: '92000000-0000-4000-8000-000000000009' };
    await expect(subject.observe(changedTarget, clean, true, 'OK')).resolves.toMatchObject({ exactParity: true });
    await expect(subject.observe(changedTarget, clean, false, 'HUMAN_REVIEW_REJECTED')).resolves.toMatchObject({
      status: 'completed', decision: 'would_publish', exactParity: false,
    });
    expect(traces.recordSpan).toHaveBeenCalledWith(expect.objectContaining({
      name: 'report_workflow.parity',
      status: 'error',
      output: expect.objectContaining({ exactParity: false, realCanExport: false }),
    }));
  });

  it('keeps timed-out operations admitted until their underlying work actually settles', async () => {
    vi.useFakeTimers();
    const releases: Array<() => void> = [];
    try {
      const { subject } = service('observe');
      const admit = (subject as unknown as {
        admit: (
          traceId: string,
          fingerprint: string,
          operation: (signal: AbortSignal) => Promise<{
            status: 'degraded'; traceId: null; decision: null; exactParity: null;
          }>,
        ) => Promise<{ status: 'degraded'; traceId: null; decision: null; exactParity: null }>;
      }).admit.bind(subject);
      const result = { status: 'degraded', traceId: null, decision: null, exactParity: null } as const;
      const timedOut = Array.from({ length: 32 }, (_, index) => admit(
        `hung-${index}`,
        'observe:false:HUMAN_REVIEW_REQUIRED',
        () => new Promise((resolve) => { releases.push(() => resolve(result)); }),
      ));
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(Promise.all(timedOut)).resolves.toEqual(Array.from({ length: 32 }, () => result));

      const mustNotStart = vi.fn(async () => result);
      await expect(admit('still-capped', 'observe:false:HUMAN_REVIEW_REQUIRED', mustNotStart)).resolves.toEqual(result);
      expect(mustNotStart).not.toHaveBeenCalled();

      releases.splice(0).forEach((release) => { release(); });
      await Promise.resolve();
      await Promise.resolve();
      const startsAfterSettlement = vi.fn(async () => result);
      await expect(admit('released-slot', 'observe:false:HUMAN_REVIEW_REQUIRED', startsAfterSettlement)).resolves.toEqual(result);
      expect(startsAfterSettlement).toHaveBeenCalledOnce();
    } finally {
      releases.splice(0).forEach((release) => { release(); });
      vi.useRealTimers();
    }
  });

  it('degrades new traces once the global in-flight admission cap is reached', async () => {
    const { subject, traces } = service('observe');
    let releaseDraft!: () => void;
    const draftGate = new Promise<void>((resolve) => { releaseDraft = resolve; });
    traces.recordSpan.mockImplementation(async (span) => {
      if (span.name === 'report_workflow.draft') await draftGate;
      return {};
    });
    const active = Array.from({ length: 32 }, (_, index) => subject.observe({
      ...target,
      artifactVersionId: `92000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
    }, clean));
    await vi.waitFor(() => {
      expect(traces.recordSpan.mock.calls.filter(([span]) => span.name === 'report_workflow.draft')).toHaveLength(32);
    });
    await expect(subject.observe({
      ...target,
      artifactVersionId: '92000000-0000-4000-8000-000000000099',
    }, clean)).resolves.toEqual({ status: 'degraded', traceId: null, decision: null, exactParity: null });
    releaseDraft();
    await expect(Promise.all(active)).resolves.toHaveLength(32);
  });
});
