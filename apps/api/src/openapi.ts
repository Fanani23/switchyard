import { buildApp } from './app.js';

const app = await buildApp({ logLevel: 'silent' });
await app.ready();
process.stdout.write(`${JSON.stringify(app.swagger(), null, 2)}
`);
await app.close();
