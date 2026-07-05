import { defineConfig } from 'vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';

const enableReactCompiler = process.env.DISABLE_REACT_COMPILER !== '1';

// NOTE (2026-07-05, per TanStack docs): the router plugin MUST come before
// @vitejs/plugin-react. Defaults: routesDirectory ./src/routes,
// generatedRouteTree ./src/routeTree.gen.ts.
export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    tailwindcss(),
    react(),
    enableReactCompiler ? babel({ presets: [reactCompilerPreset()] }) : undefined,
  ],
  server: {
    port: 5273,
    proxy: {
      // Dev-only: forward API calls to the NestJS backend so the browser
      // only ever talks to same-origin; no secrets or Hermes exposure.
      '/api': {
        target: process.env.VITE_DEV_API_TARGET ?? 'http://127.0.0.1:8088',
        changeOrigin: true,
      },
    },
  },
});
