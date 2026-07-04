import { useEffect, useRef, type ReactNode } from 'react';
import { gsap } from 'gsap';
import { ApiClientError } from '@consulting/api-client';
import s from './Auth.module.css';

/** Centered auth card with ambient aurora blobs (magicui-style), GSAP entrance. */
export function AuthShell({ children }: { children: ReactNode }) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const blob1 = useRef<HTMLDivElement | null>(null);
  const blob2 = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ctx = gsap.context(() => {
      if (!reduce && cardRef.current) {
        gsap.from(cardRef.current, { opacity: 0, y: 14, duration: 0.5, ease: 'power3.out' });
        gsap.from(cardRef.current.querySelectorAll('[data-stagger]'), {
          opacity: 0,
          y: 10,
          duration: 0.4,
          stagger: 0.06,
          delay: 0.08,
          ease: 'power2.out',
        });
      }
      if (!reduce) {
        for (const b of [blob1.current, blob2.current]) {
          if (!b) continue;
          gsap.to(b, {
            x: 'random(-40, 40)',
            y: 'random(-30, 30)',
            duration: 'random(6, 10)',
            repeat: -1,
            yoyo: true,
            ease: 'sine.inOut',
          });
        }
      }
    });
    return () => ctx.revert();
  }, []);

  return (
    <div className={s.wrap}>
      <div className={`${s.blob} ${s.blob1}`} ref={blob1} />
      <div className={`${s.blob} ${s.blob2}`} ref={blob2} />
      <div className={s.card} ref={cardRef}>
        <div className={s.brand} data-stagger>
          <div className={s.brandIco}>🌍</div>
          <div>
            <div className={s.brandName}>Consulting Web</div>
            <div className={s.brandSub}>지구 컨설팅 워크스페이스</div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field(props: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  invalid?: boolean;
  autoComplete?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className={s.field} data-stagger>
      <label className={s.label}>{props.label}</label>
      <input
        className={`${s.input} ${props.invalid ? s.invalid : ''}`}
        type={props.type}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        autoComplete={props.autoComplete}
        autoFocus={props.autoFocus}
      />
    </div>
  );
}

export function SubmitButton({ loading, children }: { loading: boolean; children: ReactNode }) {
  return (
    <button className={s.btn} type="submit" disabled={loading} data-stagger>
      {loading ? <span className={s.spinner} /> : null}
      {children}
    </button>
  );
}

/** ErrorBanner with a subtle shake on mount (reactbits-style feedback). */
export function ErrorBanner({ message }: { message: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (ref.current) {
      gsap.fromTo(ref.current, { x: -6 }, { x: 0, duration: 0.4, ease: 'elastic.out(1, 0.4)' });
    }
  }, [message]);
  return (
    <div className={s.error} ref={ref}>
      {message}
    </div>
  );
}

/** Map an ApiClientError code to a friendly Korean message for non-devs. */
export function friendlyError(err: unknown, fallback = '문제가 발생했어요. 잠시 후 다시 시도해주세요.'): string {
  if (err instanceof ApiClientError) {
    switch (err.code) {
      case 'UNAUTHENTICATED':
        return '이메일 또는 비밀번호가 올바르지 않습니다.';
      case 'FORBIDDEN':
        return '이 작업을 수행할 권한이 없습니다.';
      case 'NOT_FOUND':
        return '요청한 정보를 찾을 수 없습니다.';
      case 'CONFLICT':
        return '이미 사용 중인 이메일입니다.';
      case 'PRECONDITION':
        return '초대가 만료되었거나 더 이상 유효하지 않습니다.';
      case 'VALIDATION':
        return '입력값을 다시 확인해주세요.';
      default:
        return fallback;
    }
  }
  return fallback;
}

export { s as authStyles };
