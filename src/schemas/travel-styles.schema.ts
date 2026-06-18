import { z } from 'zod';

const statusSchema = z.enum(['draft', 'published', 'archived']);
const optionalUrl = z.union([z.string().url(), z.literal('')]).optional().nullable();

export const travelStyleCreateSchema = z.object({
  name: z.string().min(2),
  slug: z.string().min(2).optional(),
  emotional_promise: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  desires: z.array(z.string()).optional(),
  concerns: z.array(z.string()).optional(),
  persona: z.string().optional().nullable(),
  hero_image_url: optionalUrl,
  image_url: optionalUrl,
  status: statusSchema.default('draft'),
  is_featured: z.coerce.boolean().default(false),
  sort_order: z.coerce.number().int().optional().nullable(),
  seo_title: z.string().optional().nullable(),
  meta_title: z.string().optional().nullable(),
  meta_description: z.string().optional().nullable()
});

export const travelStyleUpdateSchema = travelStyleCreateSchema.partial();
