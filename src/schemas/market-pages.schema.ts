import { z } from 'zod';

const statusSchema = z.enum(['draft', 'published', 'archived']);
const optionalUrl = z.union([z.string().url(), z.literal('')]).optional().nullable();

// A section is one ordered content block of the market-page template
// (relevance / benefits / packages / comparison / inclusions / prose / faq /
// reviews / cta). Validated loosely — a block only needs a string `type` — so
// marketing can evolve the block shapes in the admin without a backend change.
// The frontend renders the blocks it knows and ignores the rest.
const sectionSchema = z.object({ type: z.string().min(1) }).passthrough();

// `z.coerce.boolean()` maps the string "false" to true, which would silently keep
// a page noindexed after marketing unticks the box, so parse the string forms
// explicitly and accept real booleans unchanged.
const flexibleBoolean = z.union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')]);

export const marketPageCreateSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(2).optional(),
  market_code: z.string().optional().nullable(),
  hero_eyebrow: z.string().optional().nullable(),
  hero_title: z.string().optional().nullable(),
  hero_subtitle: z.string().optional().nullable(),
  hero_image_url: optionalUrl,
  hero_cta_label: z.string().optional().nullable(),
  hero_cta_href: z.string().optional().nullable(),
  sections: z.array(sectionSchema).default([]),
  featured_tour_ids: z.array(z.string().uuid()).default([]),
  meta_title: z.string().optional().nullable(),
  meta_description: z.string().optional().nullable(),
  og_image_url: optionalUrl,
  // Ads landing pages default to noindex; marketing opts a market in explicitly.
  noindex: flexibleBoolean.default(true),
  status: statusSchema.default('draft'),
  sort_order: z.coerce.number().int().min(0).default(0)
});

export const marketPageUpdateSchema = marketPageCreateSchema.partial();
