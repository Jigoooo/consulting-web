import { createFileRoute } from '@tanstack/react-router';
import { EmptyState as SharedEmptyState } from '../shared/ui/feedback/EmptyState';

export const Route = createFileRoute('/_app/')({
  component: IndexEmptyState,
});

function IndexEmptyState() {
  return (
    <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>
      <SharedEmptyState icon="navigation" title="채널을 선택하세요" description="왼쪽에서 채널을 고르면 바로 대화를 시작할 수 있습니다." />
    </div>
  );
}
