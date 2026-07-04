import { createFileRoute, redirect } from '@tanstack/react-router';
import { AppShell } from '../components/shell/AppShell';
import { ThreadView } from '../components/thread/ThreadView';

export const Route = createFileRoute('/')({
  beforeLoad: ({ context, location }) => {
    if (!context.auth.isAuthed()) {
      throw redirect({ to: '/login', search: { redirect: location.href } });
    }
  },
  component: Home,
});

function Home() {
  return (
    <AppShell>
      <ThreadView />
    </AppShell>
  );
}
