import type { InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import '../shared-ui.css';

type InvalidProp = { invalid?: boolean | undefined };

export function Input({ className, invalid, ...props }: InputHTMLAttributes<HTMLInputElement> & InvalidProp) {
  return <input className={cn('cwInput', invalid && 'cwInput--invalid', className)} aria-invalid={invalid || undefined} {...props} />;
}

export function Textarea({ className, invalid, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & InvalidProp) {
  return <textarea className={cn('cwInput cwTextarea', invalid && 'cwInput--invalid', className)} aria-invalid={invalid || undefined} {...props} />;
}

export function NativeSelect({ className, invalid, ...props }: SelectHTMLAttributes<HTMLSelectElement> & InvalidProp) {
  return <select className={cn('cwInput', invalid && 'cwInput--invalid', className)} aria-invalid={invalid || undefined} {...props} />;
}

export function Field({ label, hint, error, children }: { label?: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="cwField">
      {label ? <span className="cwFieldLabel">{label}</span> : null}
      {children}
      {error ? <span className="cwFieldError">{error}</span> : hint ? <span className="cwFieldHint">{hint}</span> : null}
    </label>
  );
}
