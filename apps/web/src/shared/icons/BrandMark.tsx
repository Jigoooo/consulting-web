import { useId, type ComponentPropsWithoutRef } from 'react';

export type BrandMarkSize = 'sm' | 'md' | 'lg';

const px: Record<BrandMarkSize, number> = { sm: 28, md: 36, lg: 48 };

/**
 * BrandMark — the product identity glyph. Pure SVG (no emoji / text icon),
 * matches public/favicon.svg: gradient rounded square + connected-node mark
 * evoking consulting relationships. Decorative by default; pass `label` for a11y.
 * Uses a per-instance gradient id (useId) so multiple marks never collide.
 */
export function BrandMark({ size = 'md', label, className, ...props }: ComponentPropsWithoutRef<'svg'> & { size?: BrandMarkSize; label?: string }) {
  const dim = px[size];
  const decorative = !label;
  const gradientId = `cwBrandBg-${useId().replace(/:/g, '')}`;
  return (
    <svg
      width={dim}
      height={dim}
      viewBox="0 0 64 64"
      className={className}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : label}
      focusable="false"
      {...props}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accent, #5e6ad2)" />
          <stop offset="1" stopColor="var(--accent-hi, #7170ff)" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="18" fill={`url(#${gradientId})`} />
      <g fill="none" stroke="#ffffff" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="24" cy="24" r="8" />
        <circle cx="42" cy="40" r="8" />
        <path d="M30 30 L36 34" />
        <path d="M24 32 L24 44 L36 44" />
      </g>
    </svg>
  );
}
