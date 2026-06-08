import { z } from 'zod';

const optionalText = z.string().optional().nullable();
const optionalUrl = z.union([z.string().url(), z.literal('')]).optional().nullable();

export const itineraryCreateSchema = z.object({
  tour_id: z.string().uuid(),
  day_number: z.coerce.number().int().positive(),
  title: z.string().min(2),
  description: optionalText,
  accommodation: optionalText,
  meals: optionalText,
  activities: optionalText,
  image_url: optionalUrl
});

export const itineraryUpdateSchema = itineraryCreateSchema.partial();
