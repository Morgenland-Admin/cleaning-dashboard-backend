import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { company } from '../../db/schema/shared.js';
import type { TenantTables } from '../../db/schema/tenant.js';
import { brandInfoFromCompany, brandSender, sendEmail } from '../../email/service.js';
import {
  partnerActivatedEmail,
  type BrandInfo,
  type RenderedEmail,
} from '../../email/templates.js';
import { partnerPortalBase } from '../../lib/company-loader.js';
import type { EmailKind, EmailRefType } from '../../email/log.js';
import { geocodePlz } from '../../lib/geo.js';
import { notFound } from '../../lib/http-errors.js';
import { partnerChecklist, type PartnerChecklist } from '../../lib/partner-verification.js';

export type PartnerRow = TenantTables['partners']['$inferSelect'];
type CompanyFull = typeof company.$inferSelect;

/** Fields a partner may edit on their own profile (no status, commission or payout state). */
export const partnerProfileSchema = z.object({
  companyName: z.string().trim().min(1).max(200),
  legalName: z.string().trim().max(200).nullable(),
  taxId: z.string().trim().max(32).nullable(),
  vatId: z.string().trim().max(32).nullable(),
  registrationNumber: z.string().trim().max(64).nullable(),
  contactEmail: z.string().trim().email(),
  contactPhone: z.string().trim().max(32).nullable(),
  websiteUrl: z.string().trim().url().nullable(),
  addressLine1: z.string().trim().max(200).nullable(),
  addressLine2: z.string().trim().max(200).nullable(),
  city: z.string().trim().max(120).nullable(),
  region: z.string().trim().max(120).nullable(),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}$/, 'postalCode: 5 digits')
    .nullable(),
  country: z.string().length(2),
  serviceRadiusKm: z.number().int().min(5).max(300),
  services: z.array(z.string().max(80)).max(60),
  iban: z.string().trim().max(34).nullable(),
  bic: z.string().trim().max(11).nullable(),
});

/** lat/lng follow the postal code; an unknown PLZ clears them so matching never uses a stale point. */
export function locationPatch(postalCode: string | null | undefined): {
  lat?: number | null;
  lng?: number | null;
} {
  if (postalCode === undefined) return {};
  const coords = geocodePlz(postalCode);
  return { lat: coords?.lat ?? null, lng: coords?.lng ?? null };
}

/** A partner's view of their own row: staff notes and reviewer ids stay internal. */
export function toSelfView(row: PartnerRow) {
  const { internalNotes: _notes, approvedByUserId: _approver, ...rest } = row;
  return rest;
}

export async function findPartnerByUser(
  tables: TenantTables,
  userId: string,
): Promise<PartnerRow | null> {
  const [row] = await db
    .select()
    .from(tables.partners)
    .where(eq(tables.partners.userId, userId))
    .limit(1);
  return row ?? null;
}

export async function requireOwnPartner(request: FastifyRequest): Promise<PartnerRow> {
  const row = await findPartnerByUser(request.company!.tables, request.authUser!.id);
  if (!row) throw notFound('Partner profile not found');
  return row;
}

/** Offers, orders and payouts are for active partners only; suspended/rejected keep profile + chat. */
export async function requireActivePartner(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const row = await findPartnerByUser(request.company!.tables, request.authUser!.id);
  if (!row || row.status !== 'active') {
    reply.code(403).send({
      error: 'Partnerkonto ist nicht aktiv',
      partnerStatus: row?.status ?? null,
    });
  }
}

export async function loadCompanyFull(slug: string): Promise<CompanyFull | null> {
  const [row] = await db.select().from(company).where(eq(company.slug, slug)).limit(1);
  return row ?? null;
}

export async function checklistFor(
  tables: TenantTables,
  partner: PartnerRow,
  contractVersion: string | null,
): Promise<PartnerChecklist> {
  const docs = await db
    .select({
      kind: tables.partnerDocuments.kind,
      status: tables.partnerDocuments.status,
      expiresAt: tables.partnerDocuments.expiresAt,
    })
    .from(tables.partnerDocuments)
    .where(eq(tables.partnerDocuments.partnerId, partner.id));
  return partnerChecklist(partner, docs, contractVersion);
}

/** Verification flag for many partners at once (one documents query). */
export async function verifiedPartnerIds(
  tables: TenantTables,
  partners: PartnerRow[],
  contractVersion: string | null,
): Promise<Set<number>> {
  if (partners.length === 0) return new Set();
  const docs = await db
    .select({
      partnerId: tables.partnerDocuments.partnerId,
      kind: tables.partnerDocuments.kind,
      status: tables.partnerDocuments.status,
      expiresAt: tables.partnerDocuments.expiresAt,
    })
    .from(tables.partnerDocuments)
    .where(
      inArray(
        tables.partnerDocuments.partnerId,
        partners.map((p) => p.id),
      ),
    );
  const verified = new Set<number>();
  for (const p of partners) {
    const own = docs.filter((d) => d.partnerId === p.id);
    if (partnerChecklist(p, own, contractVersion).verified) verified.add(p.id);
  }
  return verified;
}

export function brandForMail(c: CompanyFull): BrandInfo {
  return brandInfoFromCompany(c);
}

/** Brand-branded mail to a partner's contact address; best-effort, never throws. */
export async function mailPartner(opts: {
  companyRow: CompanyFull;
  partner: Pick<PartnerRow, 'id' | 'contactEmail'>;
  kind: EmailKind;
  email: RenderedEmail;
  refType?: EmailRefType;
  refId?: number;
  sentByUserId?: string | null;
}): Promise<void> {
  if (!opts.partner.contactEmail) return;
  try {
    await sendEmail({
      to: opts.partner.contactEmail,
      from: brandSender(opts.companyRow),
      apiKey: opts.companyRow.resendApiKey ?? undefined,
      replyTo: opts.companyRow.email ?? undefined,
      log: {
        companySlug: opts.companyRow.slug,
        kind: opts.kind,
        refType: opts.refType ?? 'partner',
        refId: opts.refId ?? opts.partner.id,
        sentByUserId: opts.sentByUserId ?? null,
      },
      email: opts.email,
    });
  } catch (err) {
    console.error('[partner-mail] send failed', opts.kind, err);
  }
}

export async function partnerById(tables: TenantTables, id: number): Promise<PartnerRow | null> {
  const [row] = await db.select().from(tables.partners).where(eq(tables.partners.id, id)).limit(1);
  return row ?? null;
}

/** Push + branded mail when an admin activates a partner; best-effort. */
export async function notifyPartnerActivated(
  companySlug: string,
  companyName: string,
  partner: PartnerRow,
  adminId: string,
): Promise<void> {
  try {
    const { sendPushToUser } = await import('../../lib/push.js');
    await sendPushToUser(partner.userId, {
      title: `${companyName} · Partnerkonto freigeschaltet`,
      body: 'Ab jetzt erhalten Sie Auftragsanfragen.',
      url: '/',
      tag: `partner-activated:${partner.id}`,
      brandSlug: companySlug,
    });
  } catch (err) {
    console.error('[partner-activated] push failed', err);
  }
  const companyRow = await loadCompanyFull(companySlug);
  if (!companyRow) return;
  await mailPartner({
    companyRow,
    partner,
    kind: 'partner_activated',
    sentByUserId: adminId,
    email: partnerActivatedEmail({
      brand: brandForMail(companyRow),
      partnerName: partner.companyName,
      portalUrl: `${partnerPortalBase(companyRow) ?? ''}/`,
    }),
  });
}
