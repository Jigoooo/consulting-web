import { createFileRoute, redirect, Outlet } from '@tanstack/react-router';
import { AppShell } from '../components/shell/AppShell';

/**
 * Pathless authed layout: guards everything inside the workspace shell.
 * TanStack docs pattern — beforeLoad throws redirect({ to: '/login' }).
 */
export const Route = createFileRoute('/_app')({
  beforeLoad: ({ context, location }) => {
    if (!context.auth.isAuthed()) {
      throw redirect({ to: '/login', search: { redirect: location.href } });
    }
  },
  component: AppLayout,
});

function AppLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
