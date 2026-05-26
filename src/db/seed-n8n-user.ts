import { eq } from 'drizzle-orm';
import { auth } from '../auth/index.js';
import { LEGACY_COMPANY_SLUGS } from '../config/companies.js';
import { db, pool } from './index.js';
import { company, membership, user, userSettings } from './schema/shared.js';

const EMAIL = process.env.N8N_ROBOT_EMAIL ?? 'n8n@morgenland-teppiche.de';
const PASSWORD = process.env.N8N_ROBOT_PASSWORD ?? '';

async function ensureRobotUser() {
  const [existing] = await db.select().from(user).where(eq(user.email, EMAIL)).limit(1);

  if (existing) {
    const [updated] = await db
      .update(user)
      .set({
        firstName: 'n8n',
        lastName: 'Automation',
        audience: 'admin',
        accessLevel: 'admin',
        emailVerified: true,
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(user.id, existing.id))
      .returning();
    if (!updated) throw new Error(`Failed to update robot user ${EMAIL}`);
    console.info(`   ↻ existing user ${EMAIL} — metadata synced (password unchanged)`);
    return updated;
  }

  if (!PASSWORD || PASSWORD.length < 8) {
    throw new Error(
      'N8N_ROBOT_PASSWORD is required (min 8 chars) to create the robot user. ' +
        'Set it to a long random value, e.g. N8N_ROBOT_PASSWORD="$(openssl rand -base64 24)".',
    );
  }

  const created = await auth.api.signUpEmail({
    body: { email: EMAIL, password: PASSWORD, name: 'n8n Automation' },
  });
  if (!created?.user?.id) {
    throw new Error(`signUpEmail did not return a user id for ${EMAIL}`);
  }
  const [updated] = await db
    .update(user)
    .set({
      firstName: 'n8n',
      lastName: 'Automation',
      audience: 'admin',
      accessLevel: 'admin',
      emailVerified: true,
      isActive: true,
      updatedAt: new Date(),
    })
    .where(eq(user.id, created.user.id))
    .returning();
  if (!updated) throw new Error(`Failed to enrich robot user ${EMAIL}`);
  console.info(`   ✓ created user ${EMAIL}`);
  return updated;
}

async function ensureMemberships(userId: string) {
  for (const slug of LEGACY_COMPANY_SLUGS) {
    const [co] = await db
      .select({ slug: company.slug })
      .from(company)
      .where(eq(company.slug, slug))
      .limit(1);
    if (!co) {
      console.warn(
        `   ! company "${slug}" not found — skipping membership (run the company seed first)`,
      );
      continue;
    }
    await db
      .insert(membership)
      .values({ userId, companySlug: slug, role: 'admin', acceptedAt: new Date() })
      .onConflictDoUpdate({
        target: [membership.userId, membership.companySlug],
        set: { role: 'admin' },
      });
    console.info(`   ✓ membership ${slug} (admin)`);
  }
}

async function ensureUserSettings(userId: string) {
  await db
    .insert(userSettings)
    .values({ userId, locale: 'de', theme: 'system' })
    .onConflictDoNothing();
}

async function main() {
  console.info(`→ Provisioning n8n robot user (${EMAIL})…`);
  const u = await ensureRobotUser();
  await ensureMemberships(u.id);
  await ensureUserSettings(u.id);
  console.info('\nDone. Robot user is admin on all three brands.');
  console.info(
    'In n8n: sign in once → use the `set-auth-token` value as `Authorization: Bearer …`,',
  );
  console.info(
    'and send `X-Company-Slug: cleanilo | hamburg_teppichreinigung | teppichreinigen_lassen` per request.',
  );
}

main()
  .catch((err) => {
    console.error('n8n robot seed failed:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
