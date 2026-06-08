import { z } from 'zod';

const statusSchema = z.enum(['draft', 'published', 'archived']);
const optionalUrl = z.union([z.string().url(), z.literal('')]).optional().nullable();

export const categoryCreateSchema = z.object({
  name: z.string().min(2),
  slug: z.string().min(2).optional(),
  description: z.string().optional().nullable(),
  icon_url: optionalUrl,
  image_url: optionalUrl,
  lottie_url: optionalUrl,
  status: statusSchema.default('draft'),
  sort_order: z.coerce.number().int().min(0).default(0),
  meta_title: z.string().optional().nullable(),
  meta_description: z.string().optional().nullable()
});

export const categoryUpdateSchema = categoryCreateSchema.partial();
