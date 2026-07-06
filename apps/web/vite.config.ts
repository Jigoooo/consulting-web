import { defineConfig, type Plugin } from 'vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';

const enableReactCompiler = process.env.DISABLE_REACT_COMPILER !== '1';

// SW deployment safety (2026-07-06). Build version is a timestamp compared by
// INEQUALITY (mismatch = update), so rollbacks behave like normal deploys.
const BUILD_VERSION = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/T(\d{4})\d{2}\..+$/, '-$1');

/** Emits /version.json ({version, assets}) next to the bundle so the service
 * worker can detect deploys and precache the new hashed assets before telling
 * clients to switch. See public/sw.js. */
function versionManifest(): Plugin {
  return {
    name: 'consulting-version-manifest',
    apply: 'build',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((f) => f.startsWith('assets/'))
        .map((f) => `/${f}`);
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ version: BUILD_VERSION, assets }),
      });
    },
  };
}

// NOTE (2026-07-05, per TanStack docs): the router plugin MUST come before
// @vitejs/plugin-react. Defaults: routesDirectory ./src/routes,
// generatedRouteTree ./src/routeTree.gen.ts.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(BUILD_VERSION),
  },
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    tailwindcss(),
    react(),
    enableReactCompiler ? babel({ presets: [reactCompilerPreset()] }) : undefined,
    versionManifest(),
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
