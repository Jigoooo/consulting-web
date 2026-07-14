import { StateGraph, START, END, Annotation, interrupt, type BaseCheckpointSaver } from '@langchain/langgraph';
import {
  decideNextNode,
  preflightToVerdict,
  type PreflightPort,
  type ReportWorkflowNode,
  type ReportShadowDecision,
} from './report-workflow.core.js';

/**
 * LangGraph wiring for the ReportGenerationWorkflow shadow spike.
 *
 * The pure decision logic lives in report-workflow.core.ts (unit-tested without a
 * DB). This module is the thin orchestration shell: it maps nodes to the EXISTING
 * preflight port, checkpoints between nodes, and pauses at human_approve via
 * interrupt() so a killed process can resume from the checkpoint (criterion a).
 */

export interface ReportWorkflowTarget {
  workspaceId: string;
  projectId: string;
  artifactId: string;
  artifactVersionId: string;
  title: string;
  versionNo: number;
  content: string;
  governingMessage: string | null;
  soWhat: string | null;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  contentHash: string;
}

/** Optional sink for node transitions → wire to trace_spans in production (criterion b). */
export interface WorkflowSpanSink {
  record(span: { node: ReportWorkflowNode; contentHash: string; verdict: string | null }): Promise<void> | void;
}

const ReportState = Annotation.Root({
  workspaceId: Annotation<string>,
  projectId: Annotation<string>,
  artifactId: Annotation<string>,
  artifactVersionId: Annotation<string>,
  contentHash: Annotation<string>,
  verdict: Annotation<'PASS' | 'PASS_WITH_WARNINGS' | 'BLOCKED' | null>({ reducer: (_p, n) => n, default: () => null }),
  gateBlockers: Annotation<string[]>({ reducer: (_p, n) => n, default: () => [] }),
  gateWarnings: Annotation<string[]>({ reducer: (_p, n) => n, default: () => [] }),
  redTeamVerdict: Annotation<'PASS' | 'PASS_WITH_WARNINGS' | 'BLOCKED' | null>({ reducer: (_p, n) => n, default: () => null }),
  attempt: Annotation<number>({ reducer: (_p, n) => n, default: () => 0 }),
  humanApproved: Annotation<boolean>({ reducer: (_p, n) => n, default: () => false }),
  shadowDecision: Annotation<ReportShadowDecision | null>({ reducer: (_p, n) => n, default: () => null }),
  visited: Annotation<ReportWorkflowNode[]>({ reducer: (p, n) => [...p, ...n], default: () => [] }),
});

export interface BuildReportWorkflowOptions {
  target: ReportWorkflowTarget;
  preflightPort: PreflightPort;
  checkpointer: BaseCheckpointSaver;
  maxRepairAttempts?: number;
  forceBlock?: boolean;
  spanSink?: WorkflowSpanSink;
}

export function buildReportWorkflow(opts: BuildReportWorkflowOptions) {
  const { target, preflightPort, checkpointer, spanSink } = opts;
  const maxRepairAttempts = opts.maxRepairAttempts ?? 2;

  async function runPreflight() {
    const preflight = await preflightPort.preflight(target);
    const verdict = preflightToVerdict(preflight);
    if (!opts.forceBlock) return verdict;
    return {
      ...verdict,
      verdict: 'BLOCKED' as const,
      gateBlockers: verdict.gateBlockers.includes('final_eligibility_blocked')
        ? verdict.gateBlockers
        : [...verdict.gateBlockers, 'final_eligibility_blocked'],
    };
  }

  const trace = async (node: ReportWorkflowNode, verdict: string | null) => {
    await spanSink?.record({ node, contentHash: target.contentHash, verdict });
  };

  const graph = new StateGraph(ReportState)
    .addNode('draft', async () => {
      await trace('draft', null);
      return { visited: ['draft'] as ReportWorkflowNode[] };
    })
    .addNode('verify', async () => {
      const v = await runPreflight();
      await trace('verify', v.verdict);
      return { ...v, visited: ['verify'] as ReportWorkflowNode[] };
    })
    .addNode('human_approve', async () => {
      // Durable pause: an object payload preserves explicit false rejections.
      const response = interrupt<unknown, { approved: boolean }>({ kind: 'report_publish_approval', contentHash: target.contentHash });
      await trace('human_approve', null);
      return { humanApproved: response?.approved === true, visited: ['human_approve'] as ReportWorkflowNode[] };
    })
    .addNode('block', async () => {
      await trace('block', null);
      return { shadowDecision: 'would_block' as ReportShadowDecision, visited: ['block'] as ReportWorkflowNode[] };
    })
    .addNode('publish', async () => {
      // SHADOW: decision only, no export side-effect.
      await trace('publish', null);
      return { shadowDecision: 'would_publish' as ReportShadowDecision, visited: ['publish'] as ReportWorkflowNode[] };
    });

  graph.addEdge(START, 'draft');

  const route = (state: typeof ReportState.State): ReportWorkflowNode | typeof END => {
    // Pure routing: never mutate state here. The terminal shadowDecision is
    // derived from whether the publish node ran (see deriveShadowDecision).
    const { next } = decideNextNode(state, maxRepairAttempts);
    return next === 'END' ? END : next;
  };

  graph.addConditionalEdges('draft', route, ['verify']);
  graph.addConditionalEdges('verify', route, ['block', 'human_approve']);
  graph.addConditionalEdges('human_approve', route, ['publish', 'block']);
  graph.addConditionalEdges('block', route, [END]);
  graph.addConditionalEdges('publish', route, [END]);

  return graph.compile({ checkpointer });
}

/**
 * The publish node is the only place a would_publish decision is minted; every
 * terminal path that skips it is a would_block. Deriving here keeps the routing
 * function pure and the decision single-sourced.
 */
export function deriveShadowDecision(finalState: { shadowDecision: ReportShadowDecision | null }): ReportShadowDecision {
  return finalState.shadowDecision ?? 'would_block';
}
