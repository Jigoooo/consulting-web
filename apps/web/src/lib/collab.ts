import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { AddEvidenceRequest, CreateArtifactRequest, AddArtifactVersionRequest, UploadAttachmentRequest } from '@consulting/contracts';

export const collabKeys = {
  evidence: (threadId: string) => ['evidence', threadId] as const,
  evidenceDecision: (threadId: string) => ['evidence-decision', threadId] as const,
  reviewQueue: (threadId: string) => ['review-queue', threadId] as const,
  artifacts: (workspaceId: string) => ['artifacts', workspaceId] as const,
  artifact: (id: string) => ['artifact', id] as const,
  notifications: ['notifications'] as const,
  attachments: (threadId: string) => ['attachments', threadId] as const,
};

// --- evidence (2-A) ---
export function useEvidence(threadId: string | undefined) {
  return useQuery({
    queryKey: collabKeys.evidence(threadId ?? ''),
    queryFn: () => api.listEvidence(threadId!),
    enabled: Boolean(threadId),
  });
}

/** #6: project-scoped evidence across all channels of a project. */
export function useProjectEvidence(projectId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['evidence-project', projectId ?? ''],
    queryFn: () => api.listProjectEvidence(projectId!),
    enabled: Boolean(projectId) && enabled,
  });
}

export function useAddEvidence(threadId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AddEvidenceRequest) => api.addEvidence(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: collabKeys.evidence(threadId ?? '') }),
  });
}

export function useEvidenceDecisionSummary(threadId: string | undefined) {
  return useQuery({
    queryKey: collabKeys.evidenceDecision(threadId ?? ''),
    queryFn: () => api.evidenceDecisionSummary(threadId!),
    enabled: Boolean(threadId),
  });
}

export function useReviewQueue(threadId: string | undefined) {
  return useQuery({
    queryKey: collabKeys.reviewQueue(threadId ?? ''),
    queryFn: () => api.reviewQueue(threadId!),
    enabled: Boolean(threadId),
  });
}

// --- artifacts (2-B) ---
export function useArtifacts(workspaceId: string | undefined, projectId?: string) {
  return useQuery({
    queryKey: [...collabKeys.artifacts(workspaceId ?? ''), projectId ?? 'all'],
    queryFn: () => api.listArtifacts(workspaceId!, projectId),
    enabled: Boolean(workspaceId),
  });
}

export function useArtifactDetail(id: string | undefined) {
  return useQuery({
    queryKey: collabKeys.artifact(id ?? ''),
    queryFn: () => api.artifactDetail(id!),
    enabled: Boolean(id),
  });
}

export function useCreateArtifact(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateArtifactRequest) => api.createArtifact(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: collabKeys.artifacts(workspaceId ?? '') }),
  });
}

export function useAddArtifactVersion(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; body: AddArtifactVersionRequest }) =>
      api.addArtifactVersion(input.id, input.body),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: collabKeys.artifacts(workspaceId ?? '') });
      void qc.invalidateQueries({ queryKey: collabKeys.artifact(v.id) });
    },
  });
}

// --- notifications (2-C) — 30s polling, no websocket by design. ---
export function useNotifications(enabled: boolean) {
  return useQuery({
    queryKey: collabKeys.notifications,
    queryFn: () => api.listNotifications(),
    refetchInterval: 30_000,
    enabled,
  });
}

export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) => api.markNotificationsRead(ids),
    onSuccess: () => void qc.invalidateQueries({ queryKey: collabKeys.notifications }),
  });
}

// --- attachments (2-D G-3) ---
export function useAttachments(threadId: string | undefined) {
  return useQuery({
    queryKey: collabKeys.attachments(threadId ?? ''),
    queryFn: () => api.listAttachments(threadId!),
    enabled: Boolean(threadId),
  });
}

export function useUploadAttachment(threadId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UploadAttachmentRequest) => api.uploadAttachment(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: collabKeys.attachments(threadId ?? '') }),
  });
}

export function useDeleteAttachment(threadId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteAttachment(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: collabKeys.attachments(threadId ?? '') });
      void qc.invalidateQueries({ queryKey: ['library-sources'] });
    },
  });
}

/** 축3: 추출 텍스트(파일 뷰어 — HWP/HWPX/PDF 원문 표시). processing이면 폴링. */
export function useAttachmentExtraction(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['attachment-extraction', id ?? ''],
    queryFn: () => api.getAttachmentExtraction(id!),
    enabled: Boolean(id) && enabled,
    // 축6: 백그라운드 추출이 진행 중(processing)이면 2초마다 폴링해 완료를 반영.
    refetchInterval: (query) => (query.state.data?.status === 'processing' ? 2000 : false),
  });
}

/** 축4: 자료실 집계 목록(워크스페이스/프로젝트/종류/검색 필터). */
export function useLibrarySources(
  workspaceId: string | undefined,
  opts?: { projectId?: string; type?: string; q?: string },
) {
  return useQuery({
    queryKey: ['library-sources', workspaceId ?? '', opts?.projectId ?? 'all', opts?.type ?? 'all', opts?.q ?? ''],
    queryFn: () =>
      api.listLibrarySources(workspaceId!, {
        ...(opts?.projectId ? { projectId: opts.projectId } : {}),
        ...(opts?.type ? { type: opts.type } : {}),
        ...(opts?.q ? { q: opts.q } : {}),
      }),
    enabled: Boolean(workspaceId),
  });
}

/** Read a File into a base64 payload for uploadAttachment. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const url = typeof result === 'string' ? result : '';
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('파일을 읽지 못했습니다.'));
    reader.readAsDataURL(file);
  });
}

/** Download an attachment as a browser save dialog (authed blob). */
export async function saveAttachment(id: string, fileName: string): Promise<void> {
  const blob = await api.downloadAttachment(id);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export async function saveArtifactExport(id: string, title: string, format: 'pdf' | 'docx', version?: number): Promise<void> {
  const blob = await api.exportArtifact(id, format, version);
  const safeTitle = title
    .trim()
    .split('')
    .map((char) => {
      const code = char.charCodeAt(0);
      return code <= 31 || '\\/:*?"<>|'.includes(char) ? '-' : char;
    })
    .join('')
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'artifact';
  const suffix = version ? `-v${version}` : '';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeTitle}${suffix}.${format}`;
  a.click();
  URL.revokeObjectURL(url);
}
