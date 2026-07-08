import type { WorkspaceModalKind, WorkspaceModalState } from '../../../lib/workspaceModalStore';

export type ContextPanelTabId = 'evidence' | 'search';

export interface ContextPanelTab {
  id: ContextPanelTabId;
  label: string;
}

export function getContextPanelTabs({ hasSearch, searchCount }: { hasSearch: boolean; searchCount: number }): ContextPanelTab[] {
  if (!hasSearch) return [];
  return [
    { id: 'evidence', label: '근거' },
    { id: 'search', label: `검색 ${searchCount}` },
  ];
}

export function resolveWorkspaceModalPresentationKind(modal: WorkspaceModalState): WorkspaceModalKind {
  return modal.kind ?? modal.lastKind ?? 'artifacts';
}