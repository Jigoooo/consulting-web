import { useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { Icon } from '../../icons/Icon';
import { Button } from '../button/Button';
import { Input } from '../input/Input';
import { DialogContent, DialogRoot } from '../dialog/Dialog';
import s from './Menu.module.css';

export interface MenuAction {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

export function RowMenu({ actions }: { actions: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open && popRef.current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      gsap.from(popRef.current, { opacity: 0, y: -4, scale: 0.97, duration: 0.16, ease: 'power2.out' });
    }
  }, [open]);

  return (
    <div className={s.wrap} ref={wrapRef} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`${s.trigger} ${open ? s.triggerOpen : ''}`}
        aria-label="메뉴"
        onClick={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
      >
        <Icon name="more" size="xs" decorative />
      </button>
      {open ? (
        <div className={s.pop} ref={popRef} role="menu">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              className={`${s.item} ${a.danger ? s.danger : ''}`}
              onClick={() => {
                setOpen(false);
                a.onSelect();
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function useTextPrompt() {
  const [state, setState] = useState<{
    title: string;
    initial: string;
    resolve: (v: string | null) => void;
  } | null>(null);

  function prompt(title: string, initial = ''): Promise<string | null> {
    return new Promise((resolve) => setState({ title, initial, resolve }));
  }

  const dialog = state ? (
    <PromptDialog
      title={state.title}
      initial={state.initial}
      onClose={(v) => {
        state.resolve(v);
        setState(null);
      }}
    />
  ) : null;

  return { prompt, dialog };
}

function PromptDialog({ title, initial, onClose }: { title: string; initial: string; onClose: (v: string | null) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <DialogRoot open onOpenChange={(open) => !open && onClose(null)}>
      <DialogContent title={title} description="이름은 언제든 다시 바꿀 수 있습니다.">
        <form
          className={s.dialogForm}
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = value.trim();
            if (trimmed) onClose(trimmed);
          }}
        >
          <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
          <div className={s.dialogActions}>
            <Button type="button" variant="ghost" onClick={() => onClose(null)}>
              취소
            </Button>
            <Button type="submit" variant="primary" disabled={!value.trim()}>
              확인
            </Button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
