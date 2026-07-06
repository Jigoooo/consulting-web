import type { InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '../../lib/cn';
import '../shared-ui.css';

type InvalidProp = { invalid?: boolean | undefined };
/** `unstyled` opts out of the cwInput chrome entirely (border/background/padding)
 *  so a host container can own the surface — prevents double-border seams (B1). */
type BareProp = { unstyled?: boolean | undefined };

export function Input({ className, invalid, ref, ...props }: InputHTMLAttributes<HTMLInputElement> & InvalidProp & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} className={cn('cwInput', invalid && 'cwInput--invalid', className)} aria-invalid={invalid || undefined} {...props} />;
}

export function Textarea({ className, invalid, unstyled, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & InvalidProp & BareProp) {
  return (
    <textarea
      className={cn(unstyled ? 'cwInputBare' : 'cwInput cwTextarea', !unstyled && invalid && 'cwInput--invalid', className)}
      aria-invalid={invalid || undefined}
      {...props}
    />
  );
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
