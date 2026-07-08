import { useEffect, useRef, useState, useTransition, type CSSProperties, type ReactNode } from 'react';
import { useLocation, useRouter } from '@tanstack/react-router';
import { ApiClientError } from '@consulting/api-client';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useAuth } from '../../../lib/useAuth';
import {
  useWorkspaces,
  useWorkspaceTree,
  useCreateProject,
  useCreateChannel,
  useCreateTopic,
  useCreateWorkspace,
  useRenameNode,
  useArchiveNode,
  useArchivedScopes,
  useRestoreArchived,
  useMembers,
} from '../../../lib/spaces';
import { useSelectedWorkspace, wsStore } from '../../../lib/wsStore';
import { tailScrollRequestStore, useActiveThread } from '../../../lib/threadCtx';
import { useTheme, themeStore } from '../../../lib/themeStore';
import { api } from '../../../lib/api';
import { resolveTopicThreadForNavigation } from '../../../lib/openTopicThread';
import { useToast } from '../../../shared/ui/toast/Toast';
import { RowMenu, useTextPrompt } from '../../../shared/ui/menu/Menu';
import { ConfirmDialog, DialogRoot, DialogContent } from '../../../shared/ui/dialog/Dialog';
import { NotificationBell } from '../../notification-center/ui/NotificationBell';
import { Icon } from '../../../shared/icons/Icon';
import type { IconName } from '../../../shared/icons/registry';
import { Button } from '../../../shared/ui/button/Button';
import { Input } from '../../../shared/ui/input/Input';
import { Skeleton } from '../../../shared/ui/skeleton/Skeleton';
import { EmptyState } from '../../../shared/ui/feedback/EmptyState';
import { useDelayedFlag } from '../../../shared/lib/useDelayedFlag';
import { EvidencePanel } from '../../evidence-panel/ui/EvidencePanel';
import { SearchResultsPanel } from '../../evidence-panel/ui/SearchResultsPanel';
import { messageWindowKeys } from '../../chat-thread/model/useMessageWindow';
import { searchStore, useSearchState } from '../../chat-thread/model/searchStore';
import { OfflineBadge } from '../../../shared/ui/offline/OfflineBadge';
import { workspaceModalStore, useWorkspaceModal } from '../../../lib/workspaceModalStore';
import { ArtifactsSurface } from '../../../components/artifacts/ArtifactsSurface';
import { LibrarySurface } from '../../../components/library/LibrarySurface';
import { getContextPanelTabs, resolveWorkspaceModalPresentationKind } from '../model/contextPanelView';
import s from './AppShell.module.css';

/** Persistent 4-pane frame: rail / sidebar(tree) / center(Outlet) / context. */
export function AppShell({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const [contextCollapsed, setContextCollapsed] = useState(false);
  const searchState = useSearchState();
  useEffect(() => {
    if (location.pathname === '/library' || location.pathname === '/artifacts') {
      setContextCollapsed(true);
    }
  }, [location.pathname]);
  useEffect(() => {
    if (location.pathname.startsWith('/th/') && searchState.open && searchState.query) {
      setContextCollapsed(false);
    }
  }, [location.pathname, searchState.open, searchState.query]);
  return (
    <div className={`${s.app} ${contextCollapsed ? s.appContextCollapsed : ''}`}>
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
      <ContextPanel collapsed={contextCollapsed} onToggle={() => setContextCollapsed((prev) => !prev)} />
      <WorkspaceSurfaceModal />
    </div>
  );
}

function WorkspaceSurfaceModal() {
  const modal = useWorkspaceModal();
  const open = modal.kind !== null;
  const presentationKind = resolveWorkspaceModalPresentationKind(modal);
  const title = presentationKind === 'library' ? '자료실' : presentationKind === 'members' ? '워크스페이스 멤버' : '산출물 보관함';
  const description =
    presentationKind === 'library'
      ? '대화 흐름은 그대로 두고 자료만 확인합니다.'
      : presentationKind === 'members'
        ? '이 워크스페이스에 참여한 사람과 초대를 관리합니다.'
        : '대화 흐름은 그대로 두고 확정 문서만 확인합니다.';
  return (
    <DialogRoot open={open} onOpenChange={(next) => { if (!next) workspaceModalStore.close(); }}>
      <DialogContent
        className={presentationKind === 'members' ? s.membersDialog : s.workspaceSurfaceDialog}
        title={title}
        description={description}
      >
        {presentationKind === 'library' ? (
          <LibrarySurface variant="modal" />
        ) : presentationKind === 'artifacts' ? (
          <ArtifactsSurface initialProjectId={modal.projectId} variant="modal" />
        ) : presentationKind === 'members' ? (
          <WorkspaceMembersPanel />
        ) : null}
      </DialogContent>
    </DialogRoot>
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
  resetSignal,
}: {
  placeholder: string;
  onSubmit: (name: string) => void;
  busy: boolean;
  level: 'project' | 'channel' | 'topic';
  resetSignal?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const levelClass = level === 'project' ? s.createProject : level === 'channel' ? s.createChannel : s.createTopic;

  function cancel() {
    setName('');
    setOpen(false);
  }
  useEffect(() => {
    setName('');
    setOpen(false);
  }, [resetSignal]);
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
  const qc = useQueryClient();
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
  const archiveNode = useArchiveNode(selected ?? undefined);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const archivedScopes = useArchivedScopes(selected ?? undefined, archiveOpen);
  const restoreArchived = useRestoreArchived(selected ?? undefined);
  const { prompt, dialog } = useTextPrompt();
  const [pendingArchive, setPendingArchive] = useState<{ kind: 'projects' | 'channels' | 'topics'; id: string; label: string } | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  // A3: optimistic channel selection — highlight the clicked topic instantly
  // instead of waiting for threadDetail to resolve (keepPreviousData otherwise
  // holds the OLD highlight until the new topic loads, which reads as lag).
  const [pendingTopicId, setPendingTopicId] = useState<string | null>(null);
  const [isNavPending, startNav] = useTransition();
  const lastClickedTopicRef = useRef<string | null>(null);
  const navSpinner = useDelayedFlag(isNavPending, 150);

  const routeTopicId = location.pathname.match(/^\/t\/([^/]+)/)?.[1] ?? null;
  const resolvedTopicId = activeThreadDetail.data?.topicId ?? routeTopicId;
  // Optimistic id wins until the server-resolved id catches up to it.
  const currentTopicId = pendingTopicId ?? resolvedTopicId;

  // Once the route/detail resolves to the optimistic target, clear the override.
  useEffect(() => {
    if (pendingTopicId && resolvedTopicId === pendingTopicId) setPendingTopicId(null);
  }, [pendingTopicId, resolvedTopicId]);

  // 300ms 넘게 로딩일 때만 스켈레톤 — 즉시 로드는 깜빡임 없이 통과.
  const showTreeSkeleton = useDelayedFlag(isLoading, 300, 260);

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

  function onArchive(kind: 'projects' | 'channels' | 'topics', id: string, label: string) {
    setPendingArchive({ kind, id, label });
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
      lastClickedTopicRef.current = topicId;
      if (topicId === currentTopicId) {
        tailScrollRequestStore.request();
        onNavigate?.();
        return;
      }
      // A3: optimistic highlight now; defer the (heavier) route swap so the click
      // feedback is never blocked by rendering the new thread.
      setPendingTopicId(topicId);
      onNavigate?.();
      // G1-fix: resolve the channel's default thread ourselves and navigate
      // straight to /th/:threadId, skipping the /t/:topicId bridge that fetched
      // threads then redirected (a 2-hop sequence that made fast clicks feel
      // swallowed). ensureQueryData reuses the react-query cache, so a revisited
      // channel is instant (0 network); a first visit does one fetch. latest-wins
      // is keyed on the topic the user last clicked.
      startNav(() => {
        void (async () => {
          try {
            // A newer click won the race — abandon this navigation.
            if (lastClickedTopicRef.current !== topicId) return;
            const thread = await resolveTopicThreadForNavigation({ queryClient: qc, topicId, workspaceId: selected ?? undefined });
            if (lastClickedTopicRef.current !== topicId) return;
            void qc.prefetchQuery({
              queryKey: messageWindowKeys.latest(thread.id),
              queryFn: () => api.listMessagesPage(thread.id, { limit: 50 }),
              staleTime: 30_000,
            });
            void router.navigate({ to: '/th/$threadId', params: { threadId: thread.id } });
          } catch {
            if (lastClickedTopicRef.current === topicId) {
              setPendingTopicId(null);
              toast('error', '채널 대화를 여는 데 실패했어요.');
            }
          }
        })();
      });
    } catch {
      setPendingTopicId(null);
      toast('error', '채널 대화를 여는 데 실패했어요.');
    }
  }

  async function createChannelWithDefaultTopic(projectId: string, name: string) {
    try {
      const channel = await createChannel.mutateAsync({ projectId, name });
      const topic = await createTopic.mutateAsync({ channelId: channel.id, name: '대화' });
      const thread = await resolveTopicThreadForNavigation({ queryClient: qc, topicId: topic.id, workspaceId: selected ?? undefined });
      await router.navigate({ to: '/th/$threadId', params: { threadId: thread.id } });
    } catch {
      toast('error', '채널 생성에 실패했어요.');
    }
  }

  async function confirmArchive() {
    if (!pendingArchive || archiveBusy) return;
    setArchiveBusy(true);
    try {
      await archiveNode.mutateAsync({ kind: pendingArchive.kind, id: pendingArchive.id });
      const activeScope = activeThreadDetail.data;
      const archivedCurrentView = Boolean(activeScope && (
        (pendingArchive.kind === 'projects' && activeScope.projectId === pendingArchive.id) ||
        (pendingArchive.kind === 'channels' && activeScope.channelId === pendingArchive.id) ||
        (pendingArchive.kind === 'topics' && activeScope.topicId === pendingArchive.id)
      ));
      if (archivedCurrentView) {
        setPendingTopicId(null);
        lastClickedTopicRef.current = null;
        await qc.invalidateQueries({ queryKey: ['thread'] });
        await router.navigate({ to: '/' });
      }
      toast('success', '보관했어요.');
      setPendingArchive(null);
    } catch {
      toast('error', '보관에 실패했어요.');
    } finally {
      setArchiveBusy(false);
    }
  }

  async function restoreArchiveItem(item: { kind: 'project' | 'channel' | 'topic' | 'thread'; id: string; name: string }) {
    try {
      await restoreArchived.mutateAsync({ kind: item.kind, id: item.id });
      toast('success', `"${item.name}" 복원했어요.`);
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'PARENT_ARCHIVED') {
        toast('info', '상위 항목을 먼저 복원해야 해요.');
        return;
      }
      toast('error', '복원에 실패했어요.');
    }
  }

  return (
    <div className={`${s.sidebar} ${className}`}>
      {dialog}
      <ConfirmDialog
        open={pendingArchive !== null}
        onOpenChange={(open) => !open && !archiveBusy && setPendingArchive(null)}
        title={`"${pendingArchive?.label ?? ''}" 보관할까요?`}
        description="목록에서는 숨겨지지만 지구가 참고할 수 있는 지식으로 보존됩니다. 필요하면 다시 꺼낼 수 있어요."
        confirmLabel="보관하기"
        busy={archiveBusy}
        onConfirm={() => void confirmArchive()}
      />
      <DialogRoot open={archiveOpen} onOpenChange={setArchiveOpen}>
        <DialogContent
          className={s.archiveDialog}
          title="숨긴 항목"
          description="목록에서 숨긴 프로젝트·채널·대화는 지식으로 보존됩니다. 필요하면 여기서 다시 표시할 수 있어요."
        >
          <div className={s.archiveList} aria-busy={archivedScopes.isFetching || undefined}>
            {archivedScopes.isLoading ? (
              <div className={s.archiveSkeletons}>
                <Skeleton width="100%" height={44} />
                <Skeleton width="82%" height={44} />
                <Skeleton width="94%" height={44} />
              </div>
            ) : archivedScopes.isError ? (
              <div className={`${s.archiveEmpty} ${s.archiveError}`}>
                <div>보관함을 불러오지 못했어요.</div>
                <Button size="xs" variant="secondary" loading={archivedScopes.isFetching} onClick={() => void archivedScopes.refetch()}>
                  다시 불러오기
                </Button>
              </div>
            ) : archivedScopes.data?.items.length ? (
              archivedScopes.data.items.map((item) => (
                <div key={`${item.kind}:${item.id}`} className={s.archiveItem}>
                  <div className={s.archiveMeta}>
                    <div className={s.archiveTitle}>
                      <span className={s.archiveKind}>{archiveKindLabel[item.kind]}</span>
                      <span>{item.name}</span>
                    </div>
                    <div className={s.archivePath}>{item.parentPath.length ? item.parentPath.join(' › ') : '워크스페이스 바로 아래'}</div>
                  </div>
                  <Button size="xs" variant="secondary" loading={restoreArchived.isPending} onClick={() => void restoreArchiveItem(item)}>
                    복원
                  </Button>
                </div>
              ))
            ) : (
              <div className={s.archiveEmpty}>보관한 항목이 아직 없어요.</div>
            )}
          </div>
        </DialogContent>
      </DialogRoot>
      <div className={s.wsHead}>
        <div className={s.wsIco}>{wsName.slice(0, 1)}</div>
        <div className={s.wsHeadMain}>
          <div className={s.wsName}>{wsName}</div>
          <div className={s.wsSub}>{ws ? `${ws.role}${ws.isPersonal ? ' · 개인' : ''}` : ''}</div>
        </div>
        <div className={s.wsHeadActions}>
          <button
            type="button"
            className={s.wsHeadBtn}
            title="워크스페이스 멤버"
            aria-label="워크스페이스 멤버"
            disabled={!selected}
            onClick={() => workspaceModalStore.open('members')}
          >
            <Icon name="user-plus" size="sm" decorative />
          </button>
          <NotificationBell />
        </div>
      </div>
      <button
        type="button"
        className={s.workspaceTool}
        onClick={() => {
          workspaceModalStore.open('artifacts');
          onNavigate?.();
        }}
      >
        <Icon name="file-text" size="sm" decorative />
        <span>
          <strong>산출물 보관함</strong>
          <small>대화에서 확정한 보고서·문서</small>
        </span>
      </button>
      <button
        type="button"
        className={s.workspaceTool}
        onClick={() => {
          workspaceModalStore.open('library');
          onNavigate?.();
        }}
      >
        <Icon name="files" size="sm" decorative />
        <span>
          <strong>자료실</strong>
          <small>근거·업로드 문서 모아보기</small>
        </span>
      </button>
      <button type="button" className={s.workspaceTool} onClick={() => setArchiveOpen(true)} disabled={!selected}>
        <Icon name="library" size="sm" decorative />
        <span>
          <strong>숨긴 항목</strong>
          <small>목록에서 숨긴 프로젝트·채널·대화 복원</small>
        </span>
      </button>
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
          const createResetSignal = `${selected ?? ''}:${location.pathname}:${currentTopicId ?? ''}`;
          return (
            <div key={p.id} className={`${s.projectBlock} ${collapsed ? s.projectBlockCollapsed : s.projectBlockOpen}`}>
              <div
                className={s.projRow}
                role="button"
                tabIndex={0}
                aria-expanded={!collapsed}
                aria-label={collapsed ? `${p.name} 펼치기` : `${p.name} 접기`}
                onClick={() => toggleProject(p.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleProject(p.id);
                  }
                }}
              >
                <span className={`${s.projToggle} ${collapsed ? s.projToggleCollapsed : ''}`} aria-hidden>
                  <Icon name="chevron-down" size="xs" tone="muted" decorative />
                </span>
                <span className={s.projMain}>
                  <Icon name="folder" size="xs" tone="muted" decorative />
                  {p.name}
                </span>
                <RowMenu
                  actions={[
                    { label: '산출물 보기', onSelect: () => workspaceModalStore.open('artifacts', { projectId: p.id }) },
                    { label: '이름 변경', onSelect: () => void onRename('projects', p.id, p.name) },
                    { label: '보관하기', onSelect: () => void onArchive('projects', p.id, p.name) },
                  ]}
                />
              </div>
              <div className={`${s.channelListShell} ${collapsed ? s.channelListCollapsed : s.channelListOpen}`} aria-hidden={collapsed} inert={collapsed ? true : undefined}>
                <div className={s.channelListInner}>
                  <div className={s.channelList}>
                    {p.channels.map((c) => {
                      const channelActive = c.topics.some((t) => t.id === currentTopicId);
                      const channelPending = navSpinner && c.topics.some((t) => t.id === pendingTopicId);
                      return (
                      <div key={c.id} className={s.channelBlock}>
                        <div
                          className={`${s.chanRow} ${channelActive ? s.chanRowActive : ''}`}
                          role="button"
                          tabIndex={collapsed ? -1 : 0}
                          aria-current={channelActive ? 'page' : undefined}
                          onClick={() => void openChannel(c)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              void openChannel(c);
                            }
                          }}
                        >
                          <span className={s.chanMain}>
                            <Icon name="hash" size="xs" tone="muted" decorative />
                            {c.name}
                            {channelPending ? <Icon name="loader" size="xs" tone="muted" decorative className="cwSpin" /> : null}
                          </span>
                          <RowMenu
                            actions={[
                              { label: '이름 변경', onSelect: () => void onRename('channels', c.id, c.name) },
                              { label: '보관하기', onSelect: () => void onArchive('channels', c.id, c.name) },
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
                      resetSignal={createResetSignal}
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
          resetSignal={`${selected ?? ''}:${location.pathname}:${currentTopicId ?? ''}`}
          onSubmit={(name) => createProject.mutate(name)}
        />
      </div>
    </div>
  );
}

const archiveKindLabel: Record<'project' | 'channel' | 'topic' | 'thread', string> = {
  project: '프로젝트',
  channel: '채널',
  topic: '대화 묶음',
  thread: '대화',
};

const roleLabel: Record<string, string> = {
  owner: '소유자',
  admin: '관리자',
  editor: '편집자',
  commenter: '댓글',
  viewer: '뷰어',
};

function WorkspaceMembersPanel() {
  const selected = useSelectedWorkspace();
  const { data: members } = useMembers(selected ?? undefined);
  const toast = useToast();
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer' | 'admin'>('editor');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const inviteRoleIndex = inviteRole === 'editor' ? 0 : inviteRole === 'viewer' ? 1 : 2;

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
    <div className={s.membersModalBody}>
      <div className={s.ctxSection}>
        <div className={s.ctxTitle}>멤버 {members?.members.length ? `· ${members.members.length}` : ''}</div>
        {members?.members.length ? (
          members.members.map((m) => (
            <div key={m.userId} className={s.member}>
              <div className={s.memberAv}>{m.displayName.slice(0, 1)}</div>
              <div className={s.memberName}>{m.displayName}</div>
              <div className={s.memberRole}>{roleLabel[m.role] ?? m.role}</div>
            </div>
          ))
        ) : (
          <div className={s.ctxHint}>아직 멤버가 없어요. 아래에서 초대 링크를 만들어 보세요.</div>
        )}
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
    </div>
  );
}

function ContextPanel({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const activeThread = useActiveThread();
  const searchState = useSearchState();
  // #6: resolve the active thread's project so the evidence panel can offer a
  // project-wide scope toggle.
  const activeThreadDetail = useQuery({
    queryKey: ['thread', activeThread],
    queryFn: () => api.threadDetail(activeThread!),
    enabled: activeThread !== null,
    placeholderData: keepPreviousData,
  });
  const activeProjectId = activeThreadDetail.data?.projectId;
  const [tab, setTab] = useState<'evidence' | 'search'>('evidence');
  const hasSearch = Boolean(searchState.query) && searchState.threadId === activeThread;
  const searchCount = searchState.results.length + searchState.files.length + searchState.evidence.length;
  const contextTabs = getContextPanelTabs({ hasSearch, searchCount });

  // Auto-switch to search when a search is active (F3); otherwise show evidence.
  useEffect(() => {
    if (hasSearch) setTab('search');
    else setTab('evidence');
  }, [activeThread, hasSearch]);

  return (
    <div className={`${s.context} ${collapsed ? s.contextCollapsed : ''}`}>
      <button
        type="button"
        className={`${s.contextToggle} cwTap`}
        onClick={onToggle}
        aria-label={collapsed ? '우측 패널 열기' : '우측 패널 접기'}
        title={collapsed ? '우측 패널 열기' : '우측 패널 접기'}
      >
        <Icon name={collapsed ? 'chevron-left' : 'chevron-right'} size="xs" decorative />
      </button>
      <div className={`${s.contextContent} ${collapsed ? s.contextContentHidden : ''}`} aria-hidden={collapsed} inert={collapsed ? true : undefined}>
        {activeThread ? (
          <>
            {contextTabs.length ? (
              <div className={s.ctxTabs}>
                {contextTabs.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`${s.ctxTab} ${tab === item.id ? s.ctxTabOn : ''}`}
                    onClick={() => setTab(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}

            {tab === 'search' && hasSearch ? (
              <div className={s.ctxSection}>
                <div className={s.ctxTitle}>검색 결과</div>
                <SearchResultsPanel onJump={(index) => searchStore.focusIndex(index)} />
              </div>
            ) : (
              <div className={s.ctxSection}>
                <div className={s.ctxTitle}>근거 자료</div>
                <EvidencePanel threadId={activeThread} {...(activeProjectId ? { projectId: activeProjectId } : {})} />
              </div>
            )}
          </>
        ) : (
          <div className={s.ctxSection}>
            <EmptyState icon="pin" title="채널을 열어보세요" description="채널 대화를 열면 이 답변의 근거와 검증이 여기에 정리됩니다." />
          </div>
        )}
      </div>
    </div>
  );
}
