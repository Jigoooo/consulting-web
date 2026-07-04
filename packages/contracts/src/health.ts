import { z } from 'zod';

/** GET /health/ready — component-level health (design §22). */
export const HealthComponentSchema = z.enum(['ok', 'degraded', 'down']);
export type HealthComponent = z.infer<typeof HealthComponentSchema>;

export const HealthResponseSchema = z.object({
  status: HealthComponentSchema,
  components: z.object({
    api: HealthComponentSchema,
    db: HealthComponentSchema,
    redis: HealthComponentSchema,
    bullmq: HealthComponentSchema,
    hermes: HealthComponentSchema,
  }),
  version: z.string(),
  time: z.string().datetime(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
