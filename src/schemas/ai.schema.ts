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

// Page context (lenient strings — public endpoint; ids are filtered, not trusted).
export const aiPageContextSchema = z
  .object({
    path: z.string().max(300).optional(),
    tour_id: z.string().max(200).optional(),
    tour_slug: z.string().max(200).optional(),
    destination_id: z.string().max(200).optional(),
    departure_id: z.string().max(200).optional()
  })
  .partial();

export const aiChatSchema = z.object({
  conversationId: z.string().uuid().optional(),
  lead: aiLeadContextSchema.optional(),
  message: z.string().min(1).max(2000),
  page_context: aiPageContextSchema.optional(),
  shortlist: z.array(z.string().max(200)).max(50).optional(),
  turnstile_token: z.string().max(4000).optional(),
  idempotency_key: z.string().uuid().optional()
});

export const aiHandoffSchema = z.object({
  notes: z.string().max(2000).optional(),
  stage: z.string().max(80).default('New Lead')
});

export const aiCreateBookingSchema = z.object({
  confirmed_by_user: z.literal(true),
  idempotency_key: z.string().uuid()
});

// Admin content co-pilot (Phase 7) — authoring help inside the CMS.
export const aiAssistSchema = z.object({
  task: z.enum([
    'write_short',
    'write_description',
    'improve',
    'shorten',
    'suggest_highlights',
    'seo_meta',
    'translate_sw',
    'draft_itinerary'
  ]),
  text: z.string().max(8000).optional(),
  language: z.enum(['en', 'sw']).optional(),
  context: z
    .object({
      title: z.string().max(300).optional(),
      destination: z.string().max(200).optional(),
      duration_days: z.coerce.number().int().positive().max(60).optional(),
      budget_tier: z.string().max(80).optional(),
      highlights: z.string().max(4000).optional(),
      short_description: z.string().max(4000).optional(),
      full_description: z.string().max(8000).optional()
    })
    .partial()
    .optional()
});

// Admin: update conversation pipeline status / lead status.
export const aiStatusSchema = z
  .object({
    status: z.string().max(40).optional(),
    lead_status: z.string().max(40).optional()
  })
  .refine((v) => v.status || v.lead_status, { message: 'Provide status or lead_status.' });

// Admin: create a booking request from a conversation.
export const aiAdminBookingSchema = z.object({
  idempotency_key: z.string().uuid().optional()
});
