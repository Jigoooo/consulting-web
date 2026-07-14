import { useEffect, useMemo, useState } from 'react';
import type { CreateProjectResponse, ProjectNode } from '@consulting/contracts';
import { Button } from '../../../shared/ui/button/Button';
import { Input } from '../../../shared/ui/input/Input';
import { DialogContent, DialogRoot } from '../../../shared/ui/dialog/Dialog';
import { Icon } from '../../../shared/icons/Icon';
import { useToast } from '../../../shared/ui/toast/Toast';
import { useCreateProject } from '../../../lib/spaces';
import {
  BASIC_INFO_EDIT_HELPER,
  CONNECTION_EDIT_HELPER,
  DEFAULT_TEMPLATE_CHANNEL_LABEL,
  EDIT_AFTER_CREATE_NOTICE,
  REVIEW_EDIT_HELPER,
  SUCCESS_EDIT_NOTICE,
  buildCreateProjectPayload,
  canSubmitProjectWizard,
  initialProjectWizardDraft,
  removeConnectionDraft,
  upsertConnectionDraft,
  type ProjectConnectionDraft,
  type ProjectCreateWizardDraft,
} from '../model/projectCreateWizard';
import s from './ProjectWizard.module.css';

const steps = [
  { id: 0, label: '기본 정보' },
  { id: 1, label: '연결 정의' },
  { id: 2, label: '확인' },
] as const;

export function ProjectCreateWizard({
  open,
  onOpenChange,
  workspaceId,
  projects,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string | undefined;
  projects: ProjectNode[];
  onCreated?: (result: CreateProjectResponse) => void;
}) {
  const [draft, setDraft] = useState<ProjectCreateWizardDraft>(() => initialProjectWizardDraft());
  const [step, setStep] = useState(0);
  const createProject = useCreateProject(workspaceId);
  const toast = useToast();
  const selectedProjects = useMemo(
    () => draft.connections
      .map((connection) => ({ connection, project: projects.find((project) => project.id === connection.projectId) }))
      .filter((item): item is { connection: ProjectConnectionDraft; project: ProjectNode } => Boolean(item.project)),
    [draft.connections, projects],
  );

  useEffect(() => {
    if (!open) return;
    setDraft(initialProjectWizardDraft());
    setStep(0);
  }, [open]);

  function patchDraft(patch: Partial<ProjectCreateWizardDraft>) {
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  function toggleConnection(projectId: string, checked: boolean) {
    setDraft((prev) => ({
      ...prev,
      connectionDecision: checked ? 'selected' : prev.connections.length <= 1 ? 'skip' : prev.connectionDecision,
      connections: checked
        ? upsertConnectionDraft(prev.connections, { projectId, strength: 'weak' })
        : removeConnectionDraft(prev.connections, projectId),
    }));
  }

  function changeStrength(projectId: string, strength: ProjectConnectionDraft['strength']) {
    setDraft((prev) => ({ ...prev, connections: upsertConnectionDraft(prev.connections, { projectId, strength }) }));
  }

  async function submit() {
    if (!workspaceId || !canSubmitProjectWizard(draft) || createProject.isPending) return;
    try {
      const result = await createProject.mutateAsync(buildCreateProjectPayload(draft, workspaceId));
      toast('success', `"${draft.name.trim()}" 프로젝트를 만들었어요. ${SUCCESS_EDIT_NOTICE}`);
      onOpenChange(false);
      onCreated?.(result);
    } catch {
      toast('error', '프로젝트 생성에 실패했어요. 이름 중복 또는 연결 대상을 확인해주세요.');
    }
  }

  const canGoNext = step === 0 ? Boolean(draft.name.trim()) : step === 1 ? canSubmitProjectWizard(draft) : true;
  const isLastStep = step === steps.length - 1;

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={s.dialog}
        title="새 프로젝트 생성"
        description="기본 뼈대, 연결 관계, 자료 추가 위치를 한 번에 정리합니다."
      >
        <div className={s.notice} role="note">
          <Icon name="info" size="sm" decorative />
          <span>{EDIT_AFTER_CREATE_NOTICE}</span>
        </div>

        <div className={s.steps} aria-label="프로젝트 생성 단계">
          {steps.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`${s.step} ${step === item.id ? s.stepOn : ''}`}
              onClick={() => item.id <= step && setStep(item.id)}
              disabled={item.id > step}
            >
              <span>{item.id + 1}</span>
              {item.label}
            </button>
          ))}
        </div>

        <div className={s.body}>
          {step === 0 ? (
            <section className={s.section}>
              <p className={s.helperText}>{BASIC_INFO_EDIT_HELPER}</p>
              <label className={s.field}>
                <span>프로젝트명</span>
                <Input autoFocus value={draft.name} onChange={(event) => patchDraft({ name: event.target.value })} placeholder="예: 창원시 조직진단 후속" maxLength={120} />
              </label>
              <label className={s.field}>
                <span>개요</span>
                <textarea value={draft.overview} onChange={(event) => patchDraft({ overview: event.target.value })} placeholder="이 프로젝트가 다루는 범위를 짧게 적어주세요." maxLength={2000} />
              </label>
              <label className={s.field}>
                <span>목표</span>
                <textarea value={draft.goal} onChange={(event) => patchDraft({ goal: event.target.value })} placeholder="성공 기준이나 최종 산출물을 적어주세요." maxLength={2000} />
              </label>
              <label className={s.checkRow}>
                <input type="checkbox" checked={draft.useDefaultTemplate} onChange={(event) => patchDraft({ useDefaultTemplate: event.target.checked })} />
                <span>{DEFAULT_TEMPLATE_CHANNEL_LABEL}</span>
              </label>
            </section>
          ) : null}

          {step === 1 ? (
            <section className={s.section}>
              <p className={s.helperText}>{CONNECTION_EDIT_HELPER}</p>
              <div className={s.choiceRow}>
                <button type="button" className={`${s.choice} ${draft.connectionDecision === 'skip' ? s.choiceOn : ''}`} onClick={() => patchDraft({ connectionDecision: 'skip', connections: [] })}>
                  <strong>나중에 연결</strong>
                  <span>생성 후 프로젝트 설정에서 언제든 연결할 수 있어요.</span>
                </button>
                <button type="button" className={`${s.choice} ${draft.connectionDecision === 'selected' ? s.choiceOn : ''}`} onClick={() => patchDraft({ connectionDecision: 'selected' })}>
                  <strong>지금 연결</strong>
                  <span>기존 프로젝트와 기억 공유/관련 관계를 지정합니다.</span>
                </button>
              </div>

              {draft.connectionDecision === 'selected' ? (
                <div className={s.projectList}>
                  {projects.length ? projects.map((project) => {
                    const connection = draft.connections.find((item) => item.projectId === project.id);
                    return (
                      <div key={project.id} className={s.projectPick}>
                        <label>
                          <input type="checkbox" checked={Boolean(connection)} onChange={(event) => toggleConnection(project.id, event.target.checked)} />
                          <span>{project.name}</span>
                        </label>
                        <select value={connection?.strength ?? 'weak'} disabled={!connection} onChange={(event) => changeStrength(project.id, event.target.value as ProjectConnectionDraft['strength'])}>
                          <option value="weak">약한 연결 · related_to</option>
                          <option value="strong">강한 연결 · shares_memory_with</option>
                        </select>
                      </div>
                    );
                  }) : <div className={s.empty}>연결할 기존 프로젝트가 아직 없어요.</div>}
                </div>
              ) : null}
            </section>
          ) : null}

          {step === 2 ? (
            <section className={s.section}>
              <div className={s.summaryGrid}>
                <div><span>이름</span><strong>{draft.name.trim() || '미입력'}</strong></div>
                <div><span>기본 채널</span><strong>{draft.useDefaultTemplate ? '자동 생성' : '생성 안 함'}</strong></div>
                <div><span>연결</span><strong>{selectedProjects.length ? `${selectedProjects.length}개` : '나중에 설정'}</strong></div>
              </div>
              {selectedProjects.length ? (
                <ul className={s.connectionSummary}>
                  {selectedProjects.map(({ project, connection }) => (
                    <li key={project.id}>{project.name} · {connection.strength === 'strong' ? '강한 연결' : '약한 연결'}</li>
                  ))}
                </ul>
              ) : null}
              <label className={s.field}>
                <span>자료 추가 메모</span>
                <textarea value={draft.materialNote} onChange={(event) => patchDraft({ materialNote: event.target.value })} placeholder="생성 후 자료실/프로젝트 채널에서 추가할 파일이나 링크를 적어두세요." maxLength={2000} />
              </label>
              <div className={s.notice} role="note">
                <Icon name="check" size="sm" decorative />
                <span>{REVIEW_EDIT_HELPER}</span>
              </div>
            </section>
          ) : null}
        </div>

        <div className={s.actions}>
          <Button type="button" variant="secondary" onClick={() => (step === 0 ? onOpenChange(false) : setStep((prev) => prev - 1))} disabled={createProject.isPending}>
            {step === 0 ? '취소' : '이전'}
          </Button>
          {isLastStep ? (
            <Button type="button" variant="primary" onClick={() => void submit()} loading={createProject.isPending} disabled={!canSubmitProjectWizard(draft) || !workspaceId}>
              프로젝트 만들기
            </Button>
          ) : (
            <Button type="button" variant="primary" onClick={() => setStep((prev) => prev + 1)} disabled={!canGoNext}>
              다음
            </Button>
          )}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
