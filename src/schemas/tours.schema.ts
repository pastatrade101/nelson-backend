import { z } from 'zod';

const statusSchema = z.enum(['draft', 'published', 'archived']);
const optionalUrl = z.union([z.string().url(), z.literal('')]).optional().nullable();
const optionalUuid = z.union([z.string().uuid(), z.literal('')]).optional().nullable();

export const tourCreateSchema = z.object({
  title: z.string().min(2),
  slug: z.string().min(2).optional(),
  short_description: z.string().min(5).optional().nullable(),
  full_description: z.string().min(5).optional().nullable(),
  destination_id: optionalUuid,
  category_id: optionalUuid,
  experience_type: z.string().max(120).optional().nullable(),
  persona_tags: z.array(z.string().max(80)).default([]),
  budget_tier: z.string().max(80).optional().nullable(),
  duration_days: z.coerce.number().int().positive(),
  duration_nights: z.coerce.number().int().min(0).default(0),
  price_from: z.coerce.number().nonnegative(),
  currency: z.string().min(3).max(3).default('USD'),
  main_image_url: optionalUrl,
  banner_image_url: optionalUrl,
  sample_itinerary: z.union([z.array(z.record(z.unknown())), z.string()]).optional().nullable(),
  highlights: z.array(z.string()).default([]),
  difficulty_level: z.string().optional().nullable(),
  group_size: z.string().optional().nullable(),
  group_size_min: z.coerce.number().int().min(0).optional().nullable(),
  group_size_max: z.coerce.number().int().min(0).optional().nullable(),
  minimum_age: z.coerce.number().int().min(0).optional().nullable(),
  start_location: z.string().optional().nullable(),
  end_location: z.string().optional().nullable(),
  status: statusSchema.default('draft'),
  is_available: z.coerce.boolean().default(true),
  is_featured: z.coerce.boolean().default(false),
  is_popular: z.coerce.boolean().default(false),
  seats_remaining: z.coerce.number().int().min(0).optional().nullable(),
  seo_title: z.string().optional().nullable(),
  meta_title: z.string().optional().nullable(),
  meta_description: z.string().optional().nullable(),
  og_image: optionalUrl,
  og_image_url: optionalUrl
});

export const tourUpdateSchema = tourCreateSchema.partial();
