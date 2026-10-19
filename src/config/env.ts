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
  // Hop count ("1") or trusted proxy ranges ("loopback,linklocal,uniquelocal"). Ranges are needed once
  // partner portals proxy /api: a fixed hop count would read the proxy's IP as the client's.
  TRUST_PROXY: z
    .string()
    .default('1')
    .transform((v) => (/^\d+$/.test(v.trim()) ? Number(v) : v.split(',').map((s) => s.trim()))),
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
  // Resend webhook signing secrets: the unsuffixed one belongs to the RESEND_API_KEY account
  // (system mail); brand ones are seeded into company.resend_webhook_secret.
  RESEND_WEBHOOK_SECRET: optionalString,
  RESEND_WEBHOOK_SECRET_HAMBURG: optionalString,
  RESEND_WEBHOOK_SECRET_CLEANILO: optionalString,
  RESEND_WEBHOOK_SECRET_TRL: optionalString,
  ADMIN_FROM_EMAIL: z.string().email().default('admin@reinigungs-portal.com'),
  ADMIN_FROM_NAME: z.string().default('Reinigungs-Portal'),
  // Own brand domains (incl. subdomains): an inquiry from one is loop traffic (our own mail
  // re-ingested), so it gets no confirmation mail. Backstop behind the n8n self-sender filter.
  OWN_EMAIL_DOMAINS: z
    .string()
    .default(
      'cleanilo.de,hamburg-teppichreinigung.de,teppichreinigen-lassen.de,reinigungs-portal.com',
    )
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  // Per contact email, rolling hour; caps runaway feedback loops.
  INQUIRY_MAX_PER_EMAIL_PER_HOUR: z.coerce.number().int().positive().default(10),
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
  AWS_REGION: z.string().default('eu-central-1'),
  AWS_ACCESS_KEY_ID: optionalString,
  AWS_SECRET_ACCESS_KEY: optionalString,
  S3_ENDPOINT: optionalUrl,
  S3_BUCKET: optionalString,
  // Public base URL for the public/ asset prefix (blog images); falls back to endpoint/bucket/region.
  S3_PUBLIC_BASE_URL: optionalUrl,
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

  // Meta Conversions API: needs both pixel id and token, else no-op.
  META_PIXEL_ID_HAMBURG: optionalString,
  META_CAPI_TOKEN_HAMBURG: optionalString,
  META_TEST_EVENT_CODE_HAMBURG: optionalString,
  META_PIXEL_ID_CLEANILO: optionalString,
  META_CAPI_TOKEN_CLEANILO: optionalString,
  META_TEST_EVENT_CODE_CLEANILO: optionalString,

  // Must equal REVALIDATE_SECRET in the storefront; unset ⇒ blog/SEO edits wait for the 1 h ISR window.
  STOREFRONT_REVALIDATE_SECRET_HAMBURG: optionalString,
  STOREFRONT_REVALIDATE_SECRET_CLEANILO: optionalString,

  // Key unset ⇒ /admin/ai/* returns 503.
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().int().positive().max(8192).default(1024),

  // Human vs AI callback split: within the radius of the reference point ⇒ human. Default ref is
  // PLZ 20457 from the centroid table, so the haversine matches the lookup data.
  CALLBACK_GEO_REF_LAT: z.coerce.number().default(53.53165),
  CALLBACK_GEO_REF_LNG: z.coerce.number().default(9.98526),
  CALLBACK_GEO_RADIUS_KM: z.coerce.number().positive().default(100),
  CALLBACK_DEFAULT_HUMAN_ASSIGNEE_ID: optionalString,
  // X-Intake-Token for the voice-AI / n8n intake endpoint; unset ⇒ endpoint disabled (503).
  INQUIRY_INTAKE_TOKEN: optionalString,

  // One CLEANILO Calendly account serves all brands (the only brand-sharing exception); Calendly
  // writes the CLEANILO Google Calendar itself. Needs the paid plan; unset ⇒ no booking attempted.
  CALENDLY_API_TOKEN: optionalString,
  // CLEANILO "Besichtigung / Ausführung" event type URI; list via `scripts/calendly-setup.ts event-types`.
  CALENDLY_PICKUP_EVENT_TYPE_URI: optionalString,
  // Unset ⇒ the webhook accepts nothing (503): unverified bookings are untrusted.
  CALENDLY_WEBHOOK_SIGNING_KEY: optionalString,
  // Our slots are Europe/Berlin wall clock.
  CALENDLY_TIMEZONE: z.string().default('Europe/Berlin'),
  // Test seam for a local Calendly stub; rejected in production.
  CALENDLY_API_BASE: optionalUrl,
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

// Publishable keys reach browsers: never allow an sk_ here.
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
  // Stripe webhooks fail silently without the signing secret.
  if (parsed.data.STRIPE_SECRET_KEY && !parsed.data.STRIPE_WEBHOOK_SECRET) {
    errors.push('STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set.');
  }
  // PayPal: all three or none.
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
  // A token without an event type would silently skip the calendar.
  if (parsed.data.CALENDLY_API_TOKEN && !parsed.data.CALENDLY_PICKUP_EVENT_TYPE_URI) {
    errors.push(
      'CALENDLY_PICKUP_EVENT_TYPE_URI is required when CALENDLY_API_TOKEN is set (otherwise no pickup can be booked).',
    );
  }
  // The stub seam would swallow real bookings.
  if (
    parsed.data.CALENDLY_API_BASE &&
    parsed.data.CALENDLY_API_BASE !== 'https://api.calendly.com'
  ) {
    errors.push('CALENDLY_API_BASE must be unset in production (test seam only).');
  }
  if (errors.length > 0) {
    console.error('Production environment misconfigured:\n  ' + errors.join('\n  '));
    process.exit(1);
  }
}

export const env = parsed.data;
export type Env = typeof env;
