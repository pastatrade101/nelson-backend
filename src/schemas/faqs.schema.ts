import { z } from 'zod';

export const faqCreateSchema = z.object({
  question: z.string().min(5),
  answer: z.string().min(5),
  category: z.string().optional().nullable(),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  sort_order: z.coerce.number().int().min(0).default(0)
});

export const faqUpdateSchema = faqCreateSchema.partial();
