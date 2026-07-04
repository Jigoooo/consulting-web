import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  PreconditionFailedException,
  UnauthorizedException,
} from '@nestjs/common';
import type { DomainError } from '@consulting/shared';
import { ZodError, type ZodSchema } from 'zod';

export function parseBody<T>(schema: ZodSchema<T>, body: unknown): T {
  try {
    return schema.parse(body);
  } catch (e) {
    if (e instanceof ZodError) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'invalid request body' });
    }
    throw e;
  }
}

export function parseResponse<T>(schema: ZodSchema<T>, body: unknown): T {
  try {
    return schema.parse(body);
  } catch {
    // Response contract mismatch is a server bug. Do not leak schema internals.
    throw new InternalServerErrorException({ code: 'INTERNAL', message: 'response contract violation' });
  }
}

export function throwDomainError(error: DomainError): never {
  const body = { code: error.code, message: error.message };
  switch (error.code) {
    case 'VALIDATION':
      throw new BadRequestException(body);
    case 'UNAUTHENTICATED':
      throw new UnauthorizedException(body);
    case 'FORBIDDEN':
      throw new ForbiddenException(body);
    case 'NOT_FOUND':
      throw new NotFoundException(body);
    case 'CONFLICT':
    case 'IDEMPOTENCY':
      throw new ConflictException(body);
    case 'PRECONDITION':
      throw new PreconditionFailedException(body);
    case 'INTERNAL':
    default:
      throw new InternalServerErrorException(body);
  }
}
