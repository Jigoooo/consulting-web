import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import type { AuthStore } from '../lib/api';
import { Icon } from '../shared/icons/Icon';
import { Button } from '../shared/ui/button/Button';

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
        <div style={{ marginBottom: 12 }}><Icon name="navigation" size="lg" tone="muted" decorative /></div>
        <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 6 }}>페이지를 찾을 수 없어요</div>
        <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 20 }}>
          주소가 바뀌었거나 삭제된 페이지일 수 있어요.
        </div>
        <Button asChild variant="primary">
          <a href="/">워크스페이스로 이동</a>
        </Button>
      </div>
    </div>
  );
}
