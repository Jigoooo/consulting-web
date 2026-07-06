import { useEffect, useState, type ReactNode } from 'react';
import { Link, useRouter } from '@tanstack/react-router';
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
  const themeIcon: IconName = theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'monitor';
  const themeLabel = theme === 'dark' ? '다크' : theme === 'light' ? '라이트' : '시스템';

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
      <Link
        to="/artifacts"
        className={s.railAction}
        title="산출물 보관함"
        aria-label="산출물 보관함"
        activeProps={{ className: `${s.railAction} ${s.rbtnOn}` }}
      >
        <Icon name="file-text" size="sm" decorative />
        <span className={s.railActionLabel}>산출물</span>
      </Link>
      <button
        type="button"
        className={s.railAction}
        title={`테마: ${themeLabel} (클릭하여 변경)`}
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
              구조: 워크스페이스 → 프로젝트 → 채널 → 토픽(대화)
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
function InlineCreate({ placeholder, onSubmit, busy }: { placeholder: string; onSubmit: (name: string) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  function cancel() {
    setName('');
    setOpen(false);
  }
  if (!open) {
    return (
      <button type="button" className={s.newProj} onClick={() => setOpen(true)}>
        <Icon name="plus" size="xs" decorative /> {placeholder}
      </button>
    );
  }
  return (
    <form
      className={s.inlineCreate}
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
  const { user } = useAuth();
  const toast = useToast();
  const selected = useSelectedWorkspace();
  const { data: wsData } = useWorkspaces();
  const { data: tree, isLoading } = useWorkspaceTree(selected ?? undefined);
  const createProject = useCreateProject(selected ?? undefined);
  const createChannel = useCreateChannel(selected ?? undefined);
  const createTopic = useCreateTopic(selected ?? undefined);
  const renameNode = useRenameNode(selected ?? undefined);
  const deleteNode = useDeleteNode(selected ?? undefined);
  const { prompt, dialog } = useTextPrompt();
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'projects' | 'channels' | 'topics'; id: string; label: string } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

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
      <div className={s.tree}>
        <div className={s.secLabel}>프로젝트</div>
        {isLoading ? (
          <div style={{ padding: '8px' }}>
            <div className={s.skel} />
            <div className={s.skel} style={{ width: '70%' }} />
            <div className={s.skel} style={{ width: '85%' }} />
          </div>
        ) : null}
        {tree?.projects.map((p) => (
          <div key={p.id}>
            <div className={s.projRow}>
              <Icon name="chevron-down" size="xs" tone="muted" decorative /> {p.name}
              <RowMenu
                actions={[
                  { label: '이름 변경', onSelect: () => void onRename('projects', p.id, p.name) },
                  { label: '삭제', danger: true, onSelect: () => void onDelete('projects', p.id, p.name) },
                ]}
              />
            </div>
            {p.channels.map((c) => (
              <div key={c.id}>
                <div className={s.chanRow}>
                  # {c.name}
                  <RowMenu
                    actions={[
                      { label: '이름 변경', onSelect: () => void onRename('channels', c.id, c.name) },
                      { label: '삭제', danger: true, onSelect: () => void onDelete('channels', c.id, c.name) },
                    ]}
                  />
                </div>
                {c.topics.map((t) => (
                  <div key={t.id} style={{ display: 'flex', alignItems: 'center' }}>
                    <Link
                      to="/t/$topicId"
                      params={{ topicId: t.id }}
                      className={s.topic}
                      style={{ flex: 1 }}
                      activeProps={{ className: `${s.topic} ${s.active}` }}
                      onClick={() => onNavigate?.()}
                    >
                      <span className={s.hash}>#</span> {t.name}
                    </Link>
                    <RowMenu
                      actions={[
                        { label: '이름 변경', onSelect: () => void onRename('topics', t.id, t.name) },
                        { label: '삭제', danger: true, onSelect: () => void onDelete('topics', t.id, t.name) },
                      ]}
                    />
                  </div>
                ))}
                <InlineCreate
                  placeholder="새 토픽"
                  busy={createTopic.isPending}
                  onSubmit={(name) => createTopic.mutate({ channelId: c.id, name })}
                />
              </div>
            ))}
            <InlineCreate
              placeholder="새 채널"
              busy={createChannel.isPending}
              onSubmit={(name) => createChannel.mutate({ projectId: p.id, name })}
            />
          </div>
        ))}
        <InlineCreate
          placeholder="새 프로젝트"
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
        <div className={s.roleSeg} role="radiogroup" aria-label="초대 권한 선택">
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
