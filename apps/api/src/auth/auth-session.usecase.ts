import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { eq } from 'drizzle-orm';
import { ok, err, type Result, domainError } from '@consulting/shared';
import type { PublicUser, AuthSessionResponse } from '@consulting/contracts';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { ENV_TOKEN } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { PASSWORD_HASHER, hashToken, type PasswordHasher } from './password.js';
import { signJwt, verifyJwt } from './jwt.js';

const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_TTL_SEC = 30 * 24 * 60 * 60;

export interface LoginCommand {
  email: string;
  password: string;
  userAgent?: string;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function toPublicUser(user: {
  id: string;
  email: string;
  displayName: string;
  status: 'active' | 'archived' | 'suspended' | 'deleted_soft';
}): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
  };
}

@Injectable()
export class AuthSessionUseCase {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
  ) {}

  async login(cmd: LoginCommand): Promise<Result<AuthSessionResponse>> {
    const email = cmd.email.trim().toLowerCase();
    const [user] = await this.db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        displayName: schema.users.displayName,
        status: schema.users.status,
        passwordHash: schema.users.passwordHash,
      })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);

    if (!user || !user.passwordHash || !this.hasher.verify(cmd.password, user.passwordHash)) {
      return err(domainError('UNAUTHENTICATED', 'invalid email or password'));
    }
    if (user.status !== 'active') {
      return err(domainError('FORBIDDEN', 'user is not active'));
    }

    const issuedAt = nowSec();
    const accessToken = signJwt(
      { sub: user.id, typ: 'access', iat: issuedAt, exp: issuedAt + ACCESS_TTL_SEC },
      this.env.JWT_ACCESS_SECRET,
    );
    const refreshToken = signJwt(
      { sub: user.id, typ: 'refresh', iat: issuedAt, exp: issuedAt + REFRESH_TTL_SEC },
      this.env.JWT_REFRESH_SECRET,
    );

    await this.db.insert(schema.sessions).values({
      userId: user.id,
      refreshTokenHash: hashToken(refreshToken),
      ...(cmd.userAgent !== undefined ? { userAgent: cmd.userAgent } : {}),
      expiresAt: new Date((issuedAt + REFRESH_TTL_SEC) * 1000),
    });

    return ok({
      user: toPublicUser(user),
      tokens: { accessToken, refreshToken, expiresInSec: ACCESS_TTL_SEC },
    });
  }

  verifyAccessToken(token: string): Result<{ userId: string }> {
    const claims = verifyJwt(token, this.env.JWT_ACCESS_SECRET, 'access');
    if (!claims) return err(domainError('UNAUTHENTICATED', 'invalid access token'));
    return ok({ userId: claims.sub });
  }

  /**
   * Refresh rotation (N-3): validate the JWT, confirm the hashed session row
   * still exists (not revoked / expired), delete it, then issue a fresh pair
   * with a new session row. A stolen-and-already-used refresh token therefore
   * fails on its second use.
   */
  async refresh(refreshToken: string, userAgent?: string): Promise<Result<AuthSessionResponse>> {
    const claims = verifyJwt(refreshToken, this.env.JWT_REFRESH_SECRET, 'refresh');
    if (!claims) return err(domainError('UNAUTHENTICATED', 'invalid refresh token'));

    const tokenHash = hashToken(refreshToken);
    const [session] = await this.db
      .select({ id: schema.sessions.id, expiresAt: schema.sessions.expiresAt })
      .from(schema.sessions)
      .where(eq(schema.sessions.refreshTokenHash, tokenHash))
      .limit(1);
    if (!session || session.expiresAt.getTime() < Date.now()) {
      return err(domainError('UNAUTHENTICATED', 'refresh session not found or expired'));
    }

    const [user] = await this.db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        displayName: schema.users.displayName,
        status: schema.users.status,
      })
      .from(schema.users)
      .where(eq(schema.users.id, claims.sub))
      .limit(1);
    if (!user || user.status !== 'active') {
      return err(domainError('FORBIDDEN', 'user is not active'));
    }

    // Rotate: revoke the used session, then mint a fresh pair.
    await this.db.delete(schema.sessions).where(eq(schema.sessions.id, session.id));

    const issuedAt = nowSec();
    const accessToken = signJwt(
      { sub: user.id, typ: 'access', iat: issuedAt, exp: issuedAt + ACCESS_TTL_SEC },
      this.env.JWT_ACCESS_SECRET,
    );
    const nextRefreshToken = signJwt(
      { sub: user.id, typ: 'refresh', iat: issuedAt, exp: issuedAt + REFRESH_TTL_SEC },
      this.env.JWT_REFRESH_SECRET,
    );
    await this.db.insert(schema.sessions).values({
      userId: user.id,
      refreshTokenHash: hashToken(nextRefreshToken),
      ...(userAgent !== undefined ? { userAgent } : {}),
      expiresAt: new Date((issuedAt + REFRESH_TTL_SEC) * 1000),
    });

    return ok({
      user: toPublicUser(user),
      tokens: { accessToken, refreshToken: nextRefreshToken, expiresInSec: ACCESS_TTL_SEC },
    });
  }
}
