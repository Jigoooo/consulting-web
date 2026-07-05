import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/** Last-resort error boundary (N-5) — friendly Korean fallback + reload. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg-canvas)', padding: 24 }}>
        <div style={{ textAlign: 'center', maxWidth: 420 }}>
          <div style={{ fontSize: 44, marginBottom: 14 }}>🌍</div>
          <div style={{ fontSize: 19, fontWeight: 600, marginBottom: 8 }}>화면에 문제가 생겼어요</div>
          <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.6 }}>
            일시적인 오류일 수 있어요. 새로고침하면 대부분 해결됩니다.
            문제가 계속되면 관리자에게 알려주세요.
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              font: 'inherit',
              fontSize: 14.5,
              fontWeight: 600,
              color: '#fff',
              background: 'linear-gradient(135deg, var(--accent), #6b74e0)',
              border: 'none',
              borderRadius: 8,
              padding: '11px 22px',
              cursor: 'pointer',
            }}
          >
            새로고침
          </button>
        </div>
      </div>
    );
  }
}
