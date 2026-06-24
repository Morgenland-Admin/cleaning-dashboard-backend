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
  RESEND_API_KEY_HAMBURG: optionalString,
  RESEND_API_KEY_CLEANILO: optionalString,
  RESEND_API_KEY_TRL: optionalString,
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
  PAYPAL_CLIENT_ID: optionalString,
  PAYPAL_SECRET: optionalString,
  PAYPAL_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
  PAYPAL_WEBHOOK_ID: optionalString,
  N8N_CANCEL_WEBHOOK_URL: optionalUrl,
  N8N_WEBHOOK_SECRET: optionalString,
  VAPID_PUBLIC_KEY: optionalString,
  VAPID_PRIVATE_KEY: optionalString,
  VAPID_SUBJECT: z.string().default('mailto:admin@reinigungs-portal.com'),
  SENTRY_DSN: optionalString,

  // Meta Conversions API (per-brand). Needs both pixel id + token, else no-op.
  // TEST_EVENT_CODE is optional (Events Manager → Test Events).
  META_PIXEL_ID_HAMBURG: optionalString,
  META_CAPI_TOKEN_HAMBURG: optionalString,
  META_TEST_EVENT_CODE_HAMBURG: optionalString,

  // Claude text assistant. Key unset ⇒ /admin/ai/* returns 503 (UI shows a hint).
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().int().positive().max(8192).default(1024),

  // ── Voice-AI / callback geo-routing ──
  // Reference point and radius for splitting inquiries between a human callback
  // (within radius) and the automated AI warm-callback queue (outside). Both are
  // expected to change as we grow, so they live in config, not code. Default ref
  // is PLZ 20457 taken from the centroid table itself, keeping the haversine
  // self-consistent with the lookup data.
  CALLBACK_GEO_REF_LAT: z.coerce.number().default(53.53165),
  CALLBACK_GEO_REF_LNG: z.coerce.number().default(9.98526),
  CALLBACK_GEO_RADIUS_KM: z.coerce.number().positive().default(100),
  // User id that human (Hamburg-area) callbacks are assigned to by default.
  // A plain user pointer — hand off or distribute across reps later by changing
  // this value (or the assignment logic), no schema change. Set to Kabir's id.
  CALLBACK_DEFAULT_HUMAN_ASSIGNEE_ID: optionalString,
  // Shared secret the voice-AI / n8n intake endpoint must present in the
  // X-Intake-Token header. When unset, the intake endpoint is disabled (503).
  INQUIRY_INTAKE_TOKEN: optionalString,
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

// Publishable keys end up in browsers — never allow an sk_ here.
if (parsed.data.STRIPE_PUBLISHABLE_KEY?.startsWith('sk_')) {
  console.error(
    'STRIPE_PUBLISHABLE_KEY contains a SECRET key (sk_...). ' +
      'Set the pk_... publishable key here and rotate the leaked secret key.',
  );
  process.exit(1);
}

if (parsed.data.NODE_ENV === 'production') {
  const errors: string[] = [];
  if (parsed.data.APP_BASE_URL === 'http://localhost:5173') {
    errors.push('APP_BASE_URL is required in production (currently using the local dev default).');
  }
  // Stripe webhooks fail silently without the signing secret — catch it at boot.
  if (parsed.data.STRIPE_SECRET_KEY && !parsed.data.STRIPE_WEBHOOK_SECRET) {
    errors.push('STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set.');
  }
  // PayPal must be configured as a coherent set, or not at all.
  const paypalKeys = [
    parsed.data.PAYPAL_CLIENT_ID,
    parsed.data.PAYPAL_SECRET,
    parsed.data.PAYPAL_WEBHOOK_ID,
  ];
  if (paypalKeys.some(Boolean) && !paypalKeys.every(Boolean)) {
    errors.push(
      'PayPal is half-configured: set PAYPAL_CLIENT_ID, PAYPAL_SECRET and PAYPAL_WEBHOOK_ID together, or none.',
    );
  }
  if (errors.length > 0) {
    console.error('Production environment misconfigured:\n  ' + errors.join('\n  '));
    process.exit(1);
  }
}

export const env = parsed.data;
export type Env = typeof env;
