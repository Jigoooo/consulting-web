import type { Env } from '../config/env.schema.js';
import type { SecretName, SecretProviderPort } from './secret-provider.port.js';

/** Env-backed secret provider (Phase 0). Reads validated env; never logs values. */
export class EnvSecretProvider implements SecretProviderPort {
  constructor(private readonly env: Env) {}

  get(name: SecretName): string {
    return this.env[name];
  }
}
