import type { InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import '../shared-ui.css';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('cwInput', className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn('cwInput cwTextarea', className)} {...props} />;
}

export function NativeSelect({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn('cwInput', className)} {...props} />;
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
