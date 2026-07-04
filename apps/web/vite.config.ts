import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';

// NOTE (2026-07-05, per TanStack docs): the router plugin MUST come before
// @vitejs/plugin-react. Defaults: routesDirectory ./src/routes,
// generatedRouteTree ./src/routeTree.gen.ts.
export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
  ],
  server: {
    port: 5273,
    proxy: {
      // Dev-only: forward API calls to the NestJS backend so the browser
      // only ever talks to same-origin; no secrets or Hermes exposure.
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
});
