import { gsap } from 'gsap';
import { useEffect, useRef } from 'react';

// D5: global GSAP tuning applied once on import. force3D promotes transform/opacity
// tweens to the GPU; lagSmoothing keeps animations coherent when the main thread
// stalls (e.g. a heavy stream flush) instead of jumping.
gsap.config({ force3D: true });
gsap.ticker.lagSmoothing(500, 33);

/** True when the user asked the OS to reduce motion. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * useEntrance — reactbits/magicui-style entrance: children fade+rise with a
 * subtle stagger. Respects prefers-reduced-motion. Returns a ref to attach to
 * the container whose direct children animate in.
 */
export function useEntrance(deps: readonly unknown[] = []) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion()) return;
    const ctx = gsap.context(() => {
      gsap.from(el.children, {
        opacity: 0,
        y: 8,
        duration: 0.4,
        ease: 'power2.out',
        stagger: 0.05,
      });
    }, el);
    return () => ctx.revert();
  }, deps);
  return ref;
}
