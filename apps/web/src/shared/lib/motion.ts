export const motion = {
  fast: 0.16,
  base: 0.24,
  slow: 0.36,
  easeOut: 'power2.out',
  easeSpring: 'back.out(1.7)',
} as const;

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
