import { z } from 'zod';

const statusSchema = z.enum(['draft', 'published', 'archived']);
const optionalUrl = z.union([z.string().url(), z.literal('')]).optional().nullable();

export const activityCreateSchema = z.object({
  name: z.string().min(2),
  slug: z.string().min(2).optional(),
  destination_id: z.union([z.string().uuid(), z.literal('')]).optional().nullable(),
  location_label: z.string().optional().nullable(),
  category: z
    .enum(['wildlife', 'adventure', 'cultural', 'water', 'trekking', 'relaxation'])
    .default('wildlife'),
  difficulty: z.enum(['easy', 'moderate', 'challenging', 'strenuous']).optional().nullable(),
  description: z.string().optional().nullable(),
  why_we_recommend: z.string().optional().nullable(),
  highlights: z.array(z.string()).optional(),
  hero_image_url: optionalUrl,
  image_url: optionalUrl,
  duration_label: z.string().optional().nullable(),
  price_from: z.coerce.number().nonnegative().optional().nullable(),
  currency: z.string().min(3).max(3).default('USD'),
  price_unit: z.string().optional().nullable(),
  badge: z.string().optional().nullable(),
  best_season: z.array(z.string()).optional(),
  status: statusSchema.default('draft'),
  is_featured: z.coerce.boolean().default(false),
  seo_title: z.string().optional().nullable(),
  meta_title: z.string().optional().nullable(),
  meta_description: z.string().optional().nullable()
});

export const activityUpdateSchema = activityCreateSchema.partial();
