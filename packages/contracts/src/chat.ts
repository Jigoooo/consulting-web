import { z } from 'zod';

const UuidSchema = z.string().uuid();
const RunIdSchema = z.string().trim().min(1).max(128);

export const ChatStreamUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  contextLimit: z.number().int().positive().optional(),
}).strict();
export type ChatStreamUsage = z.infer<typeof ChatStreamUsageSchema>;

export const ChatStreamRequestSchema = z.object({
  threadId: UuidSchema,
  message: z.string().max(20_000),
  clientMessageId: UuidSchema.optional(),
  /** Optional Hermes model route alias from GET /chat/runtime/models. */
  model: z.string().trim().min(1).max(200).optional(),
  /** Draft file attachments to bind to the persisted user message for this turn. */
  attachmentIds: z.array(UuidSchema).max(10).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.message.trim() || (value.attachmentIds?.length ?? 0) > 0) return;
  ctx.addIssue({ code: 'custom', message: 'message or attachmentIds is required', path: ['message'] });
});
export type ChatStreamRequest = z.infer<typeof ChatStreamRequestSchema>;

export const ChatApprovalChoiceSchema = z.enum(['once', 'session', 'always', 'deny']);
export type ChatApprovalChoice = z.infer<typeof ChatApprovalChoiceSchema>;

export const ChatStreamStartEventSchema = z.object({
  type: z.literal('start'),
  runId: RunIdSchema,
  threadId: UuidSchema,
  ts: z.string().datetime(),
  model: z.string().min(1).max(200).optional(),
  contextLimit: z.number().int().positive().optional(),
}).strict();

export const ChatStreamDeltaEventSchema = z.object({
  type: z.literal('delta'),
  runId: RunIdSchema,
  text: z.string(),
}).strict();

/** Tool activity surfaced mid-stream (Phase 2-A) — feeds ThinkingRibbon + evidence. */
export const ChatStreamToolEventSchema = z.object({
  type: z.literal('tool'),
  runId: RunIdSchema,
  phase: z.enum(['started', 'completed']),
  tool: z.string().min(1).max(120),
  preview: z.string().max(500).optional(),
}).strict();

export const ChatStreamReasoningEventSchema = z.object({
  type: z.literal('reasoning'),
  runId: RunIdSchema,
  text: z.string().max(2_000),
}).strict();

export const ChatStreamApprovalEventSchema = z.object({
  type: z.literal('approval'),
  runId: RunIdSchema,
  /** Product-side durable approval ledger id. Server-generated for UI approval responses. */
  approvalId: UuidSchema.optional(),
  /** Upstream action/rule identity. Missing identity is treated as high blast radius. */
  toolId: z.string().min(1).max(120).optional(),
  command: z.string().max(2_000).optional(),
  message: z.string().max(2_000).optional(),
  risk: z.string().max(120).optional(),
  choices: z.array(ChatApprovalChoiceSchema).min(1),
}).strict();

export const ChatStreamDoneEventSchema = z.object({
  type: z.literal('done'),
  runId: RunIdSchema,
  usage: ChatStreamUsageSchema.optional(),
}).strict();

export const ChatStreamErrorEventSchema = z.object({
  type: z.literal('error'),
  runId: RunIdSchema.optional(),
  code: z.string().min(1),
  message: z.string().min(1),
}).strict();

export const ChatStreamEventSchema = z.discriminatedUnion('type', [
  ChatStreamStartEventSchema,
  ChatStreamDeltaEventSchema,
  ChatStreamToolEventSchema,
  ChatStreamReasoningEventSchema,
  ChatStreamApprovalEventSchema,
  ChatStreamDoneEventSchema,
  ChatStreamErrorEventSchema,
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>;

export const ChatStreamSseFrameSchema = z.object({
  event: z.enum(['start', 'delta', 'tool', 'reasoning', 'approval', 'done', 'error']),
  data: ChatStreamEventSchema,
}).strict();
export type ChatStreamSseFrame = z.infer<typeof ChatStreamSseFrameSchema>;

export const ChatRuntimeModelSchema = z.object({
  id: z.string().min(1).max(200),
  /** Exact value to send as ChatStreamRequest.model. Distinct from display label. */
  route: z.string().min(1).max(200),
  label: z.string().min(1).max(240),
  provider: z.string().min(1).max(120),
  modelName: z.string().min(1).max(200),
  root: z.string().min(1).max(240).optional(),
  parent: z.string().min(1).max(240).nullable().optional(),
  current: z.boolean().optional(),
}).strict();
export type ChatRuntimeModel = z.infer<typeof ChatRuntimeModelSchema>;

export const ChatRuntimeModelsResponseSchema = z.object({
  defaultModel: z.string().min(1).max(200).optional(),
  models: z.array(ChatRuntimeModelSchema),
}).strict();
export type ChatRuntimeModelsResponse = z.infer<typeof ChatRuntimeModelsResponseSchema>;

export const ChatRuntimeCapabilitiesResponseSchema = z.object({
  model: z.string().min(1).max(200).optional(),
  features: z.object({
    modelRouting: z.boolean(),
    runStop: z.boolean(),
    runApprovalResponse: z.boolean(),
    approvalEvents: z.boolean(),
  }).strict(),
}).strict();
export type ChatRuntimeCapabilitiesResponse = z.infer<typeof ChatRuntimeCapabilitiesResponseSchema>;

export const ChatRunStatusResponseSchema = z.object({
  runId: RunIdSchema,
  status: z.string().min(1).max(120),
  model: z.string().min(1).max(200).optional(),
  lastEvent: z.string().min(1).max(120).optional(),
  usage: ChatStreamUsageSchema.optional(),
}).strict();
export type ChatRunStatusResponse = z.infer<typeof ChatRunStatusResponseSchema>;

export const ChatRunActionRequestSchema = z.object({
  threadId: UuidSchema,
}).strict();
export type ChatRunActionRequest = z.infer<typeof ChatRunActionRequestSchema>;

export const ChatApprovalResponseRequestSchema = z.object({
  threadId: UuidSchema,
  approvalId: UuidSchema,
  choice: ChatApprovalChoiceSchema,
  resolveAll: z.boolean().optional(),
}).strict();
export type ChatApprovalResponseRequest = z.infer<typeof ChatApprovalResponseRequestSchema>;

export const ChatRunActionResponseSchema = z.object({
  ok: z.literal(true),
  runId: RunIdSchema,
  status: z.string().min(1).max(120).optional(),
}).strict();
export type ChatRunActionResponse = z.infer<typeof ChatRunActionResponseSchema>;
