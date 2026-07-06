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
  message: z.string().min(1).max(20_000),
  clientMessageId: UuidSchema.optional(),
}).strict();
export type ChatStreamRequest = z.infer<typeof ChatStreamRequestSchema>;

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

export const ChatStreamDoneEventSchema = z.object({
  type: z.literal('done'),
  runId: RunIdSchema,
  usage: ChatStreamUsageSchema.optional(),
}).strict();

export const ChatStreamErrorEventSchema = z.object({
  type: z.literal('error'),
  runId: UuidSchema.optional(),
  code: z.string().min(1),
  message: z.string().min(1),
}).strict();

export const ChatStreamEventSchema = z.discriminatedUnion('type', [
  ChatStreamStartEventSchema,
  ChatStreamDeltaEventSchema,
  ChatStreamToolEventSchema,
  ChatStreamReasoningEventSchema,
  ChatStreamDoneEventSchema,
  ChatStreamErrorEventSchema,
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>;

export const ChatStreamSseFrameSchema = z.object({
  event: z.enum(['start', 'delta', 'tool', 'reasoning', 'done', 'error']),
  data: ChatStreamEventSchema,
}).strict();
export type ChatStreamSseFrame = z.infer<typeof ChatStreamSseFrameSchema>;
