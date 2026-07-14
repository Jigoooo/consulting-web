/**
 * W3 shadow spike runner — proves the LangGraph success criteria against a REAL
 * Postgres checkpointer (isolated schema) with a stub preflight port. No app DB
 * tables are touched; the checkpointer lives in its own schema.
 *
 * Criteria (roadmap §5.2):
 *   (a) human-wait → process kill → rebuild graph on same checkpointer → resume
 *   (b) node transitions recorded (span sink captures the chain)
 *   (c) deterministic decision on identical input
 *   (d) shadow decision parity with the preflight contract
 *
 * Run:
 *   LG_CHECKPOINT_DSN=postgresql://postgres@127.0.0.1:55420/consulting_rbac \
 *   pnpm --filter @consulting/api exec tsx scripts/report_workflow_shadow_spike.ts
 */
import { Command } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { ArtifactExportPreflightResponse } from '@consulting/contracts';
import { buildReportWorkflow, deriveShadowDecision, type WorkflowSpanSink } from '../src/workflows/report-workflow.graph.js';
import { shadowParityHolds, type ReportWorkflowNode } from '../src/workflows/report-workflow.core.js';

const DSN: string = process.env.LG_CHECKPOINT_DSN ?? '';
if (!DSN) throw new Error('LG_CHECKPOINT_DSN required');

const SCHEMA = 'langgraph_checkpoints_spike';

function passPreflight(): ArtifactExportPreflightResponse {
  return {
    canExport: true, reason: 'OK', versionNo: 1,
    gate: { decision: 'PASS_WITH_WARNINGS', blockers: [], warnings: [{ code: 'stale_source_warning', severity: 'warning', message: '기준일 확인 권장' }] },
    messages: [], redTeam: { mode: 'warning', status: 'completed', verdict: 'PASS_WITH_WARNINGS', contentHash: 'a'.repeat(64), policyVersion: 'artifact_red_team_v1', attacks: [], defenses: [], reviewedAt: '2026-07-12T00:00:00.000Z' },
  };
}

const target = {
  workspaceId: 'ws-spike', projectId: 'pj-spike', artifactId: 'af-spike', artifactVersionId: 'ver-spike',
  title: '리포트 발행 shadow 스파이크', versionNo: 1, content: '본문', governingMessage: '핵심 결론', soWhat: '의미',
  sourceThreadId: null, sourceMessageId: null, contentHash: 'spikehash',
};

async function main() {
  const preflightResponse = passPreflight();
  const preflightPort = { preflight: () => Promise.resolve(preflightResponse) };

  const saver = PostgresSaver.fromConnString(DSN, { schema: SCHEMA });
  await saver.setup();

  const threadId = `spike-${Date.now()}`;
  const config = { configurable: { thread_id: threadId } };

  const spansA: ReportWorkflowNode[] = [];
  const sinkA: WorkflowSpanSink = { record: (s) => { spansA.push(s.node); } };

  // --- Phase 1: run until the human-approve interrupt, then DISCARD the graph
  // (simulate process kill) ---
  const graph1 = buildReportWorkflow({ target, preflightPort, checkpointer: saver, spanSink: sinkA });
  const firstPass = await graph1.invoke({}, config);
  const interrupted = Boolean((firstPass as { __interrupt__?: unknown }).__interrupt__);

  const stateBeforeKill = await graph1.getState(config);
  const pausedAtApproval = stateBeforeKill.next.includes('human_approve');

  // --- Phase 2: rebuild a BRAND NEW graph object on the SAME checkpointer and
  // resume — if the checkpoint carried state, this completes without replaying
  // earlier nodes. ---
  const spansB: ReportWorkflowNode[] = [];
  const sinkB: WorkflowSpanSink = { record: (s) => { spansB.push(s.node); } };
  const graph2 = buildReportWorkflow({ target, preflightPort, checkpointer: saver, spanSink: sinkB });
  const resumed = await graph2.invoke(new Command({ resume: true }), config);

  const finalState = await graph2.getState(config);
  const decision = deriveShadowDecision(resumed);

  // Criterion (c): re-run a fresh thread with identical input → identical decision
  const config2 = { configurable: { thread_id: `spike-det-${Date.now()}` } };
  const gDet = buildReportWorkflow({ target, preflightPort, checkpointer: saver });
  await gDet.invoke({}, config2);
  const detResumed = await gDet.invoke(new Command({ resume: true }), config2);
  const detDecision = deriveShadowDecision(detResumed);

  // Criterion (d): parity with the preflight contract
  const parity = shadowParityHolds(decision, preflightResponse.canExport);

  const nodesBeforeKill = [...spansA];
  const nodesAfterResume = [...spansB];
  const resumeReplayedEarlierNodes = nodesAfterResume.some((n) => n === 'draft' || n === 'verify');

  const result = {
    criterion_a_durable_resume: interrupted && pausedAtApproval && !resumeReplayedEarlierNodes && decision === 'would_publish',
    criterion_b_trace_continuity: nodesBeforeKill.length > 0 && nodesBeforeKill.includes('verify'),
    criterion_c_determinism: decision === detDecision,
    criterion_d_parity: parity,
    decision,
    detDecision,
    nodesBeforeKill,
    nodesAfterResume,
    finalVisited: (finalState.values as { visited: ReportWorkflowNode[] }).visited,
    pausedAtApproval,
    resumeReplayedEarlierNodes,
  };
  const ok = result.criterion_a_durable_resume && result.criterion_b_trace_continuity && result.criterion_c_determinism && result.criterion_d_parity;

  // Cleanup the spike schema so nothing lingers.
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: DSN });
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();

  console.log(JSON.stringify({ ok, ...result }, null, 2));
  if (!ok) process.exit(1);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : String(e)); process.exit(1); });
