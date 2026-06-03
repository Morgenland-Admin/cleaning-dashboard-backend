import { eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { auth } from '../auth/index.js';
import { db, pool } from './index.js';
import { account, company, membership, user, userSettings } from './schema/shared.js';
import { getTenantTables } from './schema/tenant.js';

// Safety net: never let the dev seed touch a remote/prod DB.
const DB_URL = process.env.DATABASE_URL ?? '';
if (!/@(localhost|127\.0\.0\.1|postgres)[:/]/.test(DB_URL)) {
  console.error('seed-local refuses to run: DATABASE_URL is not local. Point it at localhost.');
  process.exit(1);
}

const DEFAULT_PW = process.env.LOCAL_SEED_PASSWORD ?? 'admin@12345';
const N8N_PW = process.env.N8N_ROBOT_PASSWORD ?? 'n8n-local-12345';

type Role = 'owner' | 'admin' | 'manager' | 'viewer';
type Access = 'super_admin' | 'admin' | 'manager' | 'viewer';

interface LocalUser {
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  accessLevel: Access;
  memberships: Record<string, Role>;
}

const USERS: LocalUser[] = [
  {
    email: 'admin@reinigungs-portal.com',
    firstName: 'Admin',
    lastName: '',
    password: DEFAULT_PW,
    accessLevel: 'super_admin',
    memberships: {
      cleanilo: 'owner',
      hamburg_teppichreinigung: 'owner',
      teppichreinigen_lassen: 'owner',
    },
  },
  {
    email: 'anna.becker@reinigungs-portal.com',
    firstName: 'Anna',
    lastName: 'Becker',
    password: DEFAULT_PW,
    accessLevel: 'admin',
    memberships: {
      cleanilo: 'admin',
      hamburg_teppichreinigung: 'admin',
      teppichreinigen_lassen: 'admin',
    },
  },
  {
    email: 'lukas.hoffmann@reinigungs-portal.com',
    firstName: 'Lukas',
    lastName: 'Hoffmann',
    password: DEFAULT_PW,
    accessLevel: 'manager',
    memberships: { cleanilo: 'manager', hamburg_teppichreinigung: 'manager' },
  },
  {
    email: 'sophie.wagner@reinigungs-portal.com',
    firstName: 'Sophie',
    lastName: 'Wagner',
    password: DEFAULT_PW,
    accessLevel: 'viewer',
    memberships: { teppichreinigen_lassen: 'viewer' },
  },
  {
    email: process.env.N8N_ROBOT_EMAIL ?? 'n8n@morgenland-teppiche.de',
    firstName: 'n8n',
    lastName: 'Automation',
    password: N8N_PW,
    accessLevel: 'admin',
    memberships: {
      cleanilo: 'admin',
      hamburg_teppichreinigung: 'admin',
      teppichreinigen_lassen: 'admin',
    },
  },
];

async function ensureUser(u: LocalUser): Promise<string> {
  const [existing] = await db.select().from(user).where(eq(user.email, u.email)).limit(1);
  if (existing) {
    await db
      .update(user)
      .set({
        firstName: u.firstName,
        lastName: u.lastName,
        audience: 'admin',
        accessLevel: u.accessLevel,
        isActive: true,
        emailVerified: true,
        updatedAt: new Date(),
      })
      .where(eq(user.id, existing.id));
    return existing.id;
  }
  const id = nanoid();
  const hashed = await auth.$context.then((ctx) => ctx.password.hash(u.password));
  await db.insert(user).values({
    id,
    name: `${u.firstName} ${u.lastName}`.trim() || u.email,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    audience: 'admin',
    accessLevel: u.accessLevel,
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
  return id;
}

async function ensureMemberships(userId: string, memberships: Record<string, Role>) {
  for (const [slug, role] of Object.entries(memberships)) {
    await db
      .insert(membership)
      .values({ userId, companySlug: slug, role, acceptedAt: new Date() })
      .onConflictDoUpdate({ target: [membership.userId, membership.companySlug], set: { role } });
  }
}

async function seedBrandSamples(schemaName: string, name: string) {
  const t = getTenantTables(schemaName);
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(t.newsletterSubscribers);
  if (Number(n) > 0) return; // already seeded

  await db.insert(t.newsletterSubscribers).values([
    {
      email: `anna.demo@example.com`,
      firstName: 'Anna',
      locale: 'de',
      source: 'local',
      confirmed: true,
      confirmedAt: new Date(),
    },
    {
      email: `bernd.demo@example.com`,
      firstName: 'Bernd',
      locale: 'de',
      source: 'local',
      confirmed: false,
    },
  ]);
  await db.insert(t.contactMessages).values({
    name: 'Max Mustermann',
    email: 'kontakt.demo@example.com',
    subject: `Frage – ${name}`,
    message: 'Lokale Demo-Kontaktnachricht.',
    locale: 'de',
    source: 'local',
    consentPrivacy: true,
  });
  await db.insert(t.serviceInquiries).values({
    name: 'Erika Musterfrau',
    email: 'anfrage.demo@example.com',
    service: 'Teppichreinigung',
    message: 'Lokale Demo-Serviceanfrage.',
    locale: 'de',
    source: 'local',
    consentPrivacy: true,
  });
}

async function main() {
  console.info('→ Local seed: users…');
  for (const u of USERS) {
    const id = await ensureUser(u);
    await ensureMemberships(id, u.memberships);
    console.info(`   ✓ ${u.email} (${u.accessLevel})`);
  }
  console.info('→ Local seed: per-brand demo data…');
  const companies = await db
    .select({ schemaName: company.schemaName, name: company.name })
    .from(company);
  for (const c of companies) {
    await seedBrandSamples(c.schemaName, c.name);
    console.info(`   ✓ ${c.name}`);
  }
  console.info(`\nDone. Login: admin@reinigungs-portal.com / ${DEFAULT_PW}`);
}

main()
  .catch((err) => {
    console.error('local seed failed:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
