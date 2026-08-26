import { z } from 'zod';

const statusSchema = z.enum(['draft', 'published', 'archived']);
const optionalUrl = z.union([z.string().url(), z.literal('')]).optional().nullable();

export const safariEssentialCreateSchema = z.object({
  title: z.string().min(2),
  slug: z.string().min(2).optional(),
  summary: z.string().optional().nullable(),
  content: z.string().optional().nullable(),
  hero_image_url: optionalUrl,
  topic: z.string().optional().nullable(),
  // Defaults to the only live destination; a Kenya hub is a new value, not a
  // schema change.
  country: z.string().optional(),
  meta_title: z.string().optional().nullable(),
  meta_description: z.string().optional().nullable(),
  og_image_url: optionalUrl,
  noindex: z.boolean().optional(),
  status: statusSchema.default('draft'),
  sort_order: z.number().int().optional()
});

export const safariEssentialUpdateSchema = safariEssentialCreateSchema.partial();
