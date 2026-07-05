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
  const [touched, setTouched] = useState<{ name?: boolean; email?: boolean; password?: boolean }>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const nameError = touched.name ? validateName(displayName) : undefined;
  const emailError = touched.email ? validateEmail(email) : undefined;
  const passwordError = touched.password ? validatePassword(password, PASSWORD_MIN) : undefined;
  const canSubmit =
    !validateName(displayName) && !validateEmail(email) && !validatePassword(password, PASSWORD_MIN) && !loading;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched({ name: true, email: true, password: true });
    const nErr = validateName(displayName);
    const eErr = validateEmail(email);
    const pErr = validatePassword(password, PASSWORD_MIN);
    if (nErr || eErr || pErr) {
      setError(null);
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
          onBlur={() => setTouched((t) => ({ ...t, name: true }))}
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
          onBlur={() => setTouched((t) => ({ ...t, email: true }))}
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
          onBlur={() => setTouched((t) => ({ ...t, password: true }))}
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
