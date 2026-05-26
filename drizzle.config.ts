import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  schemaFilter: ['public', 'cleanilo', 'hamburg_teppichreinigung', 'teppichreinigen_lassen'],
  verbose: true,
  strict: true,
});
