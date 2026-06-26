import { createHash, randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { supabase } from '../config/supabase';
import { AppError } from '../utils/api-response';

// How long a generated magic link stays valid (covers the whole pre-trip
// window: deposits, balance payments, document exchange).
const LINK_TTL_DAYS = 120;
// How long a browser session lasts after opening a valid link.
const SESSION_TTL = '14d';
export const TRIP_COOKIE = 'gf_trip';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const frontendOrigin = () => env.FRONTEND_URL.split(',')[0].replace(/\/$/, '');

type TripSession = { bid: string; scope: 'trip' };

/** Sign the per-booking session token stored in the httpOnly cookie. */
export const signTripSession = (bookingId: string): string =>
  jwt.sign({ bid: bookingId, scope: 'trip' } satisfies TripSession, env.JWT_SECRET, { expiresIn: SESSION_TTL });

/** Verify a session token and return the booking id, or null. Scope-checked so
 *  an admin token can never be used here and vice-versa. */
export const verifyTripSession = (token: string | undefined): string | null => {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as Partial<TripSession>;
    return payload?.scope === 'trip' && typeof payload.bid === 'string' ? payload.bid : null;
  } catch {
    return null;
  }
};

/**
 * Create a fresh magic link for a booking. Any previously-issued links are
 * revoked so only the latest one works (regenerating disables an old/leaked
 * link). Returns the full URL — only the hash is persisted.
 */
export const createTripLink = async (bookingId: string, adminId: string | null) => {
  const { data: booking, error } = await supabase
    .from('booking_requests')
    .select('id')
    .eq('id', bookingId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new AppError('Unable to load booking.', 500, [error]);
  if (!booking) throw new AppError('Booking not found.', 404);

  // Revoke existing active links for this booking.
  await supabase
    .from('trip_access_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('booking_id', bookingId)
    .is('revoked_at', null);

  const rawToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + LINK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { error: insertError } = await supabase.from('trip_access_tokens').insert({
    booking_id: bookingId,
    token_hash: sha256(rawToken),
    expires_at: expiresAt,
    created_by: adminId
  });
  if (insertError) throw new AppError('Unable to create trip link.', 500, [insertError]);

  return { url: `${frontendOrigin()}/trip/${rawToken}`, expiresAt };
};

/** Exchange a raw magic-link token for the booking id it grants access to. */
export const redeemTripToken = async (rawToken: string): Promise<string | null> => {
  if (!rawToken || rawToken.length < 20) return null;
  const { data, error } = await supabase
    .from('trip_access_tokens')
    .select('id, booking_id, expires_at, revoked_at')
    .eq('token_hash', sha256(rawToken))
    .maybeSingle();
  if (error || !data) return null;
  if (data.revoked_at || new Date(data.expires_at).getTime() < Date.now()) return null;

  await supabase.from('trip_access_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', data.id);
  return data.booking_id as string;
};

/**
 * Build the customer-safe view of a booking. Deliberately excludes everything
 * internal (admin_notes, assigned_to, lead_context, ai_conversation_id, source,
 * raw ids). Returns null if the booking is missing/deleted.
 */
export const getTripView = async (bookingId: string) => {
  const { data: booking, error } = await supabase
    .from('booking_requests')
    .select(
      'booking_code, full_name, email, phone, country, travel_date, number_of_adults, number_of_children, total_people, special_requests, message, estimated_amount, currency, status, payment_status, tour_id, tours(title, slug, main_image_url, duration_days)'
    )
    .eq('id', bookingId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new AppError('Unable to load trip.', 500, [error]);
  if (!booking) return null;

  const b = booking as Record<string, unknown>;

  const { data: paymentRows } = await supabase
    .from('booking_payments')
    .select('amount, currency, payment_method, transaction_reference, status, paid_at')
    .eq('booking_id', bookingId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  const payments = (paymentRows ?? []) as Array<Record<string, unknown>>;

  let itinerary: Array<Record<string, unknown>> = [];
  if (b.tour_id) {
    const { data: days } = await supabase
      .from('itinerary_days')
      .select('day_number, title, description, accommodation, meals, activities, image_url')
      .eq('tour_id', b.tour_id)
      .order('day_number', { ascending: true });
    itinerary = (days ?? []) as Array<Record<string, unknown>>;
  }

  const estimated = Number(b.estimated_amount ?? 0);
  const paid = payments
    .filter((p) => p.status === 'paid')
    .reduce((sum, p) => sum + Number(p.amount ?? 0), 0);

  return {
    booking_code: b.booking_code,
    full_name: b.full_name,
    email: b.email,
    phone: b.phone,
    country: b.country,
    travel_date: b.travel_date,
    number_of_adults: b.number_of_adults,
    number_of_children: b.number_of_children,
    total_people: b.total_people,
    special_requests: b.special_requests,
    message: b.message,
    status: b.status,
    payment_status: b.payment_status,
    currency: b.currency,
    estimated_amount: b.estimated_amount,
    amount_paid: paid,
    balance_due: Math.max(0, estimated - paid),
    tour: b.tours ?? null,
    payments,
    itinerary
  };
};

/** Record a message from the traveller. Reuses contact_messages so it lands in
 *  the admin Messages inbox, tagged with the booking code. */
export const recordTripMessage = async (bookingId: string, body: string) => {
  const { data: booking } = await supabase
    .from('booking_requests')
    .select('booking_code, full_name, email, phone')
    .eq('id', bookingId)
    .is('deleted_at', null)
    .maybeSingle();
  if (!booking) throw new AppError('Booking not found.', 404);
  const b = booking as Record<string, unknown>;

  const { error } = await supabase.from('contact_messages').insert({
    full_name: String(b.full_name ?? 'Traveller'),
    email: String(b.email ?? ''),
    phone: b.phone ? String(b.phone) : null,
    subject: `Trip portal · ${String(b.booking_code ?? '')}`,
    message: body
  });
  if (error) throw new AppError('Unable to send your message.', 500, [error]);
};
