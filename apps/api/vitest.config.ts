import { defineConfig } from 'vitest/config';

// Unit tests only: no database, no network. Integration lives in vitest.integration.config.ts.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
