export type WorkspaceRole = 'owner' | 'admin' | 'editor' | 'commenter' | 'viewer';

export function canSendMessage(role: WorkspaceRole | undefined): boolean {
  return role === 'owner' || role === 'admin' || role === 'editor' || role === 'commenter';
}

export function canEditSpace(role: WorkspaceRole | undefined): boolean {
  return role === 'owner' || role === 'admin' || role === 'editor';
}

export function canInviteWorkspace(role: WorkspaceRole | undefined): boolean {
  return role === 'owner' || role === 'admin';
}
