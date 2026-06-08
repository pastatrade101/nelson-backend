import { z } from 'zod';

export const testimonialCreateSchema = z.object({
  client_name: z.string().min(2),
  client_country: z.string().optional().nullable(),
  client_image_url: z.union([z.string().url(), z.literal('')]).optional().nullable(),
  rating: z.coerce.number().int().min(1).max(5).default(5),
  message: z.string().min(5),
  tour_id: z.union([z.string().uuid(), z.literal('')]).optional().nullable(),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  is_featured: z.boolean().optional().default(false),
  sort_order: z.coerce.number().int().min(0).default(0)
});

export const testimonialUpdateSchema = testimonialCreateSchema.partial();
