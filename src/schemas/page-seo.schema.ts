import { z } from 'zod';

const optionalText = z.string().trim().optional().nullable();
const optionalUrl = z.union([z.string().trim().url(), z.literal('')]).optional().nullable();

// These rows control tags that search engines see. Keep private flows out of
// this editor: they are always noindex in the public site shell instead.
const publicPath = z
  .string()
  .trim()
  .min(1)
  .startsWith('/', 'Path must start with "/".')
  .refine((value) => !/[?#]/.test(value), 'Use a clean pathname without a query string or hash.')
  .refine(
    (value) => !/^\/(admin|api|booking|quote|trip|shortlist|enquiry|guest-details)(\/|$)/i.test(value),
    'Private, admin and transactional paths are always protected from indexing.'
  );

export const pageSeoCreateSchema = z.object({
  path: publicPath,
  title: optionalText,
  meta_description: optionalText,
  og_title: optionalText,
  og_description: optionalText,
  og_image_url: optionalUrl,
  canonical_url: optionalUrl,
  robots: z.string().trim().optional().default('index,follow'),
  structured_data: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional().nullable(),
  is_active: z.boolean().optional().default(true)
});

export const pageSeoUpdateSchema = pageSeoCreateSchema.partial();
