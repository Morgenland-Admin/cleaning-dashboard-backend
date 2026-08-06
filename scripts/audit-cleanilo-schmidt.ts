/**
 * Read-only: can the flagged ambiguous name-match be corroborated by address or
 * invoice, as the import rules require? Looks up both CRM candidate emails in
 * every tenant (customers / inquiries / contact) and prints their addresses so
 * they can be compared with the address on the historical invoice.
 *
 *   DOTENV_CONFIG_PATH=.env.prod node --import tsx scripts/audit-cleanilo-schmidt.ts <email> [<email> …]
 */
import { sql } from 'drizzle-orm';

import { db } from '../src/db/index.ts';

async function q<T = Record<string, unknown>>(text: string): Promise<T[]> {
  const res = await db.execute(sql.raw(text));
  return (Array.isArray(res) ? res : (res as { rows: T[] }).rows) as T[];
}

async function main(): Promise<void> {
  const emails = process.argv.slice(2).map((e) => e.toLowerCase());
  if (emails.length === 0) {
    console.error('Usage: audit-cleanilo-schmidt.ts <email> [<email> …]');
    process.exit(1);
  }
  const list = emails.map((e) => `'${e.replace(/'/g, "''")}'`).join(',');
  const companies = await q<{ slug: string; schema_name: string }>(
    `select slug, schema_name from company order by slug`,
  );
  const L = console.log;

  for (const c of companies) {
    const tables = await q<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = '${c.schema_name}' order by table_name`,
    );
    const names = new Set(tables.map((t) => t.table_name));

    if (names.has('customers')) {
      const rows = await q(
        `select id, name, email, address_line1, postal_code, city, tags, created_at
           from "${c.schema_name}".customers where lower(email) in (${list})`,
      );
      for (const r of rows) L(`[${c.slug}.customers] ${JSON.stringify(r)}`);
    }
    for (const t of ['inquiries', 'contact_messages', 'orders', 'newsletter_subscribers']) {
      if (!names.has(t)) continue;
      const cols = await q<{ column_name: string }>(
        `select column_name from information_schema.columns
           where table_schema = '${c.schema_name}' and table_name = '${t}'`,
      );
      const has = new Set(cols.map((x) => x.column_name));
      const emailCol = ['email', 'customer_email'].find((x) => has.has(x));
      if (!emailCol) continue;
      const pick = [
        'id',
        has.has('name') ? 'name' : has.has('customer_name') ? 'customer_name' : null,
        emailCol,
        has.has('address_line1') ? 'address_line1' : null,
        has.has('postal_code')
          ? 'postal_code'
          : has.has('address_postal_code')
            ? 'address_postal_code'
            : null,
        has.has('city') ? 'city' : has.has('address_city') ? 'address_city' : null,
        'created_at',
      ]
        .filter(Boolean)
        .join(', ');
      const rows = await q(
        `select ${pick} from "${c.schema_name}"."${t}" where lower(${emailCol}) in (${list})`,
      );
      for (const r of rows) L(`[${c.slug}.${t}] ${JSON.stringify(r)}`);
    }
  }
  L('\n(done)');
  process.exit(0);
}

void main();
