import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Inject, Logger, NotFoundException, Optional, Param, Post, PreconditionFailedException, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import {
  AddEvidenceRequestSchema,
  ChatApprovalResponseRequestSchema,
  ChatRunActionRequestSchema,
  ChatRunActionResponseSchema,
  ChatRunStatusResponseSchema,
  ChatRuntimeCapabilitiesResponseSchema,
  ChatRuntimeModelsResponseSchema,
  ChatStreamEventSchema,
  ChatStreamRequestSchema,
  ArtifactVersionDecisionAnalyticsResponseSchema,
  DecisionAnalyticsRunResponseSchema,
  EvidenceDecisionSummaryResponseSchema,
  EvidenceDecisionSummaryV2ResponseSchema,
  EvidenceDecisionSummaryV3ResponseSchema,
  ListRetrievalHitFeedbackResponseSchema,
  ListEvidenceResponseSchema,
  ListMessagesPageRequestSchema,
  ListMessagesPageResponseSchema,
  ListMessagesResponseSchema,
  OkResponseSchema,
  ReviewQueueDecisionRequestSchema,
  ReviewQueueFilterSchema,
  ReviewQueueResponseSchema,
  RunDecisionAnalyticsRequestSchema,
  RecordRetrievalHitFeedbackRequestSchema,
  SearchMessagesRequestSchema,
  SearchMessagesResponseSchema,
} from '@consulting/contracts';
import { AccessTokenGuard, requireAuthUserId, type AuthenticatedRequest } from '../auth/access-token.guard.js';
import { parseBody, parseResponse } from '../http/contract-adapter.js';
import { redactLogText } from '../security/redact-sensitive-text.js';
import { ChatStreamUseCase } from './chat-stream.usecase.js';
import { HermesRunsClient } from './hermes-runs-client.js';
import { ChatMessageStore, type FinishState } from './chat-message.store.js';
import { captureToolEvidence, EvidenceStore, type CapturedToolUse } from './evidence.store.js';
import { SpaceAccessService, type SpaceAccess } from '../spaces/space-access.service.js';
import { EvidenceDecisionStore } from '../consulting/evidence-decision.store.js';
import { DecisionAnalyticsSourceIntegrityError } from '../consulting/decision-analytics-audit.js';
import { ConsultingMemoryContextBuilder } from '../consulting/consulting-memory-context.builder.js';
import { RuntimeApprovalStore } from './runtime-approval.store.js';
import { ChatTurnIdempotencyConflictError, ChatTurnSettlementStore, type ChatTurnSettlementRecord } from './chat-turn-settlement.store.js';
import { ChatCheckpointCoalescer } from './chat-checkpoint-coalescer.js';
import { PublicChatStreamSanitizer, sanitizePublicChatText } from './public-chat-content.js';
import { ConsultingInsightShadowStore } from '../consulting/consulting-insight-shadow.store.js';
import { routeConsultingInsightIntent } from '../consulting/consulting-insight-intent.js';
import { ENV_TOKEN } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';

const PREPARATION_ABORT_DRAIN_MS = 250;
// Non-blocking memory budget: cap how long the consulting brain may delay a turn.
// Observed recall p50≈5s/max≈5.2s, so 6s lets healthy recall through while a hung
// brain degrades to empty context instead of stalling the user's answer.
const MEMORY_CONTEXT_BUDGET_MS = 6_000;

@Controller('chat')
export class ChatStreamController {
  private readonly logger = new Logger(ChatStreamController.name);

  constructor(
    @Inject(ChatStreamUseCase) private readonly chatStreamUseCase: ChatStreamUseCase,
    @Inject(HermesRunsClient) private readonly hermesRunsClient: HermesRunsClient,
    @Inject(ChatMessageStore) private readonly messages: ChatMessageStore,
    @Inject(EvidenceStore) private readonly evidence: EvidenceStore,
    @Inject(SpaceAccessService) private readonly access: SpaceAccessService,
    @Inject(EvidenceDecisionStore) private readonly evidenceDecision: EvidenceDecisionStore,
    @Inject(ConsultingMemoryContextBuilder) private readonly memoryContext: ConsultingMemoryContextBuilder,
    @Inject(RuntimeApprovalStore) private readonly approvals: RuntimeApprovalStore,
    @Inject(ChatTurnSettlementStore) private readonly settlements: ChatTurnSettlementStore,
    @Optional() @Inject(ConsultingInsightShadowStore) private readonly insightShadow?: ConsultingInsightShadowStore,
    @Optional() @Inject(ENV_TOKEN) private readonly env?: Env,
  ) {}

  private setSseHeaders(res: Response): void {
    res.status(200);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
  }

  private clientRequestHash(cmd: {
    threadId: string;
    message: string;
    model?: string | undefined;
    attachmentIds?: string[] | undefined;
  }): string {
    const canonical = JSON.stringify({
      threadId: cmd.threadId,
      message: cmd.message,
      model: cmd.model ?? null,
      attachmentIds: [...(cmd.attachmentIds ?? [])].sort(),
    });
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }

  private replaySettlement(res: Response, settlement: ChatTurnSettlementRecord): void {
    this.setSseHeaders(res);
    const write = (event: unknown) => {
      const parsed = ChatStreamEventSchema.parse(event);
      res.write(`event: ${parsed.type}\n`);
      res.write(`data: ${JSON.stringify(parsed)}\n\n`);
    };
    if (settlement.runId) {
      write({
        type: 'start',
        runId: settlement.runId,
        threadId: settlement.threadId,
        ts: new Date().toISOString(),
      });
      if (settlement.assistantText) {
        write({ type: 'delta', runId: settlement.runId, text: sanitizePublicChatText(settlement.assistantText) });
      }
    }
    if (settlement.finishState === 'complete' && settlement.runId) {
      write({ type: 'done', runId: settlement.runId });
    } else {
      write({
        type: 'error',
        ...(settlement.runId ? { runId: settlement.runId } : {}),
        code: settlement.status === 'capturing' ? 'CHAT_TURN_IN_PROGRESS' : 'CHAT_TURN_REPLAYED_FAILURE',
        message: settlement.status === 'capturing'
          ? '같은 요청을 이미 처리하고 있습니다. 잠시 후 대화 기록을 확인해주세요.'
          : '이 요청은 이전에 중단되었거나 실패했습니다. 대화 기록을 확인해주세요.',
      });
    }
    res.end();
  }

  /** Search persisted transcript rows inside a readable thread (J-1). */
  @Get('threads/:threadId/messages/search')
  @UseGuards(AccessTokenGuard)
  async searchMessages(
    @Param('threadId') threadId: string,
    @Query('q') q: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = requireAuthUserId(req);
    await this.requireThreadRead(userId, threadId);
    const parsed = SearchMessagesRequestSchema.safeParse({
      q,
      ...(limitRaw !== undefined ? { limit: Number(limitRaw) } : {}),
    });
    if (!parsed.success) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Invalid message search query' });
    }
    return parseResponse(SearchMessagesResponseSchema, await this.messages.searchMessages(threadId, parsed.data.q, parsed.data.limit));
  }

  /** Persisted transcript for a thread (N-1). */
  @Get('threads/:threadId/messages')
  @UseGuards(AccessTokenGuard)
  async list(
    @Param('threadId') threadId: string,
    @Query('page') pageRaw: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @Query('before') before: string | undefined,
    @Query('after') after: string | undefined,
    @Query('around') around: string | undefined,
    @Query('direction') direction: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = requireAuthUserId(req);
    await this.requireThreadRead(userId, threadId);
    const wantsPage = [pageRaw, limitRaw, before, after, around, direction].some((v) => v !== undefined);
    if (wantsPage) {
      const parsedResult = ListMessagesPageRequestSchema.safeParse({
        ...(limitRaw !== undefined ? { limit: Number(limitRaw) } : {}),
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(around !== undefined ? { around } : {}),
        ...(direction !== undefined ? { direction } : {}),
      });
      if (!parsedResult.success) {
        throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Invalid message page query' });
      }
      const parsed = parsedResult.data;
      return parseResponse(ListMessagesPageResponseSchema, await this.messages.listMessagesPage(threadId, parsed));
    }
    return parseResponse(ListMessagesResponseSchema, await this.messages.listMessages(threadId));
  }

  /** Evidence collected for a thread (Phase 2-A). */
  @Get('threads/:threadId/evidence')
  @UseGuards(AccessTokenGuard)
  async listEvidence(@Param('threadId') threadId: string, @Req() req: AuthenticatedRequest) {
    const userId = requireAuthUserId(req);
    await this.requireThreadRead(userId, threadId);
    return parseResponse(ListEvidenceResponseSchema, await this.evidence.listForThread(threadId));
  }

  /**
   * #6: project-scoped evidence — aggregate a project's evidence across all its
   * channels. Access gated by projectMember; the store enforces the F9 parent
   * deletedAt guard so deleted channels' evidence never leaks.
   */
  @Get('projects/:projectId/evidence')
  @UseGuards(AccessTokenGuard)
  async listProjectEvidence(@Param('projectId') projectId: string, @Req() req: AuthenticatedRequest) {
    const userId = requireAuthUserId(req);
    this.throwIfDenied(await this.access.projectMember(userId, projectId));
    return parseResponse(ListEvidenceResponseSchema, await this.evidence.listForProject(projectId));
  }

  /** Evidence-to-Decision summary for the active thread right panel. */
  @Get('threads/:threadId/evidence-decision/summary')
  @UseGuards(AccessTokenGuard)
  async evidenceDecisionSummary(
    @Param('threadId') threadId: string,
    @Query('includeJudgment') includeJudgment: string | undefined,
    @Query('includeAnalytics') includeAnalytics: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.requireThreadRead(requireAuthUserId(req), threadId);
    if (includeAnalytics === '1') {
      return parseResponse(EvidenceDecisionSummaryV3ResponseSchema, await this.evidenceDecision.summaryV3(threadId));
    }
    if (includeJudgment === '1') {
      return parseResponse(EvidenceDecisionSummaryV2ResponseSchema, await this.evidenceDecision.summaryV2(threadId));
    }
    return parseResponse(EvidenceDecisionSummaryResponseSchema, await this.evidenceDecision.summary(threadId));
  }

  /** Run immutable MCDA sensitivity and optional multiplicative KRW impact analysis. */
  @Post('threads/:threadId/decision-analytics')
  @UseGuards(AccessTokenGuard)
  async runDecisionAnalytics(
    @Param('threadId') threadId: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = requireAuthUserId(req);
    const cmd = parseBody(RunDecisionAnalyticsRequestSchema, body);
    const access = await this.requireThreadSend(userId, threadId);
    const artifactScope = cmd.artifactVersionId
      ? await this.requireDecisionAnalyticsArtifactAccess(
          userId,
          threadId,
          cmd.artifactVersionId,
          access.workspaceId,
          access.projectId,
        )
      : null;
    if (artifactScope && (!artifactScope.scorecard || cmd.scorecardId !== artifactScope.scorecard.id)) {
      throw new PreconditionFailedException({
        code: 'PRECONDITION',
        message: 'Artifact version is not linked to the requested decision scorecard',
      });
    }
    try {
      const run = await this.evidenceDecision.runDecisionAnalytics({
        workspaceId: access.workspaceId,
        threadId,
        actorUserId: userId,
        ...(artifactScope ? {
          artifactProjectId: artifactScope.projectId,
          artifactScorecardId: artifactScope.scorecard!.id,
        } : {}),
        request: cmd,
      });
      if (!run) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Decision scorecard not found' });
      return parseResponse(DecisionAnalyticsRunResponseSchema, { run });
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      if (error instanceof DecisionAnalyticsSourceIntegrityError) {
        throw new ConflictException({
          code: 'CONFLICT',
          message: 'Decision scorecard inputs are inconsistent; regenerate the scorecard',
        });
      }
      if (isDecisionAnalyticsActorMembershipError(error)) {
        throw new NotFoundException({
          code: 'NOT_FOUND',
          message: 'Decision analytics actor is no longer available',
        });
      }
      if (isDecisionAnalyticsConflictError(error)) {
        throw new ConflictException({ code: 'CONFLICT', message: 'Decision analytics inputs changed; retry' });
      }
      if (error instanceof RangeError) {
        throw new BadRequestException({ code: 'VALIDATION', message: error.message });
      }
      throw error;
    }
  }

  /** Read analytics bound to one immutable artifact version without changing its body. */
  @Get('threads/:threadId/decision-analytics/artifact-versions/:artifactVersionId')
  @UseGuards(AccessTokenGuard)
  async artifactVersionDecisionAnalytics(
    @Param('threadId') threadId: string,
    @Param('artifactVersionId') artifactVersionId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = requireAuthUserId(req);
    const access = await this.requireThreadRead(userId, threadId);
    const artifactScope = await this.requireDecisionAnalyticsArtifactAccess(
      userId,
      threadId,
      artifactVersionId,
      access.workspaceId,
      access.projectId,
    );
    const latestRun = await this.evidenceDecision.latestDecisionAnalyticsForArtifactVersion(threadId, artifactVersionId);
    return parseResponse(ArtifactVersionDecisionAnalyticsResponseSchema, {
      supported: true,
      latestRun,
      lineageStatus: artifactScope.scorecard ? 'resolved' : 'unavailable',
      scorecard: artifactScope.scorecard,
    });
  }

  /** Latest GraphRAG retrieval hits for one-click relevance/failure labeling. */
  @Get('threads/:threadId/retrieval-hits')
  @UseGuards(AccessTokenGuard)
  async listRetrievalHits(@Param('threadId') threadId: string, @Req() req: AuthenticatedRequest) {
    const access = await this.requireThreadRead(requireAuthUserId(req), threadId);
    return parseResponse(ListRetrievalHitFeedbackResponseSchema, await this.evidenceDecision.listRetrievalHits({
      workspaceId: access.workspaceId,
      threadId,
    }));
  }

  /** Record a human relevance judgment; a negative judgment requires one taxonomy label. */
  @Post('threads/:threadId/retrieval-hits/:hitId/feedback')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  async recordRetrievalHitFeedback(
    @Param('threadId') threadId: string,
    @Param('hitId') hitId: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    const cmd = parseBody(RecordRetrievalHitFeedbackRequestSchema, body);
    const access = await this.requireThreadSend(requireAuthUserId(req), threadId);
    const ok = await this.evidenceDecision.recordRetrievalHitFeedback({
      workspaceId: access.workspaceId,
      threadId,
      hitId,
      judgedRelevant: cmd.judgedRelevant,
      failureType: cmd.failureType ?? null,
    });
    if (!ok) throw new NotFoundException({ code: 'RETRIEVAL_HIT_NOT_FOUND', message: 'Retrieval hit not found' });
    return parseResponse(OkResponseSchema, { ok: true });
  }

  /** Active review queue ordered by decision impact × uncertainty × evidence gap. */
  @Get('threads/:threadId/review-queue')
  @UseGuards(AccessTokenGuard)
  async reviewQueue(
    @Param('threadId') threadId: string,
    @Query('kind') kind: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const filter = parseBody(ReviewQueueFilterSchema, kind ?? 'all');
    await this.requireThreadRead(requireAuthUserId(req), threadId);
    return parseResponse(ReviewQueueResponseSchema, await this.evidenceDecision.reviewQueue(threadId, 30, filter));
  }

  /** Resolve/ignore one active review item after an operator has handled it. */
  @Post('threads/:threadId/review-queue/:itemId/decision')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  async decideReviewQueueItem(
    @Param('threadId') threadId: string,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    const cmd = parseBody(ReviewQueueDecisionRequestSchema, body);
    await this.requireThreadSend(requireAuthUserId(req), threadId);
    const ok = await this.evidenceDecision.decideReviewItem({
      threadId,
      itemId,
      action: cmd.action,
      note: cmd.note ?? null,
    });
    if (!ok) throw new NotFoundException({ code: 'REVIEW_ITEM_NOT_FOUND', message: 'Review item not found' });
    return parseResponse(OkResponseSchema, { ok: true });
  }

  /** Manual evidence attach (Phase 2-A E-3). */
  @Post('evidence')
  @UseGuards(AccessTokenGuard)
  async addEvidence(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(AddEvidenceRequestSchema, body);
    const userId = requireAuthUserId(req);
    const access = await this.requireThreadSend(userId, cmd.threadId);
    await this.evidence.addManual({
      workspaceId: access.workspaceId,
      threadId: cmd.threadId,
      messageId: cmd.messageId ?? null,
      sourceType: cmd.sourceType,
      ref: cmd.ref,
      excerpt: cmd.excerpt,
      url: cmd.url ?? null,
      addedByUserId: userId,
    });
    return parseResponse(OkResponseSchema, { ok: true });
  }

  /** Hermes runtime model routes for the web model picker. */
  @Get('runtime/models')
  @UseGuards(AccessTokenGuard)
  async runtimeModels() {
    return parseResponse(ChatRuntimeModelsResponseSchema, await this.hermesRunsClient.listModels());
  }

  /** Machine-readable runtime feature flags; no secrets are exposed. */
  @Get('runtime/capabilities')
  @UseGuards(AccessTokenGuard)
  async runtimeCapabilities() {
    return parseResponse(ChatRuntimeCapabilitiesResponseSchema, await this.hermesRunsClient.capabilities());
  }

  /** Poll a run after checking that the requester can read the owning thread. */
  @Get('runtime/runs/:runId')
  @UseGuards(AccessTokenGuard)
  async runtimeRunStatus(
    @Param('runId') runId: string,
    @Query('threadId') threadId: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const parsed = ChatRunActionRequestSchema.safeParse({ threadId });
    if (!parsed.success) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Invalid run status query' });
    const access = await this.requireThreadRead(requireAuthUserId(req), parsed.data.threadId);
    await this.requireRuntimeRunBinding(runId, parsed.data.threadId, access.workspaceId);
    return parseResponse(ChatRunStatusResponseSchema, await this.hermesRunsClient.runStatus(runId));
  }

  /** Stop an in-flight Hermes run, scoped by thread access. */
  @Post('runtime/runs/:runId/stop')
  @UseGuards(AccessTokenGuard)
  async stopRuntimeRun(@Param('runId') runId: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(ChatRunActionRequestSchema, body);
    const access = await this.requireThreadSend(requireAuthUserId(req), cmd.threadId);
    await this.requireRuntimeRunBinding(runId, cmd.threadId, access.workspaceId);
    return parseResponse(ChatRunActionResponseSchema, await this.hermesRunsClient.stopRun(runId));
  }

  /** Resolve a host-side command approval emitted by Hermes Runs SSE. */
  @Post('runtime/runs/:runId/approval')
  @UseGuards(AccessTokenGuard)
  async approveRuntimeRun(@Param('runId') runId: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(ChatApprovalResponseRequestSchema, body);
    const userId = requireAuthUserId(req);
    const access = await this.requireThreadSend(userId, cmd.threadId);
    if (cmd.choice === 'always') {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Approval choice "always" requires durable product policy registry support' });
    }
    if (cmd.resolveAll) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Approval resolveAll requires durable product policy registry support' });
    }
    if (cmd.choice !== 'deny') {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Positive approval requires an action-bound upstream approval protocol' });
    }
    const decision = await this.approvals.decideRuntimeApproval({
      approvalId: cmd.approvalId,
      workspaceId: access.workspaceId,
      threadId: cmd.threadId,
      requestedByUserId: userId,
      runId,
      choice: cmd.choice,
    });
    if (!decision.ok) {
      if (decision.reason === 'not_found') {
        throw new NotFoundException({ code: 'APPROVAL_NOT_FOUND', message: 'Approval request not found' });
      }
      throw new BadRequestException({ code: 'APPROVAL_NOT_DECIDABLE', message: `Approval request is not decidable: ${decision.reason}` });
    }
    let response: unknown;
    try {
      response = await this.hermesRunsClient.respondApproval(runId, cmd.choice, cmd.resolveAll);
    } catch (error) {
      const statusMatch = error instanceof Error ? error.message.match(/\((\d{3})\)$/u) : null;
      const status = statusMatch?.[1] ? Number(statusMatch[1]) : null;
      const deliveryStatus = status !== null && status >= 400 && status < 500 && status !== 408
        ? 'failed' as const
        : 'ambiguous' as const;
      await this.approvals.markRuntimeApprovalDelivery({
        approvalId: cmd.approvalId,
        workspaceId: access.workspaceId,
        runId,
        status: deliveryStatus,
      }).catch(() => undefined);
      throw error;
    }
    await this.approvals.markRuntimeApprovalDelivery({
      approvalId: cmd.approvalId,
      workspaceId: access.workspaceId,
      runId,
      status: 'delivered',
    });
    return parseResponse(ChatRunActionResponseSchema, response);
  }

  @Post('stream')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  async stream(@Body() body: unknown, @Req() req: AuthenticatedRequest, @Res() res: Response) {
    const cmd = parseBody(ChatStreamRequestSchema, body);
    const userId = requireAuthUserId(req);
    const access = await this.requireThreadSend(userId, cmd.threadId);

    const runMessage = cmd.message.trim() || '첨부 파일을 확인해주세요.';
    const runtimeStartedAt = Date.now();
    let firstSseAt: number | null = null;
    let sseEvents = 0;
    const writeSse = (event: string, payload: string): void => {
      firstSseAt ??= Date.now();
      sseEvents += 1;
      res.write(`event: ${event}\n`);
      res.write(`data: ${payload}\n\n`);
    };

    // The browser idempotency key, user row, assistant capture row, and ledger are
    // created atomically before any Hermes run or SSE byte can escape.
    const userMessageId = randomUUID();
    const settlementId = randomUUID();
    const assistantMessageId = randomUUID();
    let assistantText = '';
    const publicStream = new PublicChatStreamSanitizer();
    let runId: string | null = null;
    let finishState: FinishState = 'error';
    let upstreamTerminalState: FinishState | null = null;
    let settled = false;
    let settleInFlight: Promise<void> | null = null;
    let clientAborted = false;
    let insightShadowId: string | undefined;
    const upstreamAbort = new AbortController();
    const toolUses: CapturedToolUse[] = [];
    const captureSettlement = (terminalFinishState = finishState) => ({
      settlementId,
      assistantMessageId,
      userMessageId,
      workspaceId: access.workspaceId,
      threadId: cmd.threadId,
      requestedByUserId: userId,
      userPrompt: runMessage,
      userText: cmd.message,
      assistantText: sanitizePublicChatText(assistantText),
      runId,
      finishState: terminalFinishState,
      toolUses: toolUses.map((item) => ({ ...item })),
      attachmentIds: cmd.attachmentIds ?? [],
      ...(insightShadowId ? { insightShadowId } : {}),
      ...(cmd.clientMessageId
        ? {
            clientMessageId: cmd.clientMessageId,
            clientRequestHash: this.clientRequestHash(cmd),
          }
        : {}),
    });
    let terminalSnapshot: ReturnType<typeof captureSettlement> | null = null;
    let capture;
    try {
      capture = await this.settlements.beginCapture(captureSettlement('error'));
    } catch (error) {
      if (error instanceof ChatTurnIdempotencyConflictError) {
        throw new ConflictException('동일한 요청 ID를 다른 대화 내용에 재사용할 수 없습니다.');
      }
      throw error;
    }
    if (capture.state === 'existing') {
      this.replaySettlement(res, capture.settlement);
      return;
    }
    const captureLeaseToken = capture.leaseToken;
    const enabledThreads = new Set((this.env?.CONSULTING_INSIGHT_WEB_SHADOW_THREAD_IDS ?? '')
      .split(',').map((value) => value.trim()).filter(Boolean));
    const policyHash = this.env?.CONSULTING_INSIGHT_POLICY_HASH ?? '';
    const insightIntent = routeConsultingInsightIntent(runMessage);
    if (
      this.env?.CONSULTING_INSIGHT_WEB_SHADOW_MODE === 'shadow'
      && enabledThreads.has(cmd.threadId)
      && /^[a-f0-9]{64}$/u.test(policyHash)
      && this.insightShadow
      && insightIntent.decision === 'analysis'
    ) {
      try {
        const accepted = await this.insightShadow.accept({
          settlementId,
          userMessageId,
          workspaceId: access.workspaceId,
          threadId: cmd.threadId,
          intentDecision: insightIntent.decision,
          intentConfidence: insightIntent.confidence,
          sourceMessageHash: createHash('sha256').update(cmd.message, 'utf8').digest('hex'),
          policyHash,
        });
        if (accepted.state === 'accepted' || accepted.state === 'existing') insightShadowId = accepted.id;
      } catch (error) {
        this.logger.warn(`consulting insight shadow acceptance failed: ${redactLogText(error instanceof Error ? error.message : String(error))}`);
      }
    }
    this.setSseHeaders(res);
    let captureLeaseFailure: unknown;
    const checkpoints = new ChatCheckpointCoalescer<ReturnType<typeof captureSettlement>>(
      async (snapshot) => await this.settlements.checkpointCapture(snapshot, captureLeaseToken),
      {
        intervalMs: 300,
        maxBufferedBytes: 2_048,
        onError: (error) => {
          if (captureLeaseFailure !== undefined) return;
          captureLeaseFailure = error ?? new Error('chat checkpoint failed');
          upstreamAbort.abort();
        },
      },
    );
    const captureHeartbeat = setInterval(() => {
      void this.settlements.heartbeatCapture(settlementId, captureLeaseToken).then((alive) => {
        if (alive || captureLeaseFailure !== undefined) return;
        captureLeaseFailure = new Error('chat capture lease lost');
        upstreamAbort.abort();
      }).catch((error: unknown) => {
        if (captureLeaseFailure !== undefined) return;
        captureLeaseFailure = error ?? new Error('chat capture heartbeat failed');
        upstreamAbort.abort();
      });
    }, 30_000);
    captureHeartbeat.unref();
    const persist = async (snapshot = terminalSnapshot ?? captureSettlement()) => {
      if (settled) return;
      if (settleInFlight) return settleInFlight;
      terminalSnapshot ??= snapshot;
      settleInFlight = (async () => {
        try {
          await checkpoints.close();
        } catch (error) {
          captureLeaseFailure ??= error;
        }
        await this.settlements.finalizeCapture(terminalSnapshot, captureLeaseToken);
        settled = true;
      })()
        .catch((err: unknown) => {
          const message = redactLogText(err instanceof Error ? err.message : String(err));
          this.logger.warn(`chat settlement request failed: ${message}`);
          throw err;
        })
        .finally(() => {
          settleInFlight = null;
        });
      await settleInFlight;
    };
    res.on('close', () => {
      if (res.writableEnded || clientAborted) return;
      clientAborted = true;
      finishState = upstreamTerminalState ?? 'cancelled';
      upstreamAbort.abort();
      void persist(captureSettlement(finishState)).catch(() => undefined);
    });

    let pendingDonePayload: string | null = null;
    let streamFailure: unknown;
    let memoryMs: number | null = null;
    let preflightMs: number | null = null;
    let preparationMs: number | null = null;
    try {
      const preparationStartedAt = Date.now();
      const memoryBundlePromise = (typeof this.memoryContext.buildBundle === 'function'
        ? this.memoryContext.buildBundle({ threadId: cmd.threadId, query: runMessage, signal: upstreamAbort.signal, budgetMs: MEMORY_CONTEXT_BUDGET_MS })
        : this.memoryContext.build({ threadId: cmd.threadId, query: runMessage, signal: upstreamAbort.signal, budgetMs: MEMORY_CONTEXT_BUDGET_MS }).then((context) => ({
            context,
            scope: null,
            retrieval: null,
            shadowEligible: false,
            ineligibleReason: 'builder_error' as const,
          }))).then((bundle) => {
            memoryMs = Math.max(0, Date.now() - preparationStartedAt);
            return bundle;
          });
      const preparedRunPromise = (typeof this.hermesRunsClient.prepareChatRun === 'function'
        ? this.hermesRunsClient.prepareChatRun(access.workspaceId, upstreamAbort.signal)
        : Promise.resolve(undefined)).then((prepared) => {
          preflightMs = Math.max(0, Date.now() - preparationStartedAt);
          return prepared;
        });
      const preparationTasks = [memoryBundlePromise, preparedRunPromise] as const;
      const settledPreparation = Promise.allSettled(preparationTasks);
      let preparation;
      try {
        preparation = await Promise.all(preparationTasks);
      } catch (error) {
        upstreamAbort.abort(error);
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          settledPreparation,
          new Promise<void>((resolve) => {
            drainTimer = setTimeout(resolve, PREPARATION_ABORT_DRAIN_MS);
            drainTimer.unref?.();
          }),
        ]);
        if (drainTimer) clearTimeout(drainTimer);
        throw error;
      }
      const [memoryBundle, preparedRun] = preparation;
      preparationMs = Math.max(0, Date.now() - preparationStartedAt);
      const graphRagContext = memoryBundle.context;
      if (
        insightShadowId
        && this.insightShadow
        && memoryBundle.shadowEligible
        && memoryBundle.scope?.workspaceId === access.workspaceId
        && memoryBundle.scope.threadId === cmd.threadId
        && memoryBundle.retrieval
      ) {
        try {
          const attached = await this.insightShadow.attachRetrieval(insightShadowId, {
            retrievalRunId: memoryBundle.retrieval.runId,
            retrievalSnapshotHash: memoryBundle.retrieval.snapshotHash,
          });
          if (!attached) this.logger.warn('consulting insight shadow retrieval attachment rejected');
        } catch (error) {
          this.logger.warn(`consulting insight shadow retrieval attachment failed: ${redactLogText(error instanceof Error ? error.message : String(error))}`);
        }
      }
      const runScope: { workspaceId: string; projectId: string; memoryContext?: string } = {
        workspaceId: access.workspaceId,
        projectId: access.projectId,
      };
      if (graphRagContext) runScope.memoryContext = graphRagContext;
      for await (const event of this.hermesRunsClient.streamChat(
        { ...cmd, message: runMessage },
        runScope,
        upstreamAbort.signal,
        preparedRun,
      )) {
        if (clientAborted) break;
        const parsed = ChatStreamEventSchema.parse(event);
        let outbound = parsed;
        if (parsed.type === 'approval') {
          const approval = await this.withAbort(this.approvals.createRuntimeApproval({
            workspaceId: access.workspaceId,
            threadId: cmd.threadId,
            requestedByUserId: userId,
            runId: parsed.runId,
            ...(parsed.command ? { command: parsed.command } : {}),
            ...(parsed.message ? { message: parsed.message } : {}),
            ...(parsed.risk ? { risk: parsed.risk } : {}),
            ...(parsed.toolId ? { toolId: parsed.toolId } : {}),
            choices: parsed.choices,
          }), upstreamAbort.signal);
          if (clientAborted || res.writableEnded) break;
          outbound = { ...parsed, approvalId: approval.approvalId };
        }
        let captureChanged = false;
        if (parsed.type === 'start') {
          runId = parsed.runId;
          captureChanged = true;
        }
        if (parsed.type === 'delta') {
          assistantText += parsed.text;
          outbound = { ...parsed, text: publicStream.push(parsed.text) };
          captureChanged = true;
        }
        if (parsed.type === 'tool') {
          captureToolEvidence(toolUses, parsed);
          captureChanged = true;
        }
        if (parsed.type === 'error') {
          finishState = 'error';
          upstreamTerminalState = 'error';
          captureChanged = true;
        }
        if (parsed.type === 'done') {
          finishState = 'complete';
          upstreamTerminalState = 'complete';
          pendingDonePayload = JSON.stringify(outbound);
          continue;
        }
        const checkpointBytes = parsed.type === 'delta' ? Buffer.byteLength(parsed.text, 'utf8') : 0;
        if (outbound.type === 'delta' && outbound.text.length === 0) {
          if (captureChanged) checkpoints.schedule(captureSettlement(), checkpointBytes);
          continue;
        }
        if (res.writableEnded) break;
        writeSse(outbound.type, JSON.stringify(outbound));
        if (captureChanged) {
          checkpoints.schedule(captureSettlement(), checkpointBytes);
          if (parsed.type === 'tool' || parsed.type === 'error') await checkpoints.flush();
        }
      }
    } catch (error) {
      if (!clientAborted) streamFailure = captureLeaseFailure ?? error;
    }
    if (!clientAborted && !streamFailure && upstreamTerminalState === null) {
      streamFailure = new Error('Hermes stream ended without a terminal event');
    }
    if (captureLeaseFailure && !clientAborted && !streamFailure) {
      streamFailure = captureLeaseFailure;
    }
    const trailingPublicText = publicStream.flush();
    if (trailingPublicText && runId && !clientAborted && !res.writableEnded) {
      const trailingEvent = ChatStreamEventSchema.parse({ type: 'delta', runId, text: trailingPublicText });
      writeSse('delta', JSON.stringify(trailingEvent));
    }

    let settlementFailure: unknown;
    try {
      await persist();
    } catch (error) {
      settlementFailure = error;
      if (!clientAborted && !res.writableEnded) {
        writeSse('error', JSON.stringify({
          type: 'error',
          ...(runId ? { runId } : {}),
          code: 'CHAT_SETTLEMENT_FAILED',
          message: '답변을 안전하게 저장하지 못했습니다. 다시 시도해주세요.',
        }));
        res.end();
      }
    }
    if (
      !settlementFailure
      && upstreamTerminalState === 'complete'
      && captureLeaseFailure !== undefined
      && streamFailure === captureLeaseFailure
    ) {
      streamFailure = undefined;
    }
    clearInterval(captureHeartbeat);
    if (!settlementFailure && !clientAborted && !res.writableEnded) {
      if (streamFailure) {
        writeSse('error', JSON.stringify({
          type: 'error',
          ...(runId ? { runId } : {}),
          code: 'CHAT_STREAM_FAILED',
          message: '응답 준비 또는 전송 중 오류가 발생했습니다. 다시 시도해주세요.',
        }));
      } else if (pendingDonePayload) {
        writeSse('done', pendingDonePayload);
      }
      res.end();
    }
    this.logger.log(JSON.stringify({
      event: 'chat_stream_runtime',
      settlementId,
      totalMs: Math.max(0, Date.now() - runtimeStartedAt),
      preparationMs,
      memoryMs,
      preflightMs,
      firstSseMs: firstSseAt === null ? null : Math.max(0, firstSseAt - runtimeStartedAt),
      sseEvents,
      checkpointScheduled: checkpoints.stats.scheduled,
      checkpointWrites: checkpoints.stats.writes,
      checkpointFailed: captureLeaseFailure !== undefined,
      finishState,
      clientAborted,
      streamFailed: Boolean(streamFailure),
      settlementFailed: Boolean(settlementFailure),
    }));
    if (settlementFailure) {
      if (settlementFailure instanceof Error) throw settlementFailure;
      throw new Error('chat settlement failed');
    }
    if (streamFailure) {
      const rawMessage = streamFailure instanceof Error
        ? streamFailure.message
        : typeof streamFailure === 'string'
          ? streamFailure
          : 'unknown stream failure';
      const message = redactLogText(rawMessage);
      this.logger.warn(`chat stream failed after capture: ${message}`);
    }
  }

  private async withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw this.abortReason(signal);
    let onAbort: (() => void) | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        onAbort = () => reject(this.abortReason(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        operation.then(resolve, reject);
      });
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  private abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Chat stream aborted', 'AbortError');
  }

  private async requireRuntimeRunBinding(runId: string, threadId: string, workspaceId: string): Promise<void> {
    const owner = await this.settlements.findOwnershipByRunId(runId);
    if (!owner || owner.threadId !== threadId || owner.workspaceId !== workspaceId) {
      throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Run not found' });
    }
  }

  private async requireDecisionAnalyticsArtifactAccess(
    userId: string,
    threadId: string,
    artifactVersionId: string,
    expectedWorkspaceId: string,
    expectedProjectId: string,
  ): Promise<{
    workspaceId: string;
    projectId: string;
    scorecard: { id: string; question: string; createdAt: string } | null;
  }> {
    const scope = await this.evidenceDecision.decisionAnalyticsArtifactScope(threadId, artifactVersionId);
    if (
      !scope
      || scope.workspaceId !== expectedWorkspaceId
      || scope.projectId !== expectedProjectId
    ) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Artifact version not found' });
    }
    const permission = await this.access.projectPermission(userId, scope.projectId, 'artifact.render');
    if (!permission.allowed || permission.workspaceId !== scope.workspaceId) {
      const membership = await this.access.workspaceAnyMembership(userId, scope.workspaceId);
      if (!membership.allowed) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Artifact version not found' });
      }
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Artifact render access denied' });
    }
    return scope;
  }

  private async requireThreadRead(userId: string, threadId: string): Promise<{ workspaceId: string; projectId: string }> {
    const access = await this.chatStreamUseCase.canReadThread(userId, threadId);
    if (access.status === 'not_found') throw new NotFoundException({ code: 'NOT_FOUND', message: 'Thread not found' });
    if (access.status === 'forbidden') {
      const membership = await this.access.workspaceAnyMembership(userId, access.workspaceId);
      if (!membership.allowed) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Thread not found' });
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Thread access denied' });
    }
    return { workspaceId: access.workspaceId, projectId: access.projectId };
  }

  private async requireThreadSend(userId: string, threadId: string): Promise<{ workspaceId: string; projectId: string }> {
    const access = await this.chatStreamUseCase.canSendThread(userId, threadId);
    if (access.status === 'not_found') throw new NotFoundException({ code: 'NOT_FOUND', message: 'Thread not found' });
    if (access.status === 'forbidden') {
      const membership = await this.access.workspaceAnyMembership(userId, access.workspaceId);
      if (!membership.allowed) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Thread not found' });
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Thread send access denied' });
    }
    return { workspaceId: access.workspaceId, projectId: access.projectId };
  }

  private throwIfDenied(access: SpaceAccess): asserts access is Extract<SpaceAccess, { allowed: true }> {
    if (access.allowed) return;
    if (access.reason === 'not_found') throw new NotFoundException({ code: 'NOT_FOUND', message: 'space not found' });
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'space access denied' });
  }
}

function isDecisionAnalyticsConflictError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current);
    const record = current as Record<string, unknown>;
    const code = record.code;
    const message = typeof record.message === 'string' ? record.message : '';
    const constraint = typeof record.constraint === 'string' ? record.constraint : '';
    if (
      (code === '23514' && /decision analytics (?:run scope|artifact binding)/iu.test(message))
      || (code === '23503' && constraint.startsWith('decision_analytics_runs_'))
    ) return true;
    current = record.cause;
  }
  return false;
}

function isDecisionAnalyticsActorMembershipError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current);
    const record = current as Record<string, unknown>;
    if (
      record.code === '23514'
      && typeof record.message === 'string'
      && /decision analytics user actor is not an active workspace member/iu.test(record.message)
    ) return true;
    current = record.cause;
  }
  return false;
}
