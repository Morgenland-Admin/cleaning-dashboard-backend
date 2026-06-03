import { eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { auth } from '../auth/index.js';
import { db, pool } from './index.js';
import { account, company, membership, user, userSettings } from './schema/shared.js';
import { getTenantTables } from './schema/tenant.js';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@reinigungs-portal.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const ADMIN_FIRST = process.env.ADMIN_FIRST_NAME ?? 'Admin';
const ADMIN_LAST = process.env.ADMIN_LAST_NAME ?? '';

const N8N_EMAIL = process.env.N8N_ROBOT_EMAIL ?? 'n8n@morgenland-teppiche.de';
const N8N_PASSWORD = process.env.N8N_ROBOT_PASSWORD ?? '';

interface SeedUser {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  accessLevel: 'super_admin' | 'admin';
  role: 'owner' | 'admin';
}

/** Create the user + credential directly (public sign-up is disabled). Idempotent. */
async function ensureUser(seed: SeedUser): Promise<string> {
  const [existing] = await db.select().from(user).where(eq(user.email, seed.email)).limit(1);
  if (existing) {
    await db
      .update(user)
      .set({
        firstName: seed.firstName,
        lastName: seed.lastName,
        audience: 'admin',
        accessLevel: seed.accessLevel,
        isActive: true,
        emailVerified: true,
        updatedAt: new Date(),
      })
      .where(eq(user.id, existing.id));
    console.info(`   ↻ ${seed.email} (exists — password unchanged)`);
    return existing.id;
  }

  const id = nanoid();
  const hashed = await auth.$context.then((ctx) => ctx.password.hash(seed.password));
  await db.insert(user).values({
    id,
    name: `${seed.firstName} ${seed.lastName}`.trim() || seed.email,
    email: seed.email,
    firstName: seed.firstName,
    lastName: seed.lastName,
    audience: 'admin',
    accessLevel: seed.accessLevel,
    emailVerified: true,
    isActive: true,
  });
  await db.insert(account).values({
    id: nanoid(),
    userId: id,
    providerId: 'credential',
    accountId: id,
    password: hashed,
  });
  await db.insert(userSettings).values({ userId: id }).onConflictDoNothing();
  console.info(`   ✓ created ${seed.email}`);
  return id;
}

async function ensureMembershipsAllBrands(userId: string, role: 'owner' | 'admin') {
  const companies = await db.select({ slug: company.slug }).from(company);
  for (const c of companies) {
    await db
      .insert(membership)
      .values({ userId, companySlug: c.slug, role, acceptedAt: new Date() })
      .onConflictDoUpdate({
        target: [membership.userId, membership.companySlug],
        set: { role },
      });
  }
}

/** Insert one sample row per tenant table, only when that table is empty. */
async function seedBrandSamples(slug: string, schemaName: string, name: string) {
  const t = getTenantTables(schemaName);

  const [{ n: nlCount } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(t.newsletterSubscribers);
  if (Number(nlCount) === 0) {
    await db.insert(t.newsletterSubscribers).values({
      email: `newsletter.demo+${slug}@example.com`,
      firstName: 'Max',
      lastName: 'Mustermann',
      locale: 'de',
      source: 'prod-seed',
      confirmed: true,
      confirmedAt: new Date(),
    });
  }

  const [{ n: cCount } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(t.contactMessages);
  if (Number(cCount) === 0) {
    await db.insert(t.contactMessages).values({
      name: 'Max Mustermann',
      email: `kontakt.demo+${slug}@example.com`,
      phone: '+49 40 1234567',
      subject: `Anfrage – ${name}`,
      message: 'Beispiel-Kontaktnachricht (prod-seed). Kann gelöscht werden.',
      locale: 'de',
      source: 'prod-seed',
      consentPrivacy: true,
    });
  }

  const [{ n: iCount } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(t.serviceInquiries);
  if (Number(iCount) === 0) {
    await db.insert(t.serviceInquiries).values({
      name: 'Erika Musterfrau',
      email: `anfrage.demo+${slug}@example.com`,
      phone: '+49 40 7654321',
      service: 'Teppichreinigung',
      message: 'Beispiel-Serviceanfrage (prod-seed). Kann gelöscht werden.',
      locale: 'de',
      source: 'prod-seed',
      consentPrivacy: true,
    });
  }
  console.info(`   ✓ ${slug}: newsletter + contact + inquiry ensured`);
}

async function main() {
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
    throw new Error(
      'ADMIN_PASSWORD is required (min 8 chars). e.g. ADMIN_PASSWORD="$(openssl rand -base64 18)"',
    );
  }
  if (!N8N_PASSWORD || N8N_PASSWORD.length < 8) {
    throw new Error('N8N_ROBOT_PASSWORD is required (min 8 chars).');
  }

  console.info('→ Prod seed: admin + n8n robot…');
  const adminId = await ensureUser({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    firstName: ADMIN_FIRST,
    lastName: ADMIN_LAST,
    accessLevel: 'super_admin',
    role: 'owner',
  });
  await ensureMembershipsAllBrands(adminId, 'owner');

  const n8nId = await ensureUser({
    email: N8N_EMAIL,
    password: N8N_PASSWORD,
    firstName: 'n8n',
    lastName: 'Automation',
    accessLevel: 'admin',
    role: 'admin',
  });
  await ensureMembershipsAllBrands(n8nId, 'admin');

  console.info('→ Per-brand sample rows…');
  const companies = await db
    .select({ slug: company.slug, schemaName: company.schemaName, name: company.name })
    .from(company);
  for (const c of companies) {
    await seedBrandSamples(c.slug, c.schemaName, c.name);
  }

  console.info('\nDone. Admin + n8n robot + 1 newsletter/contact/inquiry per brand.');
  console.info(`   admin: ${ADMIN_EMAIL}  ·  n8n: ${N8N_EMAIL}`);
}

main()
  .catch((err) => {
    console.error('prod seed failed:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
