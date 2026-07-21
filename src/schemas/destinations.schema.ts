import { z } from 'zod';

const statusSchema = z.enum(['draft', 'published', 'archived']);
const optionalUrl = z.union([z.string().url(), z.literal('')]).optional().nullable();

export const destinationCreateSchema = z.object({
  name: z.string().min(2),
  slug: z.string().min(2).optional(),
  country: z.string().min(2).default('Tanzania'),
  region: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  short_description: z.string().optional().nullable(),
  description: z.string().min(5).optional().nullable(),
  image_url: optionalUrl,
  main_image_url: optionalUrl,
  banner_image_url: optionalUrl,
  latitude: z.coerce.number().optional().nullable(),
  longitude: z.coerce.number().optional().nullable(),
  safety_overview: z.string().optional().nullable(),
  health_vaccinations: z.string().optional().nullable(),
  security_advice: z.string().optional().nullable(),
  travel_insurance_note: z.string().optional().nullable(),
  emergency_contacts: z.string().optional().nullable(),
  score_wildlife: z.coerce.number().min(0).max(10).optional().nullable(),
  score_luxury: z.coerce.number().min(0).max(10).optional().nullable(),
  score_family: z.coerce.number().min(0).max(10).optional().nullable(),
  score_photography: z.coerce.number().min(0).max(10).optional().nullable(),
  score_adventure: z.coerce.number().min(0).max(10).optional().nullable(),
  score_budget_from: z.coerce.number().nonnegative().optional().nullable(),
  status: statusSchema.default('draft'),
  is_featured: z.coerce.boolean().default(false),
  meta_title: z.string().optional().nullable(),
  meta_description: z.string().optional().nullable(),
  og_image_url: optionalUrl,
  // Long-form destination guide (jsonb): an ordered array of typed content blocks.
  // Validated loosely — a block only needs a string `type` — so the editorial schema
  // can evolve without backend changes. Rendered by the frontend DestinationGuide.
  guide: z.array(z.object({ type: z.string() }).passthrough()).optional().nullable(),
  guide_reviewed_at: z.string().optional().nullable()
});

export const destinationUpdateSchema = destinationCreateSchema.partial();
