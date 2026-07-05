import type { ComponentPropsWithoutRef } from 'react';
import { iconRegistry, type IconName } from './registry';
import './icons.css';

export type IconSize = 'xs' | 'sm' | 'md' | 'lg';
export type IconTone = 'default' | 'muted' | 'accent' | 'danger' | 'success' | 'inverse';

export interface IconProps extends Omit<ComponentPropsWithoutRef<'svg'>, 'color' | 'name'> {
  name: IconName;
  size?: IconSize;
  tone?: IconTone;
  decorative?: boolean;
  ariaLabel?: string;
}

export function Icon({ name, size = 'md', tone = 'default', decorative, ariaLabel, className, ...props }: IconProps) {
  const Glyph = iconRegistry[name];
  const isDecorative = decorative ?? !ariaLabel;
  return (
    <Glyph
      className={['cwIcon', `cwIcon--${size}`, `cwIcon--${tone}`, className].filter(Boolean).join(' ')}
      aria-hidden={isDecorative ? true : undefined}
      aria-label={isDecorative ? undefined : ariaLabel}
      role={isDecorative ? undefined : 'img'}
      focusable="false"
      strokeWidth={2}
      {...props}
    />
  );
}
