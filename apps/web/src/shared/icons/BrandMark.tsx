import type { ComponentPropsWithoutRef } from 'react';

export type BrandMarkSize = 'sm' | 'md' | 'lg';

const px: Record<BrandMarkSize, number> = { sm: 28, md: 36, lg: 48 };

/** Solid editorial J monogram. Decorative by default; pass `label` for a11y. */
export function BrandMark({ size = 'md', label, className, ...props }: ComponentPropsWithoutRef<'svg'> & { size?: BrandMarkSize; label?: string }) {
  const dim = px[size];
  const decorative = !label;
  return (
    <svg
      width={dim}
      height={dim}
      viewBox="0 0 64 64"
      data-brand-mark="j-monogram"
      className={className}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : label}
      focusable="false"
      {...props}
    >
      <rect width="64" height="64" rx="14" fill="var(--brand-mark-bg, var(--ink, #1f211f))" />
      <path
        d="M19 18h26v18c0 8-5 13-13 13-6 0-11-2-14-7"
        fill="none"
        stroke="var(--brand-mark-fg, #f7f5f1)"
        strokeWidth={4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
