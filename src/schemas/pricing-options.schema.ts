import { z } from 'zod';

const optionalText = z.string().optional().nullable();

export const priceTypeSchema = z.enum([
  'per_person',
  'per_group',
  'per_child',
  'single_supplement',
  'upgrade',
  'discount'
]);

const pricingOptionBaseSchema = z.object({
  tour_id: z.string().uuid(),
  title: z.string().trim().min(2),
  description: optionalText,
  price: z.coerce.number().min(0),
  // Per-child rate for the same comfort level (2026-11-16). Optional: blank
  // means "on request". An empty form field arrives as '' or null, which must
  // stay null rather than coerce to 0, so it is normalised before coercion.
  child_price: z.preprocess(
    (value) => (value === '' || value === undefined ? null : value),
    z.coerce.number().min(0).nullable()
  ).optional(),
  currency: z.string().trim().min(3).max(3).default('USD'),
  price_type: priceTypeSchema.default('per_person'),
  sort_order: z.coerce.number().int().default(0)
});

export const pricingOptionCreateSchema = pricingOptionBaseSchema;
export const pricingOptionUpdateSchema = pricingOptionBaseSchema.partial();
