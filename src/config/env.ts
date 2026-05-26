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
  // Resend — optional in dev. If unset, the email service logs and skips sending.
  RESEND_API_KEY: optionalString,
  ADMIN_FROM_EMAIL: z.string().email().default('admin@reinigungs-portal.com'),
  ADMIN_FROM_NAME: z.string().default('Reinigungs-Portal'),
  /** Base URL the frontend is served from — used to build reset / invite links. */
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
  // --- S3 storage (single bucket, one folder per company) ---
  AWS_REGION: z.string().default('eu-central-1'),
  AWS_ACCESS_KEY_ID: optionalString,
  AWS_SECRET_ACCESS_KEY: optionalString,
  /** Override the S3 endpoint — for MinIO / LocalStack in dev. */
  S3_ENDPOINT: optionalUrl,
  /** Shared bucket for all 3 companies. Optional in dev (uploads then 503). */
  S3_BUCKET: optionalString,
  // --- Stripe (used by the orders module). Optional in dev: missing keys
  // make the checkout endpoint 503 the same way the S3 path does, so the
  // backend still boots without payment setup.
  STRIPE_SECRET_KEY: optionalString,
  /** From Stripe Dashboard → Developers → Webhooks. Required to verify webhook signatures. */
  STRIPE_WEBHOOK_SECRET: optionalString,
  /** Stripe publishable key — never used server-side. Exposed via /storefront/orders/config for frontends that want it (not required for hosted Checkout). */
  STRIPE_PUBLISHABLE_KEY: optionalString,
  // --- Web Push (VAPID). Generate once with `npx web-push generate-vapid-keys`.
  // Optional in dev — when unset, push endpoints 503 the same way Stripe / S3 do.
  VAPID_PUBLIC_KEY: optionalString,
  VAPID_PRIVATE_KEY: optionalString,
  /** Contact URL or mailto identifying us to push services. */
  VAPID_SUBJECT: z.string().default('mailto:admin@reinigungs-portal.com'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
