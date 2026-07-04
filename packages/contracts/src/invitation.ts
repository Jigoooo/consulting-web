import { z } from 'zod';

const UuidSchema = z.string().uuid();
const ScopeTypeSchema = z.enum(['workspace', 'project', 'channel', 'topic', 'thread']);
const RoleSchema = z.enum(['owner', 'admin', 'editor', 'commenter', 'viewer']);

export const CreateInvitationRequestSchema = z.object({
  workspaceId: UuidSchema,
  invitedByUserId: UuidSchema,
  email: z.string().email().max(320).optional(),
  scopeType: ScopeTypeSchema,
  scopeId: UuidSchema,
  role: RoleSchema,
  ttlMs: z.number().int().positive().optional(),
}).strict();
export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequestSchema>;

/** Raw token is returned ONLY at creation time so the caller can compose the share link. */
export const CreateInvitationResponseSchema = z.object({
  invitationId: UuidSchema,
  token: z.string().min(1),
}).strict();
export type CreateInvitationResponse = z.infer<typeof CreateInvitationResponseSchema>;

export const InvitationPreviewRequestSchema = z.object({
  token: z.string().min(1),
}).strict();
export type InvitationPreviewRequest = z.infer<typeof InvitationPreviewRequestSchema>;

/** Public landing-page preview. Must never contain raw token or tokenHash. */
export const InvitationPreviewResponseSchema = z.object({
  workspaceId: UuidSchema,
  scopeType: ScopeTypeSchema,
  scopeId: UuidSchema,
  role: RoleSchema,
  expiresAt: z.string().datetime(),
  accepted: z.boolean(),
  emailHint: z.string().email().max(320).nullable(),
}).strict();
export type InvitationPreviewResponse = z.infer<typeof InvitationPreviewResponseSchema>;

export const AcceptInvitationRequestSchema = z.object({
  token: z.string().min(1),
  userId: UuidSchema,
}).strict();
export type AcceptInvitationRequest = z.infer<typeof AcceptInvitationRequestSchema>;

export const AcceptInvitationResponseSchema = z.object({
  membershipId: UuidSchema.or(z.literal('existing')),
}).strict();
export type AcceptInvitationResponse = z.infer<typeof AcceptInvitationResponseSchema>;
