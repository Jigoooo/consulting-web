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
}
