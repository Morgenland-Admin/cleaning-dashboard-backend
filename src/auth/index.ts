import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { bearer } from 'better-auth/plugins';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { and, eq, isNotNull } from 'drizzle-orm';
import { account, company, membership, session, user, verification } from '../db/schema/shared.js';
import { adminSender, brandInfoFromCompany, brandSender, sendEmail } from '../email/service.js';
import { partnerResetPasswordEmail, resetPasswordEmail } from '../email/templates.js';

/** Partner users reset on their brand's portal, in the brand's name; everyone else on the admin. */
async function partnerResetBrand(userId: string) {
  const [u] = await db.select({ audience: user.audience }).from(user).where(eq(user.id, userId));
  if (u?.audience !== 'partner') return null;
  const [row] = await db
    .select({ company })
    .from(membership)
    .innerJoin(company, eq(company.slug, membership.companySlug))
    .where(and(eq(membership.userId, userId), isNotNull(company.partnerPortalOrigin)))
    .limit(1);
  return row?.company ?? null;
}

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  basePath: '/auth',
  // Partner portals sign in through a same-origin proxy, so their origin must be trusted too.
  trustedOrigins: async () => {
    const { loadAllActiveCompanies } = await import('../lib/company-loader.js');
    const companies = await loadAllActiveCompanies().catch(() => []);
    return [
      ...env.CORS_ORIGINS,
      ...companies.map((c) => c.partnerPortalOrigin).filter((o): o is string => !!o),
    ];
  },
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: { user, session, account, verification },
  }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    minPasswordLength: 8,
    disableSignUp: true,
    sendResetPassword: async ({ user: u, url, token }) => {
      const brand = await partnerResetBrand(u.id);
      if (brand && token) {
        const portal = brand.partnerPortalOrigin!.replace(/\/$/, '');
        await sendEmail({
          to: u.email,
          from: brandSender(brand),
          apiKey: brand.resendApiKey ?? undefined,
          log: { companySlug: brand.slug, kind: 'password_reset' },
          email: partnerResetPasswordEmail({
            brand: brandInfoFromCompany(brand),
            name: u.name,
            resetUrl: `${portal}/passwort-zuruecksetzen?token=${encodeURIComponent(token)}`,
          }),
        });
        return;
      }
      const base = env.APP_BASE_URL.replace(/\/$/, '');
      const resetUrl = token ? `${base}/reset-password?token=${encodeURIComponent(token)}` : url;
      const rendered = resetPasswordEmail({ name: u.name, resetUrl });
      await sendEmail({
        to: u.email,
        from: adminSender(),
        log: { companySlug: null, kind: 'password_reset' },
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
      // Refetched on every window focus; the 30/min default logs active users out.
      '/get-session': { window: 60, max: 120 },
    },
  },
  databaseHooks: {
    session: {
      create: {
        // A deactivated account must not get a fresh session (existing ones are deleted on deactivate).
        before: async (s) => {
          const [u] = await db
            .select({ isActive: user.isActive })
            .from(user)
            .where(eq(user.id, s.userId))
            .limit(1);
          if (u && !u.isActive) throw new APIError('FORBIDDEN', { message: 'Account disabled' });
        },
      },
    },
  },
  plugins: [bearer()],
});

export type Auth = typeof auth;
export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;
