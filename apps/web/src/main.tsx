import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { routeTree } from './routeTree.gen';
import { authStore } from './lib/api';
import { bindAuthRouterInvalidation } from './lib/auth-router-sync';
import { bindAuthIdentityIsolation } from './lib/auth-identity-isolation';
import { clearMessageWindowCache } from './widgets/chat-thread/model/messageCache';
import { clearComposerDrafts } from './widgets/chat-thread/model/composerDraftStore';
import { setupServiceWorker, reloadIfUpdateReady } from './lib/sw';
import { ToastProvider } from './shared/ui/toast/Toast';
import { ErrorBoundary } from './shared/ui/error-boundary/ErrorBoundary';
import './lib/motion'; // D5: apply global GSAP tuning (force3D, lagSmoothing) once
import './styles/global.css';

setupServiceWorker();

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

const stopAuthIdentityIsolation = bindAuthIdentityIsolation(
  {
    getUserId: () => authStore.getUser()?.id ?? null,
    subscribe: authStore.subscribe,
  },
  () => {
    queryClient.clear();
    clearMessageWindowCache();
    clearComposerDrafts();
  },
);

const router = createRouter({
  routeTree,
  context: { queryClient, auth: authStore },
  defaultPreload: 'intent',
  scrollRestoration: true,
});

const stopAuthRouterSync = bindAuthRouterInvalidation(authStore, () => {
  void router.invalidate();
});
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopAuthRouterSync();
    stopAuthIdentityIsolation();
  });
}

// SW deploy flow: when a new version is fully precached, swap at a natural
// navigation boundary (user expects a screen change; no form state at risk).
router.subscribe('onBeforeNavigate', () => {
  reloadIfUpdateReady();
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
