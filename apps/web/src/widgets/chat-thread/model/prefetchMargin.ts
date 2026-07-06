/**
 * G2 — unconscious infinite-scroll prefetch.
 *
 * The sentinel IntersectionObserver used to fire on a fixed `320px` top margin,
 * so on a tall viewport or a fast flick the user could reach the very top before
 * the older page arrived (visible "불러오는 중"). We instead size the observer's
 * root margin to a *multiple of the viewport height* and grow it further with the
 * current scroll velocity, so older pages are requested well before the edge is
 * in view. The result is returned as a CSS `rootMargin` string:
 *   "<top> <right> <bottom> <left>"
 * Only the top/bottom vary; left/right stay 0.
 */
export interface PrefetchMarginInput {
  /** scroll container height in px (0 when unmeasured / SSR). */
  viewportHeight: number;
  /** recent scroll speed in px/frame (absolute value; 0 when idle). */
  velocity: number;
}

const DEFAULT_VIEWPORT = 600; // fallback when the scroller isn't measured yet
const TOP_MULTIPLIER = 1.5; // request older pages 1.5 viewports early
const BOTTOM_MULTIPLIER = 0.8; // newer pages a bit less eagerly
const VELOCITY_GAIN = 12; // px of extra top margin per px/frame of velocity
const MAX_TOP_MULTIPLIER = 4; // hard ceiling: never exceed 4 viewports

/** Build the IntersectionObserver rootMargin for the current viewport + velocity. */
export function computePrefetchRootMargin({ viewportHeight, velocity }: PrefetchMarginInput): string {
  const vh = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : DEFAULT_VIEWPORT;
  const v = Number.isFinite(velocity) && velocity > 0 ? velocity : 0;

  const baseTop = vh * TOP_MULTIPLIER;
  const boost = v * VELOCITY_GAIN;
  const ceiling = vh * MAX_TOP_MULTIPLIER;
  const top = Math.round(Math.min(baseTop + boost, ceiling));
  const bottom = Math.round(vh * BOTTOM_MULTIPLIER);

  return `${top}px 0px ${bottom}px 0px`;
}
