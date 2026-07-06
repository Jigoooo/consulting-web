import { describe, expect, it } from 'vitest';
import { computePrefetchRootMargin } from './prefetchMargin';

describe('computePrefetchRootMargin (G2 unconscious prefetch)', () => {
  it('scales the top margin to ~1.5x viewport when idle', () => {
    const m = computePrefetchRootMargin({ viewportHeight: 800, velocity: 0 });
    // "top right bottom left" — top ~= 1.5 * 800 = 1200
    expect(m).toBe('1200px 0px 640px 0px');
  });

  it('grows the top margin with scroll velocity (inertia guard)', () => {
    const slow = computePrefetchRootMargin({ viewportHeight: 800, velocity: 0 });
    const fast = computePrefetchRootMargin({ viewportHeight: 800, velocity: 40 });
    const topSlow = Number.parseInt(slow.split(' ')[0]!, 10);
    const topFast = Number.parseInt(fast.split(' ')[0]!, 10);
    expect(topFast).toBeGreaterThan(topSlow);
  });

  it('caps the velocity boost so the margin never explodes', () => {
    const capped = computePrefetchRootMargin({ viewportHeight: 800, velocity: 100000 });
    const insane = computePrefetchRootMargin({ viewportHeight: 800, velocity: 1e9 });
    expect(capped).toBe(insane);
    const top = Number.parseInt(capped.split(' ')[0]!, 10);
    // hard ceiling = 4x viewport = 3200
    expect(top).toBe(3200);
  });

  it('falls back to a sane default when viewport height is 0 (SSR/unmeasured)', () => {
    const m = computePrefetchRootMargin({ viewportHeight: 0, velocity: 0 });
    expect(m).toBe('900px 0px 480px 0px');
  });

  it('never produces negative or NaN margins', () => {
    const m = computePrefetchRootMargin({ viewportHeight: -500, velocity: Number.NaN });
    for (const part of m.split(' ')) {
      if (part === '0px') continue;
      const n = Number.parseInt(part, 10);
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
  });
});
