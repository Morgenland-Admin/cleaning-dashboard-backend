/**
 * Imports the retired CLEANILO system (read-only JSONL snapshot of `dbcleanilo_admin` + `dbcleanilo`)
 * into the cleanilo tenant. Every raw row goes to `legacy_records`; customers, orders, inquiries,
 * contact messages, newsletter sign-ups and partner applications are also mapped to real tables.
 *
 * Dry run by default (prints the plan against the target DB). `--commit` writes rows directly — never
 * through the API — so no mail, invoice, partner dispatch or callback fires. Re-runnable: rows that
 * were already imported are skipped, so a dropped connection is fixed by running it again.
 *
 *   node --import tsx scripts/import-cleanilo-legacy.ts [--snapshot <dir>] [--commit]
 *   DOTENV_CONFIG_PATH=.env.prod node --import tsx scripts/import-cleanilo-legacy.ts --commit
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db, pool } from '../src/db/index.ts';
import { membership, user } from '../src/db/schema/shared.ts';
import { createTenantSchemaSql, getTenantTables } from '../src/db/schema/tenant.ts';
import { recomputeCustomerAggregates } from '../src/lib/customer-stats.ts';
import { haversineKm } from '../src/lib/geo.ts';
import { PLZ_CENTROIDS } from '../src/lib/plz-centroids.generated.ts';
import { attachLegacyPartnerChat, legacyAttachments } from '../src/modules/legacy/partner-chat.ts';

const TENANT = 'cleanilo';
const SOURCE = 'import_legacy_cleanilo';
const TAG = 'altsystem';
const PLACEHOLDER_DOMAIN = 'import.cleanilo.local';
const SOURCES: Record<string, string> = {
  dbcleanilo_admin: 'cleanilo_ops',
  dbcleanilo: 'cleanilo_cms',
};
// PostGIS reference data, not CLEANILO data.
const SKIP_TABLES = new Set(['spatial_ref_sys']);
// Credentials and token hashes are never copied into the new system.
const SECRET_KEY = /pass(word)?|token|secret|salt|access_?key|api_?key/i;

type Row = Record<string, unknown>;
type Snapshot = Record<string, Record<string, Row[]>>;

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const snapshotArg = args.indexOf('--snapshot');
const SNAPSHOT_DIR =
  snapshotArg >= 0
    ? args[snapshotArg + 1]!
    : path.join(os.homedir(), '.local/share/cleanilo-legacy-snapshot-2026-10-29/json');

// ── helpers ──────────────────────────────────────────────────────────────────────────────────

const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};
const lowerEmail = (v: unknown): string | null => {
  const s = str(v)?.toLowerCase() ?? null;
  return s && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : null;
};
const date = (v: unknown): Date | null => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};
const berlin = (d: Date | null) =>
  d
    ? d.toLocaleString('de-DE', {
        timeZone: 'Europe/Berlin',
        dateStyle: 'short',
        timeStyle: 'short',
      })
    : '';
const euro = (v: unknown) =>
  typeof v === 'number'
    ? `${v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
    : (str(v) ?? '–');
const sha = (s: string, n = 10) => createHash('sha1').update(s).digest('hex').slice(0, n);

/** "+49 170 …", "0170…", "0049…" → "49170…" so phones from different tables match. */
export function normPhone(v: unknown): string | null {
  let d = str(v)?.replace(/\D/g, '') ?? '';
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = `49${d.slice(1)}`;
  return d.length >= 8 ? d : null;
}

/** "20457||hamburg" (legacy inquiry form) → { plz: "20457", region: "hamburg" }. */
export function splitZip(v: unknown): { plz: string | null; region: string | null } {
  const [zip, region] = (str(v) ?? '').split('||');
  const plz = zip?.trim().match(/^\d{5}$/) ? zip.trim() : null;
  return { plz, region: str(region) };
}

/** The old system stored points as (lat, lng) in PostGIS's (x, y) order; Germany has lat > lng. */
export function fixLatLng(y: unknown, x: unknown): { lat: number; lng: number } | null {
  if (typeof y !== 'number' || typeof x !== 'number') return null;
  return y > x ? { lat: y, lng: x } : { lat: x, lng: y };
}

export function nearestPlz(y: unknown, x: unknown): string | null {
  const point = fixLatLng(y, x);
  if (!point) return null;
  const { lat, lng } = point;
  let best: string | null = null;
  let bestKm = Infinity;
  for (const [plz, [plat, plng]] of Object.entries(PLZ_CENTROIDS)) {
    const km = haversineKm({ lat, lng }, { lat: plat, lng: plng });
    if (km < bestKm) [best, bestKm] = [plz, km];
  }
  return bestKm <= 30 ? best : null;
}

const stripSecrets = (row: Row): Row =>
  Object.fromEntries(Object.entries(row).filter(([k]) => !SECRET_KEY.test(k)));

/** Stable key per source row: its id, the phone primary key of clients/partners, else a content hash. */
export function legacyIdOf(table: string, row: Row): string {
  if (row.id != null) return String(row.id);
  if (table === 'cleanilo_client' || table === 'cleanilo_partner') return String(row.phone);
  if (table === 'last_seen_admin_table') return `${row.entity_type_id}:${row.entity_id}`;
  return `h:${sha(JSON.stringify(row), 24)}`;
}

const legacyCreatedAt = (row: Row) =>
  date(row.created_at) ?? date(row.createdAt) ?? date(row.published_at) ?? null;

function loadSnapshot(dir: string): Snapshot {
  if (!existsSync(dir)) throw new Error(`Snapshot not found: ${dir}`);
  const out: Snapshot = {};
  for (const db of Object.keys(SOURCES)) {
    out[db] = {};
    for (const file of readdirSync(path.join(dir, db))) {
      if (!file.endsWith('.jsonl')) continue;
      const table = file.slice(0, -'.jsonl'.length);
      if (SKIP_TABLES.has(table)) continue;
      out[db]![table] = readFileSync(path.join(dir, db, file), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Row);
    }
  }
  return out;
}

const legacyRef = (db: string, table: string, row: Row) => ({
  source: SOURCES[db],
  table,
  id: legacyIdOf(table, row),
});

// ── plan ─────────────────────────────────────────────────────────────────────────────────────

export function buildPlan(snap: Snapshot) {
  const ops = snap.dbcleanilo_admin!;
  const cms = snap.dbcleanilo!;
  const t = (src: Record<string, Row[]>, name: string) => src[name] ?? [];

  const services = new Map(
    t(ops, 'cleanilo_service').map((s) => [
      s.id as number,
      { name: str(s.name), slug: str(s.slug) },
    ]),
  );
  const reports = new Map(t(ops, 'order_report').map((r) => [r.orderId as number, r]));

  // Clients have no email; take one from their orders, then from other forms with the same phone.
  const emailByPhone = new Map<string, string>();
  const learn = (phone: unknown, email: unknown) => {
    const p = normPhone(phone);
    const e = lowerEmail(email);
    if (p && e && !emailByPhone.has(p)) emailByPhone.set(p, e);
  };
  const byNewest = (rows: Row[]) =>
    [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  for (const o of byNewest(t(ops, 'cleanilo_orders'))) learn(o.clientPhone, o.email);
  for (const i of byNewest(t(ops, 'inquiry'))) learn(i.phone, i.email);
  for (const b of byNewest(t(cms, 'bookings'))) learn(b.phone, b.email);
  for (const c of byNewest(t(cms, 'contact_requests'))) learn(c.phone, c.email);

  // Same address the client's customer row gets, so chats and customer stay linked.
  const clientEmail = (rawPhone: unknown) => {
    const phone = normPhone(rawPhone);
    return (
      (phone && emailByPhone.get(phone)) ??
      `altkunde-${sha(phone ?? String(rawPhone))}@${PLACEHOLDER_DOMAIN}`
    );
  };
  const clientName = new Map(t(ops, 'cleanilo_client').map((c) => [String(c.phone), str(c.name)]));
  const partnerName = new Map(
    t(ops, 'cleanilo_partner').map((p) => [
      String(p.phone),
      str(p.name) ?? [p.first_name, p.last_name].map(str).filter(Boolean).join(' '),
    ]),
  );

  const archive = Object.entries(snap).flatMap(([dbName, tables]) =>
    Object.entries(tables).flatMap(([table, rows]) =>
      rows.map((row) => ({
        source: SOURCES[dbName]!,
        legacyTable: table,
        legacyId: legacyIdOf(table, row),
        data: stripSecrets(row),
        legacyCreatedAt: legacyCreatedAt(row),
      })),
    ),
  );

  const customers = t(ops, 'cleanilo_client').map((c) => {
    const email = clientEmail(c.phone);
    return {
      email,
      placeholder: email.endsWith(`@${PLACEHOLDER_DOMAIN}`),
      name: str(c.name),
      phone: str(c.phone),
      createdAt: date(c.created_at) ?? new Date(),
    };
  });

  const orders = t(ops, 'cleanilo_orders').map((o) => {
    const svc = services.get(o.cleaniloServiceId as number);
    const slug =
      svc?.slug ?? str(o.service_category)?.toLowerCase().replace(/\s+/g, '-') ?? 'sonstiges';
    const report = reports.get(o.id as number);
    // before_price = what the customer paid; after_price is net of the partner commission.
    const totalCents =
      report && typeof report.before_price === 'number' ? Math.round(report.before_price * 100) : 0;
    const done = o.status === 'COMPLETED';
    const statusLog = (o.statusLog ?? {}) as Record<string, unknown>;
    const updated = date(o.updated_at) ?? date(o.created_at) ?? new Date();
    const address = (o.address ?? {}) as Record<string, unknown>;
    const firstDate = date(((o.date_of_service as unknown[]) ?? [])[0]);
    return {
      legacyId: String(o.id),
      orderNumber: `ALT-${o.id}`,
      kind: slug.length <= 32 ? slug : slug.slice(0, slug.lastIndexOf('-', 32)),
      status: done ? 'completed' : 'cancelled',
      customerName: str(o.name) ?? 'Unbekannt',
      customerEmail: lowerEmail(o.email) ?? `altauftrag-${o.id}@${PLACEHOLDER_DOMAIN}`,
      customerPhone: str(o.clientPhone),
      addressLine1: str(address.address),
      addressPostalCode: str(address.zip_code)?.slice(0, 16) ?? null,
      preferredDate: firstDate ? firstDate.toISOString().slice(0, 10) : null,
      customerNotes: str(o.note),
      subtotalCents: totalCents,
      totalCents,
      // Only completed jobs with a known final price count as paid history (customer totals).
      paidAt: done && totalCents > 0 ? (date(statusLog.paymentPendingToAccepted) ?? updated) : null,
      completedAt: done ? (date(statusLog.acceptedToCompleted) ?? updated) : null,
      cancelledAt: done ? null : updated,
      internalNotes: `Aus dem alten CLEANILO-System übernommen (Status dort: ${o.status}).`,
      createdAt: date(o.created_at) ?? updated,
      updatedAt: updated,
      metadata: {
        legacy: { ...legacyRef('dbcleanilo_admin', 'cleanilo_orders', o), status: o.status },
        serviceSlug: svc?.slug ?? null,
        serviceName: svc?.name ?? str(o.service_category),
        region: str(o.region),
        fullAddress: str(address.full_address),
        datesOfService: o.date_of_service ?? [],
        details: o.orderRecord ?? {},
        qna: o.qna ?? [],
        legacyAttachments: o.attachments ?? [],
        assignedPartnerPhone: str(o.assignedPartnerPhone),
        stripePaymentIntentId: str(o.stripe_payment_intent_id),
        ...(report ? { report: stripSecrets(report) } : {}),
      },
    };
  });

  type Inquiry = {
    ref: ReturnType<typeof legacyRef>;
    name: string;
    email: string | null;
    phone: string | null;
    plz: string | null;
    service: string | null;
    message: string;
    createdAt: Date;
    metadata: Row;
  };
  const inquiry = (
    db: string,
    table: string,
    row: Row,
    fields: Omit<Inquiry, 'ref' | 'createdAt' | 'metadata'>,
    extra: Row = {},
  ): Inquiry => ({
    ref: legacyRef(db, table, row),
    ...fields,
    createdAt: legacyCreatedAt(row) ?? new Date(),
    metadata: { legacy: legacyRef(db, table, row), ...extra },
  });
  const join = (...parts: unknown[]) =>
    parts.map(str).filter(Boolean).join('\n\n') || '(keine Nachricht)';

  const inquiries: Inquiry[] = [
    ...t(ops, 'inquiry').map((i) => {
      const svc = services.get(i.serviceId as number);
      const { plz, region } = splitZip(i.zip_code);
      return inquiry(
        'dbcleanilo_admin',
        'inquiry',
        i,
        {
          name: str(i.name) ?? 'Unbekannt',
          email: lowerEmail(i.email),
          phone: str(i.phone),
          plz,
          service: svc?.name ?? null,
          message: join(i.message),
        },
        {
          serviceSlug: svc?.slug ?? null,
          region,
          company: str(i.company),
          legacyAttachments: i.attachments ?? [],
        },
      );
    }),
    ...t(cms, 'bookings').map((b) =>
      inquiry(
        'dbcleanilo',
        'bookings',
        b,
        {
          name: str(b.name) ?? 'Unbekannt',
          email: lowerEmail(b.email),
          phone: str(b.phone),
          plz: splitZip(b.postal).plz,
          service: str(b.service),
          message: join(
            b.description,
            b.booking_detail && JSON.stringify(b.booking_detail),
            b.drop_down_selection && JSON.stringify(b.drop_down_selection),
          ),
        },
        { company: str(b.company) },
      ),
    ),
    ...['booking_services', 'service_quotations', 'fleckens', 'polsterreinigungs'].flatMap(
      (table) =>
        t(cms, table).map((r) =>
          inquiry(
            'dbcleanilo',
            table,
            r,
            {
              name: str(r.name) ?? 'Unbekannt',
              email: lowerEmail(r.email),
              phone: str(r.phone) ?? str(r.number),
              plz: null,
              service: str(r.service),
              message: join(
                r.description,
                r.booking_detail && JSON.stringify(r.booking_detail),
                r.location && `Ort: ${str(r.location)}`,
                r.quantity && `Menge: ${JSON.stringify(r.quantity)}`,
                r.pricing && `Preis: ${JSON.stringify(r.pricing)}`,
                (r.booking_date_time ?? r.datetime) &&
                  `Wunschtermin: ${str(r.booking_date_time ?? r.datetime)}`,
              ),
            },
            { company: str(r.company) },
          ),
        ),
    ),
  ];

  const contacts = t(cms, 'contact_requests').flatMap((c) => {
    const email = lowerEmail(c.email);
    if (!email) return [];
    return [
      {
        ref: legacyRef('dbcleanilo', 'contact_requests', c),
        subject: 'Kontaktanfrage (altes System)',
        name: str(c.name) ?? 'Unbekannt',
        email,
        phone: str(c.phone),
        message: join(c.description),
        createdAt: legacyCreatedAt(c) ?? new Date(),
        updatedAt: legacyCreatedAt(c) ?? new Date(),
      },
    ];
  });

  // Old chats with a client become one contact message per conversation, full transcript inside.
  const groupBy = (rows: Row[], key: (r: Row) => string) => {
    const out = new Map<string, Row[]>();
    for (const r of rows) out.set(key(r), [...(out.get(key(r)) ?? []), r]);
    return out;
  };
  const chatThread = (
    table: string,
    id: string,
    clientPhone: unknown,
    subject: string,
    rows: Row[],
    who: (m: Row) => string,
  ) => {
    const sorted = [...rows].sort((a, b) =>
      String(a.created_at).localeCompare(String(b.created_at)),
    );
    const lines = sorted.map((m) => {
      const files = legacyAttachments(m.attachment);
      return `${berlin(date(m.created_at))} · ${who(m)}: ${str(m.message) ?? ''}${files.length ? ` [Anhang: ${files.join(', ')}]` : ''}`;
    });
    const first = date(sorted[0]?.created_at) ?? new Date();
    const last = date(sorted.at(-1)?.created_at) ?? first;
    return {
      ref: { source: SOURCES.dbcleanilo_admin, table, id },
      subject,
      name: clientName.get(String(clientPhone)) ?? 'Unbekannt',
      email: clientEmail(clientPhone),
      phone: str(clientPhone),
      message: `Chat im alten CLEANILO-System (${sorted.length} Nachrichten)\n\n${lines.join('\n')}`,
      createdAt: first,
      updatedAt: last,
    };
  };
  const chats = [
    ...[...groupBy(t(ops, 'admin_client_chat'), (m) => String(m.clientPhone))].map(
      ([phone, rows]) =>
        chatThread(
          'admin_client_chat',
          `client:${phone}`,
          phone,
          'Chat mit CLEANILO (altes System)',
          rows,
          (m) => (m.owner === 'ADMIN' ? 'CLEANILO' : 'Kunde'),
        ),
    ),
    ...[...groupBy(t(ops, 'client_partner_chat'), (m) => `${m.clientPhone}|${m.partnerPhone}`)].map(
      ([pair, rows]) => {
        const [clientPhone, partnerPhone] = pair.split('|');
        const partner = partnerName.get(partnerPhone!) || partnerPhone;
        return chatThread(
          'client_partner_chat',
          `pair:${clientPhone}:${partnerPhone}`,
          clientPhone,
          'Chat Kunde ↔ Partner (altes System)',
          rows,
          (m) => (m.owner === 'PARTNER' ? `Partner (${partner})` : 'Kunde'),
        );
      },
    ),
  ];

  // Partner bids go into the matching order's internal notes.
  const bidNotes = [...groupBy(t(ops, 'cleanilo_order_bids'), (b) => String(b.orderId))].map(
    ([orderId, rows]) => {
      const bids = [...rows]
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .map((b) => ({
          partner: partnerName.get(String(b.partnerPhone)) || str(b.partnerPhone),
          amount: b.amount,
          selected: !!b.selected,
          note: str(b.note),
          createdAt: str(b.created_at),
          serviceDate: b.service_date ?? null,
        }));
      const block = [
        'Angebote im alten System:',
        ...bids.map(
          (b) =>
            `- ${b.partner}: ${euro(b.amount)}${b.selected ? ' (ausgewählt)' : ''} · ${berlin(date(b.createdAt))}${b.note ? ` – ${b.note}` : ''}`,
        ),
      ].join('\n');
      return { legacyOrderId: orderId, bids, block };
    },
  );

  const newsletterSeen = new Set<string>();
  const oldestFirst = (rows: Row[]) =>
    [...rows].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const newsletter = oldestFirst(t(cms, 'newsletters')).flatMap((n) => {
    const email = lowerEmail(n.email);
    if (!email || newsletterSeen.has(email)) return [];
    newsletterSeen.add(email);
    return [{ email, createdAt: legacyCreatedAt(n) ?? new Date() }];
  });

  const servicesByPartner = new Map<string, string[]>();
  for (const m of t(ops, 'partner_service_mapper')) {
    const slug = services.get(m.cleaniloServiceId as number)?.slug;
    if (!slug) continue;
    const key = String(m.cleaniloPartnerPhone);
    servicesByPartner.set(key, [...(servicesByPartner.get(key) ?? []), slug]);
  }
  const partners = t(ops, 'cleanilo_partner').flatMap((p) => {
    const email = lowerEmail(p.business_email) ?? lowerEmail(p.email);
    if (!email) return [];
    const person = [p.first_name, p.middle_name, p.last_name].map(str).filter(Boolean).join(' ');
    return [
      {
        email,
        companyName: str(p.name) ?? person ?? email,
        contactName: person || str(p.name) || email,
        phone: str(p.business_phone) ?? str(p.phone),
        websiteUrl: str(p.business_website),
        postalCode: nearestPlz(p.__location_lat, p.__location_lng) ?? '00000',
        city: str(p.region),
        services: [...new Set(servicesByPartner.get(String(p.phone)) ?? [])],
        message: `Bestandspartner aus dem alten CLEANILO-System (verifiziert: ${p.is_verified ? 'ja' : 'nein'}, Stripe Connect: ${p.stripe_connect_verified ? 'verifiziert' : 'nein'}). Dokumente und Verlauf: Altdaten › cleanilo_partner ${p.phone}.`,
        createdAt: legacyCreatedAt(p) ?? new Date(),
        account: {
          firstName: str(p.first_name),
          lastName: str(p.last_name),
          legacyPhone: str(p.phone),
          point: fixLatLng(p.__location_lat, p.__location_lng),
          notes: [
            'Aus dem alten CLEANILO-System übernommen (Login dort per SMS; Passwort über „Passwort vergessen“ setzen).',
            `Im alten System verifiziert: ${p.is_verified ? 'ja' : 'nein'}; Stripe Connect: ${p.stripe_connect_verified ? 'verifiziert' : 'nein'}${str(p.stripe_connect_id) ? ` (${str(p.stripe_connect_id)})` : ''}.`,
            `Dokumente (Versicherung, Gewerbe, Vertrag …) und Verlauf: Altdaten › cleanilo_partner ${str(p.phone)}.`,
          ].join('\n'),
        },
      },
    ];
  });

  return {
    archive,
    customers,
    orders,
    inquiries,
    contacts: [...contacts, ...chats],
    chatThreads: chats.length,
    newsletter,
    partners,
    bidNotes,
  };
}

type Plan = ReturnType<typeof buildPlan>;

// ── run ──────────────────────────────────────────────────────────────────────────────────────

async function chunked<T>(rows: T[], size: number, fn: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

async function existingLegacyIds(table: 'orders' | 'serviceInquiries' | 'contactMessages') {
  const tables = getTenantTables(TENANT);
  const tbl = tables[table];
  const rows = await db
    .select({
      ref: sql<string>`${tbl.metadata}->'legacy'->>'source' || ':' || (${tbl.metadata}->'legacy'->>'table') || ':' || (${tbl.metadata}->'legacy'->>'id')`,
    })
    .from(tbl)
    .where(eq(tbl.source, SOURCE));
  return new Set(rows.map((r) => r.ref));
}
const refKey = (r: { source?: string; table: string; id: string }) =>
  `${r.source}:${r.table}:${r.id}`;

async function report(plan: Plan) {
  const tables = getTenantTables(TENANT);
  const emails = [...new Set(plan.customers.map((c) => c.email))];
  const existingCustomers = new Set<string>();
  await chunked(emails, 500, async (chunk) => {
    const rows = await db
      .select({ email: tables.customers.email })
      .from(tables.customers)
      .where(inArray(tables.customers.email, chunk));
    rows.forEach((r) => existingCustomers.add(r.email));
  });
  const [doneOrders, doneInquiries, doneContacts] = await Promise.all([
    existingLegacyIds('orders').catch(() => new Set<string>()),
    existingLegacyIds('serviceInquiries').catch(() => new Set<string>()),
    existingLegacyIds('contactMessages').catch(() => new Set<string>()),
  ]);
  const archiveDone = await db
    .execute(sql`select count(*)::int as n from ${sql.identifier(TENANT)}."legacy_records"`)
    .then((r) => (r.rows[0] as { n: number }).n)
    .catch(() => 0);

  const byTable = new Map<string, number>();
  for (const a of plan.archive)
    byTable.set(
      `${a.source}.${a.legacyTable}`,
      (byTable.get(`${a.source}.${a.legacyTable}`) ?? 0) + 1,
    );
  const count = <T>(rows: T[], f: (r: T) => boolean) => rows.filter(f).length;

  console.log(
    `\nCLEANILO legacy import — ${COMMIT ? 'COMMIT' : 'dry run'} into tenant "${TENANT}"`,
  );
  console.log(`Snapshot: ${SNAPSHOT_DIR}\n`);
  console.log(
    `Archive (legacy_records): ${plan.archive.length} rows in ${byTable.size} tables; already imported: ${archiveDone}`,
  );
  console.log(
    `Customers from old clients: ${plan.customers.length} (real email ${count(plan.customers, (c) => !c.placeholder)}, placeholder ${count(plan.customers, (c) => c.placeholder)}); already exist in target: ${count(plan.customers, (c) => existingCustomers.has(c.email))} (only empty fields filled)`,
  );
  console.log(
    `Orders: ${plan.orders.length} (completed ${count(plan.orders, (o) => o.status === 'completed')}, cancelled ${count(plan.orders, (o) => o.status === 'cancelled')}, counted as paid ${count(plan.orders, (o) => o.paidAt != null)}); already imported: ${count(plan.orders, (o) => doneOrders.has(refKey(o.metadata.legacy)))}`,
  );
  console.log(
    `Inquiries (closed as "lost"): ${plan.inquiries.length} (without email ${count(plan.inquiries, (i) => !i.email)}, with PLZ ${count(plan.inquiries, (i) => !!i.plz)}); already imported: ${count(plan.inquiries, (i) => doneInquiries.has(refKey(i.ref)))}`,
  );
  console.log(
    `Contact messages (archived): ${plan.contacts.length} incl. ${plan.chatThreads} old chat conversations; already imported: ${count(plan.contacts, (c) => doneContacts.has(refKey(c.ref)))}`,
  );
  console.log(`Orders with old partner bids added to their notes: ${plan.bidNotes.length}`);
  console.log(`Newsletter (unconfirmed, never mailed): ${plan.newsletter.length} distinct emails`);
  console.log(
    `Partner applications (status "new"): ${plan.partners.length} (PLZ from location ${count(plan.partners, (p) => p.postalCode !== '00000')})`,
  );
  console.log('\nArchive rows per table:');
  for (const [k, n] of [...byTable].sort()) console.log(`  ${k.padEnd(64)} ${n}`);
}

/**
 * Old partners become pending portal partners: a partner login without password (they use
 * "Passwort vergessen"), the brand membership and a partners row, plus their old admin chat.
 * No email is sent. Partners whose email already has a login are left as they are.
 */
async function promotePartners(plan: Plan) {
  const T = getTenantTables(TENANT);
  const apps = await db
    .select()
    .from(T.partnerApplications)
    .where(and(eq(T.partnerApplications.source, SOURCE), eq(T.partnerApplications.status, 'new')));
  // Every old company folded into this login (same email), by its old phone key.
  const legacyPhonesFor = (email: string) =>
    plan.partners
      .filter((p) => p.email === email.toLowerCase() && p.account.legacyPhone)
      .map((p) => p.account.legacyPhone!);
  let created = 0;
  let chats = 0;
  const skipped: string[] = [];
  for (const app of apps) {
    const legacy = plan.partners.find((p) => p.email === app.email);
    const [existing] = await db
      .select({ id: user.id, audience: user.audience })
      .from(user)
      .where(sql`lower(${user.email}) = ${app.email.toLowerCase()}`)
      .limit(1);
    const now = new Date();
    if (existing) {
      const [partnerRow] = await db
        .select({ id: T.partners.id })
        .from(T.partners)
        .where(eq(T.partners.userId, existing.id))
        .limit(1);
      if (partnerRow) {
        // A second old company with the same email: note it on the partner created first.
        await db
          .update(T.partners)
          .set({
            internalNotes: sql`coalesce(${T.partners.internalNotes} || ${'\n'}, '') || ${`Weitere Firma im alten System mit derselben E-Mail: ${app.companyName}.`}`,
          })
          .where(
            and(
              eq(T.partners.id, partnerRow.id),
              sql`coalesce(${T.partners.internalNotes}, '') not like ${`%derselben E-Mail: ${app.companyName}.%`}`,
            ),
          );
        await db
          .update(T.partnerApplications)
          .set({ status: 'invited', invitedAt: now, updatedAt: now })
          .where(eq(T.partnerApplications.id, app.id));
      } else {
        skipped.push(
          `${app.companyName} (Login mit dieser E-Mail existiert bereits, Typ ${existing.audience})`,
        );
      }
      continue;
    }
    const userId = nanoid();
    await db.transaction(async (tx) => {
      await tx.insert(user).values({
        id: userId,
        name: app.contactName,
        email: app.email,
        firstName: legacy?.account.firstName ?? null,
        lastName: legacy?.account.lastName ?? null,
        audience: 'partner',
        accessLevel: 'none',
        emailVerified: true,
        isActive: true,
        createdAt: app.createdAt,
      });
      await tx
        .insert(membership)
        .values({ userId, companySlug: TENANT, role: 'partner', acceptedAt: now })
        .onConflictDoNothing();
      await tx.insert(T.partners).values({
        userId,
        companyName: app.companyName,
        contactEmail: app.email,
        contactPhone: app.phone,
        websiteUrl: app.websiteUrl,
        city: app.city,
        postalCode: app.postalCode === '00000' ? null : app.postalCode,
        lat: legacy?.account.point?.lat ?? null,
        lng: legacy?.account.point?.lng ?? null,
        services: app.services,
        status: 'pending',
        internalNotes: legacy?.account.notes ?? null,
        createdAt: app.createdAt,
      });
      await tx
        .update(T.partnerApplications)
        .set({ status: 'invited', invitedAt: now, updatedAt: now })
        .where(eq(T.partnerApplications.id, app.id));
    });
    created += 1;
    chats += await attachLegacyPartnerChat(T, { userId, legacyPhones: legacyPhonesFor(app.email) });
  }
  // Partners created by an earlier run: attach is a no-op once their old chat is there.
  const earlier = await db
    .select({
      userId: T.partners.userId,
      email: T.partners.contactEmail,
      phone: T.partners.contactPhone,
    })
    .from(T.partners)
    .where(sql`${T.partners.internalNotes} like 'Aus dem alten CLEANILO-System übernommen%'`);
  for (const p of earlier) {
    chats += await attachLegacyPartnerChat(T, {
      userId: p.userId,
      legacyPhones: legacyPhonesFor(p.email ?? ''),
    });
  }
  console.log(
    `partners: ${created} pending partner logins created, ${chats} old chat messages attached`,
  );
  for (const s of skipped) console.log(`  skipped: ${s}`);
}

async function commit(plan: Plan) {
  const T = getTenantTables(TENANT);
  // Creates legacy_records if the deployed backend has not yet, and is idempotent otherwise.
  await db.execute(sql.raw(createTenantSchemaSql(TENANT)));

  await chunked(plan.archive, 1000, (chunk) =>
    db.insert(T.legacyRecords).values(chunk).onConflictDoNothing(),
  );
  console.log(`archive: ${plan.archive.length} rows written or already present`);

  await chunked(plan.customers, 500, (chunk) =>
    db
      .insert(T.customers)
      .values(
        chunk.map((c) => ({
          email: c.email,
          name: c.name,
          phone: c.phone,
          tags: [TAG],
          marketingOptIn: false,
          internalNotes: 'Aus dem alten CLEANILO-System übernommen.',
          createdAt: c.createdAt,
          updatedAt: c.createdAt,
        })),
      )
      .onConflictDoNothing(),
  );
  // Existing customers keep their data; only blanks are filled.
  for (const c of plan.customers) {
    await db
      .update(T.customers)
      .set({
        phone: sql`coalesce(${T.customers.phone}, ${c.phone})`,
        name: sql`coalesce(nullif(${T.customers.name}, ''), ${c.name})`,
      })
      .where(eq(T.customers.email, c.email));
  }
  console.log(`customers: ${plan.customers.length} upserted (blanks filled only)`);

  const doneOrders = await existingLegacyIds('orders');
  const newOrders = plan.orders.filter((o) => !doneOrders.has(refKey(o.metadata.legacy)));
  await chunked(newOrders, 200, (chunk) =>
    db.insert(T.orders).values(
      chunk.map(({ legacyId: _id, ...o }) => ({
        ...o,
        publicToken: randomBytes(24).toString('base64url'),
        pickupMode: 'onsite',
        addressCountry: 'DE',
        source: SOURCE,
        consentPrivacy: false,
        consentMarketing: false,
      })),
    ),
  );
  console.log(
    `orders: ${newOrders.length} inserted, ${plan.orders.length - newOrders.length} already present`,
  );

  // Appends once: orders whose notes already carry the bids (or were edited to) are left alone.
  for (const b of plan.bidNotes) {
    await db
      .update(T.orders)
      .set({
        internalNotes: sql`coalesce(${T.orders.internalNotes} || ${'\n\n'}, '') || ${b.block}`,
        metadata: sql`${T.orders.metadata} || ${JSON.stringify({ bids: b.bids })}::jsonb`,
      })
      .where(
        and(
          eq(T.orders.source, SOURCE),
          sql`${T.orders.metadata}->'legacy'->>'table' = 'cleanilo_orders'`,
          sql`${T.orders.metadata}->'legacy'->>'id' = ${b.legacyOrderId}`,
          sql`coalesce(${T.orders.internalNotes}, '') not like '%Angebote im alten System:%'`,
        ),
      );
  }
  console.log(`order notes: bids added to up to ${plan.bidNotes.length} orders`);

  const doneInquiries = await existingLegacyIds('serviceInquiries');
  const newInquiries = plan.inquiries.filter((i) => !doneInquiries.has(refKey(i.ref)));
  await chunked(newInquiries, 200, (chunk) =>
    db.insert(T.serviceInquiries).values(
      chunk.map((i) => ({
        name: i.name,
        email: i.email,
        phone: i.phone,
        plz: i.plz,
        service: i.service,
        message: i.message,
        status: 'lost',
        closedAt: i.createdAt,
        source: SOURCE,
        consentPrivacy: false,
        consentMarketing: false,
        internalNotes: 'Aus dem alten CLEANILO-System übernommen; Ergebnis dort unbekannt.',
        metadata: i.metadata,
        createdAt: i.createdAt,
        updatedAt: i.createdAt,
      })),
    ),
  );
  console.log(
    `inquiries: ${newInquiries.length} inserted, ${plan.inquiries.length - newInquiries.length} already present`,
  );

  const doneContacts = await existingLegacyIds('contactMessages');
  const newContacts = plan.contacts.filter((c) => !doneContacts.has(refKey(c.ref)));
  await chunked(newContacts, 200, (chunk) =>
    db.insert(T.contactMessages).values(
      chunk.map((c) => ({
        name: c.name,
        email: c.email,
        phone: c.phone,
        subject: c.subject,
        message: c.message,
        status: 'archived',
        source: SOURCE,
        consentPrivacy: false,
        consentMarketing: false,
        metadata: { legacy: c.ref },
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
    ),
  );
  console.log(
    `contact messages: ${newContacts.length} inserted, ${plan.contacts.length - newContacts.length} already present`,
  );

  await chunked(plan.newsletter, 500, (chunk) =>
    db
      .insert(T.newsletterSubscribers)
      .values(
        chunk.map((n) => ({
          email: n.email,
          source: SOURCE,
          tags: [TAG],
          confirmed: false,
          createdAt: n.createdAt,
          updatedAt: n.createdAt,
        })),
      )
      .onConflictDoNothing(),
  );
  console.log(`newsletter: ${plan.newsletter.length} upserted as unconfirmed`);

  const existingApps = new Set(
    (
      await db
        .select({ email: T.partnerApplications.email })
        .from(T.partnerApplications)
        .where(eq(T.partnerApplications.source, SOURCE))
    ).map((r) => r.email),
  );
  const newApps = plan.partners.filter((p) => !existingApps.has(p.email));
  if (newApps.length) {
    await db.insert(T.partnerApplications).values(
      newApps.map(({ account: _account, ...p }) => ({
        ...p,
        status: 'new',
        consentPrivacy: false,
        source: SOURCE,
        updatedAt: p.createdAt,
      })),
    );
  }
  console.log(
    `partner applications: ${newApps.length} inserted, ${plan.partners.length - newApps.length} already present`,
  );

  await promotePartners(plan);

  // Same backfill the backend runs at boot: emails become customers, rows get their customer_id.
  await db.execute(sql.raw(createTenantSchemaSql(TENANT)));
  await db.execute(sql`
    update ${sql.identifier(TENANT)}."customers" c set "tags" = c."tags" || ${JSON.stringify([TAG])}::jsonb
    where not (c."tags" ? ${TAG}) and (
      exists (select 1 from ${sql.identifier(TENANT)}."orders" o where o."customer_id" = c."id" and o."source" = ${SOURCE})
      or exists (select 1 from ${sql.identifier(TENANT)}."service_inquiries" s where s."customer_id" = c."id" and s."source" = ${SOURCE})
      or exists (select 1 from ${sql.identifier(TENANT)}."contact_messages" m where m."customer_id" = c."id" and m."source" = ${SOURCE})
      or exists (select 1 from ${sql.identifier(TENANT)}."newsletter_subscribers" n where n."customer_id" = c."id" and n."source" = ${SOURCE}))`);

  // Customers made from old emails get the date of their first old record, not the import date.
  const q = sql.identifier(TENANT);
  await db.execute(sql`
    update ${q}."customers" c set "created_at" = f.first_at, "updated_at" = greatest(c."updated_at", f.first_at)
    from (
      select "customer_id", min("created_at") as first_at from (
        select "customer_id", "created_at" from ${q}."orders" where "source" = ${SOURCE}
        union all select "customer_id", "created_at" from ${q}."service_inquiries" where "source" = ${SOURCE}
        union all select "customer_id", "created_at" from ${q}."contact_messages" where "source" = ${SOURCE}
        union all select "customer_id", "created_at" from ${q}."newsletter_subscribers" where "source" = ${SOURCE}
      ) x where "customer_id" is not null group by "customer_id"
    ) f
    where c."id" = f."customer_id" and c."tags" ? ${TAG} and f.first_at < c."created_at"`);

  const paid = await db
    .selectDistinct({ id: T.orders.customerId })
    .from(T.orders)
    .where(
      and(
        eq(T.orders.source, SOURCE),
        sql`${T.orders.paidAt} is not null`,
        sql`${T.orders.customerId} is not null`,
      ),
    );
  for (const { id } of paid) await recomputeCustomerAggregates(T, id!);
  console.log(`customer totals recomputed for ${paid.length} customers with paid old orders`);
}

async function main() {
  const plan = buildPlan(loadSnapshot(SNAPSHOT_DIR));
  await report(plan);
  if (COMMIT) {
    console.log('\nWriting …');
    await commit(plan);
    console.log('\nDone. Re-running is safe.');
  } else {
    console.log('\nDry run only. Add --commit to write.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
