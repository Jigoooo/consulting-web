import { Global, Module } from '@nestjs/common';
import { parseEnv, type Env } from './env.schema.js';
import { EnvSecretProvider } from '../secrets/env-secret-provider.js';
import { SECRET_PROVIDER } from '../secrets/secret-provider.port.js';

export const ENV_TOKEN = Symbol('ENV');

/**
 * Loads + validates env once at boot. Throws (blocks boot) on invalid config,
 * satisfying Phase 0 acceptance #3.
 */
@Global()
@Module({
  providers: [
    {
      provide: ENV_TOKEN,
      useFactory: (): Env => {
        const parsed = parseEnv(process.env);
        if (!parsed.ok || !parsed.env) {
          const detail = (parsed.errors ?? ['unknown']).join('\n  - ');
          throw new Error(`Invalid environment configuration:\n  - ${detail}`);
        }
        return parsed.env;
      },
    },
    {
      provide: SECRET_PROVIDER,
      inject: [ENV_TOKEN],
      useFactory: (env: Env) => new EnvSecretProvider(env),
    },
  ],
  exports: [ENV_TOKEN, SECRET_PROVIDER],
})
export class ConfigModule {}
