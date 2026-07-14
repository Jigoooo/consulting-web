import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: false,
    environment: 'node',
    pool: 'forks',
    // Integration files share one explicit PostgreSQL/Redis pair. Running files
    // concurrently lets unrelated AppModule relays claim each other's outbox rows.
    fileParallelism: false,
    include: ['test/**/*.test.ts'],
  },
});
