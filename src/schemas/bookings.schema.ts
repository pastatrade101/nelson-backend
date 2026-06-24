import { z } from 'zod';

export const BOOKING_STATUSES = [
  'pending',
  'contacted',
  'itinerary_sent',
  'negotiating',
  'confirmed',
  'cancelled',
  'completed',
  'rejected'
] as const;

export const PAYMENT_STATUSES = ['unpaid', 'partially_paid', 'paid', 'refunded', 'failed'] as const;

export const BOOKING_SOURCES = [
  'website_booking_form',
  'plan_my_trip',
  'ai_handoff',
  'whatsapp',
  'admin_created',
  'hubspot_import'
] as const;

const statusEnum = z.enum(BOOKING_STATUSES);
const paymentEnum = z.enum(PAYMENT_STATUSES);
const sourceEnum = z.enum(BOOKING_SOURCES);
const uuidOrEmpty = z.union([z.string().uuid(), z.literal('')]).optional().nullable();
const optionalDate = z
  .union([z.string().regex(/^\d{4}-\d{2}-\d{2}/), z.literal('')])
  .optional()
  .nullable();

// Flexible lead details captured by Plan My Trip / AI handoff.
const leadContextSchema = z.record(z.unknown()).optional().nullable();

export const bookingCreateSchema = z.object({
  tour_id: uuidOrEmpty,
  full_name: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(6).optional().nullable(),
  country: z.string().optional().nullable(),
  travel_date: optionalDate,
  number_of_adults: z.coerce.number().int().min(1).default(1),
  number_of_children: z.coerce.number().int().min(0).default(0),
  special_requests: z.string().optional().nullable(),
  message: z.string().optional().nullable(),
  estimated_amount: z.coerce.number().nonnegative().optional().nullable(),
  currency: z.string().min(3).max(3).default('USD'),
  source: sourceEnum.default('website_booking_form'),
  ai_conversation_id: uuidOrEmpty,
  lead_context: leadContextSchema,
  // Honeypot — must stay empty for humans. Kept in the schema (zod strips unknown
  // keys) so the controller can inspect it, then it is dropped before insert.
  hp_company: z.string().max(120).optional().nullable()
});

export const bookingUpdateSchema = z.object({
  tour_id: uuidOrEmpty,
  full_name: z.string().min(2).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  travel_date: optionalDate,
  number_of_adults: z.coerce.number().int().min(1).optional(),
  number_of_children: z.coerce.number().int().min(0).optional(),
  special_requests: z.string().optional().nullable(),
  message: z.string().optional().nullable(),
  estimated_amount: z.coerce.number().nonnegative().optional().nullable(),
  currency: z.string().min(3).max(3).optional(),
  status: statusEnum.optional(),
  payment_status: paymentEnum.optional(),
  admin_notes: z.string().optional().nullable(),
  assigned_to: uuidOrEmpty,
  source: sourceEnum.optional(),
  lead_context: leadContextSchema
});

export const bookingStatusSchema = z.object({
  status: statusEnum,
  admin_notes: z.string().optional().nullable()
});

export const bookingAssignSchema = z.object({
  assigned_to: z.union([z.string().uuid(), z.literal('')]).nullable()
});

export const bookingNotesSchema = z.object({
  admin_notes: z.string().optional().nullable()
});
