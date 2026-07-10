import {
  AuthSessionResponseSchema,
  SignUpBootstrapResponseSchema,
  CreateInvitationResponseSchema,
  InvitationPreviewResponseSchema,
  AcceptInvitationResponseSchema,
  CreateProjectResponseSchema,
  CreateWorkspaceResponseSchema,
  CreateChannelResponseSchema,
  CreateTopicResponseSchema,
  CreateThreadResponseSchema,
  type SignUpRequest,
  type LoginRequest,
  type AuthSessionResponse,
  type SignUpBootstrapResponse,
  type CreateInvitationRequest,
  type CreateInvitationResponse,
  type InvitationPreviewResponse,
  type AcceptInvitationResponse,
  type CreateProjectRequest,
  type CreateWorkspaceRequest,
  type CreateChannelRequest,
  type CreateTopicRequest,
  type CreateThreadRequest,
  type CreateProjectResponse,
  type CreateWorkspaceResponse,
  type CreateChannelResponse,
  type CreateTopicResponse,
  type CreateThreadResponse,
  type ChatStreamRequest,
  type ChatStreamEvent,
  ChatRuntimeModelsResponseSchema,
  ChatRuntimeCapabilitiesResponseSchema,
  ChatRunStatusResponseSchema,
  ChatRunActionResponseSchema,
  type ChatRuntimeModelsResponse,
  type ChatRuntimeCapabilitiesResponse,
  type ChatRunStatusResponse,
  type ChatApprovalResponseRequest,
  type ChatRunActionResponse,
  ListWorkspacesResponseSchema,
  ListArchivedScopesResponseSchema,
  WorkspaceTreeResponseSchema,
  ListThreadsResponseSchema,
  ThreadDetailResponseSchema,
  ListMessagesResponseSchema,
  ListMessagesPageResponseSchema,
  SearchMessagesResponseSchema,
  ListMembersResponseSchema,
  CreateContextEdgeResponseSchema,
  ListContextEdgesResponseSchema,
  ScopeProfileResponseSchema,
  OkResponseSchema,
  type ListWorkspacesResponse,
  type ArchivedScopeKind,
  type ListArchivedScopesResponse,
  type WorkspaceTreeResponse,
  type ListThreadsResponse,
  type ThreadDetailResponse,
  type ListMessagesResponse,
  type ListMessagesPageRequest,
  type ListMessagesPageResponse,
  type SearchMessagesRequest,
  type SearchMessagesResponse,
  type ListMembersResponse,
  type CreateContextEdgeRequest,
  type CreateContextEdgeResponse,
  type ListContextEdgesRequest,
  type ListContextEdgesResponse,
  type ScopeProfileResponse,
  type UpdateScopeProfileRequest,
  type OkResponse,
  ListEvidenceResponseSchema,
  EvidenceDecisionSummaryResponseSchema,
  ReviewQueueResponseSchema,
  ListArtifactsResponseSchema,
  ArtifactDetailResponseSchema,
  CreateArtifactResponseSchema,
  ArtifactExportPreflightResponseSchema,
  ListNotificationsResponseSchema,
  type AddEvidenceRequest,
  type ListEvidenceResponse,
  type EvidenceDecisionSummaryResponse,
  type ReviewQueueResponse,
  type ReviewQueueDecisionRequest,
  type CreateArtifactRequest,
  type AddArtifactVersionRequest,
  type VerifyArtifactVersionRequest,
  type CreateArtifactResponse,
  type ListArtifactsResponse,
  type ArtifactDetailResponse,
  type ArtifactExportPreflightResponse,
  type ListNotificationsResponse,
  UploadAttachmentResponseSchema,
  ListAttachmentsResponseSchema,
  AttachmentExtractionResponseSchema,
  type UploadAttachmentRequest,
  type UploadAttachmentResponse,
  type ListAttachmentsResponse,
  type AttachmentExtractionResponse,
  PushPublicKeyResponseSchema,
  type PushPublicKeyResponse,
  type PushSubscribeRequest,
  ListLibrarySourcesResponseSchema,
  type ListLibrarySourcesResponse,
  ObservabilityTraceListResponseSchema,
  type ObservabilityTraceListResponse,
} from '@consulting/contracts';
import { HttpCore, type ApiClientOptions } from './http-core.js';
import { readChatSseStream } from './sse.js';

/**
 * Typed client for the consulting-web API. Every method parses the response
 * against the shared Zod contract, so the browser gets compile-time types AND
 * runtime validation. Secrets (Hermes key, JWT secret) never transit this
 * client — only the intended access/refresh envelope does.
 */
export class ConsultingApiClient {
  private readonly http: HttpCore;

  constructor(options: ApiClientOptions) {
    this.http = new HttpCore(options);
  }

  // --- auth ---
  signup(body: SignUpRequest): Promise<SignUpBootstrapResponse> {
    return this.http.request('/auth/signup', { method: 'POST', body, auth: false }, (d) =>
      SignUpBootstrapResponseSchema.parse(d),
    );
  }

  login(body: LoginRequest): Promise<AuthSessionResponse> {
    return this.http.request('/auth/login', { method: 'POST', body, auth: false }, (d) =>
      AuthSessionResponseSchema.parse(d),
    );
  }

  /** Rotate a refresh token for a fresh access+refresh pair (N-3). */
  refresh(refreshToken: string): Promise<AuthSessionResponse> {
    return this.http.request('/auth/refresh', { method: 'POST', body: { refreshToken }, auth: false }, (d) =>
      AuthSessionResponseSchema.parse(d),
    );
  }

  // --- invitations ---
  createInvitation(body: CreateInvitationRequest): Promise<CreateInvitationResponse> {
    return this.http.request('/invitations', { method: 'POST', body }, (d) =>
      CreateInvitationResponseSchema.parse(d),
    );
  }

  /** Non-consuming landing preview. No auth required (public share-link). */
  previewInvitation(token: string): Promise<InvitationPreviewResponse> {
    return this.http.request('/invitations/preview', { method: 'POST', body: { token }, auth: false }, (d) =>
      InvitationPreviewResponseSchema.parse(d),
    );
  }

  acceptInvitation(token: string): Promise<AcceptInvitationResponse> {
    return this.http.request('/invitations/accept', { method: 'POST', body: { token } }, (d) =>
      AcceptInvitationResponseSchema.parse(d),
    );
  }

  // --- spaces (read) ---
  listWorkspaces(): Promise<ListWorkspacesResponse> {
    return this.http.request('/spaces/workspaces', { method: 'GET' }, (d) =>
      ListWorkspacesResponseSchema.parse(d),
    );
  }

  workspaceTree(workspaceId: string): Promise<WorkspaceTreeResponse> {
    return this.http.request(`/spaces/workspaces/${workspaceId}/tree`, { method: 'GET' }, (d) =>
      WorkspaceTreeResponseSchema.parse(d),
    );
  }

  listThreads(topicId: string): Promise<ListThreadsResponse> {
    return this.http.request(`/spaces/topics/${topicId}/threads`, { method: 'GET' }, (d) =>
      ListThreadsResponseSchema.parse(d),
    );
  }

  threadDetail(threadId: string): Promise<ThreadDetailResponse> {
    return this.http.request(`/spaces/threads/${threadId}`, { method: 'GET' }, (d) =>
      ThreadDetailResponseSchema.parse(d),
    );
  }

  listMessages(threadId: string): Promise<ListMessagesResponse> {
    return this.http.request(`/chat/threads/${threadId}/messages`, { method: 'GET' }, (d) =>
      ListMessagesResponseSchema.parse(d),
    );
  }

  listMessagesPage(threadId: string, query: ListMessagesPageRequest = {}): Promise<ListMessagesPageResponse> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.before !== undefined) params.set('before', query.before);
    if (query.after !== undefined) params.set('after', query.after);
    if (query.around !== undefined) params.set('around', query.around);
    if (query.direction !== undefined) params.set('direction', query.direction);
    const suffix = params.size > 0 ? `?${params.toString()}` : '?page=1';
    return this.http.request(`/chat/threads/${threadId}/messages${suffix}`, { method: 'GET' }, (d) =>
      ListMessagesPageResponseSchema.parse(d),
    );
  }

  searchMessages(threadId: string, query: SearchMessagesRequest): Promise<SearchMessagesResponse> {
    const params = new URLSearchParams();
    params.set('q', query.q);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    return this.http.request(`/chat/threads/${threadId}/messages/search?${params.toString()}`, { method: 'GET' }, (d) =>
      SearchMessagesResponseSchema.parse(d),
    );
  }

  listMembers(workspaceId: string): Promise<ListMembersResponse> {
    return this.http.request(`/spaces/workspaces/${workspaceId}/members`, { method: 'GET' }, (d) =>
      ListMembersResponseSchema.parse(d),
    );
  }

  listArchivedScopes(workspaceId: string): Promise<ListArchivedScopesResponse> {
    return this.http.request(`/spaces/workspaces/${workspaceId}/archive`, { method: 'GET' }, (d) =>
      ListArchivedScopesResponseSchema.parse(d),
    );
  }

  createContextEdge(body: CreateContextEdgeRequest): Promise<CreateContextEdgeResponse> {
    return this.http.request('/spaces/context-edges', { method: 'POST', body }, (d) =>
      CreateContextEdgeResponseSchema.parse(d),
    );
  }

  listContextEdges(query: ListContextEdgesRequest): Promise<ListContextEdgesResponse> {
    const params = new URLSearchParams();
    params.set('scopeType', query.scopeType);
    params.set('scopeId', query.scopeId);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    return this.http.request(`/spaces/context-edges?${params.toString()}`, { method: 'GET' }, (d) =>
      ListContextEdgesResponseSchema.parse(d),
    );
  }

  deleteContextEdge(edgeId: string): Promise<OkResponse> {
    return this.http.request(`/spaces/context-edges/${edgeId}`, { method: 'DELETE' }, (d) => OkResponseSchema.parse(d));
  }

  getProjectProfile(projectId: string): Promise<ScopeProfileResponse> {
    return this.http.request(`/spaces/projects/${projectId}/profile`, { method: 'GET' }, (d) =>
      ScopeProfileResponseSchema.parse(d),
    );
  }

  updateProjectProfile(projectId: string, body: UpdateScopeProfileRequest): Promise<ScopeProfileResponse> {
    return this.http.request(`/spaces/projects/${projectId}/profile`, { method: 'PATCH', body }, (d) =>
      ScopeProfileResponseSchema.parse(d),
    );
  }

  getChannelProfile(channelId: string): Promise<ScopeProfileResponse> {
    return this.http.request(`/spaces/channels/${channelId}/profile`, { method: 'GET' }, (d) =>
      ScopeProfileResponseSchema.parse(d),
    );
  }

  updateChannelProfile(channelId: string, body: UpdateScopeProfileRequest): Promise<ScopeProfileResponse> {
    return this.http.request(`/spaces/channels/${channelId}/profile`, { method: 'PATCH', body }, (d) =>
      ScopeProfileResponseSchema.parse(d),
    );
  }

  getTopicProfile(topicId: string): Promise<ScopeProfileResponse> {
    return this.http.request(`/spaces/topics/${topicId}/profile`, { method: 'GET' }, (d) =>
      ScopeProfileResponseSchema.parse(d),
    );
  }

  updateTopicProfile(topicId: string, body: UpdateScopeProfileRequest): Promise<ScopeProfileResponse> {
    return this.http.request(`/spaces/topics/${topicId}/profile`, { method: 'PATCH', body }, (d) =>
      ScopeProfileResponseSchema.parse(d),
    );
  }

  // --- spaces (mutate, N-4) ---
  renameNode(kind: 'projects' | 'channels' | 'topics', id: string, name: string): Promise<OkResponse> {
    return this.http.request(`/spaces/${kind}/${id}`, { method: 'PATCH', body: { name } }, (d) =>
      OkResponseSchema.parse(d),
    );
  }

  renameThread(id: string, title: string): Promise<OkResponse> {
    return this.http.request(`/spaces/threads/${id}`, { method: 'PATCH', body: { title } }, (d) =>
      OkResponseSchema.parse(d),
    );
  }

  archiveNode(kind: 'projects' | 'channels' | 'topics' | 'threads', id: string): Promise<OkResponse> {
    return this.http.request(`/spaces/${kind}/${id}`, { method: 'DELETE' }, (d) => OkResponseSchema.parse(d));
  }

  restoreArchived(kind: ArchivedScopeKind, id: string): Promise<OkResponse> {
    return this.http.request(`/spaces/archive/${kind}/${id}/restore`, { method: 'POST' }, (d) => OkResponseSchema.parse(d));
  }

  // --- spaces ---
  createProject(body: CreateProjectRequest): Promise<CreateProjectResponse> {
    return this.http.request('/spaces/projects', { method: 'POST', body }, (d) =>
      CreateProjectResponseSchema.parse(d),
    );
  }

  createWorkspace(body: CreateWorkspaceRequest): Promise<CreateWorkspaceResponse> {
    return this.http.request('/spaces/workspaces', { method: 'POST', body }, (d) =>
      CreateWorkspaceResponseSchema.parse(d),
    );
  }

  createChannel(body: CreateChannelRequest): Promise<CreateChannelResponse> {
    return this.http.request('/spaces/channels', { method: 'POST', body }, (d) =>
      CreateChannelResponseSchema.parse(d),
    );
  }

  createTopic(body: CreateTopicRequest): Promise<CreateTopicResponse> {
    return this.http.request('/spaces/topics', { method: 'POST', body }, (d) =>
      CreateTopicResponseSchema.parse(d),
    );
  }

  createThread(body: CreateThreadRequest): Promise<CreateThreadResponse> {
    return this.http.request('/spaces/threads', { method: 'POST', body }, (d) =>
      CreateThreadResponseSchema.parse(d),
    );
  }

  // --- chat ---
  /**
   * Open a chat stream for a thread and yield strict ChatStreamEvents.
   * Pass an AbortSignal to cancel the stream (composer cancel button).
   */
  async *streamChat(body: ChatStreamRequest, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
    const response = await this.http.raw('/chat/stream', {
      method: 'POST',
      body,
      ...(signal ? { signal } : {}),
      timeoutMs: false,
    });
    yield* readChatSseStream(response);
  }

  // --- Hermes runtime control (slash/model/status/approval/stop) ---
  listRuntimeModels(): Promise<ChatRuntimeModelsResponse> {
    return this.http.request('/chat/runtime/models', { method: 'GET' }, (d) =>
      ChatRuntimeModelsResponseSchema.parse(d),
    );
  }

  runtimeCapabilities(): Promise<ChatRuntimeCapabilitiesResponse> {
    return this.http.request('/chat/runtime/capabilities', { method: 'GET' }, (d) =>
      ChatRuntimeCapabilitiesResponseSchema.parse(d),
    );
  }

  runStatus(runId: string, threadId: string): Promise<ChatRunStatusResponse> {
    const params = new URLSearchParams({ threadId });
    return this.http.request(`/chat/runtime/runs/${encodeURIComponent(runId)}?${params.toString()}`, { method: 'GET' }, (d) =>
      ChatRunStatusResponseSchema.parse(d),
    );
  }

  stopRun(runId: string, threadId: string): Promise<ChatRunActionResponse> {
    return this.http.request(`/chat/runtime/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST', body: { threadId } }, (d) =>
      ChatRunActionResponseSchema.parse(d),
    );
  }

  respondRunApproval(runId: string, body: ChatApprovalResponseRequest): Promise<ChatRunActionResponse> {
    return this.http.request(`/chat/runtime/runs/${encodeURIComponent(runId)}/approval`, { method: 'POST', body }, (d) =>
      ChatRunActionResponseSchema.parse(d),
    );
  }

  // --- evidence (Phase 2-A) ---
  listEvidence(threadId: string): Promise<ListEvidenceResponse> {
    return this.http.request(`/chat/threads/${threadId}/evidence`, { method: 'GET' }, (d) =>
      ListEvidenceResponseSchema.parse(d),
    );
  }

  /** #6: project-scoped evidence aggregated across all channels of a project. */
  listProjectEvidence(projectId: string): Promise<ListEvidenceResponse> {
    return this.http.request(`/chat/projects/${projectId}/evidence`, { method: 'GET' }, (d) =>
      ListEvidenceResponseSchema.parse(d),
    );
  }

  addEvidence(body: AddEvidenceRequest): Promise<OkResponse> {
    return this.http.request('/chat/evidence', { method: 'POST', body }, (d) => OkResponseSchema.parse(d));
  }

  evidenceDecisionSummary(threadId: string): Promise<EvidenceDecisionSummaryResponse> {
    return this.http.request(`/chat/threads/${threadId}/evidence-decision/summary`, { method: 'GET' }, (d) =>
      EvidenceDecisionSummaryResponseSchema.parse(d),
    );
  }

  reviewQueue(threadId: string): Promise<ReviewQueueResponse> {
    return this.http.request(`/chat/threads/${threadId}/review-queue`, { method: 'GET' }, (d) =>
      ReviewQueueResponseSchema.parse(d),
    );
  }

  decideReviewQueueItem(threadId: string, itemId: string, body: ReviewQueueDecisionRequest): Promise<OkResponse> {
    return this.http.request(
      `/chat/threads/${threadId}/review-queue/${encodeURIComponent(itemId)}/decision`,
      { method: 'POST', body },
      (d) => OkResponseSchema.parse(d),
    );
  }

  // --- artifacts (Phase 2-B) ---
  listArtifacts(workspaceId: string, projectId?: string): Promise<ListArtifactsResponse> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return this.http.request(`/artifacts/workspaces/${workspaceId}${qs}`, { method: 'GET' }, (d) =>
      ListArtifactsResponseSchema.parse(d),
    );
  }

  artifactDetail(id: string): Promise<ArtifactDetailResponse> {
    return this.http.request(`/artifacts/${id}`, { method: 'GET' }, (d) =>
      ArtifactDetailResponseSchema.parse(d),
    );
  }

  createArtifact(body: CreateArtifactRequest): Promise<CreateArtifactResponse> {
    return this.http.request('/artifacts', { method: 'POST', body }, (d) =>
      CreateArtifactResponseSchema.parse(d),
    );
  }

  addArtifactVersion(id: string, body: AddArtifactVersionRequest): Promise<CreateArtifactResponse> {
    return this.http.request(`/artifacts/${id}/versions`, { method: 'POST', body }, (d) =>
      CreateArtifactResponseSchema.parse(d),
    );
  }

  verifyArtifactVersion(id: string, body: VerifyArtifactVersionRequest): Promise<ArtifactExportPreflightResponse> {
    return this.http.request(`/artifacts/${id}/verify`, { method: 'POST', body }, (d) =>
      ArtifactExportPreflightResponseSchema.parse(d),
    );
  }

  deleteArtifact(id: string): Promise<OkResponse> {
    return this.http.request(`/artifacts/${id}`, { method: 'DELETE' }, (d) => OkResponseSchema.parse(d));
  }

  // --- notifications (Phase 2-C) ---
  listNotifications(): Promise<ListNotificationsResponse> {
    return this.http.request('/notifications', { method: 'GET' }, (d) =>
      ListNotificationsResponseSchema.parse(d),
    );
  }

  markNotificationsRead(ids?: string[]): Promise<OkResponse> {
    return this.http.request('/notifications/read', { method: 'POST', body: ids ? { ids } : {} }, (d) =>
      OkResponseSchema.parse(d),
    );
  }

  // --- Web Push (2026-07-06) ---
  pushPublicKey(): Promise<PushPublicKeyResponse> {
    return this.http.request('/push/public-key', { method: 'GET' }, (d) =>
      PushPublicKeyResponseSchema.parse(d),
    );
  }

  pushSubscribe(body: PushSubscribeRequest): Promise<OkResponse> {
    return this.http.request('/push/subscribe', { method: 'POST', body }, (d) => OkResponseSchema.parse(d));
  }

  pushUnsubscribe(endpoint: string): Promise<OkResponse> {
    return this.http.request('/push/unsubscribe', { method: 'POST', body: { endpoint } }, (d) =>
      OkResponseSchema.parse(d),
    );
  }

  // --- attachments (Phase 2-D G-3) ---
  uploadAttachment(body: UploadAttachmentRequest): Promise<UploadAttachmentResponse> {
    return this.http.request('/attachments', { method: 'POST', body }, (d) =>
      UploadAttachmentResponseSchema.parse(d),
    );
  }

  listAttachments(threadId: string): Promise<ListAttachmentsResponse> {
    return this.http.request(`/attachments/threads/${threadId}`, { method: 'GET' }, (d) =>
      ListAttachmentsResponseSchema.parse(d),
    );
  }

  deleteAttachment(id: string): Promise<OkResponse> {
    return this.http.request(`/attachments/${id}`, { method: 'DELETE' }, (d) => OkResponseSchema.parse(d));
  }

  /** 축3: 추출 텍스트(파일 뷰어용). */
  getAttachmentExtraction(id: string): Promise<AttachmentExtractionResponse> {
    return this.http.request(`/attachments/${id}/extraction`, { method: 'GET' }, (d) =>
      AttachmentExtractionResponseSchema.parse(d),
    );
  }

  /** 축4: 자료실 집계 목록(워크스페이스/프로젝트 단위). */
  listLibrarySources(
    workspaceId: string,
    opts?: { projectId?: string; type?: string; q?: string; cursor?: string },
  ): Promise<ListLibrarySourcesResponse> {
    const params = new URLSearchParams();
    if (opts?.projectId) params.set('projectId', opts.projectId);
    if (opts?.type) params.set('type', opts.type);
    if (opts?.q) params.set('q', opts.q);
    if (opts?.cursor) params.set('cursor', opts.cursor);
    const qs = params.toString();
    return this.http.request(
      `/library/workspaces/${workspaceId}/sources${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
      (d) => ListLibrarySourcesResponseSchema.parse(d),
    );
  }

  /** P4 Trace Viewer: trace spans + eval ledger for an authenticated workspace. */
  listObservabilityTraces(
    workspaceId: string,
    opts?: { threadId?: string; traceId?: string; limit?: number; cursor?: string },
  ): Promise<ObservabilityTraceListResponse> {
    const params = new URLSearchParams();
    if (opts?.threadId) params.set('threadId', opts.threadId);
    if (opts?.traceId) params.set('traceId', opts.traceId);
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts?.cursor) params.set('cursor', opts.cursor);
    const qs = params.toString();
    return this.http.request(
      `/observability/workspaces/${workspaceId}/traces${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
      (d) => ObservabilityTraceListResponseSchema.parse(d),
    );
  }

  /** Authenticated binary download — returns a blob URL the caller must revoke. */
  async downloadAttachment(id: string): Promise<Blob> {
    const response = await this.http.raw(`/attachments/${id}/content`, { method: 'GET' });
    return response.blob();
  }

  /** Authenticated artifact export preflight — same verifier gate as final export, no rendering. */
  exportArtifactPreflight(id: string, format: 'pdf' | 'docx', version?: number): Promise<ArtifactExportPreflightResponse> {
    const params = new URLSearchParams({ format });
    if (version) params.set('version', String(version));
    return this.http.request(`/artifacts/${id}/export-preflight?${params.toString()}`, { method: 'GET' }, (d) =>
      ArtifactExportPreflightResponseSchema.parse(d),
    );
  }

  /** Authenticated artifact export (PDF/DOCX) — returns a downloadable blob. */
  async exportArtifact(id: string, format: 'pdf' | 'docx', version?: number): Promise<Blob> {
    const params = new URLSearchParams({ format });
    if (version) params.set('version', String(version));
    const response = await this.http.raw(`/artifacts/${id}/export?${params.toString()}`, { method: 'GET' });
    return response.blob();
  }
}
