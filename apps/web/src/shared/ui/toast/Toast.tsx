import * as ToastPrimitive from '@radix-ui/react-toast';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Icon } from '../../icons/Icon';
import type { IconName } from '../../icons/registry';
import s from './Toast.module.css';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

const ToastCtx = createContext<(kind: ToastKind, message: string) => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

let seq = 1;

const kindIcon: Record<ToastKind, IconName> = {
  success: 'check',
  error: 'alert',
  info: 'info',
  warning: 'warning',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = seq++;
    setItems((prev) => [...prev.slice(-3), { id, kind, message }]);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      <ToastPrimitive.Provider swipeDirection="right" duration={3600}>
        {children}
        {items.map((item) => (
          <ToastPrimitive.Root
            key={item.id}
            className={`${s.toast} ${s[item.kind]}`}
            onOpenChange={(open) => {
              if (!open) dismiss(item.id);
            }}
          >
            <span className={s.icon} aria-hidden>
              <Icon name={kindIcon[item.kind]} size="sm" decorative />
            </span>
            <ToastPrimitive.Title className={s.msg}>{item.message}</ToastPrimitive.Title>
            <ToastPrimitive.Close className={s.close} aria-label="닫기">
              <Icon name="x" size="xs" decorative />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className={s.viewport} />
      </ToastPrimitive.Provider>
    </ToastCtx.Provider>
  );
}
