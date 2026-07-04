import { z } from 'zod';

const UuidSchema = z.string().uuid();

export const ChatStreamRequestSchema = z.object({
  threadId: UuidSchema,
  message: z.string().min(1).max(20_000),
  clientMessageId: UuidSchema.optional(),
}).strict();
export type ChatStreamRequest = z.infer<typeof ChatStreamRequestSchema>;

export const ChatStreamStartEventSchema = z.object({
  type: z.literal('start'),
  runId: UuidSchema,
  threadId: UuidSchema,
  ts: z.string().datetime(),
}).strict();

export const ChatStreamDeltaEventSchema = z.object({
  type: z.literal('delta'),
  runId: UuidSchema,
  text: z.string(),
}).strict();

export const ChatStreamDoneEventSchema = z.object({
  type: z.literal('done'),
  runId: UuidSchema,
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
  ChatStreamDoneEventSchema,
  ChatStreamErrorEventSchema,
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>;

export const ChatStreamSseFrameSchema = z.object({
  event: z.enum(['start', 'delta', 'done', 'error']),
  data: ChatStreamEventSchema,
}).strict();
export type ChatStreamSseFrame = z.infer<typeof ChatStreamSseFrameSchema>;
