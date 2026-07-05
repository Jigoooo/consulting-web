import { Body, Controller, Get, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ListNotificationsResponseSchema, MarkReadRequestSchema, OkResponseSchema } from '@consulting/contracts';
import { AccessTokenGuard, requireAuthUserId, type AuthenticatedRequest } from '../auth/access-token.guard.js';
import { parseBody, parseResponse } from '../http/contract-adapter.js';
import { NotificationStore } from './notification.store.js';

/** Phase 2-C notification feed. Poll-friendly: GET is cheap, single-user scoped. */
@Controller('notifications')
@UseGuards(AccessTokenGuard)
export class NotificationsController {
  constructor(@Inject(NotificationStore) private readonly store: NotificationStore) {}

  @Get()
  async list(@Req() req: AuthenticatedRequest) {
    const userId = requireAuthUserId(req);
    return parseResponse(ListNotificationsResponseSchema, await this.store.listForUser(userId));
  }

  @Post('read')
  async markRead(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(MarkReadRequestSchema, body);
    const userId = requireAuthUserId(req);
    await this.store.markRead(userId, cmd.ids);
    return parseResponse(OkResponseSchema, { ok: true });
  }
}
