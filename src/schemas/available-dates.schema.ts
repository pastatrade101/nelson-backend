import { z } from 'zod';

const nullableInteger = z.union([z.coerce.number().int().min(0), z.null()]).optional();
const nullableMoney = z.union([z.coerce.number().min(0), z.null()]).optional();
const optionalDate = z.string().date().optional().nullable();
const optionalText = z.string().optional().nullable();

export const availableDateStatusSchema = z.enum(['available', 'limited', 'full', 'cancelled']);

const availableDateBaseSchema = z.object({
  tour_id: z.string().uuid(),
  start_date: z.string().date(),
  end_date: optionalDate,
  available_slots: nullableInteger,
  price: nullableMoney,
  currency: z.string().trim().min(3).max(3).default('USD'),
  status: availableDateStatusSchema.default('available'),
  notes: optionalText
});

export const availableDateCreateSchema = availableDateBaseSchema.refine((value) => !value.end_date || value.end_date >= value.start_date, {
  message: 'End date must not be before start date.',
  path: ['end_date']
});

export const availableDateUpdateSchema = availableDateBaseSchema.partial();
