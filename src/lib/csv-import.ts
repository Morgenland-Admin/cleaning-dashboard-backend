const EMAIL_ALIASES = ['email', 'e-mail', 'mail', 'emailaddress', 'email_address'];
const FIRST_ALIASES = ['firstname', 'first_name', 'first name', 'given', 'givenname', 'vorname'];
const LAST_ALIASES = [
  'lastname',
  'last_name',
  'last name',
  'family',
  'familyname',
  'nachname',
  'surname',
];

function matchHeader(header: string, aliases: readonly string[]): boolean {
  const norm = header.toLowerCase().replace(/[\s_-]+/g, '');
  return aliases.some((a) => a.replace(/[\s_-]+/g, '') === norm);
}

export interface ParsedRow {
  email: string;
  firstName?: string;
  lastName?: string;
  line: number;
}

export function parseCsv(input: string): ParsedRow[] {
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const firstLine = text.slice(0, text.indexOf('\n')).slice(0, 4096) || text;
  let delim = ',';
  const commaCount = (firstLine.match(/,/g) ?? []).length;
  const semiCount = (firstLine.match(/;/g) ?? []).length;
  const tabCount = (firstLine.match(/\t/g) ?? []).length;
  if (semiCount > commaCount && semiCount > tabCount) delim = ';';
  else if (tabCount > commaCount && tabCount > semiCount) delim = '\t';

  const allRows = parseDelimited(text, delim);
  if (allRows.length === 0) return [];

  const header = allRows[0]!.map((h) => h.trim());
  let emailCol = -1;
  let firstCol = -1;
  let lastCol = -1;
  header.forEach((h, i) => {
    if (emailCol < 0 && matchHeader(h, EMAIL_ALIASES)) emailCol = i;
    else if (firstCol < 0 && matchHeader(h, FIRST_ALIASES)) firstCol = i;
    else if (lastCol < 0 && matchHeader(h, LAST_ALIASES)) lastCol = i;
  });
  if (emailCol < 0) {
    throw new Error(
      `Keine "email"-Spalte gefunden. Bitte CSV mit Header-Zeile (z.B. "email,first_name,last_name") hochladen.`,
    );
  }

  const out: ParsedRow[] = [];
  for (let i = 1; i < allRows.length; i += 1) {
    const row = allRows[i]!;
    const email = (row[emailCol] ?? '').trim().toLowerCase();
    if (!email) continue;
    out.push({
      email,
      firstName: firstCol >= 0 ? (row[firstCol] ?? '').trim() || undefined : undefined,
      lastName: lastCol >= 0 ? (row[lastCol] ?? '').trim() || undefined : undefined,
      line: i + 1,
    });
  }
  return out;
}

function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuote = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuote = true;
    } else if (c === delim) {
      cur.push(field);
      field = '';
    } else if (c === '\n') {
      cur.push(field);
      if (!(cur.length === 1 && cur[0] === '')) rows.push(cur);
      cur = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || cur.length > 0) {
    cur.push(field);
    if (!(cur.length === 1 && cur[0] === '')) rows.push(cur);
  }
  return rows;
}

export type RejectReason =
  | 'invalid_email'
  | 'duplicate'
  | 'own_domain'
  | 'system_address'
  | 'disposable_domain';

export interface ImportRow {
  email: string;
  firstName?: string;
  lastName?: string;
  line: number;
  reject?: RejectReason;
}

export interface FilterOptions {
  ownDomains: string[];
  existingEmails: Set<string>;
}

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

const SYSTEM_LOCALPARTS = new Set([
  'postmaster',
  'abuse',
  'noreply',
  'no-reply',
  'donotreply',
  'mailer-daemon',
  'hostmaster',
  'webmaster',
  'admin',
  'root',
  'support',
  'info',
]);

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  'trashmail.com',
  '10minutemail.com',
  'guerrillamail.com',
  'tempmail.com',
  'yopmail.com',
  'throwawaymail.com',
  'fakeinbox.com',
  'dispostable.com',
]);

export function filterImportRows(rows: ParsedRow[], opts: FilterOptions): ImportRow[] {
  const seenInBatch = new Set<string>();
  const result: ImportRow[] = [];

  for (const r of rows) {
    const base: ImportRow = { ...r };

    if (!EMAIL_RE.test(r.email) || r.email.length > 254) {
      result.push({ ...base, reject: 'invalid_email' });
      continue;
    }

    const [local, domain] = r.email.split('@') as [string, string];
    const lowerDomain = domain.toLowerCase();

    if (opts.ownDomains.includes(lowerDomain)) {
      result.push({ ...base, reject: 'own_domain' });
      continue;
    }

    if (SYSTEM_LOCALPARTS.has(local.toLowerCase())) {
      result.push({ ...base, reject: 'system_address' });
      continue;
    }

    if (DISPOSABLE_DOMAINS.has(lowerDomain)) {
      result.push({ ...base, reject: 'disposable_domain' });
      continue;
    }

    if (opts.existingEmails.has(r.email)) {
      result.push({ ...base, reject: 'duplicate' });
      continue;
    }

    if (seenInBatch.has(r.email)) {
      result.push({ ...base, reject: 'duplicate' });
      continue;
    }
    seenInBatch.add(r.email);

    result.push(base);
  }

  return result;
}

export interface ImportSummary {
  parsedRows: number;
  imported: number;
  skipped: number;
  byReason: Record<RejectReason, number>;
  sampleRejects: ImportRow[];
}

export function summarise(
  filtered: ImportRow[],
  imported: number,
  sampleLimit = 25,
): ImportSummary {
  const byReason: Record<RejectReason, number> = {
    invalid_email: 0,
    duplicate: 0,
    own_domain: 0,
    system_address: 0,
    disposable_domain: 0,
  };
  const rejects: ImportRow[] = [];
  for (const r of filtered) {
    if (r.reject) {
      byReason[r.reject] += 1;
      if (rejects.length < sampleLimit) rejects.push(r);
    }
  }
  return {
    parsedRows: filtered.length,
    imported,
    skipped: filtered.length - imported,
    byReason,
    sampleRejects: rejects,
  };
}
