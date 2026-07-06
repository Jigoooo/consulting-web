import { createFileRoute, redirect, useRouter, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';
import { api, authStore } from '../lib/api';
import {
  AuthShell,
  Field,
  SubmitButton,
  ErrorBanner,
  PasswordStrengthMeter,
  friendlyError,
  validateEmail,
  validatePassword,
  validateName,
  authStyles as s,
} from '../features/auth-session/ui/AuthKit';

const PASSWORD_MIN = 10;

const searchSchema = z.object({
  redirect: z.string().default('/'),
});

export const Route = createFileRoute('/signup')({
  validateSearch: searchSchema,
  beforeLoad: ({ context, search }) => {
    if (context.auth.isAuthed()) {
      // TanStack Router uses thrown redirects for control flow.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: search.redirect });
    }
  },
  component: SignupPage,
});

function SignupPage() {
  const router = useRouter();
  const search = Route.useSearch();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // 검증 노출 정책: 필수값 비어있음 → submit 이후만, 형식/길이 오류 → 값 입력 후 blur 또는 submit 이후.
  const [blurred, setBlurred] = useState<{ name?: boolean; email?: boolean; password?: boolean }>({});
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const showName = submitted || (blurred.name && displayName.length > 0);
  const showEmail = submitted || (blurred.email && email.length > 0);
  const showPassword = submitted || (blurred.password && password.length > 0);
  const nameError = showName ? validateName(displayName) : undefined;
  const emailError = showEmail ? validateEmail(email) : undefined;
  const passwordError = showPassword ? validatePassword(password, PASSWORD_MIN) : undefined;
  const canSubmit =
    !validateName(displayName) && !validateEmail(email) && !validatePassword(password, PASSWORD_MIN) && !loading;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    const nErr = validateName(displayName);
    const eErr = validateEmail(email);
    const pErr = validatePassword(password, PASSWORD_MIN);
    if (nErr || eErr || pErr) {
      setError(null);
      requestAnimationFrame(() => {
        const firstInvalid = document.querySelector<HTMLInputElement>('form input[aria-invalid="true"]');
        firstInvalid?.focus();
      });
      return;
    }
    if (loading) return; // guard against double-submit
    setError(null);
    setLoading(true);
    try {
      // signup returns bootstrap ids only; immediately log in for a session.
      await api.signup({ email, password, displayName });
      const session = await api.login({ email, password });
      authStore.setSession({
        accessToken: session.tokens.accessToken,
        refreshToken: session.tokens.refreshToken,
        user: session.user,
      });
      await router.navigate({ to: search.redirect });
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell>
      <div className={s.title} data-stagger>지구 워크스페이스 시작하기</div>
      <div className={s.subtitle} data-stagger>가입하면 개인 워크스페이스가 자동으로 만들어져요.</div>
      {error ? <ErrorBanner message={error} /> : null}
      <form onSubmit={(event) => void onSubmit(event)} noValidate>
        <Field
          label="이름"
          type="text"
          value={displayName}
          onChange={setDisplayName}
          onBlur={() => setBlurred((t) => ({ ...t, name: true }))}
          placeholder="홍길동"
          autoComplete="name"
          invalid={Boolean(nameError)}
          error={nameError}
          disabled={loading}
          autoFocus
        />
        <Field
          label="이메일"
          type="email"
          value={email}
          onChange={setEmail}
          onBlur={() => setBlurred((t) => ({ ...t, email: true }))}
          placeholder="you@example.com"
          autoComplete="email"
          invalid={Boolean(emailError)}
          error={emailError}
          disabled={loading}
        />
        <Field
          label="비밀번호"
          type="password"
          value={password}
          onChange={setPassword}
          onBlur={() => setBlurred((t) => ({ ...t, password: true }))}
          placeholder="10자 이상"
          autoComplete="new-password"
          invalid={Boolean(passwordError)}
          error={passwordError}
          disabled={loading}
        />
        <PasswordStrengthMeter password={password} />
        <SubmitButton loading={loading} disabled={!canSubmit}>회원가입</SubmitButton>
      </form>
      <div className={s.divider} data-stagger>또는</div>
      <div className={s.foot} data-stagger>
        이미 계정이 있으신가요?{' '}
        <Link to="/login" search={{ redirect: search.redirect }}>로그인</Link>
      </div>
    </AuthShell>
  );
}
