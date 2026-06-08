import { z } from 'zod';

const extraData = z.union([z.record(z.unknown()), z.array(z.unknown())]).optional().nullable();

export const homepageSectionCreateSchema = z.object({
  section_key: z
    .string()
    .min(2)
    .regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers, and underscores only.'),
  title: z.string().optional().nullable(),
  subtitle: z.string().optional().nullable(),
  content: z.string().optional().nullable(),
  image_url: z.union([z.string().url(), z.literal('')]).optional().nullable(),
  button_text: z.string().optional().nullable(),
  button_url: z.string().optional().nullable(),
  extra_data: extraData,
  is_active: z.boolean().optional().default(true),
  sort_order: z.coerce.number().int().min(0).default(0)
});

export const homepageSectionUpdateSchema = homepageSectionCreateSchema.partial();
