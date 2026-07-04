import { gsap } from 'gsap';
import { useEffect, useRef } from 'react';

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
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}
