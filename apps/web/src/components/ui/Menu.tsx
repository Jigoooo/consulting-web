import { useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import s from './Menu.module.css';

export interface MenuAction {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

/**
 * Hover-revealed ⋯ menu for tree rows / thread cards (N-4). Renders a small
 * popover with GSAP pop-in; closes on outside click or Escape.
 */
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
        ⋯
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

/** Minimal inline prompt modal (rename flows) — avoids window.prompt. */
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
  const cardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (cardRef.current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      gsap.from(cardRef.current, { opacity: 0, y: 10, scale: 0.98, duration: 0.22, ease: 'power3.out' });
    }
  }, []);
  return (
    <div className={s.overlay} onClick={() => onClose(null)}>
      <div className={s.dialog} ref={cardRef} onClick={(e) => e.stopPropagation()}>
        <div className={s.dialogTitle}>{title}</div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = value.trim();
            if (trimmed) onClose(trimmed);
          }}
        >
          <input className={s.dialogInput} autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
          <div className={s.dialogActions}>
            <button type="button" className={s.dialogGhost} onClick={() => onClose(null)}>
              취소
            </button>
            <button type="submit" className={s.dialogPrimary} disabled={!value.trim()}>
              확인
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
