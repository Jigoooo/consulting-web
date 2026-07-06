import { Toaster, toast as sonnerToast } from 'sonner';
import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { Icon } from '../../icons/Icon';
import type { IconName } from '../../icons/registry';
import s from './Toast.module.css';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

const kindIcon: Record<ToastKind, IconName> = {
  success: 'check',
  error: 'alert',
  info: 'info',
  warning: 'warning',
};

const kindClass: Record<ToastKind, string> = {
  success: s.success ?? '',
  error: s.error ?? '',
  info: s.info ?? '',
  warning: s.warning ?? '',
};

/** Sonner headless custom toast — 디자인 시스템 토큰만 사용 (style prop 미사용).
 *  https://sonner.emilkowal.ski/styling : "Headless … recommended approach". */
function ConsultingToast({ id, kind, message }: { id: string | number; kind: ToastKind; message: string }) {
  return (
    <div className={`${s.toast} ${kindClass[kind]}`} role="status">
      <span className={s.icon} aria-hidden>
        <Icon name={kindIcon[kind]} size="sm" decorative />
      </span>
      <span className={s.msg}>{message}</span>
      <button type="button" className={s.close} aria-label="닫기" onClick={() => sonnerToast.dismiss(id)}>
        <Icon name="x" size="xs" decorative />
      </button>
    </div>
  );
}

const ToastCtx = createContext<(kind: ToastKind, message: string) => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const push = useCallback((kind: ToastKind, message: string) => {
    sonnerToast.custom((id) => <ConsultingToast id={id} kind={kind} message={message} />, {
      duration: 3600,
    });
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <Toaster position="top-right" visibleToasts={4} gap={8} offset={16} />
    </ToastCtx.Provider>
  );
}
