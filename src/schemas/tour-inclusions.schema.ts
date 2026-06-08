import { z } from 'zod';

export const tourInclusionCreateSchema = z.object({
  tour_id: z.string().uuid(),
  title: z.string().min(1),
  sort_order: z.coerce.number().int().min(0).optional().default(0)
});

export const tourInclusionUpdateSchema = tourInclusionCreateSchema.partial();
