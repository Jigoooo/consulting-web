import { describe, expect, it } from 'vitest';
import { canEditSpace, canInviteWorkspace, canSendMessage } from './roleCapabilities';

describe('roleCapabilities', () => {
  it('keeps viewer fully read-only', () => {
    expect(canSendMessage('viewer')).toBe(false);
    expect(canEditSpace('viewer')).toBe(false);
  });

  it('allows commenter messaging but not structural edits', () => {
    expect(canSendMessage('commenter')).toBe(true);
    expect(canEditSpace('commenter')).toBe(false);
  });

  it.each(['editor', 'admin', 'owner'] as const)('allows %s to edit and message', (role) => {
    expect(canSendMessage(role)).toBe(true);
    expect(canEditSpace(role)).toBe(true);
  });

  it('fails closed while role data is unavailable', () => {
    expect(canSendMessage(undefined)).toBe(false);
    expect(canEditSpace(undefined)).toBe(false);
    expect(canInviteWorkspace(undefined)).toBe(false);
  });

  it.each(['owner', 'admin'] as const)('allows %s to invite workspace members', (role) => {
    expect(canInviteWorkspace(role)).toBe(true);
  });

  it.each(['editor', 'commenter', 'viewer'] as const)('does not allow %s to invite workspace members', (role) => {
    expect(canInviteWorkspace(role)).toBe(false);
  });
});
