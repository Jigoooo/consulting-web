import type { CSSProperties } from 'react';
import './Skeleton.css';

type SkeletonVariant = 'text' | 'block' | 'circle';

/**
 * Shared shimmer placeholder. Prefer gating its render with `useDelayedFlag`
 * so fast loads never flash it. `lines` renders a stacked text block with a
 * slightly randomized last-line width for a natural paragraph shape.
 */
export function Skeleton({
  variant = 'text',
  width,
  height,
  radius,
  className = '',
  style,
}: {
  variant?: SkeletonVariant;
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  const cls = variant === 'circle' ? 'cwSkeleton cwSkeleton--circle' : variant === 'block' ? 'cwSkeleton cwSkeleton--block' : 'cwSkeleton cwSkeleton--text';
  return (
    <span
      className={`${cls} ${className}`.trim()}
      aria-hidden="true"
      style={{
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
        ...(radius !== undefined ? { borderRadius: radius } : {}),
        ...style,
      }}
    />
  );
}

/** A stacked paragraph of skeleton text lines. */
export function SkeletonLines({ lines = 3, className = '', gap = 8 }: { lines?: number; className?: string; gap?: number }) {
  const widths = ['92%', '78%', '85%', '64%', '88%'];
  return (
    <span className={`cwSkeletonStack ${className}`.trim()} style={{ gap }} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} width={widths[i % widths.length] ?? '80%'} />
      ))}
    </span>
  );
}

/** Chat-message shaped skeleton: avatar + two text lines. */
export function SkeletonMessage() {
  return (
    <span className="cwSkeletonMsg" aria-hidden="true">
      <Skeleton variant="circle" width={34} height={34} />
      <span className="cwSkeletonMsgBody">
        <Skeleton width="30%" height={12} />
        <Skeleton width="88%" />
        <Skeleton width="70%" />
      </span>
    </span>
  );
}
