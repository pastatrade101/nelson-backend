import { z } from 'zod';

export const paymentCreateSchema = z.object({
  booking_id: z.string().uuid(),
  amount: z.coerce.number().positive(),
  currency: z.string().min(3).max(3).default('USD'),
  payment_method: z.string().optional().nullable(),
  transaction_reference: z.string().optional().nullable(),
  payment_provider: z.string().optional().nullable(),
  status: z.enum(['unpaid', 'partially_paid', 'paid', 'refunded', 'failed']).default('unpaid'),
  paid_at: z.string().optional().nullable(),
  notes: z.string().optional().nullable()
});

export const paymentUpdateSchema = paymentCreateSchema.partial();
