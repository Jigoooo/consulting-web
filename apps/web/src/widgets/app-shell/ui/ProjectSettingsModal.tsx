import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectConnectionStrength, ProjectNode } from '@consulting/contracts';
import { api } from '../../../lib/api';
import { spaceKeys, useRenameNode } from '../../../lib/spaces';
import { workspaceModalStore } from '../../../lib/workspaceModalStore';
import { Button } from '../../../shared/ui/button/Button';
import { Input } from '../../../shared/ui/input/Input';
import { DialogContent, DialogRoot } from '../../../shared/ui/dialog/Dialog';
import { Icon } from '../../../shared/icons/Icon';
import { useToast } from '../../../shared/ui/toast/Toast';
import { EDIT_AFTER_CREATE_NOTICE, connectionStrengthToEdgeType } from '../model/projectCreateWizard';
import s from './ProjectWizard.module.css';

export function ProjectSettingsModal({
  open,
  onOpenChange,
  workspaceId,
  project,
  projects,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string | undefined;
  project: ProjectNode | null;
  projects: ProjectNode[];
}) {
  const [tab, setTab] = useState<'basic' | 'connections' | 'materials'>('basic');
  const [name, setName] = useState('');
  const [overview, setOverview] = useState('');
  const [goal, setGoal] = useState('');
  const [notes, setNotes] = useState('');
  const [connectionProjectId, setConnectionProjectId] = useState('');
  const [connectionStrength, setConnectionStrength] = useState<ProjectConnectionStrength>('weak');
  const [basicBusy, setBasicBusy] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const renameNode = useRenameNode(workspaceId);
  const qc = useQueryClient();
  const toast = useToast();

  const profileQuery = useQuery({
    queryKey: ['project-profile', project?.id ?? ''],
    queryFn: () => api.getProjectProfile(project!.id),
    enabled: open && Boolean(project),
  });
  const connectionsQuery = useQuery({
    queryKey: ['context-edges', 'project', project?.id ?? ''],
    queryFn: () => api.listContextEdges({ scopeType: 'project', scopeId: project!.id, limit: 30 }),
    enabled: open && Boolean(project),
  });
  const profileSaveBlocked = profileQuery.isLoading || profileQuery.isFetching || profileQuery.isError;
  const connectionSaveBlocked = connectionsQuery.isLoading || connectionsQuery.isFetching || connectionsQuery.isError;

  const candidateProjects = useMemo(() => projects.filter((candidate) => candidate.id !== project?.id), [project?.id, projects]);

  useEffect(() => {
    if (!open || !project) return;
    setTab('basic');
    setName(project.name);
    setOverview('');
    setGoal('');
    setNotes('');
    setConnectionProjectId('');
    setConnectionStrength('weak');
  }, [open, project]);

  useEffect(() => {
    const profile = profileQuery.data?.profile;
    if (!open || profileQuery.isLoading || profileQuery.isFetching || profileQuery.isError || !profileQuery.isSuccess) {
      return;
    }
    if (!profile) {
      setOverview('');
      setGoal('');
      setNotes('');
      return;
    }
    setOverview(profile.role);
    setGoal(profile.purpose);
    setNotes(profile.rules);
  }, [open, profileQuery.data?.profile, profileQuery.isError, profileQuery.isFetching, profileQuery.isLoading, profileQuery.isSuccess]);

  async function saveBasic() {
    if (!project || basicBusy || profileSaveBlocked) return;
    setBasicBusy(true);
    try {
      const trimmedName = name.trim();
      if (trimmedName && trimmedName !== project.name) {
        await renameNode.mutateAsync({ kind: 'projects', id: project.id, name: trimmedName });
      }
      await api.updateProjectProfile(project.id, { purpose: goal, role: overview, rules: notes, style: '' });
      await Promise.all([
        qc.invalidateQueries({ queryKey: spaceKeys.tree(workspaceId ?? '') }),
        qc.invalidateQueries({ queryKey: ['project-profile', project.id] }),
      ]);
      toast('success', '프로젝트 설정을 저장했어요.');
    } catch {
      toast('error', '프로젝트 설정 저장에 실패했어요.');
    } finally {
      setBasicBusy(false);
    }
  }

  async function saveConnection() {
    if (!project || !connectionProjectId || connectionBusy || connectionSaveBlocked) return;
    setConnectionBusy(true);
    try {
      const nextEdgeType = connectionStrengthToEdgeType(connectionStrength);
      await api.createContextEdge({
        fromScopeType: 'project',
        fromScopeId: project.id,
        toScopeType: 'project',
        toScopeId: connectionProjectId,
        edgeType: nextEdgeType,
        confidence: connectionStrength === 'strong' ? 1 : 0.65,
      });
      await qc.invalidateQueries({ queryKey: ['context-edges'] });
      setConnectionProjectId('');
      setConnectionStrength('weak');
      toast('success', '프로젝트 연결을 저장했어요.');
    } catch {
      toast('error', '프로젝트 연결 저장에 실패했어요.');
    } finally {
      setConnectionBusy(false);
    }
  }

  async function removeConnection(edgeId: string) {
    if (!project || connectionBusy) return;
    setConnectionBusy(true);
    try {
      await api.deleteContextEdge(edgeId);
      await qc.invalidateQueries({ queryKey: ['context-edges'] });
      toast('success', '프로젝트 연결을 삭제했어요.');
    } catch {
      toast('error', '프로젝트 연결 삭제에 실패했어요.');
    } finally {
      setConnectionBusy(false);
    }
  }

  function openLibrary() {
    if (!project) return;
    onOpenChange(false);
    workspaceModalStore.open('library', { projectId: project.id });
  }

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className={s.dialog} title="프로젝트 설정" description={EDIT_AFTER_CREATE_NOTICE}>
        {project ? (
          <>
            <div className={s.tabs}>
              {([
                ['basic', '기본 정보'],
                ['connections', '연결'],
                ['materials', '자료'],
              ] as const).map(([id, label]) => (
                <button key={id} type="button" className={`${s.tab} ${tab === id ? s.tabOn : ''}`} onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
            </div>

            {tab === 'basic' ? (
              <div className={s.section}>
                <label className={s.field}>
                  <span>프로젝트명</span>
                  <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
                </label>
                <label className={s.field}>
                  <span>개요</span>
                  <textarea value={overview} onChange={(event) => setOverview(event.target.value)} maxLength={2000} />
                </label>
                <label className={s.field}>
                  <span>목표</span>
                  <textarea value={goal} onChange={(event) => setGoal(event.target.value)} maxLength={2000} />
                </label>
                <label className={s.field}>
                  <span>운영 메모</span>
                  <textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} />
                </label>
                <div className={s.actions}>
                  <Button type="button" variant="primary" loading={basicBusy || profileQuery.isLoading || profileQuery.isFetching} disabled={!name.trim() || profileSaveBlocked} onClick={() => void saveBasic()}>
                    저장
                  </Button>
                </div>
              </div>
            ) : null}

            {tab === 'connections' ? (
              <div className={s.section}>
                <div className={s.notice} role="note">
                  <Icon name="info" size="sm" decorative />
                  <span>강한 연결은 shares_memory_with, 약한 연결은 related_to로 저장됩니다. 같은 프로젝트를 다시 저장하면 연결 강도를 바꿀 수 있어요.</span>
                </div>
                <div className={s.projectList}>
                  {connectionsQuery.data?.edges.length ? connectionsQuery.data.edges.map((edge) => (
                    <div key={edge.edgeId ?? `${edge.scopeType}:${edge.scopeId}:${edge.edgeType}`} className={s.connectionItem}>
                      <div>
                        <strong>{edge.projectName}</strong>
                        <span>{edge.edgeType === 'shares_memory_with' ? '강한 연결' : '약한 연결'} · {edge.direction === 'in' ? '들어오는 연결' : '나가는 연결'}</span>
                      </div>
                      {edge.edgeId && edge.origin === 'manual' ? (
                        <button type="button" onClick={() => void removeConnection(edge.edgeId!)} disabled={connectionBusy}>
                          삭제
                        </button>
                      ) : null}
                    </div>
                  )) : <div className={s.empty}>아직 연결된 프로젝트가 없어요.</div>}
                </div>
                <div className={s.connectionEditor}>
                  <select value={connectionProjectId} onChange={(event) => setConnectionProjectId(event.target.value)}>
                    <option value="">연결할 프로젝트 선택</option>
                    {candidateProjects.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                  </select>
                  <select value={connectionStrength} onChange={(event) => setConnectionStrength(event.target.value as ProjectConnectionStrength)}>
                    <option value="weak">약한 연결 · related_to</option>
                    <option value="strong">강한 연결 · shares_memory_with</option>
                  </select>
                  <Button type="button" variant="primary" loading={connectionBusy || connectionsQuery.isLoading || connectionsQuery.isFetching} disabled={!connectionProjectId || connectionSaveBlocked} onClick={() => void saveConnection()}>
                    연결 저장
                  </Button>
                </div>
              </div>
            ) : null}

            {tab === 'materials' ? (
              <div className={s.section}>
                <div className={s.materialBox}>
                  <Icon name="files" size="lg" decorative />
                  <div>
                    <strong>자료는 생성 후에도 계속 추가·삭제할 수 있어요.</strong>
                    <p>프로젝트 채널의 근거 자료 패널과 워크스페이스 자료실에서 업로드 문서와 링크를 관리합니다.</p>
                  </div>
                </div>
                <div className={s.actions}>
                  <Button type="button" variant="secondary" onClick={openLibrary}>자료실 열기</Button>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className={s.empty}>프로젝트를 선택해주세요.</div>
        )}
      </DialogContent>
    </DialogRoot>
  );
}
