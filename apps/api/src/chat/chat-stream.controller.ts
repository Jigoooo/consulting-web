import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Inject, Logger, NotFoundException, Optional, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
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
  EvidenceDecisionSummaryResponseSchema,
  EvidenceDecisionSummaryV2ResponseSchema,
  ListRetrievalHitFeedbackResponseSchema,
  ListEvidenceResponseSchema,
  ListMessagesPageRequestSchema,
  ListMessagesPageResponseSchema,
  ListMessagesResponseSchema,
  OkResponseSchema,
  ReviewQueueDecisionRequestSchema,
  ReviewQueueFilterSchema,
  ReviewQueueResponseSchema,
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
import { ConsultingMemoryContextBuilder } from '../consulting/consulting-memory-context.builder.js';
import { RuntimeApprovalStore } from './runtime-approval.store.js';
import { ChatTurnIdempotencyConflictError, ChatTurnSettlementStore, type ChatTurnSettlementRecord } from './chat-turn-settlement.store.js';
import { PublicChatStreamSanitizer, sanitizePublicChatText } from './public-chat-content.js';
import { ConsultingInsightShadowStore } from '../consulting/consulting-insight-shadow.store.js';
import { routeConsultingInsightIntent } from '../consulting/consulting-insight-intent.js';
import { ENV_TOKEN } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';

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
    @Req() req: AuthenticatedRequest,
  ) {
    await this.requireThreadRead(requireAuthUserId(req), threadId);
    if (includeJudgment === '1') {
      return parseResponse(EvidenceDecisionSummaryV2ResponseSchema, await this.evidenceDecision.summaryV2(threadId));
    }
    return parseResponse(EvidenceDecisionSummaryResponseSchema, await this.evidenceDecision.summary(threadId));
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
    const captureHeartbeat = setInterval(() => {
      void this.settlements.heartbeatCapture(settlementId, captureLeaseToken).then((alive) => {
        if (alive || captureLeaseFailure) return;
        captureLeaseFailure = new Error('chat capture lease lost');
        upstreamAbort.abort();
      }).catch((error: unknown) => {
        if (captureLeaseFailure) return;
        captureLeaseFailure = error;
        upstreamAbort.abort();
      });
    }, 30_000);
    captureHeartbeat.unref();
    const persist = async (snapshot = terminalSnapshot ?? captureSettlement()) => {
      if (settled) return;
      if (settleInFlight) return settleInFlight;
      terminalSnapshot ??= snapshot;
      settleInFlight = this.settlements.finalizeCapture(terminalSnapshot, captureLeaseToken).then(() => {
        settled = true;
      }).catch((err: unknown) => {
        const message = redactLogText(err instanceof Error ? err.message : String(err));
        this.logger.warn(`chat settlement request failed: ${message}`);
        throw err;
      }).finally(() => {
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
    try {
      const memoryBundle = typeof this.memoryContext.buildBundle === 'function'
        ? await this.memoryContext.buildBundle({ threadId: cmd.threadId, query: runMessage })
        : {
            context: await this.memoryContext.build({ threadId: cmd.threadId, query: runMessage }),
            scope: null,
            retrieval: null,
            shadowEligible: false,
            ineligibleReason: 'builder_error' as const,
          };
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
      )) {
        if (clientAborted) break;
        const parsed = ChatStreamEventSchema.parse(event);
        let outbound = parsed;
        if (parsed.type === 'approval') {
          const approval = await this.approvals.createRuntimeApproval({
            workspaceId: access.workspaceId,
            threadId: cmd.threadId,
            requestedByUserId: userId,
            runId: parsed.runId,
            ...(parsed.command ? { command: parsed.command } : {}),
            ...(parsed.message ? { message: parsed.message } : {}),
            ...(parsed.risk ? { risk: parsed.risk } : {}),
            ...(parsed.toolId ? { toolId: parsed.toolId } : {}),
            choices: parsed.choices,
          });
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
        if (captureChanged) {
          await this.settlements.checkpointCapture(captureSettlement(), captureLeaseToken);
        }
        if (outbound.type === 'delta' && outbound.text.length === 0) continue;
        if (res.writableEnded) break;
        res.write(`event: ${outbound.type}\n`);
        res.write(`data: ${JSON.stringify(outbound)}\n\n`);
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
      res.write('event: delta\n');
      res.write(`data: ${JSON.stringify(trailingEvent)}\n\n`);
    }

    let settlementFailure: unknown;
    try {
      await persist();
    } catch (error) {
      settlementFailure = error;
      if (!clientAborted && !res.writableEnded) {
        res.write('event: error\n');
        res.write(`data: ${JSON.stringify({
          type: 'error',
          ...(runId ? { runId } : {}),
          code: 'CHAT_SETTLEMENT_FAILED',
          message: '답변을 안전하게 저장하지 못했습니다. 다시 시도해주세요.',
        })}\n\n`);
        res.end();
      }
    }
    clearInterval(captureHeartbeat);
    if (!settlementFailure && !clientAborted && !res.writableEnded) {
      if (streamFailure) {
        res.write('event: error\n');
        res.write(`data: ${JSON.stringify({
          type: 'error',
          ...(runId ? { runId } : {}),
          code: 'CHAT_STREAM_FAILED',
          message: '응답 준비 또는 전송 중 오류가 발생했습니다. 다시 시도해주세요.',
        })}\n\n`);
      } else if (pendingDonePayload) {
        res.write('event: done\n');
        res.write(`data: ${pendingDonePayload}\n\n`);
      }
      res.end();
    }
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

  private async requireRuntimeRunBinding(runId: string, threadId: string, workspaceId: string): Promise<void> {
    const owner = await this.settlements.findOwnershipByRunId(runId);
    if (!owner || owner.threadId !== threadId || owner.workspaceId !== workspaceId) {
      throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Run not found' });
    }
  }

  private async requireThreadRead(userId: string, threadId: string): Promise<{ workspaceId: string; projectId: string }> {
    const access = await this.chatStreamUseCase.canReadThread(userId, threadId);
    if (access.status === 'not_found') throw new NotFoundException({ code: 'NOT_FOUND', message: 'Thread not found' });
    if (access.status === 'forbidden') throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Thread access denied' });
    return { workspaceId: access.workspaceId, projectId: access.projectId };
  }

  private async requireThreadSend(userId: string, threadId: string): Promise<{ workspaceId: string; projectId: string }> {
    const access = await this.chatStreamUseCase.canSendThread(userId, threadId);
    if (access.status === 'not_found') throw new NotFoundException({ code: 'NOT_FOUND', message: 'Thread not found' });
    if (access.status === 'forbidden') throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Thread send access denied' });
    return { workspaceId: access.workspaceId, projectId: access.projectId };
  }

  private throwIfDenied(access: SpaceAccess): asserts access is Extract<SpaceAccess, { allowed: true }> {
    if (access.allowed) return;
    if (access.reason === 'not_found') throw new NotFoundException({ code: 'NOT_FOUND', message: 'space not found' });
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'space access denied' });
  }
}
