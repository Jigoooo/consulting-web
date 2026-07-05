import { createFileRoute } from '@tanstack/react-router';
import { EmptyState as SharedEmptyState } from '../shared/ui/feedback/EmptyState';

export const Route = createFileRoute('/_app/')({
  component: IndexEmptyState,
});

function IndexEmptyState() {
  return (
    <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>
      <SharedEmptyState icon="navigation" title="토픽을 선택하세요" description="왼쪽에서 토픽을 고르거나 새로 만들어 시작합니다." />
    </div>
  );
}
