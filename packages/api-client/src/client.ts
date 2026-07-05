import {
  AuthSessionResponseSchema,
  SignUpBootstrapResponseSchema,
  CreateInvitationResponseSchema,
  InvitationPreviewResponseSchema,
  AcceptInvitationResponseSchema,
  CreateProjectResponseSchema,
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
  type CreateChannelRequest,
  type CreateTopicRequest,
  type CreateThreadRequest,
  type CreateProjectResponse,
  type CreateChannelResponse,
  type CreateTopicResponse,
  type CreateThreadResponse,
  type ChatStreamRequest,
  type ChatStreamEvent,
  ListWorkspacesResponseSchema,
  WorkspaceTreeResponseSchema,
  ListThreadsResponseSchema,
  ThreadDetailResponseSchema,
  ListMessagesResponseSchema,
  ListMembersResponseSchema,
  OkResponseSchema,
  type ListWorkspacesResponse,
  type WorkspaceTreeResponse,
  type ListThreadsResponse,
  type ThreadDetailResponse,
  type ListMessagesResponse,
  type ListMembersResponse,
  type OkResponse,
  ListEvidenceResponseSchema,
  ListArtifactsResponseSchema,
  ArtifactDetailResponseSchema,
  CreateArtifactResponseSchema,
  ListNotificationsResponseSchema,
  type AddEvidenceRequest,
  type ListEvidenceResponse,
  type CreateArtifactRequest,
  type AddArtifactVersionRequest,
  type CreateArtifactResponse,
  type ListArtifactsResponse,
  type ArtifactDetailResponse,
  type ListNotificationsResponse,
  UploadAttachmentResponseSchema,
  ListAttachmentsResponseSchema,
  type UploadAttachmentRequest,
  type UploadAttachmentResponse,
  type ListAttachmentsResponse,
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

  listMembers(workspaceId: string): Promise<ListMembersResponse> {
    return this.http.request(`/spaces/workspaces/${workspaceId}/members`, { method: 'GET' }, (d) =>
      ListMembersResponseSchema.parse(d),
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

  deleteNode(kind: 'projects' | 'channels' | 'topics' | 'threads', id: string): Promise<OkResponse> {
    return this.http.request(`/spaces/${kind}/${id}`, { method: 'DELETE' }, (d) => OkResponseSchema.parse(d));
  }

  // --- spaces ---
  createProject(body: CreateProjectRequest): Promise<CreateProjectResponse> {
    return this.http.request('/spaces/projects', { method: 'POST', body }, (d) =>
      CreateProjectResponseSchema.parse(d),
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
    });
    yield* readChatSseStream(response);
  }

  // --- evidence (Phase 2-A) ---
  listEvidence(threadId: string): Promise<ListEvidenceResponse> {
    return this.http.request(`/chat/threads/${threadId}/evidence`, { method: 'GET' }, (d) =>
      ListEvidenceResponseSchema.parse(d),
    );
  }

  addEvidence(body: AddEvidenceRequest): Promise<OkResponse> {
    return this.http.request('/chat/evidence', { method: 'POST', body }, (d) => OkResponseSchema.parse(d));
  }

  // --- artifacts (Phase 2-B) ---
  listArtifacts(workspaceId: string): Promise<ListArtifactsResponse> {
    return this.http.request(`/artifacts/workspaces/${workspaceId}`, { method: 'GET' }, (d) =>
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

  /** Authenticated binary download — returns a blob URL the caller must revoke. */
  async downloadAttachment(id: string): Promise<Blob> {
    const response = await this.http.raw(`/attachments/${id}/content`, { method: 'GET' });
    return response.blob();
  }

  /** Authenticated artifact export (PDF/DOCX) — returns a downloadable blob. */
  async exportArtifact(id: string, format: 'pdf' | 'docx', version?: number): Promise<Blob> {
    const params = new URLSearchParams({ format });
    if (version) params.set('version', String(version));
    const response = await this.http.raw(`/artifacts/${id}/export?${params.toString()}`, { method: 'GET' });
    return response.blob();
  }
}
