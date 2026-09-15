import { createHash, randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { supabase } from '../config/supabase';
import { AppError } from '../utils/api-response';
import { emailLayout, sendEmail } from './email.service';

// How long a generated magic link stays valid (covers the whole pre-trip
// window: deposits, balance payments, document exchange).
const LINK_TTL_DAYS = 120;
// How long a browser session lasts after opening a valid link.
const SESSION_TTL = '14d';
export const TRIP_COOKIE = 'gf_trip';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const frontendOrigin = () => env.FRONTEND_URL.split(',')[0].replace(/\/$/, '');

/**
 * A readable label makes a guest link recognisable without becoming its
 * credential. The random token after `~` is still what grants access.
 */
const friendlyLinkLabel = (value: string | null | undefined): string =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'traveller';

/**
 * Guest links may be presented as `jane-doe~<token>`. The label is deliberately
 * ignored during authentication: it is only a readable URL hint and may be
 * changed without weakening or invalidating the random secret.
 */
const guestLinkCredential = (presentedValue: string): string => {
  const value = presentedValue.trim();
  const separator = value.lastIndexOf('~');
  return separator === -1 ? value : value.slice(separator + 1);
};

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
export type LinkPurpose = 'trip' | 'guest_details';

/** Where each kind of link lands. Keep in step with the frontend routes. */
const LINK_PATH: Record<LinkPurpose, string> = {
  trip: 'trip',
  guest_details: 'guest-details'
};

export const createTripLink = async (
  bookingId: string | null,
  adminId: string | null,
  purpose: LinkPurpose = 'trip',
  submissionId: string | null = null,
  linkLabel: string | null = null
) => {
  let resolvedLinkLabel = linkLabel;

  // A guest-details link may target a standalone submission that has no booking.
  // Everything else still resolves through a booking, as the trip portal does.
  if (submissionId) {
    const { data: submission, error } = await supabase
      .from('guest_detail_submissions')
      .select('id, label, booking_reference')
      .eq('id', submissionId)
      .maybeSingle();
    if (error) throw new AppError('Unable to load guest form.', 500, [error]);
    if (!submission) throw new AppError('Guest form not found.', 404);
    resolvedLinkLabel ||= String(submission.label ?? submission.booking_reference ?? '');
  } else {
    const { data: booking, error } = await supabase
      .from('booking_requests')
      .select('id, full_name')
      .eq('id', bookingId as string)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw new AppError('Unable to load booking.', 500, [error]);
    if (!booking) throw new AppError('Booking not found.', 404);
    resolvedLinkLabel ||= String(booking.full_name ?? '');
  }

  // Revoke existing active links for this booking OF THE SAME PURPOSE. Scoped
  // by purpose so issuing a guest-details link does not silently kill the
  // customer's trip-portal link, and vice versa.
  const targetColumn = submissionId ? 'submission_id' : 'booking_id';
  const targetValue = submissionId ?? (bookingId as string);
  await supabase
    .from('trip_access_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq(targetColumn, targetValue)
    .eq('purpose', purpose)
    .is('revoked_at', null);

  const rawToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + LINK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { error: insertError } = await supabase.from('trip_access_tokens').insert({
    booking_id: submissionId ? null : bookingId,
    submission_id: submissionId,
    token_hash: sha256(rawToken),
    expires_at: expiresAt,
    purpose,
    created_by: adminId
  });
  if (insertError) throw new AppError('Unable to create trip link.', 500, [insertError]);

  const publicCredential = purpose === 'guest_details'
    ? `${friendlyLinkLabel(resolvedLinkLabel)}~${rawToken}`
    : rawToken;

  return { url: `${frontendOrigin()}/${LINK_PATH[purpose]}/${publicCredential}`, expiresAt };
};

/**
 * Generate a fresh link for a booking and email it to the traveller. Returns
 * the link (so the admin can still copy it) plus whether the email was sent.
 * Email failures are non-fatal — the link is always returned.
 */
export const sendTripLinkEmail = async (bookingId: string, adminId: string | null) => {
  const { data: booking } = await supabase
    .from('booking_requests')
    .select('email, full_name, booking_code, tours(title)')
    .eq('id', bookingId)
    .is('deleted_at', null)
    .maybeSingle();
  if (!booking) throw new AppError('Booking not found.', 404);
  const b = booking as Record<string, unknown>;

  const { url, expiresAt } = await createTripLink(bookingId, adminId);

  let emailed = false;
  const to = String(b.email ?? '').trim();
  if (to) {
    const name = String(b.full_name ?? 'there').split(/\s+/)[0] || 'there';
    const tripTitle = ((b.tours as { title?: string } | null)?.title) ?? 'your East Africa trip';
    emailed = await sendEmail({
      to,
      subject: `Your Emnel trip portal — ${String(b.booking_code ?? '')}`,
      html: emailLayout(
        `Hi ${name}, here's your trip portal`,
        `<p>You can view <strong>${tripTitle}</strong>, see your itinerary and payment balance, and message your specialist any time — no password needed.</p>
         <p style="font-size:13px;color:#8a948f">This secure link is just for you. Please don't forward it.</p>`,
        { label: 'Open my trip', url }
      ),
      text: `Hi ${name}, open your Emnel trip portal here: ${url}`
    });
  }

  return { url, expiresAt, emailed };
};

/**
 * Self-service: find the most recent booking for an email and send its link.
 * Always resolves silently (no indication whether the email exists) to prevent
 * account enumeration.
 */
export const requestTripAccessByEmail = async (email: string): Promise<void> => {
  const clean = email.trim().toLowerCase();
  if (!clean) return;
  const { data: booking } = await supabase
    .from('booking_requests')
    .select('id')
    .ilike('email', clean)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!booking) return;
  try {
    await sendTripLinkEmail((booking as { id: string }).id, null);
  } catch {
    /* never reveal failures to the caller */
  }
};

/** Exchange a raw magic-link token for the booking id it grants access to. */
export const redeemTripToken = async (
  rawToken: string,
  purpose: LinkPurpose = 'trip'
): Promise<string | null> => {
  if (!rawToken || rawToken.length < 20) return null;
  const { data, error } = await supabase
    .from('trip_access_tokens')
    .select('id, booking_id, submission_id, expires_at, revoked_at, purpose')
    .eq('token_hash', sha256(rawToken))
    .maybeSingle();
  if (error || !data) return null;
  if (data.revoked_at || new Date(data.expires_at).getTime() < Date.now()) return null;
  // A trip-portal token must not open the passport form, and vice versa.
  // Legacy rows predate the column and default to 'trip'.
  if ((data.purpose ?? 'trip') !== purpose) return null;

  await supabase.from('trip_access_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', data.id);
  return (data.booking_id ?? null) as string | null;
};

/**
 * Resolve a guest-details token to what it grants access to. A token points at
 * EITHER a standalone submission or a booking — never both, enforced by a CHECK.
 */
export const redeemGuestToken = async (
  presentedToken: string
): Promise<{ submissionId: string | null; bookingId: string | null } | null> => {
  const rawToken = guestLinkCredential(presentedToken);
  if (!rawToken || rawToken.length < 20) return null;
  const { data, error } = await supabase
    .from('trip_access_tokens')
    .select('id, booking_id, submission_id, expires_at, revoked_at, purpose')
    .eq('token_hash', sha256(rawToken))
    .maybeSingle();
  if (error || !data) return null;
  if (data.revoked_at || new Date(data.expires_at).getTime() < Date.now()) return null;
  if ((data.purpose ?? 'trip') !== 'guest_details') return null;

  await supabase.from('trip_access_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', data.id);
  return {
    submissionId: (data.submission_id ?? null) as string | null,
    bookingId: (data.booking_id ?? null) as string | null
  };
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
