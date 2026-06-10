import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config/env.js';
import * as schema from './schema/index.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  // Fail fast instead of queueing forever when the DB is unreachable.
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  // Kill runaway queries before they pile up and exhaust the pool.
  statement_timeout: 30_000,
});

export const db = drizzle(pool, { schema });

export type DB = typeof db;
