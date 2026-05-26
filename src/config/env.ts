import 'dotenv/config';
import { z } from 'zod';

const emptyToUndefined = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.unknown(),
);
const optionalUrl = emptyToUndefined.pipe(z.string().url().optional());
const optionalString = emptyToUndefined.pipe(z.string().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 chars'),
  BETTER_AUTH_URL: z.string().url(),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  RESEND_API_KEY: optionalString,
  ADMIN_FROM_EMAIL: z.string().email().default('admin@reinigungs-portal.com'),
  ADMIN_FROM_NAME: z.string().default('Reinigungs-Portal'),
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
  AWS_REGION: z.string().default('eu-central-1'),
  AWS_ACCESS_KEY_ID: optionalString,
  AWS_SECRET_ACCESS_KEY: optionalString,
  S3_ENDPOINT: optionalUrl,
  S3_BUCKET: optionalString,
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  STRIPE_PUBLISHABLE_KEY: optionalString,
  VAPID_PUBLIC_KEY: optionalString,
  VAPID_PRIVATE_KEY: optionalString,
  VAPID_SUBJECT: z.string().default('mailto:admin@reinigungs-portal.com'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

if (parsed.data.NODE_ENV === 'production') {
  const errors: string[] = [];
  if (parsed.data.APP_BASE_URL === 'http://localhost:5173') {
    errors.push('APP_BASE_URL is required in production (currently using the local dev default).');
  }
  if (errors.length > 0) {
    console.error('Production environment misconfigured:\n  ' + errors.join('\n  '));
    process.exit(1);
  }
}

export const env = parsed.data;
export type Env = typeof env;
