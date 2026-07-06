import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as SelectPrimitive from '@radix-ui/react-select';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { Icon } from '../../icons/Icon';
import { cn } from '../../lib/cn';
import './Dialog.css';

export const DialogRoot = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ className, children, title, description, ...props }: ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { title: string; description?: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="cwDialogOverlay" />
      <DialogPrimitive.Content className={cn('cwDialogContent', className)} {...props}>
        <div className="cwDialogHead">
          <div>
            <DialogPrimitive.Title className="cwDialogTitle">{title}</DialogPrimitive.Title>
            {description ? <DialogPrimitive.Description className="cwDialogDesc">{description}</DialogPrimitive.Description> : null}
          </div>
          <DialogPrimitive.Close className="cwDialogClose" aria-label="닫기">
            <Icon name="x" size="sm" decorative />
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export const SheetRoot = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export function SheetContent({ side = 'right', className, children, title, description, ...props }: ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { side?: 'left' | 'right'; title: string; description?: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="cwDialogOverlay" />
      <DialogPrimitive.Content className={cn('cwSheetContent', `cwSheetContent--${side}`, className)} {...props}>
        <div className="cwDialogHead">
          <div>
            <DialogPrimitive.Title className="cwDialogTitle">{title}</DialogPrimitive.Title>
            {description ? <DialogPrimitive.Description className="cwDialogDesc">{description}</DialogPrimitive.Description> : null}
          </div>
          <DialogPrimitive.Close className="cwDialogClose" aria-label="닫기">
            <Icon name="x" size="sm" decorative />
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={250}>{children}</TooltipPrimitive.Provider>;
}

/** 확인 다이얼로그 — window.confirm 대체. 파괴적/이탈성 액션 공용. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = '확인',
  cancelLabel = '취소',
  destructive = false,
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
}) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="cwConfirmDialog" title={title} {...(description ? { description } : {})}>
        <div className="cwConfirmActions">
          <button type="button" className="cwButton cwButton--secondary cwButton--md" onClick={() => onOpenChange(false)} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={cn('cwButton cwButton--md', destructive ? 'cwButton--destructive' : 'cwButton--primary')}
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {busy ? <Icon name="loader" size="sm" className="cwSpin" decorative /> : null}
            {confirmLabel}
          </button>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

export const Tooltip = TooltipPrimitive;
export const Select = SelectPrimitive;
export const Dialog = DialogPrimitive;
