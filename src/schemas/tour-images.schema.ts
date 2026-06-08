import { z } from 'zod';

const optionalText = z.string().optional().nullable();

export const tourImageCreateSchema = z.object({
  tour_id: z.string().uuid(),
  image_url: z.string().url(),
  alt_text: optionalText,
  caption: optionalText,
  sort_order: z.coerce.number().int().min(0).optional().default(0),
  is_featured: z.boolean().optional().default(false)
});

export const tourImageUpdateSchema = tourImageCreateSchema.partial();
