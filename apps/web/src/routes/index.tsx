import { createFileRoute } from '@tanstack/react-router';
import { AppShell } from '../components/shell/AppShell';
import { ThreadView } from '../components/thread/ThreadView';

export const Route = createFileRoute('/')({
  component: Home,
});

function Home() {
  return (
    <AppShell>
      <ThreadView />
    </AppShell>
  );
}
