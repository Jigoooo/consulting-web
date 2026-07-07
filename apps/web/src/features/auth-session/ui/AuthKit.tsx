import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { gsap } from 'gsap';
import { ApiClientError } from '@consulting/api-client';
import { Icon } from '../../../shared/icons/Icon';
import { BrandMark } from '../../../shared/icons/BrandMark';
import { Input } from '../../../shared/ui/input/Input';
import s from './Auth.module.css';

const brandPoints = ['적정성 검토 근거를 한곳에서', '증거 기반 산출물 자동 정리', 'AI와 함께하는 협업 워크스페이스'] as const;

/**
 * AuthShell — split-screen auth frame. Left: aurora brand panel (magicui-style
 * ambient blobs, GSAP drift). Right: the form card with spring stagger entrance.
 * Collapses to a single column under 900px. Fully token-driven → dark-mode safe.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const blob1 = useRef<HTMLDivElement | null>(null);
  const blob2 = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ctx = gsap.context(() => {
      if (!reduce && cardRef.current) {
        gsap.from(cardRef.current.querySelectorAll('[data-stagger]'), {
          opacity: 0,
          y: 12,
          duration: 0.45,
          stagger: 0.06,
          ease: 'power3.out',
        });
      }
      if (!reduce) {
        for (const b of [blob1.current, blob2.current]) {
          if (!b) continue;
          gsap.to(b, {
            x: 'random(-40, 40)',
            y: 'random(-30, 30)',
            duration: 'random(7, 11)',
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
      <aside className={s.brandPanel}>
        <div className={`${s.blob} ${s.blob1}`} ref={blob1} />
        <div className={`${s.blob} ${s.blob2}`} ref={blob2} />
        <div className={s.panelTop}>
          <BrandMark size="md" label="Consulting Web" />
          <div>
            <div className={s.panelBrandName}>Consulting Web</div>
            <div className={s.panelBrandSub}>지구 컨설팅 워크스페이스</div>
          </div>
        </div>
        <div className={s.panelBody}>
          <div className={s.panelHeadline}>근거로 말하는 컨설팅, 하나의 워크스페이스에서.</div>
          <div className={s.panelLede}>검토·진단·산출물을 한 흐름으로 잇고, AI가 근거를 함께 정리합니다.</div>
        </div>
        <div className={s.panelPoints}>
          {brandPoints.map((point) => (
            <div className={s.panelPoint} key={point}>
              <span className={s.panelPointIco}>
                <Icon name="check" size="xs" decorative />
              </span>
              {point}
            </div>
          ))}
        </div>
      </aside>

      <main className={s.formPane}>
        <div className={s.card} ref={cardRef}>
          <div className={s.brand} data-stagger>
            <div className={s.brandIco}><BrandMark size="sm" /></div>
            <div>
              <div className={s.brandName}>Consulting Web</div>
              <div className={s.brandSub}>지구 컨설팅 워크스페이스</div>
            </div>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

export function Field(props: {
  label: string;
  name?: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  invalid?: boolean;
  error?: string | undefined;
  disabled?: boolean;
  autoComplete?: string;
  autoFocus?: boolean;
}) {
  const id = useId();
  const isPassword = props.type === 'password';
  const [reveal, setReveal] = useState(false);
  const inputType = isPassword ? (reveal ? 'text' : 'password') : props.type;

  const input = (
    <Input
      id={id}
      name={props.name}
      className={s.input}
      type={inputType}
      value={props.value}
      invalid={props.invalid}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value)}
      onBlur={props.onBlur}
      placeholder={props.placeholder}
      autoComplete={props.autoComplete}
      autoFocus={props.autoFocus}
      aria-describedby={props.error ? `${id}-err` : undefined}
    />
  );

  return (
    <div className={s.field} data-stagger>
      <label className={s.label} htmlFor={id}>{props.label}</label>
      {isPassword ? (
        <div className={s.pwWrap}>
          {input}
          <button
            type="button"
            className={s.pwToggle}
            onClick={() => setReveal((v) => !v)}
            aria-label={reveal ? '비밀번호 숨기기' : '비밀번호 보기'}
            tabIndex={-1}
          >
            <Icon name={reveal ? 'eye-off' : 'eye'} size="sm" decorative />
          </button>
        </div>
      ) : (
        input
      )}
      {props.error ? <span className={s.fieldError} id={`${id}-err`}>{props.error}</span> : null}
    </div>
  );
}

export type PasswordStrength = 'weak' | 'medium' | 'strong';

export function passwordStrength(pw: string): PasswordStrength {
  let score = 0;
  if (pw.length >= 10) score += 1;
  if (pw.length >= 14) score += 1;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score += 1;
  if (/\d/.test(pw)) score += 1;
  if (/[^A-Za-z0-9]/.test(pw)) score += 1;
  if (score >= 4) return 'strong';
  if (score >= 2) return 'medium';
  return 'weak';
}

const strengthLabel: Record<PasswordStrength, string> = {
  weak: '약함 — 10자 이상, 숫자·대소문자를 섞어주세요',
  medium: '보통 — 특수문자를 더하면 더 안전해요',
  strong: '강함',
};

export function PasswordStrengthMeter({ password }: { password: string }) {
  if (!password) return null;
  const level = passwordStrength(password);
  const fillClass = level === 'strong' ? s.strengthStrong : level === 'medium' ? s.strengthMedium : s.strengthWeak;
  return (
    <div className={s.strength} aria-live="polite">
      <div className={s.strengthTrack}>
        <div className={`${s.strengthFill} ${fillClass}`} />
      </div>
      <div className={s.strengthLabel}>{strengthLabel[level]}</div>
    </div>
  );
}

export function SubmitButton({ loading, disabled, children }: { loading: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      className={`${s.btn} ${s.cwButtonInk} cwButton cwButton--primary`}
      type="submit"
      disabled={loading || disabled}
      aria-busy={loading || undefined}
      data-stagger
    >
      {loading ? <Icon name="loader" size="sm" className="cwSpin" decorative /> : null}
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
    <div className={s.error} ref={ref} role="alert">
      <Icon name="alert" size="sm" tone="danger" decorative className={s.errorIco} />
      <span>{message}</span>
    </div>
  );
}

// --- validation helpers ---
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(email: string): string | undefined {
  if (!email.trim()) return '이메일을 입력해주세요.';
  if (!EMAIL_RE.test(email.trim())) return '올바른 이메일 형식이 아닙니다.';
  return undefined;
}

export function validatePassword(password: string, min = 1): string | undefined {
  if (!password) return '비밀번호를 입력해주세요.';
  if (min > 1 && password.length < min) return `비밀번호는 ${min}자 이상이어야 합니다.`;
  return undefined;
}

export function validateName(name: string): string | undefined {
  if (!name.trim()) return '이름을 입력해주세요.';
  return undefined;
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
      case 'TIMEOUT':
        return '서버 응답이 지연되고 있어요. 잠시 후 다시 시도해주세요.';
      case 'NETWORK':
        return '서버에 연결할 수 없어요. 네트워크 또는 서버 상태를 확인해주세요.';
      default:
        return fallback;
    }
  }
  return fallback;
}

export { s as authStyles };
