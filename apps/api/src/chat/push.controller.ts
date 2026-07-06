import { Body, Controller, Get, Inject, Post, Req, UseGuards } from '@nestjs/common';
import {
  OkResponseSchema,
  PushPublicKeyResponseSchema,
  PushSubscribeRequestSchema,
  PushUnsubscribeRequestSchema,
} from '@consulting/contracts';
import { AccessTokenGuard, requireAuthUserId, type AuthenticatedRequest } from '../auth/access-token.guard.js';
import { parseBody, parseResponse } from '../http/contract-adapter.js';
import { PushService } from './push.service.js';

/** Web Push subscription management (2026-07-06). publicKey is null when the
 * server has no VAPID keys — the client then skips the subscribe UI. */
@Controller('push')
@UseGuards(AccessTokenGuard)
export class PushController {
  constructor(@Inject(PushService) private readonly push: PushService) {}

  @Get('public-key')
  publicKey() {
    return parseResponse(PushPublicKeyResponseSchema, { publicKey: this.push.publicKey() });
  }

  @Post('subscribe')
  async subscribe(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(PushSubscribeRequestSchema, body);
    const userId = requireAuthUserId(req);
    await this.push.subscribe(userId, {
      endpoint: cmd.endpoint,
      p256dh: cmd.keys.p256dh,
      auth: cmd.keys.auth,
      userAgent: req.headers['user-agent'],
    });
    return parseResponse(OkResponseSchema, { ok: true });
  }

  @Post('unsubscribe')
  async unsubscribe(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(PushUnsubscribeRequestSchema, body);
    const userId = requireAuthUserId(req);
    await this.push.unsubscribe(userId, cmd.endpoint);
    return parseResponse(OkResponseSchema, { ok: true });
  }
}
