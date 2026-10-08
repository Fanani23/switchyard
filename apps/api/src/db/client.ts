import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.js';
import * as schema from './schema.js';

const client = postgres(env.DATABASE_URL, { max: env.DB_POOL_MAX });

export const db = drizzle(client, { schema });
export type Db = typeof db;

export const closeDb = () => client.end();
