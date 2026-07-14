import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Command } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { ArtifactExportPreflightResponse } from '@consulting/contracts';
import { ENV_TOKEN } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { ConsultingRunTraceService } from '../consulting/consulting-run-trace.service.js';
import { buildReportWorkflow, deriveShadowDecision, type ReportWorkflowTarget } from './report-workflow.graph.js';
import { shadowPromotionParityHolds, type ReportShadowDecision } from './report-workflow.core.js';
import { ReportWorkflowTraceSpanSink } from './report-workflow-trace-span-sink.js';

export type ReportWorkflowShadowStatus = 'disabled' | 'degraded' | 'paused' | 'completed' | 'missing_checkpoint';
export interface ReportWorkflowShadowResult {
  status: ReportWorkflowShadowStatus;
  traceId: string | null;
  decision: ReportShadowDecision | null;
  exactParity: boolean | null;
}

const MAX_IN_FLIGHT_REPORT_WORKFLOWS = 32;
const REPORT_WORKFLOW_OPERATION_TIMEOUT_MS = 5_000;

type ReportWorkflowOperation = (signal: AbortSignal) => Promise<ReportWorkflowShadowResult>;
type PendingReportWorkflow = {
  fingerprint: string;
  operation: ReportWorkflowOperation;
  promise: Promise<ReportWorkflowShadowResult>;
  resolve: (result: ReportWorkflowShadowResult) => void;
};
type ActiveReportWorkflow = {
  fingerprint: string;
  promise: Promise<ReportWorkflowShadowResult>;
  pending?: PendingReportWorkflow;
};

@Injectable()
export class ReportWorkflowShadowService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReportWorkflowShadowService.name);
  private saver: PostgresSaver | null = null;
  private readonly inFlight = new Map<string, ActiveReportWorkflow>();
  private readonly recordedParity = new Set<string>();

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    private readonly traces: ConsultingRunTraceService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.REPORT_WORKFLOW_SHADOW_MODE === 'off') return;
    try {
      this.saver = PostgresSaver.fromConnString(this.env.DATABASE_URL, { schema: 'report_workflow_checkpoints' });
      await this.saver.setup();
    } catch (error) {
      this.saver = null;
      this.logger.error(`report workflow checkpoint setup degraded: ${safeError(error)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.saver?.end();
    this.saver = null;
  }

  async observe(
    target: ReportWorkflowTarget,
    preflight: ArtifactExportPreflightResponse,
    realCanExport = preflight.canExport,
    finalReason: ArtifactExportPreflightResponse['reason'] = !realCanExport && requiresExplicitHumanReview(preflight)
      ? 'HUMAN_REVIEW_REQUIRED'
      : preflight.reason,
  ): Promise<ReportWorkflowShadowResult> {
    if (this.env.REPORT_WORKFLOW_SHADOW_MODE === 'off') return disabledResult();
    if (!this.saver) return degradedResult();
    const traceId = reportWorkflowTraceId(target.artifactVersionId, target.contentHash);
    const fingerprint = reportWorkflowOperationFingerprint('observe', preflight, { realCanExport, finalReason });
    return this.admit(traceId, fingerprint, (signal) => this.observeLocked(target, preflight, realCanExport, finalReason, signal));
  }

  private async observeLocked(
    target: ReportWorkflowTarget,
    preflight: ArtifactExportPreflightResponse,
    realCanExport: boolean,
    finalReason: ArtifactExportPreflightResponse['reason'],
    signal: AbortSignal,
  ): Promise<ReportWorkflowShadowResult> {
    try {
      const hardBlock = isFinalHardBlock(realCanExport, finalReason);
      const runtime = this.runtime(target, preflight, hardBlock, signal);
      const before = await runtime.graph.getState(runtime.config);
      if (hasDecision(before.values)) return await this.completed(runtime.traceId, target, before.values.shadowDecision, realCanExport);
      if (before.next.includes('human_approve')) {
        if (!hardBlock) return { status: 'paused', traceId: runtime.traceId, decision: null, exactParity: null };
        const blocked = await runtime.graph.invoke(new Command({ resume: { approved: false } }), runtime.config);
        return await this.finish(runtime.traceId, target, deriveShadowDecision(blocked), realCanExport);
      }

      const first = await runtime.graph.invoke({}, runtime.config);
      if (isInterrupted(first)) {
        if (requiresExplicitHumanReview(preflight)) {
          return { status: 'paused', traceId: runtime.traceId, decision: null, exactParity: null };
        }
        const resumed = await runtime.graph.invoke(new Command({ resume: { approved: realCanExport } }), runtime.config);
        return await this.finish(runtime.traceId, target, deriveShadowDecision(resumed), realCanExport);
      }
      return await this.finish(runtime.traceId, target, deriveShadowDecision(first), realCanExport);
    } catch (error) {
      this.logger.warn(`report workflow shadow observe degraded: ${safeError(error)}`);
      return degradedResult();
    }
  }

  async resume(
    target: ReportWorkflowTarget,
    preflight: ArtifactExportPreflightResponse,
    approved: boolean,
    realCanExport: boolean,
    finalReason: ArtifactExportPreflightResponse['reason'] = !realCanExport && requiresExplicitHumanReview(preflight)
      ? 'HUMAN_REVIEW_REQUIRED'
      : preflight.reason,
  ): Promise<ReportWorkflowShadowResult> {
    if (this.env.REPORT_WORKFLOW_SHADOW_MODE === 'off') return disabledResult();
    if (!this.saver) return degradedResult();
    const traceId = reportWorkflowTraceId(target.artifactVersionId, target.contentHash);
    const fingerprint = reportWorkflowOperationFingerprint('resume', preflight, { approved, realCanExport, finalReason });
    return this.admit(traceId, fingerprint, (signal) => this.resumeLocked(target, preflight, approved, realCanExport, finalReason, signal));
  }

  private async resumeLocked(
    target: ReportWorkflowTarget,
    preflight: ArtifactExportPreflightResponse,
    approved: boolean,
    realCanExport: boolean,
    finalReason: ArtifactExportPreflightResponse['reason'],
    signal: AbortSignal,
  ): Promise<ReportWorkflowShadowResult> {
    try {
      const hardBlock = isFinalHardBlock(realCanExport, finalReason);
      const runtime = this.runtime(target, preflight, hardBlock, signal);
      const state = await runtime.graph.getState(runtime.config);
      if (!state.next.includes('human_approve')) {
        if (hasDecision(state.values)) return await this.completed(runtime.traceId, target, state.values.shadowDecision, realCanExport);
        return { status: 'missing_checkpoint', traceId: runtime.traceId, decision: null, exactParity: null };
      }
      const resumed = await runtime.graph.invoke(new Command({ resume: { approved: hardBlock ? false : approved } }), runtime.config);
      return await this.finish(runtime.traceId, target, deriveShadowDecision(resumed), realCanExport);
    } catch (error) {
      this.logger.warn(`report workflow shadow resume degraded: ${safeError(error)}`);
      return degradedResult();
    }
  }

  private admit(
    traceId: string,
    fingerprint: string,
    operation: ReportWorkflowOperation,
  ): Promise<ReportWorkflowShadowResult> {
    const existing = this.inFlight.get(traceId);
    if (existing) {
      if (existing.fingerprint === fingerprint) {
        existing.pending?.resolve(degradedResult());
        delete existing.pending;
        return existing.promise;
      }
      if (existing.pending?.fingerprint === fingerprint) return existing.pending.promise;
      existing.pending?.resolve(degradedResult());
      let resolvePending!: (result: ReportWorkflowShadowResult) => void;
      const pendingPromise = new Promise<ReportWorkflowShadowResult>((resolve) => { resolvePending = resolve; });
      existing.pending = { fingerprint, operation, promise: pendingPromise, resolve: resolvePending };
      return pendingPromise;
    }
    if (this.inFlight.size >= MAX_IN_FLIGHT_REPORT_WORKFLOWS) return Promise.resolve(degradedResult());
    return this.startAdmission(traceId, fingerprint, operation);
  }

  private startAdmission(
    traceId: string,
    fingerprint: string,
    operation: ReportWorkflowOperation,
    resolvePending?: (result: ReportWorkflowShadowResult) => void,
  ): Promise<ReportWorkflowShadowResult> {
    const entry = { fingerprint } as ActiveReportWorkflow;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<ReportWorkflowShadowResult>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort(new Error('report workflow operation timeout'));
        this.logger.warn(`report workflow shadow operation timed out: ${traceId}`);
        resolve(degradedResult());
      }, REPORT_WORKFLOW_OPERATION_TIMEOUT_MS);
      timeout.unref?.();
    });
    const execution = Promise.resolve().then(() => operation(controller.signal));
    const promise = Promise.race([execution, deadline]);
    void execution.then(
      () => {
        if (timeout) clearTimeout(timeout);
        this.completeAdmission(traceId, entry);
      },
      () => {
        if (timeout) clearTimeout(timeout);
        this.completeAdmission(traceId, entry);
      },
    );
    entry.promise = promise;
    this.inFlight.set(traceId, entry);
    if (resolvePending) void promise.then(resolvePending, () => resolvePending(degradedResult()));
    return promise;
  }

  private completeAdmission(traceId: string, completed: ActiveReportWorkflow): void {
    if (this.inFlight.get(traceId) !== completed) return;
    const pending = completed.pending;
    if (!pending) {
      this.inFlight.delete(traceId);
      return;
    }
    void this.startAdmission(traceId, pending.fingerprint, pending.operation, pending.resolve);
  }

  private runtime(
    target: ReportWorkflowTarget,
    preflight: ArtifactExportPreflightResponse,
    forceBlock: boolean,
    signal: AbortSignal,
  ) {
    const traceId = reportWorkflowTraceId(target.artifactVersionId, target.contentHash);
    const graph = buildReportWorkflow({
      target,
      preflightPort: { preflight: () => Promise.resolve(preflight) },
      checkpointer: this.saver!,
      forceBlock,
      spanSink: new ReportWorkflowTraceSpanSink(this.traces, {
        workspaceId: target.workspaceId,
        threadId: target.sourceThreadId,
        traceId,
        artifactId: target.artifactId,
        artifactVersionId: target.artifactVersionId,
      }),
    });
    return { graph, traceId, config: { configurable: { thread_id: traceId }, signal } };
  }

  private async finish(
    traceId: string,
    target: ReportWorkflowTarget,
    decision: ReportShadowDecision,
    realCanExport: boolean,
  ): Promise<ReportWorkflowShadowResult> {
    const exactParity = shadowPromotionParityHolds(decision, realCanExport);
    await this.recordParity(traceId, target, decision, realCanExport, exactParity);
    return { status: 'completed', traceId, decision, exactParity };
  }

  private async completed(
    traceId: string,
    target: ReportWorkflowTarget,
    decision: ReportShadowDecision,
    realCanExport: boolean,
  ): Promise<ReportWorkflowShadowResult> {
    const exactParity = shadowPromotionParityHolds(decision, realCanExport);
    await this.recordParity(traceId, target, decision, realCanExport, exactParity);
    return { status: 'completed', traceId, decision, exactParity };
  }

  private async recordParity(
    traceId: string,
    target: ReportWorkflowTarget,
    decision: ReportShadowDecision,
    realCanExport: boolean,
    exactParity: boolean,
  ): Promise<void> {
    const parityKey = createHash('sha256')
      .update(`${traceId}:${decision}:${realCanExport}:${exactParity}`)
      .digest('hex');
    if (this.recordedParity.has(parityKey)) return;
    await this.traces.recordSpan({
      workspaceId: target.workspaceId,
      threadId: target.sourceThreadId,
      traceId,
      spanKind: 'artifact_gate',
      name: 'report_workflow.parity',
      status: exactParity ? 'ok' : 'error',
      input: null,
      output: { decision, realCanExport, exactParity },
      metadata: {
        runKind: 'report_workflow_shadow',
        artifactId: target.artifactId,
        artifactVersionId: target.artifactVersionId,
        contentHash: target.contentHash,
        parityKey,
      },
    });
    this.recordedParity.add(parityKey);
  }
}

export function reportWorkflowTraceId(artifactVersionId: string, contentHash: string): string {
  return `report-shadow-v2-${createHash('sha256').update(`v2:${artifactVersionId}:${contentHash}`).digest('hex').slice(0, 32)}`;
}

function reportWorkflowOperationFingerprint(
  kind: 'observe' | 'resume',
  preflight: ArtifactExportPreflightResponse,
  decision: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ kind, preflight, decision }))
    .digest('hex');
}

function requiresExplicitHumanReview(preflight: ArtifactExportPreflightResponse): boolean {
  return preflight.messages.length > 0 || preflight.redTeam.verdict === 'PASS_WITH_WARNINGS';
}

function isFinalHardBlock(
  realCanExport: boolean,
  finalReason: ArtifactExportPreflightResponse['reason'],
): boolean {
  return !realCanExport && finalReason !== 'HUMAN_REVIEW_REQUIRED';
}

function isInterrupted(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && '__interrupt__' in value);
}

function hasDecision(value: unknown): value is { shadowDecision: ReportShadowDecision } {
  if (!value || typeof value !== 'object') return false;
  const decision = (value as { shadowDecision?: unknown }).shadowDecision;
  return decision === 'would_publish' || decision === 'would_block';
}

function disabledResult(): ReportWorkflowShadowResult {
  return { status: 'disabled', traceId: null, decision: null, exactParity: null };
}
function degradedResult(): ReportWorkflowShadowResult {
  return { status: 'degraded', traceId: null, decision: null, exactParity: null };
}
function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : 'unknown error';
}
