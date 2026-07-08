import { describe, expect, it } from 'vitest';
import { getContextPanelTabs, resolveWorkspaceModalPresentationKind } from './contextPanelView';

describe('context panel view policy', () => {
  it('does not show a single 근거 tab when search is inactive', () => {
    expect(getContextPanelTabs({ hasSearch: false, searchCount: 0 })).toEqual([]);
  });

  it('shows peer thread-scoped tabs only while search results exist', () => {
    expect(getContextPanelTabs({ hasSearch: true, searchCount: 3 })).toEqual([
      { id: 'evidence', label: '근거' },
      { id: 'search', label: '검색 3' },
    ]);
  });
});

describe('workspace modal presentation policy', () => {
  it('keeps the last modal kind available during the Radix close animation', () => {
    expect(resolveWorkspaceModalPresentationKind({ kind: null, lastKind: 'members' })).toBe('members');
  });

  it('falls back to the large workspace surface only when no modal has ever opened', () => {
    expect(resolveWorkspaceModalPresentationKind({ kind: null })).toBe('artifacts');
  });
});
