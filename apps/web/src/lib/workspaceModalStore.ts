import { useSyncExternalStore } from 'react';

export type WorkspaceModalKind = 'artifacts' | 'library' | 'members';

export interface WorkspaceModalState {
  kind: WorkspaceModalKind | null;
  lastKind?: WorkspaceModalKind | undefined;
  projectId?: string | undefined;
}

let state: WorkspaceModalState = { kind: null };
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export const workspaceModalStore = {
  get: (): WorkspaceModalState => state,
  open: (kind: WorkspaceModalKind, options?: { projectId?: string | undefined }): void => {
    state = { kind, lastKind: kind, projectId: options?.projectId };
    emit();
  },
  close: (): void => {
    if (!state.kind) return;
    state = { kind: null, lastKind: state.lastKind, projectId: state.projectId };
    emit();
  },
  subscribe: (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useWorkspaceModal(): WorkspaceModalState {
  return useSyncExternalStore(workspaceModalStore.subscribe, workspaceModalStore.get, workspaceModalStore.get);
}
