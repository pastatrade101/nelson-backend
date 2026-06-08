import { z } from 'zod';

const mediaTypeSchema = z.enum(['image', 'video', 'document']);
const optionalText = z.string().optional().nullable();

export const mediaCreateSchema = z.object({
  file_name: z.string().min(1),
  file_url: z.string().url(),
  file_path: z.string().min(1),
  file_type: mediaTypeSchema.default('image'),
  mime_type: optionalText,
  file_size: z.coerce.number().int().nonnegative().optional().nullable(),
  alt_text: optionalText,
  caption: optionalText
});

export const mediaUpdateSchema = z.object({
  alt_text: optionalText,
  caption: optionalText,
  file_name: z.string().min(1).optional()
});
