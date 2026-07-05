import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/')({
  component: EmptyState,
});

function EmptyState() {
  return (
    <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🧭</div>
        <div style={{ fontSize: 15, fontWeight: 560, color: 'var(--text-secondary)' }}>
          왼쪽에서 토픽을 선택하거나 새로 만들어 시작하세요
        </div>
      </div>
    </div>
  );
}
