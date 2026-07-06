import { useEffect, useRef, useState } from 'react';

/**
 * Returns `true` only when `active` has stayed truthy for at least `delayMs`.
 * Used to gate skeletons/spinners so instant loads never flash a placeholder,
 * but genuinely slow loads (>300ms) surface one. Resets immediately when the
 * source flag clears.
 */
export function useDelayedFlag(active: boolean, delayMs = 300): boolean {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!active) {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      setShown(false);
      return;
    }
    timer.current = setTimeout(() => setShown(true), delayMs);
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [active, delayMs]);

  return shown;
}
