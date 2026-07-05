import { Body, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ChatStreamEventSchema, ChatStreamRequestSchema, ListMessagesResponseSchema } from '@consulting/contracts';
import { AccessTokenGuard, requireAuthUserId, type AuthenticatedRequest } from '../auth/access-token.guard.js';
import { parseBody, parseResponse } from '../http/contract-adapter.js';
import { ChatStreamUseCase } from './chat-stream.usecase.js';
import { HermesRunsClient } from './hermes-runs-client.js';
import { ChatMessageStore, type FinishState } from './chat-message.store.js';

@Controller('chat')
export class ChatStreamController {
  constructor(
    @Inject(ChatStreamUseCase) private readonly chatStreamUseCase: ChatStreamUseCase,
    @Inject(HermesRunsClient) private readonly hermesRunsClient: HermesRunsClient,
    @Inject(ChatMessageStore) private readonly messages: ChatMessageStore,
  ) {}

  /** Persisted transcript for a thread (N-1). */
  @Get('threads/:threadId/messages')
  @UseGuards(AccessTokenGuard)
  async list(@Param('threadId') threadId: string, @Req() req: AuthenticatedRequest) {
    const userId = requireAuthUserId(req);
    const access = await this.chatStreamUseCase.canReadThread(userId, threadId);
    if (access.status === 'not_found') throw new NotFoundException({ code: 'NOT_FOUND', message: 'Thread not found' });
    if (access.status === 'forbidden') throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Thread access denied' });
    return parseResponse(ListMessagesResponseSchema, await this.messages.listMessages(threadId));
  }

  @Post('stream')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  async stream(@Body() body: unknown, @Req() req: AuthenticatedRequest, @Res() res: Response) {
    const cmd = parseBody(ChatStreamRequestSchema, body);
    const userId = requireAuthUserId(req);
    const access = await this.chatStreamUseCase.canReadThread(userId, cmd.threadId);
    if (access.status === 'not_found') throw new NotFoundException({ code: 'NOT_FOUND', message: 'Thread not found' });
    if (access.status === 'forbidden') throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Thread access denied' });

    // Persist the user turn BEFORE proxying so it survives upstream failures.
    await this.messages.saveUserMessage({
      workspaceId: access.workspaceId,
      threadId: cmd.threadId,
      authorUserId: userId,
      content: cmd.message,
    });

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
    const persist = async () => {
      if (persisted) return;
      persisted = true;
      try {
        await this.messages.saveAssistantMessage({
          workspaceId: access.workspaceId,
          threadId: cmd.threadId,
          content: assistantText,
          runId,
          finishState,
        });
      } catch {
        /* persistence must never crash the response path */
      }
    };
    res.on('close', () => {
      if (!res.writableEnded) finishState = 'cancelled';
      void persist();
    });

    try {
      for await (const event of this.hermesRunsClient.streamChat(cmd)) {
        const parsed = ChatStreamEventSchema.parse(event);
        if (parsed.type === 'start') runId = parsed.runId;
        if (parsed.type === 'delta') assistantText += parsed.text;
        if (parsed.type === 'error') finishState = 'error';
        if (res.writableEnded) break;
        res.write(`event: ${parsed.type}\n`);
        res.write(`data: ${JSON.stringify(parsed)}\n\n`);
      }
    } finally {
      await persist();
      if (!res.writableEnded) res.end();
    }
  }
}
