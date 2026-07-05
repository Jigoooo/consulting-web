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

export const Tooltip = TooltipPrimitive;
export const Select = SelectPrimitive;
export const Dialog = DialogPrimitive;
