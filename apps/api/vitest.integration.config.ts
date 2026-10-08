import { defineConfig } from 'vitest/config';

// Integration tests run against a real PostgreSQL instance. They never mock the data layer.
export default defineConfig({
  test: {
    include: ['test-integration/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
