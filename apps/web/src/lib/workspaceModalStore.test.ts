import { describe, expect, it } from 'vitest';
import { workspaceModalStore } from './workspaceModalStore';

describe('workspaceModalStore', () => {
  it('opens workspace surfaces without changing routes and can close them', () => {
    const events: string[] = [];
    const unsubscribe = workspaceModalStore.subscribe(() => {
      const state = workspaceModalStore.get();
      events.push(`${state.kind ?? 'closed'}:${state.projectId ?? ''}`);
    });

    workspaceModalStore.open('library');
    expect(workspaceModalStore.get()).toEqual({ kind: 'library', projectId: undefined });

    workspaceModalStore.open('artifacts', { projectId: 'project-1' });
    expect(workspaceModalStore.get()).toEqual({ kind: 'artifacts', projectId: 'project-1' });

    workspaceModalStore.close();
    expect(workspaceModalStore.get()).toEqual({ kind: null });
    expect(events).toEqual(['library:', 'artifacts:project-1', 'closed:']);

    unsubscribe();
  });
});
