import { Body, Controller, ForbiddenException, Inject, NotFoundException, Post, Req, UseGuards } from '@nestjs/common';
import {
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  CreateChannelRequestSchema,
  CreateChannelResponseSchema,
  CreateTopicRequestSchema,
  CreateTopicResponseSchema,
  CreateThreadRequestSchema,
  CreateThreadResponseSchema,
} from '@consulting/contracts';
import { AccessTokenGuard, requireAuthUserId, type AuthenticatedRequest } from '../auth/access-token.guard.js';
import { parseBody, parseResponse, throwDomainError } from '../http/contract-adapter.js';
import { CreateProjectUseCase } from './create-project.usecase.js';
import { CreateChannelUseCase } from './create-channel.usecase.js';
import { CreateTopicUseCase } from './create-topic.usecase.js';
import { CreateThreadUseCase } from './create-thread.usecase.js';
import { SpaceAccessService, type SpaceAccess } from './space-access.service.js';

@Controller('spaces')
@UseGuards(AccessTokenGuard)
export class SpacesController {
  constructor(
    @Inject(SpaceAccessService) private readonly access: SpaceAccessService,
    @Inject(CreateProjectUseCase) private readonly createProject: CreateProjectUseCase,
    @Inject(CreateChannelUseCase) private readonly createChannel: CreateChannelUseCase,
    @Inject(CreateTopicUseCase) private readonly createTopic: CreateTopicUseCase,
    @Inject(CreateThreadUseCase) private readonly createThread: CreateThreadUseCase,
  ) {}

  @Post('projects')
  async project(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(CreateProjectRequestSchema, body);
    const userId = requireAuthUserId(req);
    this.throwIfDenied(await this.access.workspaceMember(userId, cmd.workspaceId));
    const result = await this.createProject.execute({ ...cmd, actorUserId: userId });
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(CreateProjectResponseSchema, { id: result.value.projectId });
  }

  @Post('channels')
  async channel(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(CreateChannelRequestSchema, body);
    const userId = requireAuthUserId(req);
    this.throwIfDenied(await this.access.projectMember(userId, cmd.projectId));
    const result = await this.createChannel.commit({ ...cmd, actorUserId: userId });
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(CreateChannelResponseSchema, { id: result.value.channelId });
  }

  @Post('topics')
  async topic(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(CreateTopicRequestSchema, body);
    const userId = requireAuthUserId(req);
    this.throwIfDenied(await this.access.channelMember(userId, cmd.channelId));
    const result = await this.createTopic.execute({ ...cmd, actorUserId: userId });
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(CreateTopicResponseSchema, { id: result.value.topicId });
  }

  @Post('threads')
  async thread(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(CreateThreadRequestSchema, body);
    const userId = requireAuthUserId(req);
    this.throwIfDenied(await this.access.topicMember(userId, cmd.topicId));
    const result = await this.createThread.execute({ ...cmd, actorUserId: userId });
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(CreateThreadResponseSchema, { id: result.value.threadId });
  }

  private throwIfDenied(access: SpaceAccess): asserts access is Extract<SpaceAccess, { allowed: true }> {
    if (access.allowed) return;
    if (access.reason === 'not_found') throw new NotFoundException({ code: 'NOT_FOUND', message: 'space not found' });
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'space access denied' });
  }
}
