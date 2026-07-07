import { useEffect, useRef, useState } from 'react';

/**
 * Returns `true` only when `active` has stayed truthy for at least `delayMs`.
 * Used to gate skeletons/spinners so instant loads never flash a placeholder,
 * but genuinely slow loads (>300ms) surface one. `minVisibleMs` prevents a
 * placeholder that already appeared from disappearing in the same visual beat.
 */
export function useDelayedFlag(active: boolean, delayMs = 300, minVisibleMs = 0): boolean {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownAt = useRef(0);

  useEffect(() => {
    const clearTimer = () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
    if (!active) {
      clearTimer();
      if (shown && minVisibleMs > 0) {
        const elapsed = Date.now() - shownAt.current;
        const remaining = minVisibleMs - elapsed;
        if (remaining > 0) {
          timer.current = setTimeout(() => {
            timer.current = null;
            setShown(false);
          }, remaining);
          return clearTimer;
        }
      }
      setShown(false);
      return;
    }
    if (shown) return clearTimer;
    clearTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      shownAt.current = Date.now();
      setShown(true);
    }, delayMs);
    return clearTimer;
  }, [active, delayMs, minVisibleMs, shown]);

  return shown;
}
