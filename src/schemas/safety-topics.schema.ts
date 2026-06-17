import { z } from 'zod';

const statusSchema = z.enum(['draft', 'published', 'archived']);
const optionalUrl = z.union([z.string().url(), z.literal('')]).optional().nullable();

export const safetyTopicCreateSchema = z.object({
  title: z.string().min(2),
  slug: z.string().min(2).optional(),
  category: z
    .enum(['general', 'health', 'security', 'wildlife', 'practical'])
    .default('general'),
  icon: z.string().max(40).optional().nullable(),
  summary: z.string().optional().nullable(),
  content: z.string().optional().nullable(),
  image_url: optionalUrl,
  status: statusSchema.default('draft'),
  is_featured: z.coerce.boolean().default(false),
  sort_order: z.coerce.number().int().optional().nullable(),
  seo_title: z.string().optional().nullable(),
  meta_title: z.string().optional().nullable(),
  meta_description: z.string().optional().nullable()
});

export const safetyTopicUpdateSchema = safetyTopicCreateSchema.partial();
