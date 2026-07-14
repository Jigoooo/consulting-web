import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  CreateWorkspaceRequestSchema,
  CreateWorkspaceResponseSchema,
  CreateChannelRequestSchema,
  CreateChannelResponseSchema,
  CreateChannelBundleRequestSchema,
  CreateChannelBundleResponseSchema,
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
  ScopeProfileResponseSchema,
  UpdateScopeProfileRequestSchema,
  ArchivedScopeKindSchema,
  OkResponseSchema,
} from '@consulting/contracts';
import { AccessTokenGuard, requireAuthUserId, type AuthenticatedRequest } from '../auth/access-token.guard.js';
import { parseBody, parseResponse, throwDomainError } from '../http/contract-adapter.js';
import { CreateProjectUseCase } from './create-project.usecase.js';
import { CreateWorkspaceUseCase } from './create-workspace.usecase.js';
import { CreateChannelUseCase } from './create-channel.usecase.js';
import { CreateChannelBundleUseCase } from './create-channel-bundle.usecase.js';
import { CreateTopicUseCase } from './create-topic.usecase.js';
import { CreateThreadUseCase } from './create-thread.usecase.js';
import { SpaceAccessService, type SpaceAccess } from './space-access.service.js';
import { SpaceReadService } from './space-read.service.js';
import { RestoreParentNotActiveError, SpaceMutateService } from './space-mutate.service.js';
import { ContextGraphService, type ContextGraphRelatedScope, type ContextGraphScopeType } from './context-graph.service.js';
import { ScopeProfileService } from './scope-profile.service.js';
import type { Permission } from '../permissions/permission.types.js';

@Controller('spaces')
@UseGuards(AccessTokenGuard)
export class SpacesController {
  constructor(
    @Inject(SpaceAccessService) private readonly access: SpaceAccessService,
    @Inject(SpaceReadService) private readonly reads: SpaceReadService,
    @Inject(SpaceMutateService) private readonly mutate: SpaceMutateService,
    @Inject(ContextGraphService) private readonly contextGraph: ContextGraphService,
    @Inject(ScopeProfileService) private readonly scopeProfiles: ScopeProfileService,
    @Inject(CreateProjectUseCase) private readonly createProject: CreateProjectUseCase,
    @Inject(CreateWorkspaceUseCase) private readonly createWorkspace: CreateWorkspaceUseCase,
    @Inject(CreateChannelUseCase) private readonly createChannel: CreateChannelUseCase,
    @Inject(CreateChannelBundleUseCase) private readonly createChannelBundle: CreateChannelBundleUseCase,
    @Inject(CreateTopicUseCase) private readonly createTopic: CreateTopicUseCase,
    @Inject(CreateThreadUseCase) private readonly createThread: CreateThreadUseCase,
  ) {}

  @Get('workspaces')
  async workspaces(@Req() req: AuthenticatedRequest) {
    const userId = requireAuthUserId(req);
    return parseResponse(ListWorkspacesResponseSchema, await this.reads.listWorkspaces(userId));
  }

  @Get('workspaces/:workspaceId/tree')
  async tree(
    @Param('workspaceId') workspaceId: string,
    @Query('includePermissions') includePermissions: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = requireAuthUserId(req);
    this.throwIfDenied(await this.access.workspaceAnyMembership(userId, workspaceId));
    return parseResponse(
      WorkspaceTreeResponseSchema,
      await this.reads.workspaceTree(workspaceId, userId, includePermissions === 'true'),
    );
  }

  @Get('workspaces/:workspaceId/members')
  async members(@Param('workspaceId') workspaceId: string, @Req() req: AuthenticatedRequest) {
    const userId = requireAuthUserId(req);
    this.throwIfDenied(await this.access.workspaceMember(userId, workspaceId));
    return parseResponse(ListMembersResponseSchema, await this.mutate.listMembers(workspaceId));
  }

  @Get('workspaces/:workspaceId/archive')
  async archive(
    @Param('workspaceId') workspaceId: string,
    @Req() req: AuthenticatedRequest,
    @Query('includePermissions') includePermissions?: string,
  ) {
    const userId = requireAuthUserId(req);
    this.throwIfDenied(await this.access.workspaceAnyMembership(userId, workspaceId));
    const archive = await this.reads.listArchivedScopes(workspaceId);
    const checks = await Promise.all(
      archive.items.map((item) => this.archivedScopeReadAccess(userId, item.kind, item.id)),
    );
    const visibleItems = archive.items.filter((_item, index) => {
      const access = checks[index];
      return access?.allowed === true && access.workspaceId === workspaceId;
    });
    if (includePermissions !== 'true') {
      return parseResponse(ListArchivedScopesResponseSchema, { items: visibleItems });
    }
    const restoreChecks = await Promise.all(
      visibleItems.map((item) => this.archivedScopeRestoreAccess(userId, item.kind, item.id)),
    );
    return parseResponse(ListArchivedScopesResponseSchema, {
      items: visibleItems.map((item, index) => ({
        ...item,
        canRestore: restoreChecks[index]?.allowed === true && restoreChecks[index]?.workspaceId === workspaceId,
      })),
    });
  }

  @Post('context-edges')
  async createContextEdge(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(CreateContextEdgeRequestSchema, body);
    const userId = requireAuthUserId(req);
    await this.requireScopeMutation(userId, cmd.fromScopeType, cmd.fromScopeId);
    await this.requireScopeMutation(userId, cmd.toScopeType, cmd.toScopeId);
    const result = await this.contextGraph.createManualEdge(cmd);
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(CreateContextEdgeResponseSchema, result.value);
  }

  @Get('context-edges')
  async contextEdges(@Query() query: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(ListContextEdgesRequestSchema, query);
    const userId = requireAuthUserId(req);
    const anchorAccess = await this.scopeAccess(userId, cmd.scopeType, cmd.scopeId);
    this.throwIfDenied(anchorAccess);
    const edges = await this.contextGraph.traverseRelatedScopes(cmd);
    const visible = await Promise.all(edges.map(async (edge) => ({
      edge,
      access: await this.scopeAccess(userId, edge.scopeType, edge.scopeId),
    })));
    return parseResponse(ListContextEdgesResponseSchema, {
      edges: visible
        .filter(({ edge, access }) => access.allowed && access.workspaceId === anchorAccess.workspaceId && edge.workspaceId === anchorAccess.workspaceId)
        .map(({ edge }) => this.contextEdgeResponse(edge)),
    });
  }

  @Delete('context-edges/:edgeId')
  @HttpCode(200)
  async deleteContextEdge(@Param('edgeId') edgeId: string, @Req() req: AuthenticatedRequest) {
    const target = await this.contextGraph.getManualEdgeTarget(edgeId);
    if (!target.ok) return throwDomainError(target.error);
    const userId = requireAuthUserId(req);
    await this.requireScopeMutation(userId, target.value.fromScopeType, target.value.fromScopeId);
    await this.requireScopeMutation(userId, target.value.toScopeType, target.value.toScopeId);
    const result = await this.contextGraph.deleteManualEdge(edgeId);
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(OkResponseSchema, result.value);
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

  @Get('projects/:id/profile')
  async projectProfile(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    await this.requireNodeMember(requireAuthUserId(req), 'project', id);
    const result = await this.scopeProfiles.getProfile('project', id);
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(ScopeProfileResponseSchema, result.value);
  }

  @Patch('projects/:id/profile')
  async updateProjectProfile(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const patch = parseBody(UpdateScopeProfileRequestSchema, body);
    const userId = requireAuthUserId(req);
    await this.requireNodePermission(userId, 'project', id, 'project.update');
    const result = await this.scopeProfiles.updateProfile('project', id, { actorUserId: userId, patch });
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(ScopeProfileResponseSchema, result.value);
  }

  @Get('channels/:id/profile')
  async channelProfile(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    await this.requireNodeMember(requireAuthUserId(req), 'channel', id);
    const result = await this.scopeProfiles.getProfile('channel', id);
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(ScopeProfileResponseSchema, result.value);
  }

  @Patch('channels/:id/profile')
  async updateChannelProfile(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const patch = parseBody(UpdateScopeProfileRequestSchema, body);
    const userId = requireAuthUserId(req);
    await this.requireNodePermission(userId, 'channel', id, 'channel.update');
    const result = await this.scopeProfiles.updateProfile('channel', id, { actorUserId: userId, patch });
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(ScopeProfileResponseSchema, result.value);
  }

  @Get('topics/:id/profile')
  async topicProfile(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    await this.requireNodeMember(requireAuthUserId(req), 'topic', id);
    const result = await this.scopeProfiles.getProfile('topic', id);
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(ScopeProfileResponseSchema, result.value);
  }

  @Patch('topics/:id/profile')
  async updateTopicProfile(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const patch = parseBody(UpdateScopeProfileRequestSchema, body);
    const userId = requireAuthUserId(req);
    await this.requireNodePermission(userId, 'topic', id, 'topic.connect_memory');
    const result = await this.scopeProfiles.updateProfile('topic', id, { actorUserId: userId, patch });
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(ScopeProfileResponseSchema, result.value);
  }

  // --- rename (N-4) ---
  @Patch('projects/:id')
  async renameProject(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const { name } = parseBody(RenameRequestSchema, body);
    await this.requireNodePermission(requireAuthUserId(req), 'project', id, 'project.update');
    await this.mutate.renameNode('project', id, name);
    return parseResponse(OkResponseSchema, { ok: true });
  }

  @Patch('channels/:id')
  async renameChannel(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const { name } = parseBody(RenameRequestSchema, body);
    await this.requireNodePermission(requireAuthUserId(req), 'channel', id, 'channel.update');
    await this.mutate.renameNode('channel', id, name);
    return parseResponse(OkResponseSchema, { ok: true });
  }

  @Patch('topics/:id')
  async renameTopic(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const { name } = parseBody(RenameRequestSchema, body);
    await this.requireNodePermission(requireAuthUserId(req), 'topic', id, 'channel.update');
    await this.mutate.renameNode('topic', id, name);
    return parseResponse(OkResponseSchema, { ok: true });
  }

  @Patch('threads/:id')
  async renameThread(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const { title } = parseBody(RenameThreadRequestSchema, body);
    await this.requireThreadPermission(requireAuthUserId(req), id, 'channel.update');
    await this.mutate.renameThread(id, title);
    return parseResponse(OkResponseSchema, { ok: true });
  }

  // --- user-facing archive (N-4) ---
  @Delete('projects/:id')
  async deleteProject(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    await this.requireNodePermission(requireAuthUserId(req), 'project', id, 'project.update');
    await this.mutate.archiveNode('project', id);
    return parseResponse(OkResponseSchema, { ok: true });
  }

  @Delete('channels/:id')
  async deleteChannel(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    await this.requireNodePermission(requireAuthUserId(req), 'channel', id, 'channel.update');
    await this.mutate.archiveNode('channel', id);
    return parseResponse(OkResponseSchema, { ok: true });
  }

  @Delete('topics/:id')
  async deleteTopic(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    await this.requireNodePermission(requireAuthUserId(req), 'topic', id, 'channel.update');
    await this.mutate.archiveNode('topic', id);
    return parseResponse(OkResponseSchema, { ok: true });
  }

  @Delete('threads/:id')
  async deleteThread(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    await this.requireThreadPermission(requireAuthUserId(req), id, 'channel.update');
    await this.mutate.archiveThread(id);
    return parseResponse(OkResponseSchema, { ok: true });
  }

  @Post('archive/:kind/:id/restore')
  @HttpCode(200)
  async restoreArchived(@Param('kind') kindRaw: string, @Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const kind = ArchivedScopeKindSchema.safeParse(kindRaw);
    if (!kind.success) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'invalid archive scope kind' });

    if (kind.data === 'thread') {
      await this.requireThreadPermission(requireAuthUserId(req), id, 'channel.update', { allowArchived: true });
    } else {
      await this.requireNodePermission(requireAuthUserId(req), kind.data, id, kind.data === 'project' ? 'project.update' : 'channel.update', { allowArchived: true });
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

  private archivedScopeReadAccess(
    userId: string,
    kind: 'project' | 'channel' | 'topic' | 'thread',
    id: string,
  ): Promise<SpaceAccess> {
    const options = { allowArchived: true };
    switch (kind) {
      case 'project': return this.access.projectPermission(userId, id, 'project.read', options);
      case 'channel': return this.access.channelPermission(userId, id, 'channel.read', options);
      case 'topic': return this.access.topicPermission(userId, id, 'message.read', options);
      case 'thread': return this.access.threadPermission(userId, id, 'message.read', options);
    }
  }

  private archivedScopeRestoreAccess(
    userId: string,
    kind: 'project' | 'channel' | 'topic' | 'thread',
    id: string,
  ): Promise<SpaceAccess> {
    const options = { allowArchived: true };
    switch (kind) {
      case 'project': return this.access.projectPermission(userId, id, 'project.update', options);
      case 'channel': return this.access.channelPermission(userId, id, 'channel.update', options);
      case 'topic': return this.access.topicPermission(userId, id, 'channel.update', options);
      case 'thread': return this.access.threadPermission(userId, id, 'channel.update', options);
    }
  }

  private async scopeAccess(userId: string, kind: ContextGraphScopeType, id: string): Promise<SpaceAccess> {
    if (kind === 'thread') return this.access.threadMember(userId, id);
    if (kind === 'project') return this.access.projectMember(userId, id);
    if (kind === 'channel') return this.access.channelMember(userId, id);
    return this.access.topicMember(userId, id);
  }

  private async requireScopeMutation(userId: string, kind: ContextGraphScopeType, id: string): Promise<void> {
    const permission: Permission = kind === 'project' ? 'project.update' : 'channel.update';
    if (kind === 'thread') await this.requireThreadPermission(userId, id, permission);
    else await this.requireNodePermission(userId, kind, id, permission);
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
    const access = kind === 'project'
      ? await this.access.projectMember(userId, id)
      : kind === 'channel'
        ? await this.access.channelMember(userId, id)
        : await this.access.topicMember(userId, id);
    this.throwIfDenied(access);
  }

  private async requireThreadMember(userId: string, id: string): Promise<void> {
    this.throwIfDenied(await this.access.threadMember(userId, id));
  }

  private async requireNodePermission(userId: string, kind: 'project' | 'channel' | 'topic', id: string, permission: Permission, options: { allowArchived?: boolean } = {}): Promise<void> {
    const access = kind === 'project'
      ? options.allowArchived
        ? await this.access.projectPermission(userId, id, permission, options)
        : await this.access.projectPermission(userId, id, permission)
      : kind === 'channel'
        ? options.allowArchived
          ? await this.access.channelPermission(userId, id, permission, options)
          : await this.access.channelPermission(userId, id, permission)
        : options.allowArchived
          ? await this.access.topicPermission(userId, id, permission, options)
          : await this.access.topicPermission(userId, id, permission);
    this.throwIfDenied(access);
  }

  private async requireThreadPermission(userId: string, id: string, permission: Permission, options: { allowArchived?: boolean } = {}): Promise<void> {
    const access = options.allowArchived
      ? await this.access.threadPermission(userId, id, permission, options)
      : await this.access.threadPermission(userId, id, permission);
    this.throwIfDenied(access);
  }

  @Post('projects')
  async project(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(CreateProjectRequestSchema, body);
    const userId = requireAuthUserId(req);
    this.throwIfDenied(await this.access.workspacePermission(userId, cmd.workspaceId, 'project.create'));
    const result = await this.createProject.execute({ ...cmd, actorUserId: userId });
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(CreateProjectResponseSchema, {
      id: result.value.projectId,
      templateApplied: result.value.templateApplied,
      defaultThreadId: result.value.defaultThreadId,
      intakeThreadId: result.value.intakeThreadId,
      created: result.value.created,
    });
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
    this.throwIfDenied(await this.access.projectPermission(userId, cmd.projectId, 'channel.create'));
    const result = await this.createChannel.commit({ ...cmd, actorUserId: userId });
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(CreateChannelResponseSchema, { id: result.value.channelId });
  }

  @Post('channel-bundles')
  async channelBundle(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(CreateChannelBundleRequestSchema, body);
    const userId = requireAuthUserId(req);
    this.throwIfDenied(await this.access.projectPermission(userId, cmd.projectId, 'channel.create'));
    const result = await this.createChannelBundle.execute({ ...cmd, actorUserId: userId });
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(CreateChannelBundleResponseSchema, result.value);
  }

  @Post('channels/:channelId/ensure-conversation')
  async ensureChannelConversation(
    @Param('channelId') channelId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = requireAuthUserId(req);
    this.throwIfDenied(await this.access.channelPermission(userId, channelId, 'topic.create'));
    const result = await this.createChannelBundle.ensureConversation({ channelId, actorUserId: userId });
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(CreateChannelBundleResponseSchema, result.value);
  }

  @Post('topics')
  async topic(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(CreateTopicRequestSchema, body);
    const userId = requireAuthUserId(req);
    this.throwIfDenied(await this.access.channelPermission(userId, cmd.channelId, 'topic.create'));
    const result = await this.createTopic.execute({ ...cmd, actorUserId: userId });
    if (!result.ok) return throwDomainError(result.error);
    return parseResponse(CreateTopicResponseSchema, { id: result.value.topicId });
  }

  @Post('threads')
  async thread(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const cmd = parseBody(CreateThreadRequestSchema, body);
    const userId = requireAuthUserId(req);
    this.throwIfDenied(await this.access.topicPermission(userId, cmd.topicId, 'topic.create'));
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
