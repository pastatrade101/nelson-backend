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

export const COMFORT_TIERS = ['essential', 'classic', 'luxury', 'ultra_luxury'] as const;
const comfortTierSchema = z.enum(COMFORT_TIERS);
const travellersSchema = z.coerce.number().int().min(1).max(20);

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
  sort_order: z.coerce.number().int().default(0),
  // Price grid (2026-11-18): which comfort level and group size this adult
  // price is for, and the lodges at that level. Null on old-style options.
  comfort_tier: comfortTierSchema.nullable().optional(),
  travellers_from: travellersSchema.nullable().optional(),
  travellers_to: travellersSchema.nullable().optional(),
  lodges: z.string().trim().max(500).nullable().optional()
});

const bothOrNeither = (option: { travellers_from?: number | null; travellers_to?: number | null }) => {
  const from = option.travellers_from ?? null;
  const to = option.travellers_to ?? null;
  if (from === null && to === null) return true;
  return from !== null && to !== null && to >= from;
};
const travellersMessage = { message: 'Set both “travellers from” and “travellers to”, with “to” not below “from”.', path: ['travellers_to'] };

export const pricingOptionCreateSchema = pricingOptionBaseSchema.refine(bothOrNeither, travellersMessage);
export const pricingOptionUpdateSchema = pricingOptionBaseSchema.partial().refine(
  // A partial update may leave both out; if either is sent, both must be valid.
  (option) => (option.travellers_from === undefined && option.travellers_to === undefined) || bothOrNeither(option),
  travellersMessage
);

/**
 * The tour's whole price grid, saved in one go from the tour editor: every
 * comfort level with its lodges and child price, and an adult price per
 * group-size band. A blank adult price is sent as null and shown as
 * "On request". Old-style options (no comfort level) are left untouched.
 */
export const GRID_BANDS = [
  { from: 1, to: 1 },
  { from: 2, to: 2 },
  { from: 3, to: 4 },
  { from: 5, to: 6 }
] as const;

const blankToNull = (value: unknown) => (value === '' || value === undefined ? null : value);
const money = z.preprocess(blankToNull, z.coerce.number().min(0).max(1_000_000).nullable());

export const priceGridSchema = z.object({
  currency: z.string().trim().length(3).default('USD'),
  tiers: z
    .array(
      z.object({
        comfort_tier: comfortTierSchema,
        lodges: z.string().trim().max(500).optional().nullable(),
        child_price: money.optional(),
        bands: z
          .array(z.object({ travellers_from: travellersSchema, travellers_to: travellersSchema, price: money }))
          .max(GRID_BANDS.length)
          .refine(
            (bands) => bands.every((band) => GRID_BANDS.some((b) => b.from === band.travellers_from && b.to === band.travellers_to)),
            { message: 'Group sizes must be 1, 2, 3–4 or 5–6 travellers.' }
          )
      })
    )
    .max(4)
    .refine((tiers) => new Set(tiers.map((tier) => tier.comfort_tier)).size === tiers.length, {
      message: 'Each comfort level can appear only once.'
    })
});

export type PriceGridInput = z.infer<typeof priceGridSchema>;
