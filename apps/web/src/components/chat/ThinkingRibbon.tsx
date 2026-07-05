import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import s from './ThinkingRibbon.module.css';

/**
 * 창조 패턴 #1 — "AI 사고 리본" (U-2).
 * Between run start and the first delta, most chat UIs show a generic spinner.
 * This ribbon instead renders an orbiting-dots + shimmer phrase strip that
 * cycles through what 지구 is doing, giving non-developers a sense of agency
 * ("생각 정리 중 → 맥락 확인 중 → 답변 구성 중") instead of a dead wait.
 */
const PHASES = ['생각을 정리하고 있어요', '맥락을 확인하고 있어요', '답변을 구성하고 있어요'];

export function ThinkingRibbon() {
  const dotsRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ctx = gsap.context(() => {
      if (!reduce && dotsRef.current) {
        const dots = dotsRef.current.children;
        gsap.to(dots, {
          y: -4,
          duration: 0.45,
          ease: 'sine.inOut',
          stagger: { each: 0.12, yoyo: true, repeat: -1 },
        });
      }
      // Cycle phases every 2.4s with a soft cross-fade.
      let idx = 0;
      const cycle = () => {
        idx = (idx + 1) % PHASES.length;
        if (!textRef.current) return;
        if (reduce) {
          textRef.current.textContent = PHASES[idx]!;
          return;
        }
        gsap.to(textRef.current, {
          opacity: 0,
          y: -4,
          duration: 0.22,
          onComplete: () => {
            if (!textRef.current) return;
            textRef.current.textContent = PHASES[idx]!;
            gsap.fromTo(textRef.current, { opacity: 0, y: 4 }, { opacity: 1, y: 0, duration: 0.22 });
          },
        });
      };
      const timer = setInterval(cycle, 2400);
      return () => clearInterval(timer);
    });
    return () => ctx.revert();
  }, []);

  return (
    <div className={s.ribbon} role="status" aria-live="polite">
      <div className={s.dots} ref={dotsRef}>
        <span className={s.dot} />
        <span className={s.dot} />
        <span className={s.dot} />
      </div>
      <span className={s.text} ref={textRef}>
        {PHASES[0]}
      </span>
      <span className={s.shimmer} aria-hidden />
    </div>
  );
}
