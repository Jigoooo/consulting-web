import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useLocation, useRouter } from '@tanstack/react-router';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useAuth } from '../../../lib/useAuth';
import {
  useWorkspaces,
  useWorkspaceTree,
  useCreateProject,
  useCreateChannel,
  useCreateTopic,
  useCreateWorkspace,
  useRenameNode,
  useDeleteNode,
  useMembers,
} from '../../../lib/spaces';
import { useSelectedWorkspace, wsStore } from '../../../lib/wsStore';
import { useActiveThread } from '../../../lib/threadCtx';
import { useTheme, themeStore } from '../../../lib/themeStore';
import { api } from '../../../lib/api';
import { useToast } from '../../../shared/ui/toast/Toast';
import { RowMenu, useTextPrompt } from '../../../shared/ui/menu/Menu';
import { ConfirmDialog, DialogRoot, DialogContent } from '../../../shared/ui/dialog/Dialog';
import { NotificationBell } from '../../notification-center/ui/NotificationBell';
import { Icon } from '../../../shared/icons/Icon';
import type { IconName } from '../../../shared/icons/registry';
import { Button } from '../../../shared/ui/button/Button';
import { Input } from '../../../shared/ui/input/Input';
import { Skeleton } from '../../../shared/ui/skeleton/Skeleton';
import { useDelayedFlag } from '../../../shared/lib/useDelayedFlag';
import { EvidencePanel } from '../../evidence-panel/ui/EvidencePanel';
import { OfflineBadge } from '../../../shared/ui/offline/OfflineBadge';
import s from './AppShell.module.css';

/** Persistent 4-pane frame: rail / sidebar(tree) / center(Outlet) / context. */
export function AppShell({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  return (
    <div className={s.app}>
      <OfflineBadge />
      <Rail />
      <Sidebar className={drawerOpen ? s.drawerOpen ?? '' : ''} onNavigate={() => setDrawerOpen(false)} />
      {drawerOpen ? <div className={s.scrim} onClick={() => setDrawerOpen(false)} /> : null}
      <div className={s.center}>
        <button
          type="button"
          className={s.drawerBtn}
          aria-label="메뉴 열기"
          onClick={() => setDrawerOpen(true)}
        >
          <Icon name="menu" size="sm" decorative />
        </button>
        {children}
      </div>
      <ContextPanel />
    </div>
  );
}

function Rail() {
  const router = useRouter();
  const { logout } = useAuth();
  const { data } = useWorkspaces();
  const selected = useSelectedWorkspace();
  const theme = useTheme();
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [wsCreateOpen, setWsCreateOpen] = useState(false);
  const [wsName, setWsName] = useState('');
  const createWorkspace = useCreateWorkspace();
  const toast = useToast();

  async function submitCreateWorkspace() {
    const name = wsName.trim();
    if (!name || createWorkspace.isPending) return;
    try {
      const res = await createWorkspace.mutateAsync(name);
      wsStore.set(res.id);
      setWsCreateOpen(false);
      setWsName('');
      toast('success', `"${name}" 워크스페이스를 만들었어요.`);
    } catch {
      toast('error', '워크스페이스 생성에 실패했어요.');
    }
  }

  useEffect(() => {
    if (!data) return;
    const ok = data.workspaces.some((w) => w.id === selected);
    if (!ok && data.workspaces[0]) wsStore.set(data.workspaces[0].id);
  }, [data, selected]);

  const personal = data?.workspaces.filter((w) => w.isPersonal) ?? [];
  const shared = data?.workspaces.filter((w) => !w.isPersonal) ?? [];
  const themeIcon: IconName = theme === 'dark' ? 'moon' : 'sun';
  const themeLabel = theme === 'dark' ? '다크' : '라이트';

  return (
    <div className={s.rail}>
      {personal.length > 0 ? <div className={s.grpLabel}>개인</div> : null}
      {personal.map((w) => (
        <RailItem key={w.id} id={w.id} name={w.name} active={w.id === selected} />
      ))}
      {shared.length > 0 ? <div className={s.grpLabel}>공유</div> : null}
      {shared.map((w) => (
        <RailItem key={w.id} id={w.id} name={w.name} active={w.id === selected} />
      ))}
      <button
        type="button"
        className={s.wsAdd}
        title="새 워크스페이스"
        aria-label="새 워크스페이스 만들기"
        onClick={() => setWsCreateOpen(true)}
      >
        <Icon name="plus" size="sm" decorative />
      </button>
      <div className={s.spacer} />
      <button
        type="button"
        className={s.railAction}
        title={`테마: ${themeLabel} (라이트/다크 전환)`}
        aria-label={`테마 변경 — 현재 ${themeLabel}`}
        onClick={() => themeStore.cycle()}
      >
        <Icon name={themeIcon} size="sm" decorative />
        <span className={s.railActionLabel}>테마</span>
      </button>
      <button
        type="button"
        className={s.railAction}
        title="로그아웃"
        aria-label="로그아웃"
        onClick={() => setLogoutOpen(true)}
      >
        <Icon name="logout" size="sm" decorative />
        <span className={s.railActionLabel}>나가기</span>
      </button>
      <ConfirmDialog
        open={logoutOpen}
        onOpenChange={setLogoutOpen}
        title="로그아웃할까요?"
        description="저장된 작업은 그대로 유지됩니다. 다시 로그인하면 이어서 볼 수 있어요."
        confirmLabel="로그아웃"
        destructive
        onConfirm={() => {
          setLogoutOpen(false);
          logout();
          void router.navigate({ to: '/login', search: { redirect: '/' } });
        }}
      />
      <DialogRoot open={wsCreateOpen} onOpenChange={(open) => { setWsCreateOpen(open); if (!open) setWsName(''); }}>
        <DialogContent
          title="새 워크스페이스"
          description="워크스페이스는 팀·고객사 단위의 가장 큰 공간이에요. 안에 프로젝트와 채널을 만들 수 있습니다."
        >
          <form
            className={s.wsCreateForm}
            onSubmit={(e) => {
              e.preventDefault();
              void submitCreateWorkspace();
            }}
          >
            <Input
              autoFocus
              value={wsName}
              onChange={(e) => setWsName(e.target.value)}
              placeholder="예: 창원시 컨설팅"
              disabled={createWorkspace.isPending}
              maxLength={120}
            />
            <div className={s.wsCreateHint}>
              구조: 워크스페이스 → 프로젝트 → 채널(대화)
            </div>
            <div className={s.wsCreateActions}>
              <Button type="button" variant="secondary" onClick={() => setWsCreateOpen(false)} disabled={createWorkspace.isPending}>
                취소
              </Button>
              <Button type="submit" variant="primary" loading={createWorkspace.isPending} disabled={!wsName.trim()}>
                만들기
              </Button>
            </div>
          </form>
        </DialogContent>
      </DialogRoot>
    </div>
  );
}

function RailItem({ id, name, active }: { id: string; name: string; active: boolean }) {
  return (
    <div className={`${s.wsWrap} ${active ? s.active : ''}`}>
      <span className={s.wsBar} />
      <button
        type="button"
        className={s.ws}
        title={name}
        aria-label={`워크스페이스: ${name}`}
        aria-current={active ? 'true' : undefined}
        onClick={() => wsStore.set(id)}
      >
        {name.slice(0, 1)}
      </button>
    </div>
  );
}

/** 트리 안에서 바로 만드는 인라인 생성기 — 모달 없이 맥락 유지(사용자 선호),
 *  대신 확정/취소 버튼과 Enter/Esc 안내로 어포던스를 명확히. */
function InlineCreate({
  placeholder,
  onSubmit,
  busy,
  level,
}: {
  placeholder: string;
  onSubmit: (name: string) => void;
  busy: boolean;
  level: 'project' | 'channel' | 'topic';
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const levelClass = level === 'project' ? s.createProject : level === 'channel' ? s.createChannel : s.createTopic;

  function cancel() {
    setName('');
    setOpen(false);
  }
  if (!open) {
    return (
      <button type="button" className={s.newProj} onClick={() => setOpen(true)}>
        <span className={`${s.createTrigger} ${levelClass}`}>
          <Icon name="plus" size="xs" decorative /> {placeholder}
        </span>
      </button>
    );
  }
  return (
    <form
      className={`${s.inlineCreate} ${levelClass}`}
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) return;
        onSubmit(trimmed);
        setName('');
        setOpen(false);
      }}
    >
      <div className={s.inlineCreateRow}>
        <Input
          autoFocus
          disabled={busy}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') cancel();
          }}
          placeholder={placeholder}
          className={s.inlineCreateInput}
          aria-label={placeholder}
        />
        <button type="submit" className={s.inlineCreateOk} disabled={busy || !name.trim()} aria-label="만들기" title="만들기 (Enter)">
          {busy ? <Icon name="loader" size="xs" className="cwSpin" decorative /> : <Icon name="check" size="xs" decorative />}
        </button>
        <button type="button" className={s.inlineCreateCancel} onClick={cancel} disabled={busy} aria-label="취소" title="취소 (Esc)">
          <Icon name="x" size="xs" decorative />
        </button>
      </div>
      <div className={s.inlineCreateHint}>Enter 생성 · Esc 취소</div>
    </form>
  );
}

function Sidebar({ className = '', onNavigate }: { className?: string | undefined; onNavigate?: (() => void) | undefined }) {
  const router = useRouter();
  const location = useLocation();
  const { user } = useAuth();
  const toast = useToast();
  const selected = useSelectedWorkspace();
  const { data: wsData } = useWorkspaces();
  const { data: tree, isLoading } = useWorkspaceTree(selected ?? undefined);
  const activeThread = useActiveThread();
  const activeThreadDetail = useQuery({
    queryKey: ['thread', activeThread],
    queryFn: () => api.threadDetail(activeThread!),
    enabled: activeThread !== null,
    // 스레드 전환 순간 data가 undefined로 떨어지면 currentTopicId가 null이 되어
    // 좌측 선택 채널 하이라이트가 깜빡인다. 이전 값을 유지해 깜빡임을 없앤다.
    placeholderData: keepPreviousData,
  });
  const createProject = useCreateProject(selected ?? undefined);
  const createChannel = useCreateChannel(selected ?? undefined);
  const createTopic = useCreateTopic(selected ?? undefined);
  const renameNode = useRenameNode(selected ?? undefined);
  const deleteNode = useDeleteNode(selected ?? undefined);
  const { prompt, dialog } = useTextPrompt();
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'projects' | 'channels' | 'topics'; id: string; label: string } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());

  const routeTopicId = location.pathname.match(/^\/t\/([^/]+)/)?.[1] ?? null;
  const currentTopicId = activeThreadDetail.data?.topicId ?? routeTopicId;
  // 300ms 넘게 로딩일 때만 스켈레톤 — 즉시 로드는 깜빡임 없이 통과.
  const showTreeSkeleton = useDelayedFlag(isLoading, 300);

  const ws = wsData?.workspaces.find((w) => w.id === selected);
  const wsName = ws?.name ?? user?.displayName ?? '…';

  async function onRename(kind: 'projects' | 'channels' | 'topics', id: string, current: string) {
    const name = await prompt('새 이름을 입력하세요', current);
    if (!name || name === current) return;
    try {
      await renameNode.mutateAsync({ kind, id, name });
      toast('success', '이름을 변경했어요.');
    } catch {
      toast('error', '이름 변경에 실패했어요.');
    }
  }

  function onDelete(kind: 'projects' | 'channels' | 'topics', id: string, label: string) {
    setPendingDelete({ kind, id, label });
  }

  function toggleProject(projectId: string) {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  async function openChannel(channel: { id: string; name: string; topics: Array<{ id: string; name: string }> }) {
    try {
      const topicId = channel.topics[0]?.id ?? (await createTopic.mutateAsync({ channelId: channel.id, name: '대화' })).id;
      if (topicId === currentTopicId) return;
      onNavigate?.();
      await router.navigate({ to: '/t/$topicId', params: { topicId } });
    } catch {
      toast('error', '채널 대화를 여는 데 실패했어요.');
    }
  }

  async function createChannelWithDefaultTopic(projectId: string, name: string) {
    try {
      const channel = await createChannel.mutateAsync({ projectId, name });
      const topic = await createTopic.mutateAsync({ channelId: channel.id, name: '대화' });
      await router.navigate({ to: '/t/$topicId', params: { topicId: topic.id } });
    } catch {
      toast('error', '채널 생성에 실패했어요.');
    }
  }

  async function confirmDelete() {
    if (!pendingDelete || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await deleteNode.mutateAsync({ kind: pendingDelete.kind, id: pendingDelete.id });
      toast('success', '삭제했어요.');
      setPendingDelete(null);
    } catch {
      toast('error', '삭제에 실패했어요.');
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className={`${s.sidebar} ${className}`}>
      {dialog}
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && !deleteBusy && setPendingDelete(null)}
        title={`"${pendingDelete?.label ?? ''}" 삭제할까요?`}
        description="하위 항목도 함께 숨겨집니다. 이 작업은 되돌릴 수 없어요."
        confirmLabel="삭제"
        destructive
        busy={deleteBusy}
        onConfirm={() => void confirmDelete()}
      />
      <div className={s.wsHead}>
        <div className={s.wsIco}>{wsName.slice(0, 1)}</div>
        <div>
          <div className={s.wsName}>{wsName}</div>
          <div className={s.wsSub}>{ws ? `${ws.role}${ws.isPersonal ? ' · 개인' : ''}` : ''}</div>
        </div>
        <NotificationBell />
      </div>
      <Link
        to="/artifacts"
        className={s.workspaceTool}
        activeProps={{ className: `${s.workspaceTool} ${s.workspaceToolOn}` }}
        onClick={() => onNavigate?.()}
      >
        <Icon name="file-text" size="sm" decorative />
        <span>
          <strong>산출물 보관함</strong>
          <small>대화에서 확정한 보고서·문서</small>
        </span>
      </Link>
      <div className={s.tree}>
        <div className={s.secLabel}>프로젝트</div>
        {showTreeSkeleton ? (
          <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: 9 }}>
            <Skeleton width="100%" height={14} />
            <Skeleton width="70%" height={14} />
            <Skeleton width="85%" height={14} />
          </div>
        ) : null}
        {tree?.projects.map((p) => {
          const collapsed = collapsedProjects.has(p.id);
          return (
            <div key={p.id} className={`${s.projectBlock} ${collapsed ? s.projectBlockCollapsed : s.projectBlockOpen}`}>
              <div className={s.projRow}>
                <button
                  type="button"
                  className={`${s.projToggle} ${collapsed ? s.projToggleCollapsed : ''}`}
                  aria-label={collapsed ? `${p.name} 펼치기` : `${p.name} 접기`}
                  aria-expanded={!collapsed}
                  onClick={() => toggleProject(p.id)}
                >
                  <Icon name="chevron-down" size="xs" tone="muted" decorative />
                </button>
                <button type="button" className={s.projMain} onClick={() => toggleProject(p.id)}>
                  <Icon name="folder" size="xs" tone="muted" decorative />
                  {p.name}
                </button>
                <RowMenu
                  actions={[
                    { label: '이름 변경', onSelect: () => void onRename('projects', p.id, p.name) },
                    { label: '삭제', danger: true, onSelect: () => void onDelete('projects', p.id, p.name) },
                  ]}
                />
              </div>
              <div className={`${s.channelListShell} ${collapsed ? s.channelListCollapsed : s.channelListOpen}`} aria-hidden={collapsed} inert={collapsed ? true : undefined}>
                <div className={s.channelListInner}>
                  <div className={s.channelList}>
                    {p.channels.map((c) => {
                      const channelActive = c.topics.some((t) => t.id === currentTopicId);
                      return (
                      <div key={c.id} className={s.channelBlock}>
                        <div className={`${s.chanRow} ${channelActive ? s.chanRowActive : ''}`}>
                          <button
                            type="button"
                            className={s.chanMain}
                            aria-current={channelActive ? 'page' : undefined}
                            disabled={channelActive}
                            tabIndex={collapsed ? -1 : undefined}
                            onClick={() => void openChannel(c)}
                          >
                            <Icon name="hash" size="xs" tone="muted" decorative />
                            {c.name}
                          </button>
                          <RowMenu
                            actions={[
                              { label: '이름 변경', onSelect: () => void onRename('channels', c.id, c.name) },
                              { label: '삭제', danger: true, onSelect: () => void onDelete('channels', c.id, c.name) },
                            ]}
                          />
                        </div>
                      </div>
                      );
                    })}
                    <InlineCreate
                      level="channel"
                      placeholder="채널 추가"
                      busy={createChannel.isPending || createTopic.isPending}
                      onSubmit={(name) => void createChannelWithDefaultTopic(p.id, name)}
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        <InlineCreate
          level="project"
          placeholder="프로젝트 추가"
          busy={createProject.isPending}
          onSubmit={(name) => createProject.mutate(name)}
        />
      </div>
    </div>
  );
}

const roleLabel: Record<string, string> = {
  owner: '소유자',
  admin: '관리자',
  editor: '편집자',
  commenter: '댓글',
  viewer: '뷰어',
};

function ContextPanel() {
  const selected = useSelectedWorkspace();
  const { data: members } = useMembers(selected ?? undefined);
  const toast = useToast();
  const activeThread = useActiveThread();
  const [tab, setTab] = useState<'evidence' | 'members'>('members');
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer' | 'admin'>('editor');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const inviteRoleIndex = inviteRole === 'editor' ? 0 : inviteRole === 'viewer' ? 1 : 2;

  // Auto-switch to evidence when a thread opens (2-A E-4).
  useEffect(() => {
    if (activeThread) setTab('evidence');
    else setTab('members');
  }, [activeThread]);

  async function createInvite() {
    if (!selected || inviteBusy) return;
    setInviteBusy(true);
    setInviteLink(null);
    try {
      const res = await api.createInvitation({
        workspaceId: selected,
        scopeType: 'workspace',
        scopeId: selected,
        role: inviteRole,
      });
      const link = `${window.location.origin}/invite/${res.token}`;
      setInviteLink(link);
      try {
        await navigator.clipboard.writeText(link);
        toast('success', '초대 링크를 복사했어요.');
      } catch {
        toast('info', '아래 링크를 직접 복사해주세요.');
      }
    } catch {
      toast('error', '초대 링크 생성에 실패했어요.');
    } finally {
      setInviteBusy(false);
    }
  }

  return (
    <div className={s.context}>
      {activeThread ? (
        <div className={s.ctxTabs}>
          <button
            type="button"
            className={`${s.ctxTab} ${tab === 'evidence' ? s.ctxTabOn : ''}`}
            onClick={() => setTab('evidence')}
          >
            근거
          </button>
          <button
            type="button"
            className={`${s.ctxTab} ${tab === 'members' ? s.ctxTabOn : ''}`}
            onClick={() => setTab('members')}
          >
            멤버
          </button>
        </div>
      ) : null}

      {tab === 'evidence' && activeThread ? (
        <div className={s.ctxSection}>
          <div className={s.ctxTitle}>근거 자료</div>
          <EvidencePanel threadId={activeThread} />
        </div>
      ) : (
        <>
          <div className={s.ctxSection}>
            <div className={s.ctxTitle}>멤버</div>
            {members?.members.map((m) => (
              <div key={m.userId} className={s.member}>
                <div className={s.memberAv}>{m.displayName.slice(0, 1)}</div>
                <div className={s.memberName}>{m.displayName}</div>
                <div className={s.memberRole}>{roleLabel[m.role] ?? m.role}</div>
              </div>
            ))}
          </div>

          <div className={s.ctxSection}>
            <div className={s.ctxTitle}>초대</div>
            <div
              className={s.roleSeg}
              role="radiogroup"
              aria-label="초대 권한 선택"
              style={{ '--role-index': inviteRoleIndex } as CSSProperties}
            >
              <span className={s.roleSegThumb} aria-hidden="true" />
          {(['editor', 'viewer', 'admin'] as const).map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={inviteRole === r}
              className={`${s.roleSegItem} ${inviteRole === r ? s.roleSegOn : ''}`}
              onClick={() => setInviteRole(r)}
            >
              {roleLabel[r]}
            </button>
          ))}
        </div>
        <Button type="button" variant="primary" size="sm" className={s.inviteBtn} disabled={inviteBusy || !selected} onClick={() => void createInvite()}>
          {inviteBusy ? '생성 중…' : '초대 링크 생성'}
        </Button>
        {inviteLink ? (
          <div
            className={s.inviteLink}
            title="클릭하여 복사"
            onClick={() => {
              void navigator.clipboard.writeText(inviteLink).then(() => toast('success', '복사했어요.'));
            }}
          >
            {inviteLink}
          </div>
        ) : null}
        <div className={s.ctxHint}>링크를 받은 사람은 가입/로그인 후 이 워크스페이스에 참여합니다. 7일 후 만료.</div>
          </div>
        </>
      )}
    </div>
  );
}
