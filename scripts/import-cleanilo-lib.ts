/**
 * Pure parse + dedup + plan logic for the CLEANILO historical import.
 * No side effects, no DB — shared by the dry-run runner and the commit writer
 * so the numbers Kabir signs off on are exactly what gets written.
 */
import { readFileSync } from 'node:fs';

import { computeLoyaltyTier, type LoyaltyTier } from '../src/lib/loyalty.ts';

export interface RawInvoice {
  file: string;
  rg: string; // "2023/1201"
  datum: string; // "2023-01-09"
  kunde: string; // "Name / Straße / D-PLZ Ort"
  ort: string;
  leistung: string;
  brutto: number; // gross EUR
  fn_nr: string;
}

export interface ParsedInvoice {
  invoiceNumber: string; // original, e.g. "2023/1201"
  sourceFile: string;
  date: string;
  grossCents: number;
  service: string;
  name: string;
  street: string | null;
  plz: string | null;
  city: string | null;
  country: string;
  isB2B: boolean;
  verifiedEmail: string | null;
}

export interface PlannedCustomer {
  key: string;
  name: string;
  email: string; // real (verified) or unique placeholder
  emailIsPlaceholder: boolean;
  phone: string | null;
  street: string | null;
  plz: string | null;
  city: string | null;
  country: string;
  isB2B: boolean;
  sourceInvoices: ParsedInvoice[];
  totalOrders: number;
  totalSpentCents: number;
  firstOrderAt: string;
  lastOrderAt: string;
  tier: LoyaltyTier;
}

export interface MergeRecord {
  canonicalName: string;
  address: string;
  invoices: string[];
  variants: string[];
  totalCents: number;
}

export interface ImportPlan {
  invoices: ParsedInvoice[];
  customers: PlannedCustomer[];
  merges: MergeRecord[];
}

export const CLEANILO_SLUG = 'cleanilo';
export const IMPORT_SOURCE = 'import_cleanilo_2021_26';
const PLACEHOLDER_DOMAIN = 'import.cleanilo.local';

const B2B_SUFFIX_RE = /\b(gmbh|ag|ug|kg|ohg|gbr|mbh|e\.?\s?v\.?|se|kgaa|ltd|inc)\b/i;
const NAME_TITLE_RE = /\b(familie|fam\.?|frau|herr|hr\.?|fa\.?|firma|herrn)\b/gi;

export function eur(cents: number): string {
  return (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

export function placeholderEmail(inv: ParsedInvoice): string {
  return `kunde-${inv.invoiceNumber.replace(/\//g, '-')}@${PLACEHOLDER_DOMAIN}`;
}

function parseKunde(kunde: string): {
  name: string;
  street: string | null;
  plz: string | null;
  city: string | null;
} {
  const parts = kunde
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  const name = parts[0] ?? kunde.trim();
  let street: string | null = null;
  let plz: string | null = null;
  let city: string | null = null;
  const locRe = /(?:D-)?(\d{5})\s+(.+)/;
  for (let i = 1; i < parts.length; i += 1) {
    const m = locRe.exec(parts[i]!);
    if (m) {
      plz = m[1]!;
      city = m[2]!.trim();
    } else if (!street) {
      street = parts[i]!;
    }
  }
  return { name, street, plz, city };
}

function normName(name: string): string {
  return name
    .toLowerCase()
    .replace(NAME_TITLE_RE, ' ')
    .replace(/[^a-zäöüß\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normAddr(street: string | null, plz: string | null, city: string | null): string {
  return [street, plz, city]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]/g, '');
}

function lev(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n]!;
}

export function parseInvoices(jsonPath: string): ParsedInvoice[] {
  const raw = JSON.parse(readFileSync(jsonPath, 'utf8')) as RawInvoice[];
  return raw.map((r) => {
    const { name, street, plz, city } = parseKunde(r.kunde);
    return {
      invoiceNumber: r.rg,
      sourceFile: r.file,
      date: r.datum,
      grossCents: Math.round(Number(r.brutto) * 100),
      service: r.leistung,
      name,
      street,
      plz,
      city,
      country: 'DE',
      isB2B: B2B_SUFFIX_RE.test(name),
      verifiedEmail: null,
    };
  });
}

export interface CsvMatch {
  invoiceNumber: string;
  crmName: string;
  crmEmail: string;
  segment: string;
  matchType: string;
  status: string;
}

/** ';'-delimited, Windows-1252/Latin-1 encoded reconciliation export. */
export function parseReconciliation(csvPath: string): CsvMatch[] {
  const text = readFileSync(csvPath, 'latin1').replace(/\r\n/g, '\n');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const header = lines[0]!.split(';').map((h) => h.trim());
  const col = (name: string) =>
    header.findIndex((h) => h.toLowerCase().startsWith(name.toLowerCase()));
  const iNr = col('Rechnungsnr');
  const iName = col('CRM Name');
  const iEmail = col('CRM Email');
  const iSeg = col('CRM Service');
  const iMatch = col('Match-Typ');
  const iStatus = col('Status');
  const out: CsvMatch[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const f = lines[i]!.split(';');
    out.push({
      invoiceNumber: (f[iNr] ?? '').trim(),
      crmName: (f[iName] ?? '').trim(),
      crmEmail: (f[iEmail] ?? '').trim().toLowerCase(),
      segment: (f[iSeg] ?? '').trim(),
      matchType: (f[iMatch] ?? '').trim(),
      status: (f[iStatus] ?? '').trim(),
    });
  }
  return out;
}

/** Attach verified emails + B2B flags from the reconciliation onto invoices. */
export function applyMatches(invoices: ParsedInvoice[], matches: CsvMatch[]): void {
  const verifiedByInvoice = new Map<string, string>();
  const b2bByInvoice = new Set<string>();
  for (const m of matches) {
    if (/B2B/i.test(m.segment)) b2bByInvoice.add(m.invoiceNumber);
    // Only the unambiguous name_exact + SICHER matches get a real address.
    if (m.matchType === 'name_exact' && m.status.toUpperCase() === 'SICHER' && m.crmEmail) {
      verifiedByInvoice.set(m.invoiceNumber, m.crmEmail);
    }
  }
  for (const inv of invoices) {
    const email = verifiedByInvoice.get(inv.invoiceNumber);
    if (email) inv.verifiedEmail = email;
    if (b2bByInvoice.has(inv.invoiceNumber)) inv.isB2B = true;
  }
}

/**
 * Dedup rule (agreed): verified email wins; otherwise normalised address, and
 * within one address names within edit-distance ≤ 2 collapse to one customer
 * (catches Riggers/Rieggers). Aggregates orders/spend and derives the tier.
 */
export function buildPlan(invoices: ParsedInvoice[]): {
  customers: PlannedCustomer[];
  merges: MergeRecord[];
} {
  const byKey = new Map<string, ParsedInvoice[]>();
  const addrGroups = new Map<string, ParsedInvoice[]>();

  const push = (map: Map<string, ParsedInvoice[]>, k: string, v: ParsedInvoice) => {
    const arr = map.get(k);
    if (arr) arr.push(v);
    else map.set(k, [v]);
  };

  for (const inv of invoices) {
    if (inv.verifiedEmail) push(byKey, `email:${inv.verifiedEmail}`, inv);
    else
      push(
        addrGroups,
        normAddr(inv.street, inv.plz, inv.city) || `noaddr:${normName(inv.name)}`,
        inv,
      );
  }

  for (const [addr, group] of addrGroups) {
    const names = [...new Set(group.map((g) => normName(g.name)))];
    const parent = new Map<string, string>(names.map((n) => [n, n]));
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      return r;
    };
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        if (lev(names[i]!, names[j]!) <= 2) parent.set(find(names[i]!), find(names[j]!));
      }
    }
    for (const inv of group) push(byKey, `addr:${addr}#${find(normName(inv.name))}`, inv);
  }

  const customers: PlannedCustomer[] = [];
  const merges: MergeRecord[] = [];

  for (const [key, invs] of byKey) {
    invs.sort((a, b) => a.date.localeCompare(b.date));
    const canonical = [...invs].sort((a, b) => b.name.length - a.name.length)[0]!;
    const totalCents = invs.reduce((s, i) => s + i.grossCents, 0);
    const verified = invs.find((i) => i.verifiedEmail)?.verifiedEmail ?? null;
    customers.push({
      key,
      name: canonical.name,
      email: verified ?? placeholderEmail(invs[0]!),
      emailIsPlaceholder: !verified,
      phone: null,
      street: canonical.street,
      plz: canonical.plz,
      city: canonical.city,
      country: canonical.country,
      isB2B: invs.some((i) => i.isB2B),
      sourceInvoices: invs,
      totalOrders: invs.length,
      totalSpentCents: totalCents,
      firstOrderAt: invs[0]!.date,
      lastOrderAt: invs[invs.length - 1]!.date,
      tier: computeLoyaltyTier(invs.length, totalCents),
    });
    const variants = [...new Set(invs.map((i) => i.name))];
    if (invs.length > 1) {
      merges.push({
        canonicalName: canonical.name,
        address: [canonical.street, canonical.plz, canonical.city].filter(Boolean).join(', '),
        invoices: invs.map((i) => i.invoiceNumber),
        variants,
        totalCents,
      });
    }
  }

  customers.sort((a, b) => b.totalSpentCents - a.totalSpentCents);
  merges.sort((a, b) => b.totalCents - a.totalCents);
  return { customers, merges };
}

export function makePlan(jsonPath: string, csvPath: string): ImportPlan {
  const invoices = parseInvoices(jsonPath);
  applyMatches(invoices, parseReconciliation(csvPath));
  const { customers, merges } = buildPlan(invoices);
  return { invoices, customers, merges };
}
