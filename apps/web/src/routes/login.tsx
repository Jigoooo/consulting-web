import { createFileRoute, redirect, useRouter, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';
import { api, authStore } from '../lib/api';
import { AuthShell, Field, SubmitButton, ErrorBanner, friendlyError, authStyles as s } from '../features/auth-session/ui/AuthKit';

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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
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
      <div className={s.title} data-stagger>다시 오신 걸 환영해요</div>
      <div className={s.subtitle} data-stagger>컨설팅 워크스페이스에 로그인하세요.</div>
      {error ? <ErrorBanner message={error} /> : null}
      <form onSubmit={(event) => void onSubmit(event)}>
        <Field label="이메일" type="email" value={email} onChange={setEmail} placeholder="you@example.com" autoComplete="email" autoFocus />
        <Field label="비밀번호" type="password" value={password} onChange={setPassword} placeholder="••••••••" autoComplete="current-password" />
        <SubmitButton loading={loading}>로그인</SubmitButton>
      </form>
      <div className={s.foot} data-stagger>
        계정이 없으신가요?{' '}
        <Link to="/signup" search={{ redirect: search.redirect }}>회원가입</Link>
      </div>
    </AuthShell>
  );
}
