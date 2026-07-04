import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthSessionUseCase } from './auth-session.usecase.js';

export interface AuthenticatedRequest extends Request {
  authUserId?: string;
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(@Inject(AuthSessionUseCase) private readonly authSession: AuthSessionUseCase) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(req.headers.authorization);
    if (!token) {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'missing bearer token' });
    }
    const result = this.authSession.verifyAccessToken(token);
    if (!result.ok) {
      throw new UnauthorizedException({ code: result.error.code, message: result.error.message });
    }
    req.authUserId = result.value.userId;
    return true;
  }
}

export function requireAuthUserId(req: AuthenticatedRequest): string {
  if (!req.authUserId) {
    throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'missing authenticated user' });
  }
  return req.authUserId;
}
