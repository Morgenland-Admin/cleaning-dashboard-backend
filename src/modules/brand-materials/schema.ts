import { z } from 'zod';

export const TEMPLATE_PATH_RE = /^(_brand|(kunden|partner)\/[a-z0-9-]{1,80}|system\/designsystem)$/;
export const MAX_DATA_CHARS = 200_000;
const MAX_ENTRIES = 500;

// http only for local MinIO; anything public must be https (it ends up on printed material).
const IMAGE_URL_RE = /^(https:\/\/\S+|http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/\S*)?)$/;

const capped = <T extends z.ZodTypeAny>(key: z.ZodString, value: T) =>
  z
    .record(key, value)
    .refine((r) => Object.keys(r).length <= MAX_ENTRIES, `At most ${MAX_ENTRIES} entries`);

export const brandMaterialDraftDataSchema = z
  .object({
    edits: capped(z.string().max(2000), z.string().max(5000)),
    values: capped(z.string().max(300), z.string().max(2000)),
    qr: capped(z.string().max(20), z.string().max(2000)),
    images: capped(
      z.string().max(20),
      z.string().max(2048).regex(IMAGE_URL_RE, 'Image URL must be https'),
    ),
    links: capped(z.string().max(40), z.string().max(2000)),
    utm: z.boolean(),
  })
  .partial()
  .strict();

export type BrandMaterialDraftData = z.infer<typeof brandMaterialDraftDataSchema>;

export const templatePathSchema = z.string().max(160).regex(TEMPLATE_PATH_RE, 'Invalid template');

export const upsertDraftSchema = z.object({
  templatePath: templatePathSchema,
  data: brandMaterialDraftDataSchema,
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

export const deleteDraftQuerySchema = z.object({ templatePath: templatePathSchema });
