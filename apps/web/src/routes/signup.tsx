import { createFileRoute, redirect, useRouter, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';
import { api, authStore } from '../lib/api';
import { AuthShell, Field, SubmitButton, ErrorBanner, friendlyError, authStyles as s } from '../components/auth/AuthKit';

const searchSchema = z.object({
  redirect: z.string().default('/'),
});

export const Route = createFileRoute('/signup')({
  validateSearch: searchSchema,
  beforeLoad: ({ context, search }) => {
    if (context.auth.isAuthed()) {
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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 10) {
      setError('비밀번호는 10자 이상이어야 합니다.');
      return;
    }
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
      <form onSubmit={onSubmit}>
        <Field label="이름" type="text" value={displayName} onChange={setDisplayName} placeholder="홍길동" autoComplete="name" autoFocus />
        <Field label="이메일" type="email" value={email} onChange={setEmail} placeholder="you@example.com" autoComplete="email" />
        <Field label="비밀번호" type="password" value={password} onChange={setPassword} placeholder="10자 이상" autoComplete="new-password" />
        <SubmitButton loading={loading}>회원가입</SubmitButton>
      </form>
      <div className={s.foot} data-stagger>
        이미 계정이 있으신가요?{' '}
        <Link to="/login" search={{ redirect: search.redirect }}>로그인</Link>
      </div>
    </AuthShell>
  );
}
