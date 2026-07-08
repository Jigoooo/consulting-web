import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export const spaceKeys = {
  workspaces: ['workspaces'] as const,
  tree: (workspaceId: string) => ['tree', workspaceId] as const,
  archive: (workspaceId: string) => ['archive', workspaceId] as const,
  threads: (topicId: string) => ['threads', topicId] as const,
};

export function useWorkspaces() {
  return useQuery({
    queryKey: spaceKeys.workspaces,
    queryFn: () => api.listWorkspaces(),
  });
}

export function useWorkspaceTree(workspaceId: string | undefined) {
  return useQuery({
    queryKey: spaceKeys.tree(workspaceId ?? ''),
    queryFn: () => api.workspaceTree(workspaceId!),
    enabled: Boolean(workspaceId),
  });
}

export function useArchivedScopes(workspaceId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: spaceKeys.archive(workspaceId ?? ''),
    queryFn: () => api.listArchivedScopes(workspaceId!),
    enabled: Boolean(workspaceId) && enabled,
  });
}

export function useThreads(topicId: string | undefined) {
  return useQuery({
    queryKey: spaceKeys.threads(topicId ?? ''),
    queryFn: () => api.listThreads(topicId!),
    enabled: Boolean(topicId),
  });
}

/** slugify a Korean/English name into the server slug format. */
export function toSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Korean chars are not allowed by the server slug regex — fall back to a
  // timestamped generic slug when nothing latin remains.
  const latin = base.replace(/[가-힣]/g, '');
  const cleaned = latin.replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  return cleaned.length >= 2 ? cleaned.slice(0, 63) : `s-${Date.now().toString(36)}`;
}

export function useCreateProject(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.createProject({ workspaceId: workspaceId!, name, slug: toSlug(name) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: spaceKeys.tree(workspaceId ?? '') }),
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.createWorkspace({ name, slug: toSlug(name) }),
    // await: mutateAsync 가 refetch 완료까지 기다려야 호출측에서 wsStore.set(new id)
    // 했을 때 목록에 이미 존재 → AppShell의 "목록에 없으면 첫 번째로 리셋" 가드에
    // 걸리지 않는다 (생성 직후 active 전환 race 방지).
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: spaceKeys.workspaces });
    },
  });
}

export function useCreateChannel(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { projectId: string; name: string }) =>
      api.createChannel({ projectId: input.projectId, name: input.name, slug: toSlug(input.name) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: spaceKeys.tree(workspaceId ?? '') }),
  });
}

export function useCreateTopic(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { channelId: string; name: string }) =>
      api.createTopic({ channelId: input.channelId, name: input.name, slug: toSlug(input.name) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: spaceKeys.tree(workspaceId ?? '') }),
  });
}

export function useCreateThread(topicId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (title: string) => api.createThread({ topicId: topicId!, title }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: spaceKeys.threads(topicId ?? '') }),
  });
}

/** Rename/archive mutations (N-4) — invalidate the tree (or threads) on success. */
export function useRenameNode(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { kind: 'projects' | 'channels' | 'topics'; id: string; name: string }) =>
      api.renameNode(input.kind, input.id, input.name),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: spaceKeys.tree(workspaceId ?? '') });
      // Project/channel/topic names are also shown in thread breadcrumbs.
      // Without invalidating thread details, the sidebar updates but the
      // selected channel header can keep the old name until a hard reload.
      void qc.invalidateQueries({ queryKey: ['thread'] });
    },
  });
}

export function useArchiveNode(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { kind: 'projects' | 'channels' | 'topics'; id: string }) =>
      api.archiveNode(input.kind, input.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: spaceKeys.tree(workspaceId ?? '') });
      void qc.invalidateQueries({ queryKey: spaceKeys.archive(workspaceId ?? '') });
    },
  });
}

export function useRestoreArchived(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { kind: 'project' | 'channel' | 'topic' | 'thread'; id: string }) => api.restoreArchived(input.kind, input.id),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: spaceKeys.tree(workspaceId ?? '') }),
        qc.invalidateQueries({ queryKey: spaceKeys.archive(workspaceId ?? '') }),
      ]);
    },
  });
}

export function useRenameThread(topicId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; title: string }) => api.renameThread(input.id, input.title),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: spaceKeys.threads(topicId ?? '') });
      void qc.invalidateQueries({ queryKey: ['thread', v.id] });
    },
  });
}

export function useArchiveThread(topicId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.archiveNode('threads', id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: spaceKeys.threads(topicId ?? '') }),
  });
}

export function useMembers(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['members', workspaceId ?? ''],
    queryFn: () => api.listMembers(workspaceId!),
    enabled: Boolean(workspaceId),
  });
}
