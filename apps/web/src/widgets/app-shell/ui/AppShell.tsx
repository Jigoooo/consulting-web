import { useEffect, useState, type ReactNode } from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import { useAuth } from '../../../lib/useAuth';
import {
  useWorkspaces,
  useWorkspaceTree,
  useCreateProject,
  useCreateChannel,
  useCreateTopic,
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
import { NotificationBell } from '../../notification-center/ui/NotificationBell';
import { Icon } from '../../../shared/icons/Icon';
import type { IconName } from '../../../shared/icons/registry';
import { Button } from '../../../shared/ui/button/Button';
import { Input } from '../../../shared/ui/input/Input';
import { EvidencePanel } from '../../evidence-panel/ui/EvidencePanel';
import s from './AppShell.module.css';

/** Persistent 4-pane frame: rail / sidebar(tree) / center(Outlet) / context. */
export function AppShell({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  return (
    <div className={s.app}>
      <Rail />
      <Sidebar className={drawerOpen ? s.drawerOpen ?? '' : ''} onNavigate={() => setDrawerOpen(false)} />
      {drawerOpen ? <div className={s.scrim} onClick={() => setDrawerOpen(false)} /> : null}
      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-canvas)' }}>
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

  useEffect(() => {
    if (!data) return;
    const ok = data.workspaces.some((w) => w.id === selected);
    if (!ok && data.workspaces[0]) wsStore.set(data.workspaces[0].id);
  }, [data, selected]);

  const personal = data?.workspaces.filter((w) => w.isPersonal) ?? [];
  const shared = data?.workspaces.filter((w) => !w.isPersonal) ?? [];
  const themeIcon: IconName = theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'monitor';

  return (
    <div className={s.rail}>
      {personal.map((w) => (
        <RailItem key={w.id} id={w.id} name={w.name} active={w.id === selected} />
      ))}
      {shared.length > 0 ? <div className={s.grpLabel}>공유</div> : null}
      {shared.map((w) => (
        <RailItem key={w.id} id={w.id} name={w.name} active={w.id === selected} />
      ))}
      <div className={s.spacer} />
      <Link to="/artifacts" className={s.rbtn} title="산출물" activeProps={{ className: `${s.rbtn} ${s.rbtnOn}` }}>
        <Icon name="file-text" size="sm" decorative />
      </Link>
      <div className={s.rbtn} title={`테마: ${theme === 'dark' ? '다크' : theme === 'light' ? '라이트' : '시스템'} (클릭하여 변경)`} onClick={() => themeStore.cycle()}>
        <Icon name={themeIcon} size="sm" decorative />
      </div>
      <div
        className={s.rbtn}
        title="로그아웃"
        onClick={() => {
          logout();
          void router.navigate({ to: '/login', search: { redirect: '/' } });
        }}
      >
        <Icon name="logout" size="sm" decorative />
      </div>
    </div>
  );
}

function RailItem({ id, name, active }: { id: string; name: string; active: boolean }) {
  return (
    <div className={`${s.wsWrap} ${active ? s.active : ''}`} onClick={() => wsStore.set(id)}>
      <span className={s.wsBar} />
      <div className={s.ws} title={name}>
        {name.slice(0, 1)}
      </div>
    </div>
  );
}

function InlineCreate({ placeholder, onSubmit, busy }: { placeholder: string; onSubmit: (name: string) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  if (!open) {
    return (
      <div className={s.newProj} onClick={() => setOpen(true)}>
        + {placeholder}
      </div>
    );
  }
  return (
    <form
      style={{ margin: '6px 8px' }}
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) return;
        onSubmit(trimmed);
        setName('');
        setOpen(false);
      }}
    >
      <Input
        autoFocus
        disabled={busy}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => !name.trim() && setOpen(false)}
        placeholder={placeholder}
        style={{
          width: '100%',
          font: 'inherit',
          fontSize: 13,
          padding: '6px 9px',
          border: '1px solid var(--accent)',
          borderRadius: 7,
          outline: 'none',
          boxShadow: '0 0 0 3px var(--accent-soft)',
        }}
      />
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

  async function onDelete(kind: 'projects' | 'channels' | 'topics', id: string, label: string) {
    if (!window.confirm(`"${label}"을(를) 삭제할까요? 하위 항목도 함께 숨겨집니다.`)) return;
    try {
      await deleteNode.mutateAsync({ kind, id });
      toast('success', '삭제했어요.');
    } catch {
      toast('error', '삭제에 실패했어요.');
    }
  }

  return (
    <div className={`${s.sidebar} ${className}`}>
      {dialog}
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
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          {(['editor', 'viewer', 'admin'] as const).map((r) => (
            <Button
              key={r}
              type="button"
              variant={inviteRole === r ? 'primary' : 'ghost'}
              size="xs"
              className={`${s.rolePick} ${inviteRole === r ? s.rolePickOn : ''}`}
              onClick={() => setInviteRole(r)}
            >
              {roleLabel[r]}
            </Button>
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
