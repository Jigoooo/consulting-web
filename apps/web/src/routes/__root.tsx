import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import type { AuthStore } from '../lib/api';

export interface RouterContext {
  queryClient: QueryClient;
  auth: AuthStore;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFound,
});

function RootLayout() {
  return <Outlet />;
}

function NotFound() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg-canvas)', padding: 24 }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 52, marginBottom: 12 }}>🧭</div>
        <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 6 }}>페이지를 찾을 수 없어요</div>
        <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 20 }}>
          주소가 바뀌었거나 삭제된 페이지일 수 있어요.
        </div>
        <a
          href="/"
          style={{
            display: 'inline-block',
            fontSize: 14.5,
            fontWeight: 600,
            color: '#fff',
            background: 'linear-gradient(135deg, var(--accent), #6b74e0)',
            borderRadius: 8,
            padding: '11px 22px',
            textDecoration: 'none',
          }}
        >
          워크스페이스로 돌아가기
        </a>
      </div>
    </div>
  );
}
