/**
 * SecretProviderPort (ADR-0014). The rest of the app reads secrets ONLY through
 * this port, so the storage backend (env now, Vault/1Password later) is swappable.
 */
export const SECRET_PROVIDER = Symbol('SECRET_PROVIDER');

export type SecretName =
  | 'JWT_ACCESS_SECRET'
  | 'JWT_REFRESH_SECRET'
  | 'HERMES_API_KEY'
  | 'ARTIFACT_RED_TEAM_API_KEY'
  | 'VOYAGE_API_KEY';

export interface SecretProviderPort {
  /** Returns the secret value. Never log the result. */
  get(name: SecretName): string;
}
