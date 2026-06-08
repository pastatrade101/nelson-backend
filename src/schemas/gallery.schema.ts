import { z } from 'zod';

export const galleryCreateSchema = z.object({
  title: z.string().optional().nullable(),
  image_url: z.string().url(),
  alt_text: z.string().optional().nullable(),
  caption: z.string().optional().nullable(),
  destination_id: z.union([z.string().uuid(), z.literal('')]).optional().nullable(),
  tour_id: z.union([z.string().uuid(), z.literal('')]).optional().nullable(),
  media_type: z.enum(['image', 'video', 'document']).default('image'),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  sort_order: z.coerce.number().int().min(0).default(0)
});

export const galleryUpdateSchema = galleryCreateSchema.partial();
