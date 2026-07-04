import { z } from 'zod';

const UuidSchema = z.string().uuid();
const NameSchema = z.string().trim().min(1).max(120);
const TitleSchema = z.string().trim().min(1).max(200);
const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/);

export const CreateProjectRequestSchema = z.object({
  workspaceId: UuidSchema,
  name: NameSchema,
  slug: SlugSchema,
}).strict();
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const CreateChannelRequestSchema = z.object({
  projectId: UuidSchema,
  name: NameSchema,
  slug: SlugSchema,
}).strict();
export type CreateChannelRequest = z.infer<typeof CreateChannelRequestSchema>;

export const CreateTopicRequestSchema = z.object({
  channelId: UuidSchema,
  name: NameSchema,
  slug: SlugSchema,
}).strict();
export type CreateTopicRequest = z.infer<typeof CreateTopicRequestSchema>;

export const CreateThreadRequestSchema = z.object({
  topicId: UuidSchema,
  title: TitleSchema,
}).strict();
export type CreateThreadRequest = z.infer<typeof CreateThreadRequestSchema>;

const IdResponseSchema = z.object({ id: UuidSchema }).strict();
export const CreateProjectResponseSchema = IdResponseSchema;
export type CreateProjectResponse = z.infer<typeof CreateProjectResponseSchema>;
export const CreateChannelResponseSchema = IdResponseSchema;
export type CreateChannelResponse = z.infer<typeof CreateChannelResponseSchema>;
export const CreateTopicResponseSchema = IdResponseSchema;
export type CreateTopicResponse = z.infer<typeof CreateTopicResponseSchema>;
export const CreateThreadResponseSchema = IdResponseSchema;
export type CreateThreadResponse = z.infer<typeof CreateThreadResponseSchema>;
