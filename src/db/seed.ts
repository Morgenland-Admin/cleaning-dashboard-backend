import { eq, sql } from 'drizzle-orm';
import { auth } from '../auth/index.js';
import { LEGACY_COMPANY_SLUGS, type LegacyCompanySlug } from '../config/companies.js';
import { db, pool } from './index.js';
import { company, membership, user, userSettings } from './schema/shared.js';
import { getTenantTables } from './schema/tenant.js';

type CompanySlug = LegacyCompanySlug;
const COMPANY_SLUGS = LEGACY_COMPANY_SLUGS;

/**
 * Bootstrap config for the three original tenants. Anything beyond these
 * three is created at runtime via the POST /admin/companies endpoint.
 */
const LEGACY_COMPANY_CONFIG: Record<
  LegacyCompanySlug,
  { name: string; schema: string; keyPrefix: string; storefrontOrigin: string }
> = {
  cleanilo: {
    name: 'Cleanilo',
    schema: 'cleanilo',
    keyPrefix: 'cleanilo',
    storefrontOrigin: 'https://cleanilo.de',
  },
  hamburg_teppichreinigung: {
    name: 'Hamburg Teppichreinigung',
    schema: 'hamburg_teppichreinigung',
    keyPrefix: 'hamburg-teppichreinigung',
    storefrontOrigin: 'https://hamburg-teppichreinigung.de',
  },
  teppichreinigen_lassen: {
    name: 'Teppichreinigen Lassen',
    schema: 'teppichreinigen_lassen',
    keyPrefix: 'teppichreinigen-lassen',
    storefrontOrigin: 'https://teppichreinigen-lassen.de',
  },
};

interface SeedUser {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  audience: 'admin' | 'partner' | 'customer';
  accessLevel: 'super_admin' | 'admin' | 'manager' | 'viewer' | 'none';
  phone?: string;
  /** Per-company roles. Defaults to all 3 admin companies as the same role. */
  memberships: Partial<Record<CompanySlug, 'owner' | 'admin' | 'manager' | 'viewer' | 'partner'>>;
}

const SEED_USERS: SeedUser[] = [
  {
    email: 'admin@reinigungs-portal.com',
    password: 'admin@12345',
    firstName: 'Admin',
    lastName: '',
    audience: 'admin',
    accessLevel: 'super_admin',
    phone: '+49 40 11111111',
    memberships: {
      cleanilo: 'owner',
      hamburg_teppichreinigung: 'owner',
      teppichreinigen_lassen: 'owner',
    },
  },
  {
    email: 'anna.becker@reinigungs-portal.com',
    password: 'admin@12345',
    firstName: 'Anna',
    lastName: 'Becker',
    audience: 'admin',
    accessLevel: 'admin',
    memberships: {
      cleanilo: 'admin',
      hamburg_teppichreinigung: 'admin',
      teppichreinigen_lassen: 'admin',
    },
  },
  {
    email: 'lukas.hoffmann@reinigungs-portal.com',
    password: 'admin@12345',
    firstName: 'Lukas',
    lastName: 'Hoffmann',
    audience: 'admin',
    accessLevel: 'manager',
    memberships: {
      cleanilo: 'manager',
      hamburg_teppichreinigung: 'manager',
    },
  },
  {
    email: 'sophie.wagner@reinigungs-portal.com',
    password: 'admin@12345',
    firstName: 'Sophie',
    lastName: 'Wagner',
    audience: 'admin',
    accessLevel: 'viewer',
    memberships: {
      teppichreinigen_lassen: 'viewer',
    },
  },
];

async function ensureSchemas() {
  for (const c of Object.values(LEGACY_COMPANY_CONFIG)) {
    await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "${c.schema}"`));
  }
}

const COMPANY_SENDERS: Record<string, { domain: string; from: string }> = {
  cleanilo: { domain: 'cleanilo.de', from: 'hello@cleanilo.de' },
  hamburg_teppichreinigung: {
    domain: 'hamburg-teppichreinigung.de',
    from: 'hallo@hamburg-teppichreinigung.de',
  },
  teppichreinigen_lassen: {
    domain: 'teppichreinigen-lassen.de',
    from: 'kontakt@teppichreinigen-lassen.de',
  },
};

async function seedCompanies() {
  for (const [slug, c] of Object.entries(LEGACY_COMPANY_CONFIG)) {
    const sender = COMPANY_SENDERS[slug];
    await db
      .insert(company)
      .values({
        slug,
        name: c.name,
        schemaName: c.schema,
        keyPrefix: c.keyPrefix,
        storefrontOrigin: c.storefrontOrigin,
        websiteUrl: sender ? `https://${sender.domain}` : undefined,
        senderEmail: sender?.from,
        senderName: c.name,
      })
      .onConflictDoUpdate({
        target: company.slug,
        set: {
          senderEmail: sender?.from,
          senderName: c.name,
          keyPrefix: c.keyPrefix,
          storefrontOrigin: c.storefrontOrigin,
          websiteUrl: sender ? `https://${sender.domain}` : undefined,
        },
      });
  }
}

async function ensureUser(seed: SeedUser) {
  const [existing] = await db.select().from(user).where(eq(user.email, seed.email)).limit(1);

  if (existing) {
    const [updated] = await db
      .update(user)
      .set({
        firstName: seed.firstName,
        lastName: seed.lastName,
        phone: seed.phone ?? existing.phone,
        audience: seed.audience,
        accessLevel: seed.accessLevel,
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(user.id, existing.id))
      .returning();
    if (!updated) throw new Error(`Failed to update user ${seed.email}`);
    return updated;
  }

  const created = await auth.api.signUpEmail({
    body: {
      email: seed.email,
      password: seed.password,
      name: `${seed.firstName} ${seed.lastName}`.trim(),
    },
  });
  if (!created?.user?.id) {
    throw new Error(`signUpEmail did not return a user id for ${seed.email}`);
  }
  const [updated] = await db
    .update(user)
    .set({
      firstName: seed.firstName,
      lastName: seed.lastName,
      phone: seed.phone,
      audience: seed.audience,
      accessLevel: seed.accessLevel,
      emailVerified: true,
      isActive: true,
      updatedAt: new Date(),
    })
    .where(eq(user.id, created.user.id))
    .returning();
  if (!updated) throw new Error(`Failed to enrich user ${seed.email}`);
  return updated;
}

async function ensureMemberships(userId: string, seed: SeedUser) {
  for (const slug of COMPANY_SLUGS) {
    const role = seed.memberships[slug];
    if (!role) continue;
    await db
      .insert(membership)
      .values({
        userId,
        companySlug: slug,
        role,
        acceptedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [membership.userId, membership.companySlug],
        set: { role },
      });
  }
}

async function ensureUserSettings(userId: string) {
  await db
    .insert(userSettings)
    .values({ userId, locale: 'de', theme: 'system' })
    .onConflictDoNothing();
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Insert rows into a tenant table only when it's empty, so the seed stays idempotent. */
async function seedNewsletter() {
  const NEWSLETTER_FIXTURES: Record<
    CompanySlug,
    Array<{
      email: string;
      firstName?: string;
      lastName?: string;
      source?: string;
      confirmed?: boolean;
      confirmedAt?: Date | null;
      unsubscribedAt?: Date | null;
      daysOld: number;
    }>
  > = {
    cleanilo: [
      {
        email: 'lukas.mueller@example.com',
        firstName: 'Lukas',
        lastName: 'Müller',
        source: 'homepage-footer',
        confirmed: true,
        confirmedAt: daysAgo(14),
        daysOld: 15,
      },
      {
        email: 'anna.schmidt@example.com',
        firstName: 'Anna',
        lastName: 'Schmidt',
        source: 'blog-post-1',
        confirmed: true,
        confirmedAt: daysAgo(8),
        daysOld: 9,
      },
      {
        email: 'tom.fischer@example.com',
        firstName: 'Tom',
        lastName: 'Fischer',
        source: 'checkout',
        confirmed: false,
        daysOld: 3,
      },
      {
        email: 'laura.bauer@example.com',
        firstName: 'Laura',
        lastName: 'Bauer',
        source: 'homepage-footer',
        confirmed: true,
        confirmedAt: daysAgo(40),
        unsubscribedAt: daysAgo(2),
        daysOld: 45,
      },
    ],
    hamburg_teppichreinigung: [
      {
        email: 'sandra.becker@example.com',
        firstName: 'Sandra',
        lastName: 'Becker',
        source: 'kontaktseite',
        confirmed: true,
        confirmedAt: daysAgo(20),
        daysOld: 21,
      },
      {
        email: 'kai.weber@example.com',
        firstName: 'Kai',
        lastName: 'Weber',
        source: 'google-ads',
        confirmed: true,
        confirmedAt: daysAgo(5),
        daysOld: 6,
      },
      {
        email: 'michael.wagner@example.com',
        firstName: 'Michael',
        lastName: 'Wagner',
        source: 'homepage-footer',
        confirmed: false,
        daysOld: 1,
      },
    ],
    teppichreinigen_lassen: [
      {
        email: 'julia.koch@example.com',
        firstName: 'Julia',
        lastName: 'Koch',
        source: 'anthrazit-funnel',
        confirmed: true,
        confirmedAt: daysAgo(11),
        daysOld: 12,
      },
      {
        email: 'jonas.richter@example.com',
        firstName: 'Jonas',
        lastName: 'Richter',
        source: 'newsletter-popup',
        confirmed: true,
        confirmedAt: daysAgo(30),
        daysOld: 31,
      },
      {
        email: 'elena.hoffmann@example.com',
        firstName: 'Elena',
        lastName: 'Hoffmann',
        source: 'footer-cta',
        confirmed: false,
        daysOld: 4,
      },
    ],
  };

  for (const slug of COMPANY_SLUGS) {
    const { newsletterSubscribers } = getTenantTables(LEGACY_COMPANY_CONFIG[slug].schema);
    const countRow = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(newsletterSubscribers);
    const count = countRow[0]?.count ?? 0;
    if (count > 0) {
      console.log(`   newsletter:${slug}  already has ${count} rows — skipping`);
      continue;
    }
    const fixtures = NEWSLETTER_FIXTURES[slug];
    for (const f of fixtures) {
      const createdAt = daysAgo(f.daysOld);
      await db.insert(newsletterSubscribers).values({
        email: f.email,
        firstName: f.firstName,
        lastName: f.lastName,
        source: f.source,
        confirmed: f.confirmed ?? false,
        confirmedAt: f.confirmedAt ?? null,
        unsubscribedAt: f.unsubscribedAt ?? null,
        createdAt,
        updatedAt: createdAt,
      });
    }
    console.log(`   newsletter:${slug}  ✓ ${fixtures.length} rows`);
  }
}

async function seedContacts() {
  const CONTACT_FIXTURES: Record<
    CompanySlug,
    Array<{
      name: string;
      email: string;
      phone?: string;
      subject?: string;
      message: string;
      status?: 'new' | 'read' | 'replied' | 'archived';
      daysOld: number;
    }>
  > = {
    cleanilo: [
      {
        name: 'Maria Klein',
        email: 'maria.klein@example.com',
        phone: '+49 30 12345678',
        subject: 'Reinigung für Büro',
        message:
          'Wir suchen eine wöchentliche Reinigung für unser Büro mit 6 Räumen in Berlin-Mitte. Können Sie ein Angebot zusenden?',
        status: 'new',
        daysOld: 1,
      },
      {
        name: 'Stefan Hoffmann',
        email: 'stefan@example.com',
        subject: 'Frage zu Endreinigung',
        message: 'Wir ziehen am 30.05. aus. Wie schnell könnten Sie eine Endreinigung durchführen?',
        status: 'read',
        daysOld: 3,
      },
      {
        name: 'Pia Werner',
        email: 'pia.werner@example.com',
        phone: '+49 89 98765432',
        message: 'Rückruf bitte zu allgemeinem Reinigungsvertrag.',
        status: 'replied',
        daysOld: 6,
      },
    ],
    hamburg_teppichreinigung: [
      {
        name: 'Familie Schulze',
        email: 'schulze@example.com',
        phone: '+49 40 11122233',
        subject: 'Wollteppich 4×3m',
        message:
          'Wir haben einen alten Wollteppich (ca. 4×3m), der eine professionelle Reinigung bräuchte. Kommen Sie vor Ort?',
        status: 'new',
        daysOld: 2,
      },
      {
        name: 'Hotel Alster',
        email: 'facility@hotel-alster.example',
        subject: 'Lobby-Teppiche · 6 Stück',
        message:
          'Wir benötigen ein Angebot für 6 Lobby-Teppiche (jeweils ca. 2×3m). Bitte um Vor-Ort-Termin.',
        status: 'replied',
        daysOld: 8,
      },
    ],
    teppichreinigen_lassen: [
      {
        name: 'Markus Vogel',
        email: 'markus.v@example.com',
        phone: '+49 89 55544433',
        subject: 'Hochflor-Teppich Abholung',
        message:
          'Können Sie diesen Hochflor-Teppich (ca. 2,5×3,5m) bei mir in Pasing abholen? Wann wäre der nächste Termin?',
        status: 'new',
        daysOld: 1,
      },
      {
        name: 'Kanzlei Weber',
        email: 'office@kanzlei-weber.example',
        subject: 'Büro-Auslegware',
        message:
          'Wir haben Auslegware in einem Konferenzraum (ca. 30m²), die gereinigt werden soll. Vor-Ort möglich?',
        status: 'read',
        daysOld: 4,
      },
    ],
  };

  for (const slug of COMPANY_SLUGS) {
    const { contactMessages } = getTenantTables(LEGACY_COMPANY_CONFIG[slug].schema);
    const countRow = await db.select({ count: sql<number>`count(*)::int` }).from(contactMessages);
    const count = countRow[0]?.count ?? 0;
    if (count > 0) {
      console.log(`   contacts:${slug}  already has ${count} rows — skipping`);
      continue;
    }
    const fixtures = CONTACT_FIXTURES[slug];
    for (const f of fixtures) {
      const createdAt = daysAgo(f.daysOld);
      await db.insert(contactMessages).values({
        name: f.name,
        email: f.email,
        phone: f.phone,
        subject: f.subject,
        message: f.message,
        status: f.status ?? 'new',
        consentPrivacy: true,
        consentMarketing: false,
        createdAt,
        updatedAt: createdAt,
      });
    }
    console.log(`   contacts:${slug}  ✓ ${fixtures.length} rows`);
  }
}

async function seedInquiries() {
  const INQUIRY_FIXTURES: Record<
    CompanySlug,
    Array<{
      name: string;
      email: string;
      phone?: string;
      service?: string;
      propertyDetails?: string;
      preferredDate?: string;
      budget?: string;
      message: string;
      status?: 'new' | 'in_review' | 'quoted' | 'won' | 'lost';
      quotedAmount?: string;
      metadata?: Record<string, unknown>;
      daysOld: number;
    }>
  > = {
    cleanilo: [
      {
        name: 'Anna Becker',
        email: 'anna.becker@example.com',
        phone: '+49 30 12345001',
        service: 'Hausreinigung',
        message: 'Wir brauchen eine wöchentliche Reinigung für unsere Praxis. 4 Räume, 2 Bäder.',
        preferredDate: daysFromNow(7),
        budget: '150–250 €/Termin',
        status: 'new',
        metadata: { area_m2: 85, rooms: 4, frequency: 'weekly', has_pets: false },
        daysOld: 1,
      },
      {
        name: 'Daniel Krüger',
        email: 'daniel.krueger@example.com',
        service: 'Endreinigung',
        message: 'Wohnungsübergabe nach Umzug. 3-Zimmer-Wohnung, alles muss raus aus dem Vertrag.',
        preferredDate: daysFromNow(3),
        status: 'in_review',
        metadata: { area_m2: 78, rooms: 3, frequency: 'one_time', balcony: true },
        daysOld: 2,
      },
      {
        name: 'Sabine Möller',
        email: 'sabine.moeller@example.com',
        phone: '+49 211 998877',
        service: 'Büroreinigung',
        message: 'Coworking-Bereich mit ca. 25 Arbeitsplätzen. 2× pro Woche.',
        status: 'quoted',
        quotedAmount: '320.00',
        metadata: { area_m2: 220, frequency: 'biweekly', workstations: 25 },
        daysOld: 5,
      },
      {
        name: 'Thomas Voss',
        email: 'thomas@example.com',
        service: 'Glasreinigung',
        message: 'Schaufensterfront 14m, einmalig zur Wiedereröffnung.',
        status: 'won',
        quotedAmount: '180.00',
        metadata: { area_m2: 14, frequency: 'one_time', window_height_m: 3.2 },
        daysOld: 12,
      },
    ],
    hamburg_teppichreinigung: [
      {
        name: 'Karin Roth',
        email: 'karin.roth@example.com',
        phone: '+49 40 22113344',
        service: 'Vor-Ort Reinigung',
        propertyDetails: 'Wohnzimmer, 1 Wollteppich + 2 Läufer.',
        message: 'Rotwein-Flecken auf dem großen Teppich, bitte vor Ort kommen.',
        preferredDate: daysFromNow(5),
        status: 'new',
        metadata: {
          carpet_size: '3x4 m',
          additional_pieces: 2,
          material: 'Wolle',
          service_mode: 'on_site',
          stain_type: 'Rotwein',
        },
        daysOld: 1,
      },
      {
        name: 'Hotel Alster',
        email: 'facility@hotel-alster.example',
        phone: '+49 40 999000',
        service: 'Auslegware Lobby',
        propertyDetails: 'Lobby-Bereich + Aufgang 1.OG.',
        message: 'Jährliche Tiefenreinigung der Lobby-Auslegware. Termin nachts möglich.',
        preferredDate: daysFromNow(10),
        budget: '1500–2500 €',
        status: 'quoted',
        quotedAmount: '1980.00',
        metadata: {
          carpet_size: 'ca. 120 m²',
          material: 'Synthetik',
          service_mode: 'on_site',
          night_slot: true,
        },
        daysOld: 6,
      },
      {
        name: 'Familie Wagner',
        email: 'wagner@example.com',
        service: 'Perserteppich Reinigung',
        message: 'Perser ca. 2×3m, älteres Stück, soll nicht ausbleichen.',
        status: 'in_review',
        metadata: {
          carpet_size: '2x3 m',
          material: 'Wolle/Seide',
          service_mode: 'on_site',
          age_years: 40,
        },
        daysOld: 3,
      },
    ],
    teppichreinigen_lassen: [
      {
        name: 'Markus Vogel',
        email: 'markus.v@example.com',
        phone: '+49 89 55544433',
        service: 'Abholservice',
        propertyDetails: '1 Hochflor-Teppich, Wohnzimmer.',
        message: 'Bitte abholen lassen und wieder zurückbringen.',
        preferredDate: daysFromNow(2),
        budget: '100–200 €',
        status: 'new',
        metadata: {
          carpet_dimensions: '2.5x3.5 m',
          material: 'Synthetik (Hochflor)',
          pickup_address: 'Pasinger Str. 12, 81245 München',
          earliest_pickup: daysFromNow(2),
        },
        daysOld: 1,
      },
      {
        name: 'Restaurant Olive',
        email: 'kontakt@olive-restaurant.example',
        service: 'Mehrere Läufer',
        propertyDetails: '3 Läufer aus Eingangsbereich + Gastraum.',
        message: 'Bitte komplett-Service mit Abholung. Schnellst möglich.',
        status: 'quoted',
        quotedAmount: '420.00',
        metadata: {
          carpet_dimensions: '3× ca. 1.5x4 m',
          material: 'Wolle',
          pickup_address: 'Schwanthalerstr. 88, 80336 München',
          urgent: true,
        },
        daysOld: 4,
      },
      {
        name: 'Sandra Lange',
        email: 'sandra.lange@example.com',
        service: 'Reinigung + Imprägnierung',
        message: 'Nach der Reinigung bitte auch imprägnieren lassen.',
        status: 'won',
        quotedAmount: '240.00',
        metadata: {
          carpet_dimensions: '2x3 m',
          material: 'Berber',
          pickup_address: 'Wallstr. 4, 80331 München',
          add_on: 'imprägnierung',
        },
        daysOld: 9,
      },
      {
        name: 'Jonas Bauer',
        email: 'jonas@example.com',
        service: 'Läufer-Reinigung',
        message: '2 Läufer für Flur, normal verschmutzt.',
        status: 'lost',
        metadata: {
          carpet_dimensions: '2× ca. 2x6 m',
          material: 'Synthetik',
          pickup_address: 'Bayerstr. 56, 80335 München',
        },
        daysOld: 14,
      },
    ],
  };

  for (const slug of COMPANY_SLUGS) {
    const { serviceInquiries } = getTenantTables(LEGACY_COMPANY_CONFIG[slug].schema);
    const countRow = await db.select({ count: sql<number>`count(*)::int` }).from(serviceInquiries);
    const count = countRow[0]?.count ?? 0;
    if (count > 0) {
      console.log(`   inquiries:${slug}  already has ${count} rows — skipping`);
      continue;
    }
    const fixtures = INQUIRY_FIXTURES[slug];
    for (const f of fixtures) {
      const createdAt = daysAgo(f.daysOld);
      await db.insert(serviceInquiries).values({
        name: f.name,
        email: f.email,
        phone: f.phone,
        service: f.service,
        propertyDetails: f.propertyDetails,
        preferredDate: f.preferredDate,
        budget: f.budget,
        message: f.message,
        status: f.status ?? 'new',
        quotedAmount: f.quotedAmount,
        quotedAt:
          f.status === 'quoted' || f.status === 'won' || f.status === 'lost'
            ? daysAgo(Math.max(0, f.daysOld - 1))
            : null,
        closedAt:
          f.status === 'won' || f.status === 'lost' ? daysAgo(Math.max(0, f.daysOld - 2)) : null,
        metadata: f.metadata ?? {},
        consentPrivacy: true,
        consentMarketing: false,
        createdAt,
        updatedAt: createdAt,
      });
    }
    console.log(`   inquiries:${slug}  ✓ ${fixtures.length} rows`);
  }
}

async function main() {
  const dataOnly = process.env.SEED_DATA_ONLY === '1';

  if (!dataOnly) {
    console.log('→ Ensuring per-company schemas…');
    await ensureSchemas();

    console.log('→ Seeding company registry…');
    await seedCompanies();

    console.log('→ Seeding users…');
    for (const seed of SEED_USERS) {
      const u = await ensureUser(seed);
      await ensureMemberships(u.id, seed);
      await ensureUserSettings(u.id);
      console.log(
        `   ✓ ${u.email}  (${seed.audience}/${seed.accessLevel}, ${Object.keys(seed.memberships).length} memberships)`,
      );
    }
  } else {
    console.log('→ SEED_DATA_ONLY=1 — skipping schema/company/user bootstrap');
  }

  console.log('→ Seeding sample newsletter subscribers…');
  await seedNewsletter();

  console.log('→ Seeding sample contact messages…');
  await seedContacts();

  console.log('→ Seeding sample service inquiries…');
  await seedInquiries();

  console.log('\nSeed complete.');
  if (!dataOnly) {
    console.log('\nLogin credentials (all share the same password for local dev):');
    for (const seed of SEED_USERS) {
      console.log(`   ${seed.email}  ·  ${seed.password}`);
    }
    console.log(
      "\nIf you haven't yet, run `pnpm run db:migrate` first to create the tenant tables.",
    );
  }
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
