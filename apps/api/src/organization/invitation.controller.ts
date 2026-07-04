import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import {
  AcceptInvitationRequestSchema,
  AcceptInvitationResponseSchema,
  CreateInvitationRequestSchema,
  CreateInvitationResponseSchema,
  InvitationPreviewRequestSchema,
  InvitationPreviewResponseSchema,
} from '@consulting/contracts';
import { InvitationUseCase } from './invitation.usecase.js';
import { parseBody, parseResponse, throwDomainError } from '../http/contract-adapter.js';
import { AccessTokenGuard, requireAuthUserId, type AuthenticatedRequest } from '../auth/access-token.guard.js';

@Controller('invitations')
export class InvitationController {
  constructor(@Inject(InvitationUseCase) private readonly invitationUseCase: InvitationUseCase) {}

  @Post()
  async create(@Body() body: unknown) {
    const req = parseBody(CreateInvitationRequestSchema, body);
    const result = await this.invitationUseCase.create({
      workspaceId: req.workspaceId,
      invitedByUserId: req.invitedByUserId,
      scopeType: req.scopeType,
      scopeId: req.scopeId,
      role: req.role,
      ...(req.email !== undefined ? { email: req.email } : {}),
      ...(req.ttlMs !== undefined ? { ttlMs: req.ttlMs } : {}),
    });
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(CreateInvitationResponseSchema, result.value);
  }

  @Post('preview')
  @HttpCode(200)
  async preview(@Body() body: unknown) {
    const cmd = parseBody(InvitationPreviewRequestSchema, body);
    const result = await this.invitationUseCase.preview(cmd);
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(InvitationPreviewResponseSchema, {
      ...result.value,
      expiresAt: result.value.expiresAt.toISOString(),
    });
  }

  @Post('accept')
  @UseGuards(AccessTokenGuard)
  async accept(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(AcceptInvitationRequestSchema, body);
    const result = await this.invitationUseCase.accept({ token: cmd.token, userId: requireAuthUserId(req) });
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(AcceptInvitationResponseSchema, result.value);
  }
}
