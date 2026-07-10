import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Inject, Logger, NotFoundException, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
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
  ListRetrievalHitFeedbackResponseSchema,
  ListEvidenceResponseSchema,
  ListMessagesPageRequestSchema,
  ListMessagesPageResponseSchema,
  ListMessagesResponseSchema,
  OkResponseSchema,
  ReviewQueueDecisionRequestSchema,
  ReviewQueueResponseSchema,
  RecordRetrievalHitFeedbackRequestSchema,
  SearchMessagesRequestSchema,
  SearchMessagesResponseSchema,
} from '@consulting/contracts';
import { AccessTokenGuard, requireAuthUserId, type AuthenticatedRequest } from '../auth/access-token.guard.js';
import { parseBody, parseResponse } from '../http/contract-adapter.js';
import { ChatStreamUseCase } from './chat-stream.usecase.js';
import { HermesRunsClient } from './hermes-runs-client.js';
import { ChatMessageStore, type FinishState } from './chat-message.store.js';
import { captureToolEvidence, EvidenceStore, type CapturedToolUse } from './evidence.store.js';
import { NotificationStore } from './notification.store.js';
import { SpaceAccessService, type SpaceAccess } from '../spaces/space-access.service.js';
import { EvidenceDecisionStore } from '../consulting/evidence-decision.store.js';
import { ConsultingMemoryContextBuilder } from '../consulting/consulting-memory-context.builder.js';
import { ConsultingWebIngestService } from '../consulting/consulting-web-ingest.service.js';
import { RuntimeApprovalStore } from './runtime-approval.store.js';

@Controller('chat')
export class ChatStreamController {
  private readonly logger = new Logger(ChatStreamController.name);

  constructor(
    @Inject(ChatStreamUseCase) private readonly chatStreamUseCase: ChatStreamUseCase,
    @Inject(HermesRunsClient) private readonly hermesRunsClient: HermesRunsClient,
    @Inject(ChatMessageStore) private readonly messages: ChatMessageStore,
    @Inject(EvidenceStore) private readonly evidence: EvidenceStore,
    @Inject(NotificationStore) private readonly notifications: NotificationStore,
    @Inject(SpaceAccessService) private readonly access: SpaceAccessService,
    @Inject(EvidenceDecisionStore) private readonly evidenceDecision: EvidenceDecisionStore,
    @Inject(ConsultingMemoryContextBuilder) private readonly memoryContext: ConsultingMemoryContextBuilder,
    @Inject(ConsultingWebIngestService) private readonly webIngest: ConsultingWebIngestService,
    @Inject(RuntimeApprovalStore) private readonly approvals: RuntimeApprovalStore,
  ) {}

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
  async evidenceDecisionSummary(@Param('threadId') threadId: string, @Req() req: AuthenticatedRequest) {
    await this.requireThreadRead(requireAuthUserId(req), threadId);
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
    const access = await this.requireThreadRead(requireAuthUserId(req), threadId);
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
  async reviewQueue(@Param('threadId') threadId: string, @Req() req: AuthenticatedRequest) {
    await this.requireThreadRead(requireAuthUserId(req), threadId);
    return parseResponse(ReviewQueueResponseSchema, await this.evidenceDecision.reviewQueue(threadId));
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
    await this.requireThreadRead(requireAuthUserId(req), threadId);
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
    const access = await this.requireThreadRead(userId, cmd.threadId);
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
    await this.requireThreadRead(requireAuthUserId(req), parsed.data.threadId);
    return parseResponse(ChatRunStatusResponseSchema, await this.hermesRunsClient.runStatus(runId));
  }

  /** Stop an in-flight Hermes run, scoped by thread access. */
  @Post('runtime/runs/:runId/stop')
  @UseGuards(AccessTokenGuard)
  async stopRuntimeRun(@Param('runId') runId: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(ChatRunActionRequestSchema, body);
    await this.requireThreadRead(requireAuthUserId(req), cmd.threadId);
    return parseResponse(ChatRunActionResponseSchema, await this.hermesRunsClient.stopRun(runId));
  }

  /** Resolve a host-side command approval emitted by Hermes Runs SSE. */
  @Post('runtime/runs/:runId/approval')
  @UseGuards(AccessTokenGuard)
  async approveRuntimeRun(@Param('runId') runId: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(ChatApprovalResponseRequestSchema, body);
    const userId = requireAuthUserId(req);
    const access = await this.requireThreadRead(userId, cmd.threadId);
    if (cmd.choice === 'always') {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Approval choice "always" requires durable product policy registry support' });
    }
    if (cmd.resolveAll) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Approval resolveAll requires durable product policy registry support' });
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
    return parseResponse(ChatRunActionResponseSchema, await this.hermesRunsClient.respondApproval(runId, cmd.choice, cmd.resolveAll));
  }

  @Post('stream')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  async stream(@Body() body: unknown, @Req() req: AuthenticatedRequest, @Res() res: Response) {
    const cmd = parseBody(ChatStreamRequestSchema, body);
    const userId = requireAuthUserId(req);
    const access = await this.requireThreadRead(userId, cmd.threadId);

    // Persist the user turn BEFORE proxying so it survives upstream failures.
    const userMessageId = await this.messages.saveUserMessage({
      workspaceId: access.workspaceId,
      threadId: cmd.threadId,
      authorUserId: userId,
      content: cmd.message,
    });
    await this.messages.bindAttachmentsToMessage({
      workspaceId: access.workspaceId,
      threadId: cmd.threadId,
      messageId: userMessageId,
      attachmentIds: cmd.attachmentIds ?? [],
      uploaderUserId: userId,
    });
    const runMessage = cmd.message.trim() || '첨부 파일을 확인해주세요.';
    const graphRagContext = await this.memoryContext.build({ threadId: cmd.threadId, query: runMessage });

    res.status(200);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');

    // Accumulate assistant text server-side; persist on settle regardless of
    // how the stream ends (done / error / client abort) — exactly once.
    let assistantText = '';
    let runId: string | null = null;
    let finishState: FinishState = 'complete';
    let persisted = false;
    // Phase 2-A: capture tool.started previews as evidence candidates.
    const toolUses: CapturedToolUse[] = [];
    const persist = async () => {
      if (persisted) return;
      persisted = true;
      try {
        const messageId = await this.messages.saveAssistantMessage({
          workspaceId: access.workspaceId,
          threadId: cmd.threadId,
          content: assistantText,
          runId,
          finishState,
        });
        // Evidence + notification are best-effort side effects of settle.
        await this.evidence.saveRunEvidence({
          workspaceId: access.workspaceId,
          threadId: cmd.threadId,
          messageId,
          runId,
          toolUses,
        });
        if (finishState === 'complete' && assistantText.length > 0) {
          await this.evidenceDecision.recordCompletedAnswer({
            workspaceId: access.workspaceId,
            threadId: cmd.threadId,
            assistantMessageId: messageId,
            userPrompt: runMessage,
            answer: assistantText,
            runId,
          });
          await this.webIngest.ingestCompletedTurn({
            threadId: cmd.threadId,
            userText: cmd.message,
            assistantText,
            runId,
            assistantMessageId: messageId,
          });
          await this.notifications.notifyWorkspace({
            workspaceId: access.workspaceId,
            excludeUserId: userId,
            type: 'assistant_reply',
            title: '지구의 새 답변',
            body: assistantText.slice(0, 200),
            refType: 'thread',
            refId: cmd.threadId,
          });
        }
      } catch (err) {
        // Persistence side effects must never crash the SSE response path, but they
        // also must not disappear silently: missing outbox rows are a real recall gap.
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`chat persistence side-effect failed: ${message}`);
      }
    };
    res.on('close', () => {
      if (!res.writableEnded) finishState = 'cancelled';
      void persist();
    });

    try {
      const runScope: { workspaceId: string; projectId: string; memoryContext?: string } = {
        workspaceId: access.workspaceId,
        projectId: access.projectId,
      };
      if (graphRagContext) runScope.memoryContext = graphRagContext;
      for await (const event of this.hermesRunsClient.streamChat({ ...cmd, message: runMessage }, runScope)) {
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
            choices: parsed.choices,
          });
          outbound = { ...parsed, approvalId: approval.approvalId };
        }
        if (parsed.type === 'start') runId = parsed.runId;
        if (parsed.type === 'delta') assistantText += parsed.text;
        if (parsed.type === 'tool') captureToolEvidence(toolUses, parsed);
        if (parsed.type === 'error') finishState = 'error';
        if (res.writableEnded) break;
        res.write(`event: ${outbound.type}\n`);
        res.write(`data: ${JSON.stringify(outbound)}\n\n`);
      }
    } finally {
      await persist();
      if (!res.writableEnded) res.end();
    }
  }

  private async requireThreadRead(userId: string, threadId: string): Promise<{ workspaceId: string; projectId: string }> {
    const access = await this.chatStreamUseCase.canReadThread(userId, threadId);
    if (access.status === 'not_found') throw new NotFoundException({ code: 'NOT_FOUND', message: 'Thread not found' });
    if (access.status === 'forbidden') throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Thread access denied' });
    return { workspaceId: access.workspaceId, projectId: access.projectId };
  }

  private throwIfDenied(access: SpaceAccess): asserts access is Extract<SpaceAccess, { allowed: true }> {
    if (access.allowed) return;
    if (access.reason === 'not_found') throw new NotFoundException({ code: 'NOT_FOUND', message: 'space not found' });
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'space access denied' });
  }
}
