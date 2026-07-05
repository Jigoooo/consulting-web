import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { gsap } from 'gsap';
import s from './Toast.module.css';

export type ToastKind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

const ToastCtx = createContext<(kind: ToastKind, message: string) => void>(() => {});

/** useToast() → push('error', '메시지'). Global, top-right, GSAP slide+fade. */
export function useToast() {
  return useContext(ToastCtx);
}

let seq = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = seq++;
    setItems((prev) => [...prev.slice(-3), { id, kind, message }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4200);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className={s.stack} aria-live="polite">
        {items.map((t) => (
          <Toast key={t.id} item={t} onDismiss={() => setItems((prev) => prev.filter((x) => x.id !== t.id))} />
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (ref.current) {
      gsap.from(ref.current, { x: 40, opacity: 0, duration: 0.35, ease: 'power3.out' });
    }
  }, []);
  const icon = item.kind === 'success' ? '✓' : item.kind === 'error' ? '!' : 'i';
  return (
    <div ref={ref} className={`${s.toast} ${s[item.kind]}`} onClick={onDismiss} role="status">
      <span className={s.icon}>{icon}</span>
      <span className={s.msg}>{item.message}</span>
    </div>
  );
}
