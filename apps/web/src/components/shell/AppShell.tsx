import { useEffect, useState, type ReactNode } from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import { useAuth } from '../../lib/useAuth';
import { useWorkspaces, useWorkspaceTree, useCreateProject, useCreateChannel, useCreateTopic } from '../../lib/spaces';
import { useSelectedWorkspace, wsStore } from '../../lib/wsStore';
import s from './AppShell.module.css';

/**
 * AppShell — persistent 4-pane frame, now backed by real data:
 * rail = workspaces (listWorkspaces), sidebar = tree (workspaceTree),
 * center = routed Outlet (topic/thread views).
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className={s.app}>
      <Rail />
      <Sidebar />
      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-canvas)' }}>
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

  // Auto-select: stored id if still a member, else first workspace.
  useEffect(() => {
    if (!data) return;
    const ok = data.workspaces.some((w) => w.id === selected);
    if (!ok && data.workspaces[0]) wsStore.set(data.workspaces[0].id);
  }, [data, selected]);

  const personal = data?.workspaces.filter((w) => w.isPersonal) ?? [];
  const shared = data?.workspaces.filter((w) => !w.isPersonal) ?? [];

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
      <div
        className={s.rbtn}
        title="로그아웃"
        onClick={() => {
          logout();
          void router.navigate({ to: '/login', search: { redirect: '/' } });
        }}
      >
        ⎋
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

/** Inline "+ name" creator row used for project/channel/topic creation. */
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
      <input
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

function Sidebar() {
  const { user } = useAuth();
  const selected = useSelectedWorkspace();
  const { data: wsData } = useWorkspaces();
  const { data: tree, isLoading } = useWorkspaceTree(selected ?? undefined);
  const createProject = useCreateProject(selected ?? undefined);
  const createChannel = useCreateChannel(selected ?? undefined);
  const createTopic = useCreateTopic(selected ?? undefined);

  const ws = wsData?.workspaces.find((w) => w.id === selected);
  const wsName = ws?.name ?? user?.displayName ?? '…';

  return (
    <div className={s.sidebar}>
      <div className={s.wsHead}>
        <div className={s.wsIco}>{wsName.slice(0, 1)}</div>
        <div>
          <div className={s.wsName}>{wsName}</div>
          <div className={s.wsSub}>{ws ? `${ws.role}${ws.isPersonal ? ' · 개인' : ''}` : ''}</div>
        </div>
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
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>▾</span> {p.name}
            </div>
            {p.channels.map((c) => (
              <div key={c.id}>
                <div className={s.chanRow}># {c.name}</div>
                {c.topics.map((t) => (
                  <Link
                    key={t.id}
                    to="/t/$topicId"
                    params={{ topicId: t.id }}
                    className={s.topic}
                    activeProps={{ className: `${s.topic} ${s.active}` }}
                  >
                    <span className={s.hash}>#</span> {t.name}
                  </Link>
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

function ContextPanel() {
  return (
    <div className={s.context}>
      <div style={{ padding: '14px 16px', fontSize: 13, fontWeight: 600 }}>🧭 맥락 패널</div>
      <div style={{ padding: '0 16px', fontSize: 12.5, color: 'var(--text-muted)' }}>
        근거·산출물·활동은 Phase 2에서 연결됩니다.
      </div>
    </div>
  );
}
