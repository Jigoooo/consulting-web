import { z } from 'zod';

const BooleanFlagSchema = z.preprocess((value) => {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return value;
}, z.boolean());

const OptionalUrlSchema = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().url().optional(),
);

const OptionalSecretSchema = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().min(1).optional(),
);

function canonicalBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '') || '/';
  return parsed.toString().replace(/\/$/u, '');
}

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
  // P5 runtime governance: consulting-web fails closed before starting a
  // Hermes run if the API server exposes enabled toolsets outside this list.
  HERMES_TOOL_POLICY_ENFORCED: BooleanFlagSchema.optional(),
  HERMES_ALLOWED_TOOLSETS: z.string().optional(),

  // Consulting projects default to the safe consulting_default skeleton unless
  // explicitly disabled server-side. No browser-exposed secrets or brain keys.
  CONSULTING_DEFAULT_TEMPLATE_ENABLED: BooleanFlagSchema.default(true),

  // Multimodal document embeddings. Disabled by default; key stays server-side
  // and is read through SecretProvider only.
  VOYAGE_MULTIMODAL_ENABLED: BooleanFlagSchema.default(false),
  VOYAGE_API_BASE_URL: z.string().url().default('https://api.voyageai.com'),
  VOYAGE_API_KEY: z.string().optional(),
  VOYAGE_MULTIMODAL_MODEL: z.string().default('voyage-multimodal-3.5'),

  // Claim verification cascade. Disabled by default to avoid surprise LLM cost;
  // when enabled, the server uses Hermes Runs API and still validates strict JSON.
  VERIFIER_LLM_ENABLED: BooleanFlagSchema.default(false),
  VERIFIER_LLM_MODEL: z.string().optional(),
  VERIFIER_LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // Content-bound adversarial artifact review rollout. Off prevents surprise LLM cost;
  // shadow and warning require explicit promotions. Warning remains non-blocking.
  ARTIFACT_RED_TEAM_MODE: z.enum(['off', 'shadow', 'warning']).default('off'),
  ARTIFACT_RED_TEAM_API_BASE_URL: OptionalUrlSchema,
  ARTIFACT_RED_TEAM_API_KEY: OptionalSecretSchema,
  ARTIFACT_RED_TEAM_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),

  // V3-4: response-invariant Web shadow. Off is the default and instant rollback.
  CONSULTING_INSIGHT_WEB_SHADOW_MODE: z.enum(['off', 'shadow']).optional(),
  CONSULTING_INSIGHT_WEB_SHADOW_THREAD_IDS: z.string().optional(),
  CONSULTING_INSIGHT_POLICY_HASH: z.string().regex(/^[a-f0-9]{64}$/u).optional(),

  // W3: shadow-only report workflow. "off" is the instant rollback switch.
  REPORT_WORKFLOW_SHADOW_MODE: z.enum(['off', 'observe']).default('off'),

  // Web Push (2026-07-06). Optional — when unset, push endpoints return
  // publicKey: null and the sender no-ops; the in-app bell keeps working.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:admin@localhost'),
}).superRefine((env, context) => {
  if (env.CONSULTING_INSIGHT_WEB_SHADOW_MODE === 'shadow') {
    const threadIds = (env.CONSULTING_INSIGHT_WEB_SHADOW_THREAD_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    if (threadIds.length === 0 || threadIds.some((value) => !z.string().uuid().safeParse(value).success)) {
      context.addIssue({ code: 'custom', path: ['CONSULTING_INSIGHT_WEB_SHADOW_THREAD_IDS'], message: 'shadow mode requires a non-empty comma-separated UUID allowlist' });
    }
    if (!env.CONSULTING_INSIGHT_POLICY_HASH) {
      context.addIssue({ code: 'custom', path: ['CONSULTING_INSIGHT_POLICY_HASH'], message: 'required in consulting insight shadow mode' });
    }
  }
  const dedicatedEndpointRequired = env.ARTIFACT_RED_TEAM_MODE !== 'off'
    || env.CONSULTING_INSIGHT_WEB_SHADOW_MODE === 'shadow';
  if (!dedicatedEndpointRequired) return;
  if (!env.ARTIFACT_RED_TEAM_API_BASE_URL) {
    context.addIssue({
      code: 'custom',
      path: ['ARTIFACT_RED_TEAM_API_BASE_URL'],
      message: 'required when ARTIFACT_RED_TEAM_MODE is shadow or warning',
    });
  }
  if (!env.ARTIFACT_RED_TEAM_API_KEY) {
    context.addIssue({
      code: 'custom',
      path: ['ARTIFACT_RED_TEAM_API_KEY'],
      message: 'required when ARTIFACT_RED_TEAM_MODE is shadow or warning',
    });
  }
  if (
    env.ARTIFACT_RED_TEAM_API_BASE_URL
    && canonicalBaseUrl(env.ARTIFACT_RED_TEAM_API_BASE_URL) === canonicalBaseUrl(env.HERMES_API_BASE_URL)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['ARTIFACT_RED_TEAM_API_BASE_URL'],
      message: 'must use a dedicated endpoint distinct from HERMES_API_BASE_URL',
    });
  }
  if (env.ARTIFACT_RED_TEAM_API_KEY && env.ARTIFACT_RED_TEAM_API_KEY === env.HERMES_API_KEY) {
    context.addIssue({
      code: 'custom',
      path: ['ARTIFACT_RED_TEAM_API_KEY'],
      message: 'must use a dedicated key distinct from HERMES_API_KEY',
    });
  }
});

export type Env = z.infer<typeof EnvSchema>;

export interface ParseResult {
  readonly ok: boolean;
  readonly env?: Env;
  readonly errors?: string[];
}

/** Pure parser — used by ConfigModule and by tests without booting Nest. */
export function parseEnv(raw: NodeJS.ProcessEnv): ParseResult {
  const normalized = raw.APP_ENV === 'test' && !raw.DATABASE_URL && raw.TEST_DATABASE_URL
    ? { ...raw, DATABASE_URL: raw.TEST_DATABASE_URL }
    : raw;
  const result = EnvSchema.safeParse(normalized);
  if (result.success) {
    return { ok: true, env: result.data };
  }
  const errors = result.error.issues.map(
    (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
  );
  return { ok: false, errors };
}
