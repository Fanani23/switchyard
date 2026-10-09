import { buildApp } from './app.js';
import { closeDb } from './db/client.js';
import { env } from './env.js';

// Audit retention (SPEC.md: 90 days) is enforced by an hourly cleanup.
const app = await buildApp({ logLevel: env.LOG_LEVEL, auditPurgeIntervalMs: 60 * 60 * 1000 });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await closeDb();
  });
}

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.fatal({ err }, 'failed to start');
  process.exit(1);
}
