import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export const spaceKeys = {
  workspaces: ['workspaces'] as const,
  tree: (workspaceId: string) => ['tree', workspaceId] as const,
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
