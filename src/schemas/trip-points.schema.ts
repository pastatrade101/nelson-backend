import { z } from 'zod';

const statusSchema = z.enum(['draft', 'published', 'archived']);
const optionalUrl = z.union([z.string().url(), z.literal('')]).optional().nullable();

export const tripPointCreateSchema = z.object({
  name: z.string().min(2),
  slug: z.string().min(2).optional(),
  destination_id: z.union([z.string().uuid(), z.literal('')]).optional().nullable(),
  role: z.enum(['start', 'end', 'both']).default('both'),
  gateway_type: z.enum(['airport', 'city', 'hotel', 'border', 'station']).default('airport'),
  airport_code: z.string().max(8).optional().nullable(),
  description: z.string().optional().nullable(),
  transfer_info: z.string().optional().nullable(),
  hero_image_url: optionalUrl,
  image_url: optionalUrl,
  status: statusSchema.default('draft'),
  is_featured: z.coerce.boolean().default(false),
  sort_order: z.coerce.number().int().optional().nullable(),
  seo_title: z.string().optional().nullable(),
  meta_title: z.string().optional().nullable(),
  meta_description: z.string().optional().nullable()
});

export const tripPointUpdateSchema = tripPointCreateSchema.partial();
