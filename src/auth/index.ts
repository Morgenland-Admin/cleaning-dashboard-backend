import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { account, session, user, verification } from '../db/schema/shared.js';
import { adminSender, sendEmail } from '../email/service.js';
import { resetPasswordEmail } from '../email/templates.js';

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  // Mount under /auth/* instead of the better-auth default /api/auth/* — the
  // backend already lives at api.reinigungs-portal.com so a leading /api would
  // duplicate the host segment in client URLs.
  basePath: '/auth',
  trustedOrigins: env.CORS_ORIGINS,
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: { user, session, account, verification },
  }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    minPasswordLength: 8,
    sendResetPassword: async ({ user: u, url, token }) => {
      // Rebuild the reset URL pointing at our SPA. Better Auth's `url`
      // points back to the API; we want the user dropped on our
      // /reset-password page which then POSTs the token to /auth.
      const base = env.APP_BASE_URL.replace(/\/$/, '');
      const resetUrl = token ? `${base}/reset-password?token=${encodeURIComponent(token)}` : url;
      const rendered = resetPasswordEmail({ name: u.name, resetUrl });
      await sendEmail({
        to: u.email,
        from: adminSender(),
        email: rendered,
      });
    },
  },
  user: {
    additionalFields: {
      audience: { type: 'string', required: false, defaultValue: 'customer', input: false },
      accessLevel: { type: 'string', required: false, defaultValue: 'none', input: false },
      isActive: { type: 'boolean', required: false, defaultValue: true, input: false },
    },
  },
  session: {
    // 30-day max. "Remember me" on the login form persists the cookie up to this
    // bound; unchecking it makes the cookie a session cookie (cleared on browser
    // close) but the DB session row still expires after 30 days.
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24, // refresh once a day
    additionalFields: {
      activeCompanySlug: { type: 'string', required: false, input: false },
    },
  },
  advanced: {
    crossSubDomainCookies: { enabled: false },
  },
  // Built-in rate limiting on /auth/*. The defaults are off — without this
  // block, /sign-in/email and /forget-password are unthrottled and abusable
  // for credential stuffing or reset-email spam.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 30,
    customRules: {
      '/sign-in/email': { window: 60, max: 5 },
      '/sign-up/email': { window: 60, max: 5 },
      '/forget-password': { window: 60, max: 3 },
      '/reset-password': { window: 60, max: 5 },
    },
  },
});

export type Auth = typeof auth;
export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;
