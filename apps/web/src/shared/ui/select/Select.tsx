import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../../lib/cn';
import s from './Select.module.css';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * 공통 Select (축5) — shadcn/Radix 기반. 네이티브 <select>를 대체하는 단일
 * 컴포넌트. a11y·키보드·portal 포지셔닝(clipped 컨테이너 안전)·open/close
 * 애니메이션 내장. 디자인 토큰만 사용(다크모드 하드코딩 색 금지).
 *
 * value=''(빈 문자열)은 Radix가 "미선택"으로 예약하므로 그대로 쓸 수 없다.
 * → 빈 값은 내부적으로 SENTINEL로 매핑해 "전체" 같은 옵션도 표현 가능.
 */
const EMPTY_SENTINEL = '__all__';

export function Select({
  value,
  onValueChange,
  options,
  placeholder = '선택',
  disabled,
  className,
  ariaLabel,
  size = 'md',
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  ariaLabel?: string | undefined;
  size?: 'sm' | 'md' | undefined;
}) {
  const radixValue = value === '' ? EMPTY_SENTINEL : value;
  return (
    <SelectPrimitive.Root
      value={radixValue}
      onValueChange={(v) => onValueChange(v === EMPTY_SENTINEL ? '' : v)}
      {...(disabled != null ? { disabled } : {})}
    >
      <SelectPrimitive.Trigger
        className={cn(s.trigger, size === 'sm' && s.triggerSm, className)}
        {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon className={s.chevron}>
          <ChevronDown size={15} strokeWidth={2} aria-hidden />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content className={s.content} position="popper" sideOffset={6}>
          <SelectPrimitive.Viewport className={s.viewport}>
            {options.map((opt) => (
              <SelectPrimitive.Item
                key={opt.value || EMPTY_SENTINEL}
                value={opt.value === '' ? EMPTY_SENTINEL : opt.value}
                {...(opt.disabled != null ? { disabled: opt.disabled } : {})}
                className={s.item}
              >
                <SelectPrimitive.ItemText>{opt.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className={s.indicator}>
                  <Check size={14} strokeWidth={2.4} aria-hidden />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
