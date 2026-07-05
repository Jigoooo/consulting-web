import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import type { IconName } from '../../icons/registry';
import { Icon } from '../../icons/Icon';
import '../shared-ui.css';

export const buttonVariants = cva('cwButton', {
  variants: {
    variant: {
      primary: 'cwButton--primary',
      secondary: 'cwButton--secondary',
      ghost: 'cwButton--ghost',
      outline: 'cwButton--outline',
      destructive: 'cwButton--destructive',
      link: 'cwButton--link',
    },
    size: {
      xs: 'cwButton--xs',
      sm: 'cwButton--sm',
      md: 'cwButton--md',
      lg: 'cwButton--lg',
      icon: 'cwButton--icon',
    },
  },
  defaultVariants: {
    variant: 'secondary',
    size: 'md',
  },
});

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    leadingIcon?: IconName;
    trailingIcon?: IconName;
    /** Shows a spinner and blocks interaction. Native buttons auto-disable. */
    loading?: boolean;
    children?: ReactNode;
  };

export function Button({
  className,
  variant,
  size,
  asChild,
  leadingIcon,
  trailingIcon,
  loading = false,
  disabled,
  type,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  const isDisabled = Boolean(disabled) || loading;

  // asChild renders arbitrary elements (e.g. <a>): never pass native `disabled`
  // or `type` to them — express state via aria/data attributes so CSS still
  // applies and pointer-events can be blocked.
  const stateProps = asChild
    ? { 'aria-disabled': isDisabled || undefined, 'data-disabled': isDisabled || undefined }
    : { disabled: isDisabled, type: type ?? 'button' };

  return (
    <Comp
      className={cn(buttonVariants({ variant, size }), loading && 'cwButton--loading', className)}
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      {...stateProps}
      {...props}
    >
      {loading ? <Icon name="loader" size="sm" className="cwSpin" decorative /> : leadingIcon ? <Icon name={leadingIcon} size="sm" decorative /> : null}
      {children}
      {!loading && trailingIcon ? <Icon name={trailingIcon} size="sm" decorative /> : null}
    </Comp>
  );
}

export function IconButton({ label, icon, className, variant = 'ghost', size = 'icon', ...props }: Omit<ButtonProps, 'children' | 'aria-label'> & { label: string; icon: IconName }) {
  return (
    <Button className={className} variant={variant} size={size} aria-label={label} title={props.title ?? label} {...props}>
      <Icon name={icon} size="sm" decorative />
    </Button>
  );
}

export function TextButton(props: ButtonProps) {
  return <Button variant="link" {...props} />;
}
