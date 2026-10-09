import { defineConfig } from '@playwright/test';

// `output: standalone` emits a server that expects .next/static to be copied in beside it,
// exactly as the Dockerfile does. Serve it the same way here so tests exercise the real artifact.
const copyStatic =
  "node -e \"require('fs').cpSync('.next/static','.next/standalone/apps/web/.next/static',{recursive:true})\"";

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Tests share one API and database; each builds its own project, but keep them serial so
  // timing-sensitive checks (live updates, toasts) are not starved.
  workers: 1,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    // A machine with a preinstalled Chromium of another build can point at it; CI installs
    // the matching browser and leaves this unset.
    launchOptions: process.env.PW_CHROMIUM_PATH
      ? { executablePath: process.env.PW_CHROMIUM_PATH }
      : {},
  },
  webServer: [
    {
      // The real API, built (`pnpm -r run build`) and migrated beforehand, as in CI.
      command: 'node ../api/dist/server.js',
      url: 'http://localhost:4000/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        PORT: '4000',
        LOG_LEVEL: 'warn',
        SWITCHYARD_ROOT_KEY: 'e2e-root-key-not-a-secret-0123456789abcdef',
        CORS_ORIGINS: 'http://localhost:3000',
        // E2E drives many admin calls through one key; the limiter has its own tests.
        RATE_LIMIT_MAX: '100000',
      },
    },
    {
      command: `npx next build && ${copyStatic} && node .next/standalone/apps/web/server.js`,
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: { NEXT_PUBLIC_API_URL: 'http://localhost:4000' },
    },
  ],
});
