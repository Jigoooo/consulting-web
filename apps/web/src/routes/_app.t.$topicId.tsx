import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { useThreads, useCreateThread } from '../lib/spaces';
import { useEntrance } from '../lib/motion';

export const Route = createFileRoute('/_app/t/$topicId')({
  component: TopicPage,
});

function TopicPage() {
  const { topicId } = Route.useParams();
  const router = useRouter();
  const { data, isLoading } = useThreads(topicId);
  const createThread = useCreateThread(topicId);
  const [title, setTitle] = useState('');
  const listRef = useEntrance([data?.threads.length]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    const created = await createThread.mutateAsync(trimmed);
    setTitle('');
    void router.navigate({ to: '/th/$threadId', params: { threadId: created.id } });
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '28px 32px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 14 }}>
          스레드
        </div>

        <form onSubmit={onCreate} style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="새 스레드 제목… (예: 이관 리스크 정리)"
            disabled={createThread.isPending}
            style={{
              flex: 1,
              font: 'inherit',
              fontSize: 14.5,
              padding: '10px 13px',
              border: '1px solid var(--border-whisper)',
              borderRadius: 'var(--radius-btn)',
              outline: 'none',
              background: '#fff',
            }}
          />
          <button
            type="submit"
            disabled={createThread.isPending || !title.trim()}
            style={{
              font: 'inherit',
              fontSize: 14,
              fontWeight: 600,
              color: '#fff',
              background: 'linear-gradient(135deg, var(--accent), #6b74e0)',
              border: 'none',
              borderRadius: 'var(--radius-btn)',
              padding: '10px 18px',
              cursor: 'pointer',
              boxShadow: '0 3px 10px -3px var(--accent-glow)',
            }}
          >
            시작
          </button>
        </form>

        {isLoading ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>불러오는 중…</div> : null}

        <div ref={listRef as React.RefObject<HTMLDivElement>} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {data?.threads.map((t) => (
            <Link
              key={t.id}
              to="/th/$threadId"
              params={{ threadId: t.id }}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '14px 16px',
                background: '#fff',
                border: '1px solid var(--border-whisper)',
                borderRadius: 'var(--radius-card)',
                boxShadow: 'var(--shadow-card)',
                color: 'var(--text-primary)',
                textDecoration: 'none',
              }}
            >
              <span style={{ fontSize: 14.5, fontWeight: 560 }}>{t.title}</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                {new Date(t.createdAt).toLocaleDateString('ko-KR')}
              </span>
            </Link>
          ))}
          {data && data.threads.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13.5, padding: '18px 4px' }}>
              아직 스레드가 없어요. 위에서 첫 스레드를 시작해보세요.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
