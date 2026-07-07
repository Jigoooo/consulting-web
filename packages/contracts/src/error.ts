import { z } from 'zod';

/**
 * Canonical API error envelope. Mirrors shared DomainErrorCode so the browser
 * can parse failures type-safely. HTTP status is applied at the adapter layer;
 * the wire body is always { code, message }. Never carries stack/details/secrets.
 */
export const ApiErrorCodeSchema = z.enum([
  'VALIDATION',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PARENT_ARCHIVED',
  'IDEMPOTENCY',
  'PRECONDITION',
  'INTERNAL',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string().min(1).max(2_000),
}).strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;
