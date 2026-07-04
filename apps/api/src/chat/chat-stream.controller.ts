import { Body, Controller, ForbiddenException, HttpCode, Inject, NotFoundException, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ChatStreamEventSchema, ChatStreamRequestSchema } from '@consulting/contracts';
import { AccessTokenGuard, requireAuthUserId, type AuthenticatedRequest } from '../auth/access-token.guard.js';
import { parseBody } from '../http/contract-adapter.js';
import { ChatStreamUseCase } from './chat-stream.usecase.js';

@Controller('chat')
export class ChatStreamController {
  constructor(@Inject(ChatStreamUseCase) private readonly chatStreamUseCase: ChatStreamUseCase) {}

  @Post('stream')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  async stream(@Body() body: unknown, @Req() req: AuthenticatedRequest, @Res() res: Response) {
    const cmd = parseBody(ChatStreamRequestSchema, body);
    const userId = requireAuthUserId(req);
    const access = await this.chatStreamUseCase.canReadThread(userId, cmd.threadId);
    if (access === 'not_found') throw new NotFoundException({ code: 'NOT_FOUND', message: 'Thread not found' });
    if (access === 'forbidden') throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Thread access denied' });

    res.status(200);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');

    for (const event of this.chatStreamUseCase.mockEvents(cmd)) {
      const parsed = ChatStreamEventSchema.parse(event);
      res.write(`event: ${parsed.type}\n`);
      res.write(`data: ${JSON.stringify(parsed)}\n\n`);
    }
    res.end();
  }
}
