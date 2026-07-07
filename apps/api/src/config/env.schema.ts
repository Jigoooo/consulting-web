import { z } from 'zod';

/**
 * Environment contract (ADR-0014). App MUST fail to boot on invalid/missing env.
 * Secrets live only here on the server side; never sent to the browser (ADR-0007).
 */
export const EnvSchema = z.object({
  APP_ENV: z.enum(['local', 'dev', 'staging', 'production', 'test']),
  APP_PUBLIC_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),

  HERMES_API_BASE_URL: z.string().url(),
  HERMES_API_KEY: z.string().min(1),
  HERMES_CONFIG_PATH: z.string().optional(),

  // Web Push (2026-07-06). Optional — when unset, push endpoints return
  // publicKey: null and the sender no-ops; the in-app bell keeps working.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:admin@localhost'),
});

export type Env = z.infer<typeof EnvSchema>;

export interface ParseResult {
  readonly ok: boolean;
  readonly env?: Env;
  readonly errors?: string[];
}

/** Pure parser — used by ConfigModule and by tests without booting Nest. */
export function parseEnv(raw: NodeJS.ProcessEnv): ParseResult {
  const result = EnvSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, env: result.data };
  }
  const errors = result.error.issues.map(
    (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
  );
  return { ok: false, errors };
}
