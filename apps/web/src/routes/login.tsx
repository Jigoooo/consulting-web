import { createFileRoute, redirect, useRouter, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';
import { api, authStore } from '../lib/api';
import {
  AuthShell,
  Field,
  SubmitButton,
  ErrorBanner,
  friendlyError,
  validateEmail,
  validatePassword,
  authStyles as s,
} from '../features/auth-session/ui/AuthKit';

const searchSchema = z.object({
  redirect: z.string().default('/'),
});

export const Route = createFileRoute('/login')({
  validateSearch: searchSchema,
  beforeLoad: ({ context, search }) => {
    // Already authed → skip login, honor the redirect target if present.
    if (context.auth.isAuthed()) {
      // TanStack Router uses thrown redirects for control flow.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: search.redirect });
    }
  },
  component: LoginPage,
});

function LoginPage() {
  const router = useRouter();
  const search = Route.useSearch();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // 검증 노출 정책 (NN/g #7 "입력 완료 전 검증 금지"):
  //  - 필수값 비어있음 → submit 이후에만 표시 (빈 필드 blur만으로 경고하지 않는다)
  //  - 형식 오류 → 값을 입력한 상태에서 blur 했거나 submit 이후 표시
  const [blurred, setBlurred] = useState<{ email?: boolean; password?: boolean }>({});
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const showEmail = submitted || (blurred.email && email.length > 0);
  const showPassword = submitted || (blurred.password && password.length > 0);
  const emailError = showEmail ? validateEmail(email) : undefined;
  const passwordError = showPassword ? validatePassword(password) : undefined;
  const canSubmit = !validateEmail(email) && !validatePassword(password) && !loading;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    const eErr = validateEmail(email);
    const pErr = validatePassword(password);
    if (eErr || pErr) {
      setError(null);
      // 첫 번째 오류 필드로 focus 이동 (working-memory 부담 최소화).
      // aria-invalid는 리렌더 후 반영되므로 rAF로 한 프레임 지연.
      requestAnimationFrame(() => {
        const firstInvalid = document.querySelector<HTMLInputElement>('form input[aria-invalid="true"]');
        firstInvalid?.focus();
      });
      return;
    }
    if (loading) return; // guard against double-submit (Enter spam)
    setError(null);
    setLoading(true);
    try {
      const session = await api.login({ email, password });
      authStore.setSession({
        accessToken: session.tokens.accessToken,
        refreshToken: session.tokens.refreshToken,
        user: session.user,
        accessExpiresAt: Date.now() + session.tokens.expiresInSec * 1000,
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
      <div className={s.title} data-stagger>다시 오신 걸 환영해요</div>
      <div className={s.subtitle} data-stagger>컨설팅 워크스페이스에 로그인하세요.</div>
      {error ? <ErrorBanner message={error} /> : null}
      <form onSubmit={(event) => void onSubmit(event)} noValidate>
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
          autoFocus
        />
        <Field
          label="비밀번호"
          type="password"
          value={password}
          onChange={setPassword}
          onBlur={() => setBlurred((t) => ({ ...t, password: true }))}
          placeholder="••••••••"
          autoComplete="current-password"
          invalid={Boolean(passwordError)}
          error={passwordError}
          disabled={loading}
        />
        <SubmitButton loading={loading} disabled={!canSubmit}>로그인</SubmitButton>
      </form>
      <div className={s.divider} data-stagger>또는</div>
      <div className={s.foot} data-stagger>
        계정이 없으신가요?{' '}
        <Link to="/signup" search={{ redirect: search.redirect }}>회원가입</Link>
      </div>
    </AuthShell>
  );
}
