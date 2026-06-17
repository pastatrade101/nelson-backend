import { z } from 'zod';

const statusSchema = z.enum(['draft', 'published', 'archived']);
const optionalUrl = z.union([z.string().url(), z.literal('')]).optional().nullable();

export const countryCreateSchema = z.object({
  name: z.string().min(2),
  slug: z.string().min(2).optional(),
  hero_image_url: optionalUrl,
  intro_text: z.string().optional().nullable(),
  best_months: z.array(z.string()).optional(),
  visa_info: z.string().optional().nullable(),
  health_info: z.string().optional().nullable(),
  currency: z.string().optional().nullable(),
  capital: z.string().optional().nullable(),
  phase: z.enum(['live', 'planned', 'future']).default('live'),
  status: statusSchema.default('draft'),
  is_featured: z.coerce.boolean().default(false),
  seo_title: z.string().optional().nullable(),
  meta_title: z.string().optional().nullable(),
  meta_description: z.string().optional().nullable(),
  og_image_url: optionalUrl
});

export const countryUpdateSchema = countryCreateSchema.partial();
