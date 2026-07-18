import { z } from 'zod';

export const hubspotLeadSchema = z.object({
  budget_tier: z.string().max(80).optional(),
  destination: z.string().max(120).optional(),
  email: z.string().email(),
  full_name: z.string().min(2).max(160),
  message: z.string().max(2000).optional(),
  phone: z.string().max(80).optional(),
  source: z.string().max(120).default('Emnel Adventures'),
  stage: z.string().max(80).default('New Lead')
});

export const hubspotBookingSchema = hubspotLeadSchema.extend({
  booking_id: z.string().uuid().optional(),
  tour_id: z.string().uuid().optional(),
  travel_date: z.string().optional()
});
