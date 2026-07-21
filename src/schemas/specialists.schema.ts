import { z } from 'zod';

export const specialistCreateSchema = z.object({
  name: z.string().min(2),
  role: z.string().min(2),
  photo_url: z.union([z.string().url(), z.literal('')]).optional().nullable(),
  blurb: z.string().optional().nullable(),
  whatsapp_number: z.string().optional().nullable(),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  is_featured: z.boolean().optional().default(false),
  sort_order: z.coerce.number().int().min(0).default(0)
});

export const specialistUpdateSchema = specialistCreateSchema.partial();
