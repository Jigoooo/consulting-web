import { createFileRoute, redirect, Outlet } from '@tanstack/react-router';
import { AppShell } from '../widgets/app-shell/ui/AppShell';
import { CommandPalette } from '../features/command-palette/ui/CommandPalette';

/**
 * Pathless authed layout: guards everything inside the workspace shell.
 * TanStack docs pattern — beforeLoad throws redirect({ to: '/login' }).
 */
export const Route = createFileRoute('/_app')({
  beforeLoad: ({ context, location }) => {
    if (!context.auth.isAuthed()) {
      // TanStack Router uses thrown redirects for control flow.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: '/login', search: { redirect: location.href } });
    }
  },
  component: AppLayout,
});

function AppLayout() {
  return (
    <>
      <CommandPalette />
      <AppShell>
        <Outlet />
      </AppShell>
    </>
  );
}
