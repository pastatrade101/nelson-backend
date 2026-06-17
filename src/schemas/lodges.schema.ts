import { z } from 'zod';

const statusSchema = z.enum(['draft', 'published', 'archived']);
const optionalUrl = z.union([z.string().url(), z.literal('')]).optional().nullable();

export const lodgeCreateSchema = z.object({
  name: z.string().min(2),
  slug: z.string().min(2).optional(),
  destination_id: z.union([z.string().uuid(), z.literal('')]).optional().nullable(),
  accommodation_level: z.enum(['budget', 'mid_range', 'luxury', 'ultra_luxury']).default('mid_range'),
  lodge_type: z.enum(['tented_camp', 'lodge', 'hotel', 'mobile_camp', 'treehouse']).default('lodge'),
  description: z.string().optional().nullable(),
  why_we_recommend: z.string().optional().nullable(),
  hero_image_url: optionalUrl,
  image_url: optionalUrl,
  price_per_night_from: z.coerce.number().nonnegative().optional().nullable(),
  currency: z.string().min(3).max(3).default('USD'),
  best_for: z.array(z.string()).optional(),
  romantic_rating: z.coerce.number().min(0).max(10).optional().nullable(),
  family_rating: z.coerce.number().min(0).max(10).optional().nullable(),
  website_url: optionalUrl,
  status: statusSchema.default('draft'),
  is_featured: z.coerce.boolean().default(false),
  seo_title: z.string().optional().nullable(),
  meta_title: z.string().optional().nullable(),
  meta_description: z.string().optional().nullable()
});

export const lodgeUpdateSchema = lodgeCreateSchema.partial();
