import { z } from 'zod';

export const tourExclusionCreateSchema = z.object({
  tour_id: z.string().uuid(),
  title: z.string().min(1),
  sort_order: z.coerce.number().int().min(0).optional().default(0)
});

export const tourExclusionUpdateSchema = tourExclusionCreateSchema.partial();
