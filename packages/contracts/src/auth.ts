import { z } from 'zod';

/**
 * Auth contracts (ADR-0006). Response schemas MUST NOT contain secrets:
 * no password_hash, no tokens beyond the intended access/refresh envelope,
 * no Hermes key. Enforced by test/no-secret-leak.test.ts.
 */
export const EmailSchema = z.string().email().max(320);
export const PasswordSchema = z.string().min(10).max(200);

export const SignUpRequestSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  displayName: z.string().min(1).max(120),
}).strict();
export type SignUpRequest = z.infer<typeof SignUpRequestSchema>;

export const PublicUserSchema = z.object({
  id: z.string().uuid(),
  email: EmailSchema,
  displayName: z.string(),
  status: z.enum(['active', 'suspended', 'deleted_soft']),
}).strict();
export type PublicUser = z.infer<typeof PublicUserSchema>;

export const AuthTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresInSec: z.number().int().positive(),
}).strict();
export type AuthTokens = z.infer<typeof AuthTokensSchema>;

export const SignUpResponseSchema = z.object({
  user: PublicUserSchema,
  personalWorkspaceId: z.string().uuid(),
  tokens: AuthTokensSchema,
}).strict();
export type SignUpResponse = z.infer<typeof SignUpResponseSchema>;

export const LoginRequestSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
}).strict();
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
