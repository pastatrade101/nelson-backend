import { z } from 'zod';

export const SETTING_TYPES = [
  'text',
  'textarea',
  'url',
  'email',
  'phone',
  'boolean',
  'color',
  'image',
  'json',
  'select',
  'number'
] as const;

// Setting keys that look like secrets must never live in website_settings.
const FORBIDDEN_FRAGMENTS = ['SECRET', 'TOKEN', 'PRIVATE', 'SERVICE_ROLE', 'API_KEY', 'PASSWORD', 'JWT'];

export const isForbiddenKey = (key: string) => {
  const upper = String(key).toUpperCase();
  return FORBIDDEN_FRAGMENTS.some((fragment) => upper.includes(fragment));
};

const settingKey = z
  .string()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers, and underscores only.')
  .refine((key) => !isForbiddenKey(key), 'This key is not allowed — secret-like keys must stay in backend .env.');

export const settingCreateSchema = z.object({
  setting_key: settingKey,
  setting_value: z.unknown(),
  setting_group: z.string().min(1).default('general'),
  setting_type: z.enum(SETTING_TYPES).default('text'),
  is_public: z.coerce.boolean().default(false),
  description: z.string().optional().nullable()
});

export const settingUpdateSchema = z.object({
  setting_value: z.unknown(),
  setting_group: z.string().min(1).optional(),
  setting_type: z.enum(SETTING_TYPES).optional(),
  is_public: z.coerce.boolean().optional(),
  description: z.string().optional().nullable()
});
