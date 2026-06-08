import { z } from 'zod';
import { adminRoles } from '../config/permissions';

const roleSchema = z.enum(adminRoles as [string, ...string[]]);
const optionalUrl = z.union([z.string().url(), z.literal('')]).optional().nullable();

export const userCreateSchema = z.object({
  full_name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  phone: z.string().optional().nullable(),
  avatar_url: optionalUrl,
  role: roleSchema.default('viewer'),
  is_active: z.coerce.boolean().default(true)
});

export const userUpdateSchema = userCreateSchema
  .omit({ password: true })
  .extend({
    password: z.string().min(8).optional()
  })
  .partial();

export const userStatusSchema = z.object({
  is_active: z.coerce.boolean()
});

export const userPasswordSchema = z.object({
  password: z.string().min(8)
});
