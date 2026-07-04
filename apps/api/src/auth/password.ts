import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

export interface PasswordHasher {
  hash(plain: string): string;
  verify(plain: string, stored: string): boolean;
}

/**
 * scrypt-based hasher (stdlib, no native dep for Phase 0).
 * Format: scrypt$<saltHex>$<hashHex>. Swappable for argon2 later behind this port.
 */
export class ScryptPasswordHasher implements PasswordHasher {
  hash(plain: string): string {
    const salt = randomBytes(16);
    const derived = scryptSync(plain, salt, 64);
    return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
  }

  verify(plain: string, stored: string): boolean {
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[1] as string, 'hex');
    const expected = Buffer.from(parts[2] as string, 'hex');
    const derived = scryptSync(plain, salt, expected.length);
    return expected.length === derived.length && timingSafeEqual(expected, derived);
  }
}

/** Token hashing for invitations/sessions (ADR-0009). Store only the hash. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Generate an opaque invitation/session token (returned once, never stored raw). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}
