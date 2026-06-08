import { z } from 'zod';
import {
  POLSTER_ITEMS,
  REPARATUR_ARTS,
  TEPPICH_ARTS,
  TEPPICHBODEN_BRACKETS,
  TEPPICHBODEN_TIERS,
  ZUSATZ_KINDS,
  type OrderServiceInput,
} from '../../lib/pricing.js';

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

const coordsSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
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
    pickupCoords: coordsSchema.optional(),
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
    pickupCoords: coordsSchema.optional(),
  }),
  z.object({
    kind: z.literal('polsterreinigung'),
    items: z.array(polsterLineSchema).min(1).max(20),
    addressPlz: z
      .string()
      .trim()
      .regex(/^\d{5}$/),
    addressCoords: coordsSchema.optional(),
  }),
  z.object({
    kind: z.literal('teppichbodenreinigung'),
    tier: z.enum(TEPPICHBODEN_TIERS),
    bracket: z.enum(TEPPICHBODEN_BRACKETS),
    sqm: z.number().positive().max(2000).optional(),
    addressPlz: z
      .string()
      .trim()
      .regex(/^\d{5}$/),
    addressCoords: coordsSchema.optional(),
  }),
]);

export type QuoteInput = z.infer<typeof quoteSchema>;

export function toServiceInput(parsed: QuoteInput): OrderServiceInput {
  return parsed;
}

export const checkoutSchema = quoteSchema.and(
  z.object({
    customer: customerSchema,
    address: addressSchema.optional(),
    preferredDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'preferredDate must be YYYY-MM-DD')
      .optional(),
    preferredSlots: z
      .array(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/))
      .min(1)
      .max(3)
      .optional(),
    customerNotes: z.string().trim().max(2000).optional(),
    voucherCode: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .regex(/^[A-Z0-9_-]+$/i, 'Code may only contain letters, digits, _, -')
      .optional(),
    consentPrivacy: z.literal(true, {
      errorMap: () => ({ message: 'Privacy consent is required' }),
    }),
    consentMarketing: z.boolean().optional(),
    website: z.string().max(200).optional(),
    source: z.string().trim().max(64).optional(),
    paymentMode: z.enum(['upfront', 'after_service']).optional(),
  }),
);

export type CheckoutInput = z.infer<typeof checkoutSchema>;
