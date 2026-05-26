import { z } from 'zod';
import {
  POLSTER_ITEMS,
  REPARATUR_ARTS,
  TEPPICH_ARTS,
  ZUSATZ_KINDS,
  type OrderServiceInput,
} from '../../lib/pricing.js';

// --- Customer + address ------------------------------------------------------
// Shared across all three order kinds. Kept inline rather than tied to a
// hypothetical Customer table because guest checkout means every order is a
// fresh customer snapshot — they may even have an old, outdated phone number
// in our DB and we don't want to silently overwrite it.

export const customerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().email().max(254),
  phone: z.string().trim().min(3).max(32).optional(),
});

export const addressSchema = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(120),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}$/, 'PLZ must be 5 digits'),
  country: z.string().length(2).default('DE'),
});

// --- Quote / Checkout body shapes -------------------------------------------
// `quoteSchema` is the public input; the same shape powers /quote (no DB,
// returns price) and /checkout (DB write + Stripe). The /checkout endpoint
// extends with customer + consent + address.

const carpetLineSchema = z.object({
  art: z.enum(TEPPICH_ARTS),
  sqm: z.number().positive().max(500),
  note: z.string().trim().max(120).optional(),
  addons: z.array(z.enum(ZUSATZ_KINDS)).max(3).optional(),
});

const repairLineSchema = z.object({
  art: z.enum(REPARATUR_ARTS),
  meters: z.number().positive().max(200),
  note: z.string().trim().max(120).optional(),
});

const polsterLineSchema = z.object({
  item: z.enum(POLSTER_ITEMS),
  quantity: z.number().int().positive().max(20),
});

export const quoteSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('teppichreinigung'),
    carpets: z.array(carpetLineSchema).min(1).max(20),
    pickupMode: z.enum(['pickup', 'drop_off']),
    pickupPlz: z
      .string()
      .trim()
      .regex(/^\d{5}$/)
      .optional(),
  }),
  z.object({
    kind: z.literal('teppichreparatur'),
    repairs: z.array(repairLineSchema).min(1).max(20),
    pickupMode: z.enum(['pickup', 'drop_off']),
    pickupPlz: z
      .string()
      .trim()
      .regex(/^\d{5}$/)
      .optional(),
  }),
  z.object({
    kind: z.literal('polsterreinigung'),
    items: z.array(polsterLineSchema).min(1).max(20),
    addressPlz: z
      .string()
      .trim()
      .regex(/^\d{5}$/),
  }),
]);

export type QuoteInput = z.infer<typeof quoteSchema>;

// The Zod output matches the pricing engine input one-to-one (just discriminated
// on `kind`). This cast keeps the union types aligned without re-mapping fields.
export function toServiceInput(parsed: QuoteInput): OrderServiceInput {
  return parsed;
}

// /checkout extends /quote with customer + consent + (optional) date + address.
export const checkoutSchema = quoteSchema.and(
  z.object({
    customer: customerSchema,
    address: addressSchema.optional(),
    /** Only required for Polsterreinigung (on-site appointment). */
    preferredDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'preferredDate must be YYYY-MM-DD')
      .optional(),
    customerNotes: z.string().trim().max(2000).optional(),
    consentPrivacy: z.literal(true, {
      errorMap: () => ({ message: 'Privacy consent is required' }),
    }),
    consentMarketing: z.boolean().optional(),
    /** Honeypot — must stay empty. */
    website: z.string().max(200).optional(),
    source: z.string().trim().max(64).optional(),
  }),
);

export type CheckoutInput = z.infer<typeof checkoutSchema>;
