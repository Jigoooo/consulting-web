import { z } from 'zod';

const UuidSchema = z.string().uuid();
const RunIdSchema = z.string().trim().min(1).max(128);

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

export const ChatStreamDoneEventSchema = z.object({
  type: z.literal('done'),
  runId: RunIdSchema,
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
  ChatStreamDoneEventSchema,
  ChatStreamErrorEventSchema,
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>;

export const ChatStreamSseFrameSchema = z.object({
  event: z.enum(['start', 'delta', 'tool', 'done', 'error']),
  data: ChatStreamEventSchema,
}).strict();
export type ChatStreamSseFrame = z.infer<typeof ChatStreamSseFrameSchema>;
