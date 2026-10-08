import { defineConfig } from '@playwright/test';

// `output: standalone` emits a server that expects .next/static to be copied in beside it,
// exactly as the Dockerfile does. Serve it the same way here so tests exercise the real artifact.
const copyStatic =
  'node -e "require(\'fs\').cpSync(\'.next/static\',\'.next/standalone/apps/web/.next/static\',{recursive:true})"';

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: 'http://localhost:3000', trace: 'on-first-retry' },
  webServer: {
    command: `npx next build && ${copyStatic} && node .next/standalone/apps/web/server.js`,
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
