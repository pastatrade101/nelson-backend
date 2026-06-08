import { z } from 'zod';

const statusSchema = z.enum(['draft', 'published', 'archived']);
const optionalUrl = z.union([z.string().url(), z.literal('')]).optional().nullable();

export const destinationCreateSchema = z.object({
  name: z.string().min(2),
  slug: z.string().min(2).optional(),
  country: z.string().min(2).default('Tanzania'),
  region: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  short_description: z.string().optional().nullable(),
  description: z.string().min(5).optional().nullable(),
  image_url: optionalUrl,
  main_image_url: optionalUrl,
  banner_image_url: optionalUrl,
  latitude: z.coerce.number().optional().nullable(),
  longitude: z.coerce.number().optional().nullable(),
  status: statusSchema.default('draft'),
  is_featured: z.coerce.boolean().default(false),
  meta_title: z.string().optional().nullable(),
  meta_description: z.string().optional().nullable(),
  og_image_url: optionalUrl
});

export const destinationUpdateSchema = destinationCreateSchema.partial();
