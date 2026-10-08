import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { env } from '../env.js';

const client = postgres(env.DATABASE_URL, { max: 1 });
await migrate(drizzle(client), { migrationsFolder: './drizzle' });
await client.end();
