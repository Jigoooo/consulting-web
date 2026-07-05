import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: false,
    environment: 'node',
    pool: 'forks',
    include: ['test/**/*.test.ts'],
  },
});
