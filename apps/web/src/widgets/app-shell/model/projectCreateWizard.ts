import type { CreateContextEdgeRequest, CreateProjectRequest, ProjectConnectionStrength } from '@consulting/contracts';
import { toSlug } from '../../../lib/spaces';

export const EDIT_AFTER_CREATE_NOTICE = '프로젝트명, 연결 관계, 첨부 자료는 생성 후에도 프로젝트 설정에서 언제든 수정할 수 있어요.';
export const BASIC_INFO_EDIT_HELPER = '프로젝트명과 개요는 생성 후에도 프로젝트 설정에서 바꿀 수 있어요.';
export const CONNECTION_EDIT_HELPER = '연결은 생성 후에도 프로젝트 설정에서 언제든 바꿀 수 있어요.';
export const REVIEW_EDIT_HELPER = '생성 후에도 프로젝트명·개요·연결·자료를 다시 바꿀 수 있습니다.';
export const SUCCESS_EDIT_NOTICE = '이름·연결·자료는 언제든 다시 바꿀 수 있어요.';
export const DEFAULT_TEMPLATE_CHANNEL_LABEL = '자료수집·분석·보고서·Q&A·대화 기본 채널을 자동으로 만들기';

export type ProjectConnectionDraft = {
  projectId: string;
  strength: ProjectConnectionStrength;
};

export type ProjectCreateWizardDraft = {
  name: string;
  slug: string;
  overview: string;
  goal: string;
  notes: string;
  materialNote: string;
  useDefaultTemplate: boolean;
  connectionDecision: 'skip' | 'selected';
  connections: ProjectConnectionDraft[];
};

export function initialProjectWizardDraft(): ProjectCreateWizardDraft {
  return {
    name: '',
    slug: '',
    overview: '',
    goal: '',
    notes: '',
    materialNote: '',
    useDefaultTemplate: true,
    connectionDecision: 'skip',
    connections: [],
  };
}

export function connectionStrengthToEdgeType(strength: ProjectConnectionStrength): CreateContextEdgeRequest['edgeType'] {
  return strength === 'strong' ? 'shares_memory_with' : 'related_to';
}

export function canSubmitProjectWizard(draft: ProjectCreateWizardDraft): boolean {
  const name = draft.name.trim();
  if (!name) return false;
  if (draft.connectionDecision === 'selected' && draft.connections.length === 0) return false;
  return true;
}

export function buildCreateProjectPayload(draft: ProjectCreateWizardDraft, workspaceId: string): CreateProjectRequest {
  const name = draft.name.trim();
  const overview = draft.overview.trim();
  const goal = draft.goal.trim();
  const notes = [draft.notes.trim(), draft.materialNote.trim()].filter(Boolean).join('\n\n');
  const profile = overview || goal || notes ? { overview, goal, notes } : undefined;
  return {
    workspaceId,
    name,
    slug: (draft.slug.trim() || toSlug(name)).slice(0, 63),
    applyDefaultTemplate: draft.useDefaultTemplate,
    ...(draft.useDefaultTemplate ? { templateKey: 'consulting_default' as const } : {}),
    connectionDecision: draft.connectionDecision,
    ...(draft.connectionDecision === 'selected' ? { connections: dedupeConnections(draft.connections) } : {}),
    ...(profile ? { profile } : {}),
  };
}

export function upsertConnectionDraft(
  connections: ProjectConnectionDraft[],
  next: ProjectConnectionDraft,
): ProjectConnectionDraft[] {
  const rest = connections.filter((connection) => connection.projectId !== next.projectId);
  return [...rest, next];
}

export function removeConnectionDraft(connections: ProjectConnectionDraft[], projectId: string): ProjectConnectionDraft[] {
  return connections.filter((connection) => connection.projectId !== projectId);
}

function dedupeConnections(connections: ProjectConnectionDraft[]): ProjectConnectionDraft[] {
  const byProject = new Map<string, ProjectConnectionDraft>();
  for (const connection of connections) byProject.set(connection.projectId, connection);
  return [...byProject.values()];
}
