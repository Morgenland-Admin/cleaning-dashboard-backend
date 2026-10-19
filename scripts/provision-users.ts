/**
 * Creates dashboard (audience `admin`) users + a membership on every brand. Existing emails are left untouched
 * (a re-run must never reset a password or downgrade an admin); `super_admin` is not accepted.
 * DOTENV_CONFIG_PATH=.env.prod node --import tsx scripts/provision-users.ts <users.json> [--commit]
 * The JSON (email, firstName, lastName, password, accessLevel) holds plaintext passwords: keep it out of the repo.
 */
import { readFileSync } from 'node:fs';

import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';

import { auth } from '../src/auth/index.ts';
import { db, pool } from '../src/db/index.ts';
import { account, company, membership, user, userSettings } from '../src/db/schema/shared.ts';

const ACCESS_TO_ROLE = {
  admin: 'admin',
  manager: 'manager',
  seo: 'viewer',
  viewer: 'viewer',
} as const;

const usersSchema = z
  .array(
    z.object({
      // better-auth lowercases on sign-in lookup, so a mixed-case row is unreachable.
      email: z
        .string()
        .email()
        .transform((e) => e.trim().toLowerCase()),
      firstName: z.string().trim().min(1),
      lastName: z.string().trim().min(1),
      password: z.string().min(8).max(128),
      accessLevel: z.enum(['admin', 'manager', 'seo', 'viewer']),
    }),
  )
  .min(1);

async function main(): Promise<void> {
  const [jsonPath, ...flags] = process.argv.slice(2);
  if (!jsonPath) {
    console.error('Usage: provision-users.ts <users.json> [--commit]');
    process.exit(1);
  }
  const commit = flags.includes('--commit');
  const users = usersSchema.parse(JSON.parse(readFileSync(jsonPath, 'utf8')));
  const brands = await db.select({ slug: company.slug }).from(company);
  const L = console.log;

  L(`\n${commit ? 'APPLYING' : 'DRY RUN —'} ${users.length} user(s) × ${brands.length} brand(s)`);
  L(`brands: ${brands.map((b) => b.slug).join(', ')}\n`);

  for (const u of users) {
    const [existing] = await db
      .select({ id: user.id, accessLevel: user.accessLevel })
      .from(user)
      .where(eq(user.email, u.email))
      .limit(1);
    if (existing) {
      L(`   = ${u.email} exists (accessLevel ${existing.accessLevel}) — skipped, nothing changed`);
      continue;
    }
    const role = ACCESS_TO_ROLE[u.accessLevel];
    if (!commit) {
      L(`   + ${u.email} → accessLevel ${u.accessLevel}, membership role ${role} on all brands`);
      continue;
    }

    const id = nanoid();
    const hashed = await auth.$context.then((ctx) => ctx.password.hash(u.password));
    await db.transaction(async (tx) => {
      await tx.insert(user).values({
        id,
        name: `${u.firstName} ${u.lastName}`,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        audience: 'admin',
        accessLevel: u.accessLevel,
        emailVerified: true,
        isActive: true,
      });
      await tx.insert(account).values({
        id: nanoid(),
        userId: id,
        providerId: 'credential',
        accountId: id,
        password: hashed,
      });
      await tx.insert(userSettings).values({ userId: id }).onConflictDoNothing();
      for (const b of brands) {
        await tx
          .insert(membership)
          .values({ userId: id, companySlug: b.slug, role, acceptedAt: new Date() })
          .onConflictDoNothing();
      }
    });
    L(`   ✓ created ${u.email} (${u.accessLevel}) + ${brands.length} membership(s)`);
  }

  if (!commit) L('\nNothing written. Re-run with --commit to apply.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
