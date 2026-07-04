import { describe, expect, it } from 'vitest';
import {
  AcceptInvitationRequestSchema,
  AcceptInvitationResponseSchema,
  CreateInvitationRequestSchema,
  CreateInvitationResponseSchema,
  InvitationPreviewRequestSchema,
  InvitationPreviewResponseSchema,
} from '../src/invitation.js';

describe('invitation contracts', () => {
  it('preview response is public and rejects token/hash leaks', () => {
    const clean = {
      workspaceId: '00000000-0000-0000-0000-000000000001',
      scopeType: 'workspace',
      scopeId: '00000000-0000-0000-0000-000000000001',
      role: 'viewer',
      expiresAt: new Date().toISOString(),
      accepted: false,
      emailHint: null,
    };
    expect(InvitationPreviewResponseSchema.parse(clean)).toEqual(clean);
    expect(() =>
      InvitationPreviewResponseSchema.parse({
        ...clean,
        token: 'raw-token',
      }),
    ).toThrow();
    expect(() =>
      InvitationPreviewResponseSchema.parse({
        ...clean,
        tokenHash: 'hash',
      }),
    ).toThrow();
  });

  it('request/response schemas are strict for share-link invitation endpoints', () => {
    expect(() => InvitationPreviewRequestSchema.parse({ token: 'abc', extra: true })).toThrow();
    expect(() => AcceptInvitationRequestSchema.parse({ token: 'abc', extra: true })).toThrow();
    expect(() => AcceptInvitationRequestSchema.parse({ token: 'abc', userId: cleanUuid() })).toThrow();
    expect(() => CreateInvitationRequestSchema.parse(validCreateRequest({ unknown: true }))).toThrow();
    expect(() => CreateInvitationResponseSchema.parse({ invitationId: cleanUuid(), token: 'raw', tokenHash: 'hash' })).toThrow();
    expect(() => AcceptInvitationResponseSchema.parse({ membershipId: cleanUuid(), token: 'raw' })).toThrow();
  });
});

function cleanUuid(): string {
  return '00000000-0000-0000-0000-000000000001';
}

function validCreateRequest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: cleanUuid(),
    invitedByUserId: cleanUuid(),
    scopeType: 'workspace',
    scopeId: cleanUuid(),
    role: 'viewer',
    ...extra,
  };
}
