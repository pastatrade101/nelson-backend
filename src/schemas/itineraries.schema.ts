import { z } from 'zod';

const optionalText = z.string().optional().nullable();
const optionalUrl = z.union([z.string().url(), z.literal('')]).optional().nullable();

export const itineraryCreateSchema = z.object({
  tour_id: z.string().uuid(),
  day_number: z.coerce.number().int().positive(),
  title: z.string().min(2),
  description: optionalText,
  accommodation: optionalText,
  // The lodge this night is spent at (lodges.id). `accommodation` stays as the
  // text printed on the day, and the fallback for properties not in the catalogue.
  accommodation_id: z.preprocess((v) => (v === '' ? null : v), z.string().uuid().nullable().optional()),
  meals: optionalText,
  activities: optionalText,
  image_url: optionalUrl
});

export const itineraryUpdateSchema = itineraryCreateSchema.partial();
