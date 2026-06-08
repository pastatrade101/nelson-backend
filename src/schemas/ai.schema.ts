import { z } from 'zod';

export const aiLeadContextSchema = z
  .object({
    budget_tier: z.string().max(80).optional(),
    destination: z.string().max(120).optional(),
    duration_days: z.coerce.number().int().positive().max(90).optional(),
    email: z.string().email().optional(),
    full_name: z.string().max(160).optional(),
    persona_tags: z.array(z.string().max(80)).optional(),
    phone: z.string().max(80).optional(),
    travel_timing: z.string().max(160).optional()
  })
  .partial();

export const aiChatSchema = z.object({
  conversationId: z.string().uuid().optional(),
  lead: aiLeadContextSchema.optional(),
  message: z.string().min(2).max(2000)
});

export const aiHandoffSchema = z.object({
  notes: z.string().max(2000).optional(),
  stage: z.string().max(80).default('New Lead')
});
