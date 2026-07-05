import { createFileRoute, useRouter, Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { InvitationPreviewResponse } from '@consulting/contracts';
import { api } from '../lib/api';
import { useAuth } from '../lib/useAuth';
import { AuthShell, SubmitButton, ErrorBanner, friendlyError, authStyles as s } from '../features/auth-session/ui/AuthKit';

const roleLabel: Record<string, string> = {
  owner: '소유자',
  admin: '관리자',
  editor: '편집자',
  commenter: '댓글 작성자',
  viewer: '뷰어',
};
const scopeLabel: Record<string, string> = {
  workspace: '워크스페이스',
  project: '프로젝트',
  channel: '채널',
  topic: '토픽',
  thread: '스레드',
};

export const Route = createFileRoute('/invite/$token')({
  // Non-consuming preview in the loader so the landing renders instantly.
  loader: async ({ params }): Promise<{ preview: InvitationPreviewResponse | null; error: unknown }> => {
    try {
      return { preview: await api.previewInvitation(params.token), error: null };
    } catch (error) {
      return { preview: null, error };
    }
  },
  component: InvitePage,
});

function InvitePage() {
  const { token } = Route.useParams();
  const { preview, error: loadError } = Route.useLoaderData();
  const { isAuthed, user } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  if (loadError || !preview) {
    return (
      <AuthShell>
        <div className={s.title} data-stagger>초대를 열 수 없어요</div>
        <div className={s.subtitle} data-stagger>{friendlyError(loadError, '초대 링크가 유효하지 않습니다.')}</div>
        <Link to="/login" className={s.foot} data-stagger>로그인으로 이동</Link>
      </AuthShell>
    );
  }

  async function accept() {
    setError(null);
    setLoading(true);
    try {
      await api.acceptInvitation(token);
      setDone(true);
      setTimeout(() => void router.navigate({ to: '/' }), 900);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <AuthShell>
        <div className={s.center}>
          <div className={s.checkCircle}>✓</div>
          <div className={s.title}>참여 완료!</div>
          <div className={s.subtitle}>워크스페이스로 이동하고 있어요…</div>
        </div>
      </AuthShell>
    );
  }

  const inviteTo = `/invite/${token}`;

  return (
    <AuthShell>
      <div className={s.title} data-stagger>워크스페이스 초대</div>
      <div className={s.subtitle} data-stagger>아래 공간에 참여하도록 초대받았어요.</div>

      <div className={s.meta} data-stagger>
        <div className={s.metaRow}><span className={s.metaKey}>범위</span><span className={s.metaVal}>{scopeLabel[preview.scopeType] ?? preview.scopeType}</span></div>
        <div className={s.metaRow}><span className={s.metaKey}>역할</span><span className={s.rolePill}>{roleLabel[preview.role] ?? preview.role}</span></div>
        <div className={s.metaRow}><span className={s.metaKey}>만료</span><span className={s.metaVal}>{new Date(preview.expiresAt).toLocaleDateString('ko-KR')}</span></div>
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      {preview.accepted ? (
        <div className={s.subtitle} data-stagger>이미 수락된 초대입니다.</div>
      ) : isAuthed ? (
        <form onSubmit={(e) => { e.preventDefault(); void accept(); }}>
          <SubmitButton loading={loading}>{user?.displayName ?? '나'}로 참여하기</SubmitButton>
        </form>
      ) : (
        <>
          <div className={s.subtitle} data-stagger>참여하려면 먼저 로그인하거나 가입해주세요.</div>
          <div style={{ display: 'flex', gap: 8 }} data-stagger>
            <Link to="/login" search={{ redirect: inviteTo }} className={s.btn} style={{ textDecoration: 'none' }}>로그인</Link>
            <Link to="/signup" search={{ redirect: inviteTo }} className={s.btn} style={{ textDecoration: 'none', background: 'transparent', color: 'var(--accent)', border: '1px solid var(--border-whisper)', boxShadow: 'none' }}>회원가입</Link>
          </div>
        </>
      )}
    </AuthShell>
  );
}
