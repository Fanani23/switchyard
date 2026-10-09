import { defineConfig } from 'vitest/config';

// Load tests (SPEC.md F1, F3): a real server process, real PostgreSQL, minutes of traffic.
// Not part of `test` or `test:integration`; run with `pnpm --filter @switchyard/api test:load`.
export default defineConfig({
  test: {
    include: ['test-load/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 15 * 60_000,
    hookTimeout: 5 * 60_000,
  },
});
