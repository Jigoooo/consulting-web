import type { ConsultingRunTraceService } from '../consulting/consulting-run-trace.service.js';
import type { WorkflowSpanSink } from './report-workflow.graph.js';

export interface ReportWorkflowTraceContext {
  workspaceId: string;
  threadId: string | null;
  traceId: string;
  artifactId: string;
  artifactVersionId: string;
}

export class ReportWorkflowTraceSpanSink implements WorkflowSpanSink {
  constructor(
    private readonly traces: Pick<ConsultingRunTraceService, 'recordSpan'>,
    private readonly context: ReportWorkflowTraceContext,
  ) {}

  async record(span: Parameters<WorkflowSpanSink['record']>[0]): Promise<void> {
    await this.traces.recordSpan({
      workspaceId: this.context.workspaceId,
      threadId: this.context.threadId,
      traceId: this.context.traceId,
      spanKind: 'artifact_gate',
      name: `report_workflow.${span.node}`,
      status: span.verdict === 'BLOCKED' ? 'blocked' : 'ok',
      input: null,
      output: { verdict: span.verdict },
      metadata: {
        runKind: 'report_workflow_shadow',
        artifactId: this.context.artifactId,
        artifactVersionId: this.context.artifactVersionId,
        contentHash: span.contentHash,
        node: span.node,
      },
    });
  }
}
