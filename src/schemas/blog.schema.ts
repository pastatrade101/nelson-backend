import { z } from 'zod';

const statusSchema = z.enum(['draft', 'published', 'archived']);
const optionalUrl = z.union([z.string().url(), z.literal('')]).optional().nullable();

export const blogCreateSchema = z.object({
  title: z.string().min(2),
  slug: z.string().min(2).optional(),
  excerpt: z.string().optional().nullable(),
  content: z.string().optional().nullable(),
  category_id: z.union([z.string().uuid(), z.literal('')]).optional().nullable(),
  featured_image_url: optionalUrl,
  status: statusSchema.default('draft'),
  author_name: z.string().optional().nullable(),
  meta_title: z.string().optional().nullable(),
  meta_description: z.string().optional().nullable(),
  og_image_url: optionalUrl,
  published_at: z.string().optional().nullable()
});

export const blogUpdateSchema = blogCreateSchema.partial();
