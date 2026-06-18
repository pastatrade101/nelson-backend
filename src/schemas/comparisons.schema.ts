import { z } from 'zod';

const statusSchema = z.enum(['draft', 'published', 'archived']);
const optionalUrl = z.union([z.string().url(), z.literal('')]).optional().nullable();

const dimensionSchema = z.object({
  label: z.string(),
  a: z.string(),
  b: z.string()
});
const faqSchema = z.object({
  q: z.string(),
  a: z.string()
});

export const comparisonCreateSchema = z.object({
  title: z.string().min(2),
  slug: z.string().min(2).optional(),
  eyebrow: z.string().optional().nullable(),
  intro: z.string().optional().nullable(),
  a_name: z.string().min(1),
  a_image_url: optionalUrl,
  b_name: z.string().min(1),
  b_image_url: optionalUrl,
  dimensions: z.array(dimensionSchema).optional(),
  verdict: z.string().optional().nullable(),
  cta_label: z.string().optional().nullable(),
  cta_href: z.string().optional().nullable(),
  faqs: z.array(faqSchema).optional(),
  status: statusSchema.default('draft'),
  is_featured: z.coerce.boolean().default(false),
  sort_order: z.coerce.number().int().optional().nullable(),
  seo_title: z.string().optional().nullable(),
  meta_title: z.string().optional().nullable(),
  meta_description: z.string().optional().nullable()
});

export const comparisonUpdateSchema = comparisonCreateSchema.partial();
