import { z } from 'zod';

export const contactCreateSchema = z.object({
  full_name: z.string().min(2),
  email: z.string().email(),
  phone: z.string().optional().nullable(),
  subject: z.string().optional().nullable(),
  message: z.string().min(10)
});

export const contactStatusSchema = z.object({
  status: z.enum(['new', 'read', 'replied', 'archived'])
});

export const contactAssignSchema = z.object({
  assigned_to: z.union([z.string().uuid(), z.literal('')]).nullable()
});

export const contactNotesSchema = z.object({
  admin_notes: z.string().optional().nullable()
});
