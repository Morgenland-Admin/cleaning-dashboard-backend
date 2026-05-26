import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { account, session, user, verification } from '../db/schema/shared.js';
import { adminSender, sendEmail } from '../email/service.js';
import { resetPasswordEmail } from '../email/templates.js';

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
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
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    additionalFields: {
      activeCompanySlug: { type: 'string', required: false, input: false },
    },
  },
  advanced: {
    crossSubDomainCookies: { enabled: false },
  },
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
  plugins: [bearer()],
});

export type Auth = typeof auth;
export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;
