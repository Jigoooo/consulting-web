import { describe, expect, it, vi } from 'vitest';
import { ReportWorkflowTraceSpanSink } from '../src/workflows/report-workflow-trace-span-sink.js';

const WORKSPACE_ID = '91000000-0000-4000-8000-000000000001';
const THREAD_ID = '91000000-0000-4000-8000-000000000002';

describe('ReportWorkflowTraceSpanSink', () => {
  it('commits pointer-only workflow transitions to trace_spans with blocked status', async () => {
    const recordSpan = vi.fn().mockResolvedValue({});
    const sink = new ReportWorkflowTraceSpanSink(
      { recordSpan } as never,
      { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, traceId: 'report-shadow-run-1', artifactId: 'a1', artifactVersionId: 'v1' },
    );

    await sink.record({ node: 'verify', contentHash: 'a'.repeat(64), verdict: 'BLOCKED' });

    expect(recordSpan).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      traceId: 'report-shadow-run-1',
      spanKind: 'artifact_gate',
      name: 'report_workflow.verify',
      status: 'blocked',
      input: null,
      output: { verdict: 'BLOCKED' },
      metadata: {
        runKind: 'report_workflow_shadow',
        artifactId: 'a1',
        artifactVersionId: 'v1',
        contentHash: 'a'.repeat(64),
        node: 'verify',
      },
    });
    expect(JSON.stringify(recordSpan.mock.calls)).not.toContain('document body');
  });

  it('does not swallow trace persistence failures', async () => {
    const sink = new ReportWorkflowTraceSpanSink(
      { recordSpan: vi.fn().mockRejectedValue(new Error('trace db unavailable')) } as never,
      { workspaceId: WORKSPACE_ID, threadId: null, traceId: 'report-shadow-run-2', artifactId: 'a2', artifactVersionId: 'v2' },
    );
    await expect(sink.record({ node: 'publish', contentHash: 'b'.repeat(64), verdict: null })).rejects.toThrow('trace db unavailable');
  });
});
