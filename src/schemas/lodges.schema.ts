import { z } from 'zod';

const statusSchema = z.enum(['draft', 'published', 'archived']);
const optionalUrl = z.union([z.string().url(), z.literal('')]).optional().nullable();

/**
 * Comfort tier, matching the DB CHECK constraint exactly.
 *
 * This previously accepted 'budget' and 'mid_range' and DEFAULTED to 'mid_range'
 * — values the `lodges.accommodation_level` check rejects, so a create that
 * omitted the field was refused by Postgres. Legacy spellings are still accepted
 * and normalised rather than rejected, so an older client or an import file keeps
 * working; they simply land on the canonical value the rest of the site uses
 * (see $lib/tiers on the frontend).
 */
const TIER_ALIAS: Record<string, string> = {
  budget: 'essential',
  comfortable: 'essential',
  essential: 'essential',
  mid_range: 'classic',
  midrange: 'classic',
  standard: 'classic',
  classic: 'classic',
  luxury: 'luxury',
  luxury_plus: 'ultra_luxury',
  premium_luxury: 'ultra_luxury',
  ultra_luxury: 'ultra_luxury'
};

const accommodationLevel = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const key = value.toLowerCase().trim().replace(/[\s-]+/g, '_');
    return TIER_ALIAS[key] ?? value;
  },
  z.enum(['essential', 'classic', 'luxury', 'ultra_luxury'])
).default('classic');

/** Free-text lists whose vocabulary is editorial and expected to grow. */
const textList = (max = 30) => z.array(z.string().max(120)).max(max).optional();

export const lodgeCreateSchema = z.object({
  name: z.string().min(2),
  slug: z.string().min(2).optional(),
  destination_id: z.union([z.string().uuid(), z.literal('')]).optional().nullable(),
  accommodation_level: accommodationLevel,
  lodge_type: z.enum(['tented_camp', 'lodge', 'hotel', 'mobile_camp', 'treehouse']).default('lodge'),

  // ── Story ────────────────────────────────────────────────────────────────
  short_description: z.string().max(500).optional().nullable(),
  description: z.string().optional().nullable(),
  why_we_recommend: z.string().optional().nullable(),

  // ── Where it is ──────────────────────────────────────────────────────────
  country: z.string().max(100).optional().nullable(),
  region: z.string().max(120).optional().nullable(),
  park_area: z.string().max(160).optional().nullable(),
  settings: textList(10),
  recommended_nights: z.coerce.number().int().min(1).max(30).optional().nullable(),
  best_months: textList(12),

  // ── Images ───────────────────────────────────────────────────────────────
  hero_image_url: optionalUrl,
  image_url: optionalUrl,
  mobile_hero_image_url: optionalUrl,
  social_image_url: optionalUrl,

  // ── Getting there ────────────────────────────────────────────────────────
  google_maps_url: optionalUrl,
  latitude: z.coerce.number().min(-90).max(90).optional().nullable(),
  longitude: z.coerce.number().min(-180).max(180).optional().nullable(),
  nearest_airport: z.string().max(180).optional().nullable(),
  transfer_time: z.string().max(120).optional().nullable(),
  distance_airstrip: z.string().max(120).optional().nullable(),
  distance_park_gate: z.string().max(120).optional().nullable(),
  road_accessibility: z
    .enum(['all_vehicles', 'four_by_four_recommended', 'four_by_four_required', 'seasonal_access', 'fly_in_only'])
    .optional()
    .nullable(),
  fly_in_available: z.coerce.boolean().optional().nullable(),
  transfer_available: z.coerce.boolean().optional().nullable(),

  // ── Who it suits ─────────────────────────────────────────────────────────
  best_for: textList(20),
  children_allowed: z.coerce.boolean().optional().nullable(),
  minimum_child_age: z.coerce.number().int().min(0).max(18).optional().nullable(),
  family_friendly: z.coerce.boolean().optional().nullable(),
  honeymoon_friendly: z.coerce.boolean().optional().nullable(),
  accessibility: z.enum(['fully_accessible', 'partially_accessible', 'not_accessible', 'unknown']).optional().nullable(),
  wheelchair_accessible: z.coerce.boolean().optional().nullable(),
  romantic_rating: z.coerce.number().min(0).max(10).optional().nullable(),
  family_rating: z.coerce.number().min(0).max(10).optional().nullable(),

  // ── Practicalities ───────────────────────────────────────────────────────
  electricity_availability: z
    .enum(['twenty_four_hours', 'limited_hours', 'solar_only', 'generator_backup', 'no_reliable_power'])
    .optional()
    .nullable(),
  wifi_availability: z
    .enum(['property_wide', 'common_areas_only', 'rooms_only', 'limited', 'not_available'])
    .optional()
    .nullable(),
  mobile_networks: textList(8),
  arrival_instructions: z.string().optional().nullable(),
  traveler_notes: z.string().optional().nullable(),

  // ── Commercial ───────────────────────────────────────────────────────────
  price_per_night_from: z.coerce.number().nonnegative().optional().nullable(),
  currency: z.string().min(3).max(3).default('USD'),
  website_url: optionalUrl,
  show_rates_publicly: z.coerce.boolean().optional(),

  // ── Publishing ───────────────────────────────────────────────────────────
  status: statusSchema.default('draft'),
  is_featured: z.coerce.boolean().default(false),
  indexable: z.coerce.boolean().optional(),
  seo_title: z.string().optional().nullable(),
  meta_title: z.string().optional().nullable(),
  meta_description: z.string().optional().nullable()
});

export const lodgeUpdateSchema = lodgeCreateSchema.partial();

/**
 * Rooms, rates, highlights and inclusions, replaced as one document.
 *
 * The admin edits them together — adding a room while reordering rates — so a
 * single atomic replace matches what the editor actually does and avoids a
 * per-row diff that could half-apply.
 */
const roomImage = z.object({
  image_url: z.string().min(1).max(2048),
  alt_text: z.string().max(300).optional().nullable(),
  caption: z.string().max(500).optional().nullable()
});

export const lodgeDetailsReplaceSchema = z.object({
  highlights: z.array(z.object({ title: z.string().min(1).max(180) })).max(30).default([]),
  rooms: z
    .array(
      z.object({
        name: z.string().min(1).max(160),
        room_type: z.string().max(60).optional().nullable(),
        short_description: z.string().max(800).optional().nullable(),
        max_adults: z.coerce.number().int().min(0).max(30).optional().nullable(),
        max_children: z.coerce.number().int().min(0).max(30).optional().nullable(),
        max_guests: z.coerce.number().int().min(1).max(50).optional().nullable(),
        bed_types: textList(8),
        unit_count: z.coerce.number().int().min(1).max(1000).optional().nullable(),
        views: textList(12),
        amenities: textList(50),
        images: z.array(roomImage).max(30).default([])
      })
    )
    .max(50)
    .default([]),
  rates: z
    .array(
      z.object({
        season_type: z.string().max(40).optional().nullable(),
        season_name: z.string().max(120).optional().nullable(),
        valid_from: z.union([z.string(), z.literal('')]).optional().nullable(),
        valid_until: z.union([z.string(), z.literal('')]).optional().nullable(),
        currency: z.string().min(3).max(3).default('USD'),
        rack_rate: z.coerce.number().nonnegative().optional().nullable(),
        net_rate: z.coerce.number().nonnegative().optional().nullable(),
        single_rate: z.coerce.number().nonnegative().optional().nullable(),
        double_rate: z.coerce.number().nonnegative().optional().nullable(),
        triple_rate: z.coerce.number().nonnegative().optional().nullable(),
        child_rate: z.coerce.number().nonnegative().optional().nullable(),
        single_supplement: z.coerce.number().nonnegative().optional().nullable(),
        pricing_basis: z.string().max(40).optional().nullable(),
        meal_plan: z.string().max(40).optional().nullable(),
        notes: z.string().max(800).optional().nullable()
      })
    )
    .max(100)
    .default([]),
  inclusions: z
    .array(z.object({ title: z.string().min(1).max(240), is_included: z.coerce.boolean().default(true) }))
    .max(100)
    .default([])
});
