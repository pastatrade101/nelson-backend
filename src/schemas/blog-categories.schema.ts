import { z } from 'zod';

const statusSchema = z.enum(['draft', 'published', 'archived']);

export const blogCategoryCreateSchema = z.object({
  name: z.string().min(2),
  slug: z.string().min(2).optional(),
  description: z.string().optional().nullable(),
  status: statusSchema.default('draft'),
  sort_order: z.coerce.number().int().min(0).default(0)
});

export const blogCategoryUpdateSchema = blogCategoryCreateSchema.partial();
