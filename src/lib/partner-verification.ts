export const PARTNER_DOCUMENT_KINDS = [
  'gewerbeanmeldung',
  'haftpflicht',
  'handelsregister',
  'ausweis',
  'qualifikation',
  'sonstiges',
] as const;
export type PartnerDocumentKind = (typeof PARTNER_DOCUMENT_KINDS)[number];

/** Must be approved and unexpired before a partner counts as verified. */
export const REQUIRED_PARTNER_DOCUMENTS: readonly PartnerDocumentKind[] = [
  'gewerbeanmeldung',
  'haftpflicht',
];

export interface VerificationPartner {
  status: string;
  companyName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  addressLine1: string | null;
  postalCode: string | null;
  city: string | null;
  lat: number | null;
  services: string[];
  contractVersion: string | null;
  payoutsEnabled: boolean;
  stripeConnectStatus: string;
}

export interface VerificationDocument {
  kind: string;
  status: string;
  expiresAt: string | null;
}

export type DocumentState = 'missing' | 'pending' | 'approved' | 'rejected' | 'expired';

export interface PartnerChecklist {
  profileComplete: boolean;
  servicesSet: boolean;
  locationSet: boolean;
  documents: Array<{ kind: PartnerDocumentKind; state: DocumentState }>;
  contract: { required: string | null; accepted: string | null; ok: boolean };
  payouts: { status: string; ok: boolean };
  /** Profile + services + location + documents + contract. Payouts are tracked but not required. */
  verified: boolean;
  missing: string[];
}

function documentState(docs: VerificationDocument[], kind: string, today: string): DocumentState {
  const ofKind = docs.filter((d) => d.kind === kind);
  if (ofKind.length === 0) return 'missing';
  const approved = ofKind.filter((d) => d.status === 'approved');
  if (approved.some((d) => !d.expiresAt || d.expiresAt >= today)) return 'approved';
  if (ofKind.some((d) => d.status === 'pending')) return 'pending';
  if (approved.length > 0) return 'expired';
  return 'rejected';
}

export function partnerChecklist(
  partner: VerificationPartner,
  docs: VerificationDocument[],
  requiredContractVersion: string | null,
  today: string = new Date().toISOString().slice(0, 10),
): PartnerChecklist {
  const profileComplete = !!(
    partner.companyName &&
    partner.contactEmail &&
    partner.contactPhone &&
    partner.addressLine1 &&
    partner.postalCode &&
    partner.city
  );
  const servicesSet = partner.services.length > 0;
  const locationSet = partner.lat != null;
  const documents = REQUIRED_PARTNER_DOCUMENTS.map((kind) => ({
    kind,
    state: documentState(docs, kind, today),
  }));
  const contractOk =
    !requiredContractVersion || partner.contractVersion === requiredContractVersion;
  const payoutsOk = partner.payoutsEnabled && partner.stripeConnectStatus === 'active';

  const missing: string[] = [];
  if (!profileComplete) missing.push('profile');
  if (!servicesSet) missing.push('services');
  if (!locationSet) missing.push('location');
  for (const d of documents) if (d.state !== 'approved') missing.push(`document:${d.kind}`);
  if (!contractOk) missing.push('contract');

  return {
    profileComplete,
    servicesSet,
    locationSet,
    documents,
    contract: {
      required: requiredContractVersion,
      accepted: partner.contractVersion,
      ok: contractOk,
    },
    payouts: { status: partner.stripeConnectStatus, ok: payoutsOk },
    verified: missing.length === 0,
    missing,
  };
}
