import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  CreateWorkspaceRequestSchema,
  CreateWorkspaceResponseSchema,
  CreateChannelRequestSchema,
  CreateChannelResponseSchema,
  CreateTopicRequestSchema,
  CreateTopicResponseSchema,
  CreateThreadRequestSchema,
  CreateThreadResponseSchema,
  ListWorkspacesResponseSchema,
  ListArchivedScopesResponseSchema,
  WorkspaceTreeResponseSchema,
  ListThreadsResponseSchema,
  ThreadDetailResponseSchema,
  ListMembersResponseSchema,
  RenameRequestSchema,
  RenameThreadRequestSchema,
  CreateContextEdgeRequestSchema,
  CreateContextEdgeResponseSchema,
  ListContextEdgesRequestSchema,
  ListContextEdgesResponseSchema,
  ArchivedScopeKindSchema,
  OkResponseSchema,
} from '@consulting/contracts';
import { AccessTokenGuard, requireAuthUserId, type AuthenticatedRequest } from '../auth/access-token.guard.js';
import { parseBody, parseResponse, throwDomainError } from '../http/contract-adapter.js';
import { CreateProjectUseCase } from './create-project.usecase.js';
import { CreateWorkspaceUseCase } from './create-workspace.usecase.js';
import { CreateChannelUseCase } from './create-channel.usecase.js';
import { CreateTopicUseCase } from './create-topic.usecase.js';
import { CreateThreadUseCase } from './create-thread.usecase.js';
import { SpaceAccessService, type SpaceAccess } from './space-access.service.js';
import { SpaceReadService } from './space-read.service.js';
import { RestoreParentNotActiveError, SpaceMutateService } from './space-mutate.service.js';
import { ContextGraphService, type ContextGraphRelatedScope, type ContextGraphScopeType } from './context-graph.service.js';

@Controller('spaces')
@UseGuards(AccessTokenGuard)
export class SpacesController {
  constructor(
    @Inject(SpaceAccessService) private readonly access: SpaceAccessService,
    @Inject(SpaceReadService) private readonly reads: SpaceReadService,
    @Inject(SpaceMutateService) private readonly mutate: SpaceMutateService,
    @Inject(ContextGraphService) private readonly contextGraph: ContextGraphService,
    @Inject(CreateProjectUseCase) private readonly createProject: CreateProjectUseCase,
    @Inject(CreateWorkspaceUseCase) private readonly createWorkspace: CreateWorkspaceUseCase,
    @Inject(CreateChannelUseCase) private readonly createChannel: CreateChannelUseCase,
    @Inject(CreateTopicUseCase) private readonly createTopic: CreateTopicUseCase,
    @Inject(CreateThreadUseCase) private readonly createThread: CreateThreadUseCase,
  ) {}

  @Get('workspaces')
  async workspaces(@Req() req: AuthenticatedRequest) {
    const userId = requireAuthUserId(req);
    return parseResponse(ListWorkspacesResponseSchema, await this.reads.listWorkspaces(userId));
  }

  @Get('workspaces/:workspaceId/tree')
  async tree(@Param('workspaceId') workspaceId: string, @Req() req: AuthenticatedRequest) {
    const userId = requireAuthUserId(req);
    this.throwIfDenied(await this.access.workspaceMember(userId, workspaceId));
    return parseResponse(WorkspaceTreeResponseSchema, await this.reads.workspaceTree(workspaceId));
  }

  @Get('workspaces/:workspaceId/members')
  async members(@Param('workspaceId') workspaceId: string, @Req() req: AuthenticatedRequest) {
    const userId = requireAuthUserId(req);
    this.throwIfDenied(await this.access.workspaceMember(userId, workspaceId));
    return parseResponse(ListMembersResponseSchema, await this.mutate.listMembers(workspaceId));
  }

  @Get('workspaces/:workspaceId/archive')
  async archive(@Param('workspaceId') workspaceId: string, @Req() req: AuthenticatedRequest) {
    const userId = requireAuthUserId(req);
    this.throwIfDenied(await this.access.workspaceMember(userId, workspaceId));
    return parseResponse(ListArchivedScopesResponseSchema, await this.reads.listArchivedScopes(workspaceId));
  }

  @Post('context-edges')
  async createContextEdge(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(CreateContextEdgeRequestSchema, body);
    const userId = requireAuthUserId(req);
    await this.requireScopeMember(userId, cmd.fromScopeType, cmd.fromScopeId);
    await this.requireScopeMember(userId, cmd.toScopeType, cmd.toScopeId);
    const result = await this.contextGraph.createManualEdge(cmd);
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(CreateContextEdgeResponseSchema, result.value);
  }

  @Get('context-edges')
  async contextEdges(@Query() query: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(ListContextEdgesRequestSchema, query);
    await this.requireScopeMember(requireAuthUserId(req), cmd.scopeType, cmd.scopeId);
    const edges = await this.contextGraph.traverseRelatedScopes(cmd);
    return parseResponse(ListContextEdgesResponseSchema, { edges: edges.map((edge) => this.contextEdgeResponse(edge)) });
  }

  @Get('topics/:topicId/threads')
  async threads(@Param('topicId') topicId: string, @Req() req: AuthenticatedRequest) {
    const userId = requireAuthUserId(req);
    this.throwIfDenied(await this.access.topicMember(userId, topicId));
    return parseResponse(ListThreadsResponseSchema, await this.reads.listThreads(topicId));
  }

  @Get('threads/:threadId')
  async threadDetail(@Param('threadId') threadId: string, @Req() req: AuthenticatedRequest) {
    const userId = requireAuthUserId(req);
    await this.requireThreadMember(userId, threadId);
    const detail = await this.mutate.threadDetail(threadId);
    if (!detail) throw new NotFoundException({ code: 'NOT_FOUND', message: 'thread not found' });
    return parseResponse(ThreadDetailResponseSchema, detail);
  }

  // --- rename (N-4) ---
  @Patch('projects/:id')
  async renameProject(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const { name } = parseBody(RenameRequestSchema, body);
    await this.requireNodeMember(requireAuthUserId(req), 'project', id);
    await this.mutate.renameNode('project', id, name);
    return parseResponse(OkResponseSchema, { ok: true });
  }

  @Patch('channels/:id')
  async renameChannel(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const { name } = parseBody(RenameRequestSchema, body);
    await this.requireNodeMember(requireAuthUserId(req), 'channel', id);
    await this.mutate.renameNode('channel', id, name);
    return parseResponse(OkResponseSchema, { ok: true });
  }

  @Patch('topics/:id')
  async renameTopic(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const { name } = parseBody(RenameRequestSchema, body);
    await this.requireNodeMember(requireAuthUserId(req), 'topic', id);
    await this.mutate.renameNode('topic', id, name);
    return parseResponse(OkResponseSchema, { ok: true });
  }

  @Patch('threads/:id')
  async renameThread(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const { title } = parseBody(RenameThreadRequestSchema, body);
    await this.requireThreadMember(requireAuthUserId(req), id);
    await this.mutate.renameThread(id, title);
    return parseResponse(OkResponseSchema, { ok: true });
  }

  // --- user-facing archive (N-4) ---
  @Delete('projects/:id')
  async deleteProject(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    await this.requireNodeMember(requireAuthUserId(req), 'project', id);
    await this.mutate.archiveNode('project', id);
    return parseResponse(OkResponseSchema, { ok: true });
  }

  @Delete('channels/:id')
  async deleteChannel(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    await this.requireNodeMember(requireAuthUserId(req), 'channel', id);
    await this.mutate.archiveNode('channel', id);
    return parseResponse(OkResponseSchema, { ok: true });
  }

  @Delete('topics/:id')
  async deleteTopic(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    await this.requireNodeMember(requireAuthUserId(req), 'topic', id);
    await this.mutate.archiveNode('topic', id);
    return parseResponse(OkResponseSchema, { ok: true });
  }

  @Delete('threads/:id')
  async deleteThread(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    await this.requireThreadMember(requireAuthUserId(req), id);
    await this.mutate.archiveThread(id);
    return parseResponse(OkResponseSchema, { ok: true });
  }

  @Post('archive/:kind/:id/restore')
  @HttpCode(200)
  async restoreArchived(@Param('kind') kindRaw: string, @Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const kind = ArchivedScopeKindSchema.safeParse(kindRaw);
    if (!kind.success) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'invalid archive scope kind' });

    if (kind.data === 'thread') {
      await this.requireThreadMember(requireAuthUserId(req), id);
    } else {
      await this.requireNodeMember(requireAuthUserId(req), kind.data, id);
    }

    try {
      if (kind.data === 'thread') await this.mutate.restoreThread(id);
      else await this.mutate.restoreNode(kind.data, id);
    } catch (error) {
      if (error instanceof RestoreParentNotActiveError) {
        throw new ConflictException({ code: 'PARENT_ARCHIVED', message: '상위 항목을 먼저 복원해야 합니다.' });
      }
      throw error;
    }

    return parseResponse(OkResponseSchema, { ok: true });
  }

  private async requireScopeMember(userId: string, kind: ContextGraphScopeType, id: string): Promise<void> {
    if (kind === 'thread') await this.requireThreadMember(userId, id);
    else await this.requireNodeMember(userId, kind, id);
  }

  private contextEdgeResponse(edge: ContextGraphRelatedScope) {
    return {
      edgeId: edge.edgeId,
      scopeType: edge.scopeType,
      scopeId: edge.scopeId,
      projectId: edge.projectId,
      projectName: edge.projectName,
      channelId: edge.channelId,
      channelName: edge.channelName,
      topicId: edge.topicId,
      topicName: edge.topicName,
      threadId: edge.threadId,
      threadTitle: edge.threadTitle,
      name: edge.name,
      scopePath: edge.scopePath,
      edgeType: edge.edgeType,
      origin: edge.origin,
      confidence: edge.confidence,
      direction: edge.direction,
      relation: edge.relation,
      weight: edge.weight,
    };
  }

  private async requireNodeMember(userId: string, kind: 'project' | 'channel' | 'topic', id: string): Promise<void> {
    const workspaceId = await this.mutate.nodeWorkspace(kind, id);
    if (!workspaceId) throw new NotFoundException({ code: 'NOT_FOUND', message: `${kind} not found` });
    this.throwIfDenied(await this.access.workspaceMember(userId, workspaceId));
  }

  private async requireThreadMember(userId: string, id: string): Promise<void> {
    const workspaceId = await this.mutate.threadWorkspace(id);
    if (!workspaceId) throw new NotFoundException({ code: 'NOT_FOUND', message: 'thread not found' });
    this.throwIfDenied(await this.access.workspaceMember(userId, workspaceId));
  }

  @Post('projects')
  async project(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(CreateProjectRequestSchema, body);
    const userId = requireAuthUserId(req);
    this.throwIfDenied(await this.access.workspaceMember(userId, cmd.workspaceId));
    const result = await this.createProject.execute({ ...cmd, actorUserId: userId });
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(CreateProjectResponseSchema, { id: result.value.projectId });
  }

  @Post('workspaces')
  async workspace(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(CreateWorkspaceRequestSchema, body);
    const userId = requireAuthUserId(req);
    const result = await this.createWorkspace.execute({ ...cmd, actorUserId: userId });
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(CreateWorkspaceResponseSchema, { id: result.value.workspaceId });
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
